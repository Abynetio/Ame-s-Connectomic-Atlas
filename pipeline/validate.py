"""Validate the curated knowledge graph.

    python pipeline/validate.py            # schema + referential integrity + licence checks
    python pipeline/validate.py --dois     # additionally check that every DOI resolves (network)

Exit status is non-zero if anything is wrong, so this runs in CI on every push.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parent.parent

# Source ids used in YAML geometry -> id in data/sources.yaml
GEOMETRY_SOURCES = {"cerebra": "cerebra", "thomas": "thomas", "atag": "atag", "hcp1065": "hcp1065", "hcp842": "hcp842", "schematic": "schematic"}


def _load_dir(d: Path) -> list:
    items: list = []
    for f in sorted(d.glob("*.yaml")):
        data = yaml.safe_load(f.read_text()) or []
        for it in data:
            it["_file"] = str(f.relative_to(ROOT))
        items.extend(data)
    return items


def load_graph(data_dir: Path) -> dict:
    g = {
        "regions": _load_dir(data_dir / "graph/regions"),
        "tracts": _load_dir(data_dir / "graph/tracts"),
        "pathways": _load_dir(data_dir / "graph/pathways"),
        "references": yaml.safe_load((data_dir / "graph/references.yaml").read_text()),
        "sources": yaml.safe_load((data_dir / "sources.yaml").read_text()),
    }
    return g


def validate_graph(g: dict) -> list[str]:
    errors: list[str] = []
    schema = json.loads((ROOT / "schema/graph.schema.json").read_text())
    strip = {k: [{kk: vv for kk, vv in it.items() if kk != "_file"} for it in g[k]] for k in ("regions", "tracts", "pathways")}
    v = jsonschema.Draft202012Validator(schema)
    for e in v.iter_errors(strip):
        loc = list(e.absolute_path)
        where = ""
        if len(loc) >= 2:
            it = g[loc[0]][loc[1]]
            where = f"{it.get('_file')}:{it.get('id')}"
        errors.append(f"schema {where} {'/'.join(map(str, loc[2:]))}: {e.message[:300]}")

    allowed = {s["id"]: s.get("allowed", False) for s in g["sources"]}
    refs = set(g["references"])
    ids: dict[str, str] = {}
    for kind in ("regions", "tracts", "pathways"):
        for it in g[kind]:
            if it["id"] in ids:
                errors.append(f"duplicate id {it['id']} ({kind}, already a {ids[it['id']]})")
            ids[it["id"]] = kind
            for r in it.get("refs", []):
                if r not in refs:
                    errors.append(f"{it['_file']}:{it['id']}: unknown reference '{r}'")

    def check_source(where, src):
        sid = GEOMETRY_SOURCES.get(src, src)
        if not allowed.get(sid):
            errors.append(f"{where}: geometry source '{src}' is not cleared for publication in data/sources.yaml")

    regions = {r["id"]: r for r in g["regions"]}
    tracts = {t["id"]: t for t in g["tracts"]}
    for r in g["regions"]:
        geo = r["geometry"]
        check_source(f"{r['_file']}:{r['id']}", geo.get("source", "schematic"))
        if geo["kind"] == "schematic":
            if geo["shape"] == "ellipsoid" and not ("center" in geo and "radii" in geo):
                errors.append(f"{r['id']}: ellipsoid needs center and radii")
            if geo["shape"] == "capsule" and not ("path" in geo and "radius" in geo):
                errors.append(f"{r['id']}: capsule needs path and radius")
    for t in g["tracts"]:
        for part in t["geometry"]:
            check_source(f"{t['_file']}:{t['id']}", part.get("source", "schematic"))
    for p in g["pathways"]:
        for k, st in enumerate(p["steps"]):
            where = f"{p['_file']}:{p['id']} step {k}"
            if "region" in st:
                if st["region"] not in regions:
                    errors.append(f"{where}: unknown region '{st['region']}'")
                elif "anchor" in st and st["anchor"] not in (regions[st["region"]].get("anchors") or {}):
                    errors.append(f"{where}: region '{st['region']}' has no anchor '{st['anchor']}'")
            if "tract" in st:
                if st["tract"] not in tracts:
                    errors.append(f"{where}: unknown tract '{st['tract']}'")
                else:
                    n = len(tracts[st["tract"]]["geometry"])
                    for pi in st.get("parts", []):
                        if pi >= n:
                            errors.append(f"{where}: tract '{st['tract']}' has no geometry part {pi}")
        if "region" not in p["steps"][0] or "region" not in p["steps"][-1] and "tract" not in p["steps"][-1]:
            errors.append(f"{p['_file']}:{p['id']}: a pathway must start at a region")
        for h in p.get("highlight", []):
            if h["region"] not in regions:
                errors.append(f"{p['_file']}:{p['id']}: unknown highlight region '{h['region']}'")
    return errors


def check_dois(g: dict) -> list[str]:
    errs = []
    for key, ref in g["references"].items():
        doi = ref.get("doi")
        if not doi:
            continue
        url = f"https://doi.org/api/handles/{doi}"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "aca-validate"}), timeout=30) as r:
                body = json.loads(r.read())
            if body.get("responseCode") != 1:
                errs.append(f"reference {key}: DOI {doi} does not resolve (code {body.get('responseCode')})")
        except Exception as e:  # noqa: BLE001
            errs.append(f"reference {key}: DOI {doi} lookup failed: {e}")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dois", action="store_true")
    args = ap.parse_args()
    g = load_graph(ROOT / "data")
    errors = validate_graph(g)
    if args.dois:
        errors += check_dois(g)
    if errors:
        print("\n".join(errors))
        print(f"\n{len(errors)} problem(s)")
        return 1
    print(f"ok: {len(g['regions'])} regions, {len(g['tracts'])} tracts, {len(g['pathways'])} pathways, {len(g['references'])} references")
    return 0


if __name__ == "__main__":
    sys.exit(main())
