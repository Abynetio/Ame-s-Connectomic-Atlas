"""Download the external sources that are not mirrored on GitHub.

Runs in GitHub Actions (see .github/workflows/fetch-external.yml), because the
hosts involved (Dryad, OSF, Zenodo, labsolver) are not reachable from every
development environment. Every file that is downloaded is recorded with its
size and SHA-256 in data/external/FETCH_REPORT.md and data/external/manifest.json,
together with the licence metadata the host reports.

Only the Python standard library is used so the script runs on a bare runner.

Usage:
    python pipeline/fetch_external.py [--out data/external] [--max-mb 60]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import traceback
import urllib.parse
import urllib.request
from pathlib import Path

UA = "AmesConnectomicAtlas-fetch/0.1 (+https://github.com/Abynetio/Ame-s-Connectomic-Atlas)"


def http_get(url: str, accept: str = "*/*", retries: int = 4) -> bytes:
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - we log and retry anything
            last = e
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def get_json(url: str) -> dict:
    return json.loads(http_get(url, accept="application/json"))


def save(out: Path, rel: str, data: bytes) -> dict:
    path = out / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"path": str(path.relative_to(out)), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


class Report:
    def __init__(self) -> None:
        self.sources: dict[str, dict] = {}

    def source(self, key: str) -> dict:
        return self.sources.setdefault(key, {"status": "pending", "files": [], "listing": [], "notes": []})


# --------------------------------------------------------------------------- Dryad
DRYAD = "https://datadryad.org"


def fetch_dryad(rep: Report, out: Path, key: str, doi: str, max_bytes: int, download: bool) -> None:
    s = rep.source(key)
    s["doi"] = doi
    enc = urllib.parse.quote(f"doi:{doi}", safe="")
    meta = get_json(f"{DRYAD}/api/v2/datasets/{enc}")
    s["title"] = meta.get("title")
    s["license"] = meta.get("license")
    s["version_date"] = meta.get("lastModificationDate") or meta.get("publicationDate")
    version_href = meta["_links"]["stash:version"]["href"]
    files = get_json(f"{DRYAD}{version_href}/files")
    entries = files.get("_embedded", {}).get("stash:files", [])
    # follow pagination
    nxt = files.get("_links", {}).get("next", {}).get("href")
    while nxt:
        page = get_json(f"{DRYAD}{nxt}")
        entries += page.get("_embedded", {}).get("stash:files", [])
        nxt = page.get("_links", {}).get("next", {}).get("href")
    for f in entries:
        size = f.get("size") or 0
        name = f.get("path")
        s["listing"].append({"name": name, "bytes": size})
        if not download:
            continue
        if size > max_bytes:
            s["notes"].append(f"skipped {name}: {size/1e6:.1f} MB > cap")
            continue
        href = f["_links"]["stash:download"]["href"]
        try:
            data = http_get(f"{DRYAD}{href}")
            s["files"].append(save(out, f"{key}/{name}", data))
        except Exception as e:  # noqa: BLE001
            s["notes"].append(f"download failed {name}: {e}")
    s["status"] = "ok" if (s["files"] or not download) else "failed"


# --------------------------------------------------------------------------- OSF
def osf_walk(url: str):
    while url:
        page = get_json(url)
        for item in page.get("data", []):
            attrs = item["attributes"]
            if attrs["kind"] == "folder":
                rel = item["relationships"]["files"]["links"]["related"]["href"]
                yield from osf_walk(rel)
            else:
                yield attrs.get("materialized_path"), attrs.get("size") or 0, item["links"].get("download")
        url = page.get("links", {}).get("next")


def fetch_osf(rep: Report, out: Path, key: str, node: str, patterns: list[str], max_bytes: int) -> None:
    s = rep.source(key)
    meta = get_json(f"https://api.osf.io/v2/nodes/{node}/")
    s["title"] = meta["data"]["attributes"].get("title")
    lic = meta["data"]["relationships"].get("license", {}).get("links", {}).get("related", {}).get("href")
    if lic:
        try:
            s["license"] = get_json(lic)["data"]["attributes"]["name"]
        except Exception as e:  # noqa: BLE001
            s["notes"].append(f"licence lookup failed: {e}")
    for path, size, dl in osf_walk(f"https://api.osf.io/v2/nodes/{node}/files/osfstorage/"):
        s["listing"].append({"name": path, "bytes": size})
        if not any(re.search(p, path) for p in patterns):
            continue
        if size > max_bytes:
            s["notes"].append(f"skipped {path}: {size/1e6:.1f} MB > cap")
            continue
        try:
            s["files"].append(save(out, f"{key}{path}", http_get(dl)))
        except Exception as e:  # noqa: BLE001
            s["notes"].append(f"download failed {path}: {e}")
    s["status"] = "ok" if s["files"] else "failed"


# --------------------------------------------------------------------------- Zenodo
def fetch_zenodo(rep: Report, out: Path, key: str, record: str, max_bytes: int) -> None:
    s = rep.source(key)
    meta = get_json(f"https://zenodo.org/api/records/{record}")
    md = meta.get("metadata", {})
    s["title"] = md.get("title")
    s["license"] = md.get("license")
    s["version_date"] = md.get("publication_date")
    for f in meta.get("files", []):
        name, size = f["key"], f.get("size", 0)
        s["listing"].append({"name": name, "bytes": size})
        if size > max_bytes:
            s["notes"].append(f"skipped {name}: {size/1e6:.1f} MB > cap")
            continue
        try:
            s["files"].append(save(out, f"{key}/{name}", http_get(f["links"]["self"])))
        except Exception as e:  # noqa: BLE001
            s["notes"].append(f"download failed {name}: {e}")
    s["status"] = "ok" if s["files"] else "failed"


# --------------------------------------------------------------------------- web pages
def fetch_page(rep: Report, out: Path, key: str, url: str, follow: list[str], max_bytes: int) -> None:
    """Save an HTML page and any linked files whose URL matches one of `follow`."""
    s = rep.source(key)
    html = http_get(url)
    s["files"].append(save(out, f"{key}/page.html", html))
    text = html.decode("utf-8", "replace")
    links = sorted(set(re.findall(r'href=["\']([^"\']+)["\']', text)))
    s["listing"] = [{"name": l, "bytes": None} for l in links]
    for link in links:
        if not any(re.search(p, link) for p in follow):
            continue
        absu = urllib.parse.urljoin(url, link)
        try:
            data = http_get(absu)
            if len(data) > max_bytes:
                s["notes"].append(f"skipped {absu}: too large")
                continue
            name = Path(urllib.parse.urlparse(absu).path).name or "index"
            s["files"].append(save(out, f"{key}/{name}", data))
        except Exception as e:  # noqa: BLE001
            s["notes"].append(f"download failed {absu}: {e}")
    s["status"] = "ok"


# --------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/external")
    ap.add_argument("--max-mb", type=float, default=60)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cap = int(args.max_mb * 1e6)
    rep = Report()

    jobs = [
        ("harvard_aan_v2", lambda: fetch_dryad(rep, out, "harvard_aan_v2", "10.5061/dryad.zw3r228d2", cap, True)),
        # 100 um volume is GB-scale: list only, never download in CI.
        ("edlow_100um", lambda: fetch_dryad(rep, out, "edlow_100um", "10.5061/dryad.119f80q", cap, False)),
        ("cit168", lambda: fetch_osf(rep, out, "cit168", "r2hvk",
                                      [r"MNI152-2009c.*(prob|label|det).*\.nii\.gz$", r"(?i)readme|label.*\.(txt|csv|tsv)$|\.pdf$"],
                                      cap)),
        ("hcp842_zenodo", lambda: fetch_zenodo(rep, out, "hcp842_zenodo", "3627772", cap)),
        ("yeh2022_connectome_page", lambda: fetch_page(rep, out, "yeh2022_connectome_page",
                                                        "https://brain.labsolver.org/hcp_trk_atlas.html",
                                                        [r"\.(xlsx|csv|txt|mat|zip)$"], cap)),
    ]
    for key, job in jobs:
        print(f"== {key}", flush=True)
        try:
            job()
        except Exception as e:  # noqa: BLE001
            s = rep.source(key)
            s["status"] = "failed"
            s["notes"].append(f"{type(e).__name__}: {e}")
            traceback.print_exc()
        print(json.dumps({k: v for k, v in rep.sources[key].items() if k != "listing"}, indent=1)[:4000], flush=True)

    (out / "manifest.json").write_text(json.dumps(rep.sources, indent=1))
    lines = ["# External fetch report", "", "Generated by `pipeline/fetch_external.py` in GitHub Actions.", ""]
    for key, s in rep.sources.items():
        lines += [f"## {key} — **{s['status']}**", ""]
        for k in ("title", "doi", "license", "version_date"):
            if s.get(k):
                lines.append(f"- {k}: `{json.dumps(s[k]) if not isinstance(s[k], str) else s[k]}`")
        lines.append(f"- files downloaded: {len(s['files'])} "
                     f"({sum(f['bytes'] for f in s['files'])/1e6:.1f} MB)")
        for n in s["notes"]:
            lines.append(f"- note: {n}")
        if s["listing"]:
            lines += ["", "<details><summary>listing</summary>", "", "```"]
            lines += [f"{e['name']}\t{e['bytes'] if e['bytes'] is not None else ''}" for e in s["listing"]]
            lines += ["```", "</details>"]
        lines.append("")
    (out / "FETCH_REPORT.md").write_text("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
