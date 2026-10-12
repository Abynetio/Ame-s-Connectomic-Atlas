"""Download the external sources that are not mirrored on GitHub.

Runs in GitHub Actions (see .github/workflows/fetch-external.yml), because the
hosts involved (Dryad, OSF) are not reachable from every
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


def existing(out: Path, rel: str) -> dict | None:
    """Manifest entry for a file that is already present (so re-runs do not re-download)."""
    path = out / rel
    if not path.exists():
        return None
    data = path.read_bytes()
    return {"path": rel, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "cached": True}


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
        if (e := existing(out, f"{key}/{name}")) and e["bytes"] == size:
            s["files"].append(e)
            continue
        href = f["_links"]["stash:download"]["href"]
        file_id = href.rstrip("/").split("/")[-2]
        for url in (f"{DRYAD}{href}", f"{DRYAD}/downloads/file_stream/{file_id}"):
            try:
                data = http_get(url, retries=2)
                s["files"].append(save(out, f"{key}/{name}", data))
                break
            except Exception as e:  # noqa: BLE001
                s["notes"].append(f"download failed {name} via {url}: {e}")
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


def osf_nodes(node: str):
    yield node
    url = f"https://api.osf.io/v2/nodes/{node}/children/"
    while url:
        page = get_json(url)
        for child in page.get("data", []):
            yield from osf_nodes(child["id"])
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
    walk = ((n, item) for n in osf_nodes(node) for item in osf_walk(f"https://api.osf.io/v2/nodes/{n}/files/osfstorage/"))
    for n, (path, size, dl) in walk:
        path = f"/{n}{path}"
        s["listing"].append({"name": path, "bytes": size})
        if not any(re.search(p, path) for p in patterns):
            continue
        if e := existing(out, f"{key}{path}"):
            s["files"].append(e)
            continue
        if size > max_bytes:
            s["notes"].append(f"skipped {path}: {size/1e6:.1f} MB > cap")
            continue
        try:
            s["files"].append(save(out, f"{key}{path}", http_get(dl)))
        except Exception as e:  # noqa: BLE001
            s["notes"].append(f"download failed {path}: {e}")
    s["status"] = "ok" if s["files"] else "failed"


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
                                      [
                                          # only the label maps in MNI2009c and their label lists, never templates/warps
                                          r"CIT168_Reinf_Learn_v1\.1\.0/(labels\.txt|README\.pdf|MNI152-Nonlin-Asym-2009c/CIT168toMNI152-2009c_(det|prob)\.nii\.gz)$",
                                          r"^/r2hvk/README\.pdf$",
                                      ],
                                      cap)),
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
