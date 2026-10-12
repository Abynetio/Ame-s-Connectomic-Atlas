"""Build the web atlas bundle from the curated knowledge graph and the source atlases.

    python pipeline/build.py [--raw data/raw] [--out web/public/atlas]

Inputs
  data/graph/**.yaml   curated regions, tracts, pathways, references (CC BY-SA 4.0)
  data/sources.yaml    source registry with licence flags
  data/raw/            downloaded source files (see pipeline/fetch_mirror.py)

Outputs (web/public/atlas/)
  graph.json           everything the viewer needs except bulk geometry
  meshes.bin           quantised triangle meshes (regions, HCP842 tract volumes, context)
  tracts.bin           quantised HCP1065 streamlines
  slice_{ax,co,sa}.jpg template MRI slice sprite sheets
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import yaml
from scipy import ndimage
from skimage import measure

sys.path.insert(0, str(Path(__file__).parent))
from read_tt import read_tt  # noqa: E402
from validate import load_graph, validate_graph  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MESH_SCALE = 50.0  # int16 units per mm for mesh vertices
LINE_SCALE = 20.0  # int16 units per mm for streamline points


# ============================================================================ helpers
def mirror(p):
    return [-p[0], p[1], p[2]]


def side_points(spec: dict, side: str):
    """Resolve a {L: ..., R: ..., M: ...} coordinate spec for a side (mirroring L if needed)."""
    if side in spec:
        return spec[side]
    if side == "R" and "L" in spec:
        v = spec["L"]
        return [mirror(q) for q in v] if isinstance(v[0], list) else mirror(v)
    if "M" in spec:
        return spec["M"]
    raise KeyError(side)


def sides_of(spec: dict) -> list[str]:
    if "M" in spec:
        return ["M"]
    return ["L", "R"]


def catmull_rom(points, step=1.0):
    """Centripetal-ish Catmull-Rom resampling of a polyline at roughly `step` mm."""
    P = np.asarray(points, float)
    if len(P) < 3:
        n = max(2, int(np.linalg.norm(P[-1] - P[0]) / step) + 1)
        return np.linspace(P[0], P[-1], n)
    ext = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(ext) - 2):
        p0, p1, p2, p3 = ext[i - 1], ext[i], ext[i + 1], ext[i + 2]
        n = max(2, int(np.linalg.norm(p2 - p1) / step) + 1)
        for t in np.linspace(0, 1, n, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-1])
    return np.asarray(out)


def resample_polyline(P: np.ndarray, n: int) -> np.ndarray:
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    if s[-1] == 0:
        return np.repeat(P[:1], n, axis=0)
    t = np.linspace(0, s[-1], n)
    return np.stack([np.interp(t, s, P[:, k]) for k in range(3)], axis=1)


def resample_step(P: np.ndarray, step: float) -> np.ndarray:
    seg = np.linalg.norm(np.diff(P, axis=0), axis=1)
    L = seg.sum()
    return resample_polyline(P, max(2, int(L / step) + 1))


def smooth_polyline(P: np.ndarray, sigma=1.5) -> np.ndarray:
    if len(P) < 5:
        return P
    Q = ndimage.gaussian_filter1d(P, sigma, axis=0, mode="nearest")
    Q[0], Q[-1] = P[0], P[-1]
    return Q


def rnd(a, d=1):
    return np.round(np.asarray(a, float), d).tolist()


# ============================================================================ volumes
class Volumes:
    def __init__(self, raw: Path):
        m = raw / "mirror"
        self.cerebra = nib.load(m / "CerebrA.nii.gz")
        self.thomas = nib.load(m / "THOMAS.nii.gz")
        self.atag = nib.load(m / "ATAG_basal_ganglia.nii.gz")
        self.hcp842 = nib.load(m / "HCP842_tractography.nii.gz")
        self.hcp842_names = [l.split("\t")[1].strip() for l in (m / "HCP842_tractography.txt").read_text().splitlines() if l.strip()]
        self.t1 = nib.load(m / "human_T1w.nii.gz")
        self.cit168 = nib.load(ROOT / "data/external/cit168/jkzwp/CIT168_Reinf_Learn_v1.1.0/MNI152-Nonlin-Asym-2009c/CIT168toMNI152-2009c_det.nii.gz")
        self.harvard_aan = nib.load(ROOT / "data/external/harvard_aan_v2/AAN_Brainstem_MNI152_1mm_v2p0.nii.gz")
        self._cache: dict = {}

    def data(self, src: str) -> tuple[np.ndarray, np.ndarray]:
        if src not in self._cache:
            img = {"cerebra": self.cerebra, "thomas": self.thomas, "atag": self.atag, "cit168": self.cit168, "harvard_aan": self.harvard_aan}[src]
            d = np.asanyarray(img.dataobj)
            if d.dtype.kind == "f":
                d = np.rint(d).astype(np.int32)
            self._cache[src] = (d, img.affine)
        return self._cache[src]

    def label_mask(self, src: str, labels, zrange=None, hemi: str | None = None):
        if src == "hcp842":
            names = labels if isinstance(labels, list) else [labels]
            d = np.asanyarray(self.hcp842.dataobj)
            mask = np.zeros(d.shape[:3], bool)
            for n in names:
                mask |= d[..., self.hcp842_names.index(n)] > 0
            aff = self.hcp842.affine
        else:
            d, aff = self.data(src)
            labs = labels if isinstance(labels, list) else [labels]
            mask = np.isin(d, labs)
        if hemi in ("L", "R"):  # bilateral label: keep one hemisphere
            i = np.arange(mask.shape[0])
            x = aff[0, 0] * i + aff[0, 3]
            keep = (x <= 0) if hemi == "L" else (x > 0)
            mask = mask & keep[:, None, None]
        if zrange is not None:
            k = np.arange(mask.shape[2])
            z = aff[2, 2] * k + aff[2, 3]
            keep = (z >= zrange[0]) & (z < zrange[1])
            mask = mask & keep[None, None, :]
        return mask, aff


def mask_to_mesh(mask: np.ndarray, aff: np.ndarray, target_faces: int, sigma: float = 0.8):
    if mask.sum() == 0:
        raise ValueError("empty mask")
    # crop to the bounding box so smoothing stays cheap
    nz = np.argwhere(mask)
    lo, hi = nz.min(0), nz.max(0) + 1
    mask = mask[lo[0] : hi[0], lo[1] : hi[1], lo[2] : hi[2]]
    pad = 3
    m = np.pad(mask.astype(np.float32), pad)
    m = ndimage.gaussian_filter(m, sigma)
    level = min(0.5, 0.5 * float(m.max()))  # thin structures smooth below 0.5
    verts, faces, _, _ = measure.marching_cubes(m, level)
    verts = verts - pad + lo
    verts = nib.affines.apply_affine(aff, verts)
    if np.linalg.det(aff[:3, :3]) < 0:  # keep outward winding after a mirrored affine
        faces = faces[:, ::-1]
    if len(faces) > target_faces:
        import fast_simplification

        verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int64), target_reduction=1 - target_faces / len(faces))
    import trimesh

    tm = trimesh.Trimesh(verts, faces, process=True)
    trimesh.smoothing.filter_taubin(tm, iterations=8)
    return np.asarray(tm.vertices, np.float32), np.asarray(tm.faces, np.uint32)


def mask_centroid(mask, aff):
    ijk = np.argwhere(mask)
    return nib.affines.apply_affine(aff, ijk.mean(0))


def mask_centerline(mask, aff, step=2.0):
    """Centreline of an elongated mask: bin voxels along the principal axis, take slab centroids."""
    pts = nib.affines.apply_affine(aff, np.argwhere(mask))
    c = pts.mean(0)
    u = np.linalg.svd(pts - c, full_matrices=False)[2][0]
    t = (pts - c) @ u
    edges = np.arange(t.min(), t.max() + step, step)
    cl = []
    for a, b in zip(edges[:-1], edges[1:]):
        sel = (t >= a) & (t < b)
        if sel.sum() >= 2:
            cl.append(pts[sel].mean(0))
    cl = np.asarray(cl)
    return smooth_polyline(cl, 1.0) if len(cl) > 2 else cl


# ============================================================================ mesh store
class MeshStore:
    def __init__(self):
        self.items: list[dict] = []
        self.chunks: list[bytes] = []
        self.offset = 0

    def _push(self, b: bytes) -> int:
        off = self.offset
        pad = (-len(b)) % 4
        self.chunks.append(b + b"\0" * pad)
        self.offset += len(b) + pad
        return off

    def add(self, key: str, verts: np.ndarray, faces: np.ndarray) -> int:
        q = np.clip(np.rint(verts * MESH_SCALE), -32767, 32767).astype("<i2")
        idx_t = "<u2" if len(verts) < 65536 else "<u4"
        item = {
            "key": key,
            "nv": int(len(verts)),
            "ni": int(faces.size),
            "itype": "u16" if idx_t == "<u2" else "u32",
            "v": self._push(q.tobytes()),
        }
        item["i"] = self._push(faces.astype(idx_t).tobytes())
        self.items.append(item)
        return len(self.items) - 1

    def write(self, path: Path):
        path.write_bytes(b"".join(self.chunks))


# ============================================================================ streamlines
def build_streamlines(tt_path: Path, names_path: Path, out: Path, step=1.5):
    t = read_tt(tt_path, names_path)
    lengths, pts, bundles = [], [], []
    s_idx = p_idx = 0
    centerlines: dict[str, np.ndarray] = {}
    for lab, name in enumerate(t.names):
        idx = np.flatnonzero(t.labels == lab)
        s0, p0 = s_idx, p_idx
        res = []
        for i in idx:
            s = t.streamlines[i]
            r = resample_step(smooth_polyline(s.astype(np.float64), 1.0), step)
            res.append(r)
            q = np.clip(np.rint(r * LINE_SCALE), -32767, 32767).astype("<i2")
            pts.append(q)
            lengths.append(len(r))
            s_idx += 1
            p_idx += len(r)
        bundles.append({"name": name, "s0": s0, "s1": s_idx, "p0": p0, "p1": p_idx})
        centerlines[name] = bundle_centerline(res)
    lengths_b = np.asarray(lengths, "<u2").tobytes()
    pts_b = np.concatenate(pts).tobytes()
    pad = (-len(lengths_b)) % 4
    out.write_bytes(lengths_b + b"\0" * pad + pts_b)
    meta = {
        "file": out.name,
        "scale": LINE_SCALE,
        "n_streamlines": s_idx,
        "n_points": p_idx,
        "lengths_offset": 0,
        "points_offset": len(lengths_b) + pad,
        "bundles": bundles,
    }
    endpoints = {}
    for lab, name in enumerate(t.names):
        idx = np.flatnonzero(t.labels == lab)
        endpoints[name] = np.array([[t.streamlines[i][0], t.streamlines[i][-1]] for i in idx])
    return meta, centerlines, endpoints


def bundle_centerline(lines: list[np.ndarray], n=48) -> np.ndarray:
    R = [resample_polyline(l, n) for l in lines if len(l) >= 2]
    if not R:
        return np.zeros((0, 3))
    ref = max(R, key=lambda r: np.linalg.norm(r[-1] - r[0]))
    al = []
    for r in R:
        d_same = np.linalg.norm(r[0] - ref[0]) + np.linalg.norm(r[-1] - ref[-1])
        d_flip = np.linalg.norm(r[-1] - ref[0]) + np.linalg.norm(r[0] - ref[-1])
        al.append(r if d_same <= d_flip else r[::-1])
    return smooth_polyline(np.median(np.stack(al), axis=0), 1.0)


# ============================================================================ chaining / routes
def chain_parts(polys: list[np.ndarray]) -> np.ndarray:
    polys = [p for p in polys if len(p) >= 2]
    if not polys:
        return np.zeros((0, 3))
    if len(polys) == 1:
        return polys[0]
    a, b = polys[0], polys[1]
    best = min(
        ((x, y) for x in (a, a[::-1]) for y in (b, b[::-1])),
        key=lambda xy: np.linalg.norm(xy[0][-1] - xy[1][0]),
    )
    out = [best[0], best[1]]
    for p in polys[2:]:
        end = out[-1][-1]
        out.append(p if np.linalg.norm(p[0] - end) <= np.linalg.norm(p[-1] - end) else p[::-1])
    return np.vstack(out)


def trim(P: np.ndarray, a, b) -> np.ndarray:
    if len(P) == 0:
        return P
    if a is None and b is None:
        return P
    if a is None:
        j = int(np.argmin(np.linalg.norm(P - b, axis=1)))
        far = 0 if j > len(P) // 2 else len(P) - 1
        i = far
    else:
        i = int(np.argmin(np.linalg.norm(P - a, axis=1)))
        if b is None:
            j = 0 if i > len(P) // 2 else len(P) - 1
        else:
            j = int(np.argmin(np.linalg.norm(P - b, axis=1)))
    if i <= j:
        return P[i : j + 1]
    return P[j : i + 1][::-1]


# ============================================================================ main build
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(ROOT / "data/raw"))
    ap.add_argument("--out", default=str(ROOT / "web/public/atlas"))
    ap.add_argument("--skip-slices", action="store_true")
    args = ap.parse_args()
    raw, out = Path(args.raw), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    g = load_graph(ROOT / "data")
    errors = validate_graph(g)
    if errors:
        print("\n".join(errors))
        return 1

    vols = Volumes(raw)
    meshes = MeshStore()

    # ---------------------------------------------------------------- streamlines
    print("streamlines …", flush=True)
    sl_meta, centerlines, endpoints = build_streamlines(
        raw / "yeh/ICBM152_adult.tt.gz", raw / "yeh/ICBM152_adult.tt.gz.txt", out / "tracts.bin"
    )
    bundle_index = {b["name"]: i for i, b in enumerate(sl_meta["bundles"])}

    # ---------------------------------------------------------------- regions
    print("regions …", flush=True)
    regions_out = []
    region_pos: dict[tuple[str, str], np.ndarray] = {}
    region_anchor: dict[tuple[str, str, str], np.ndarray] = {}
    for r in g["regions"]:
        geo = r["geometry"]
        rec = {k: v for k, v in r.items() if k not in ("geometry", "anchors")}
        rec["kind"] = geo["kind"]
        rec["source"] = geo.get("source", "schematic")
        rec["style"] = geo.get("style", "default")
        rec["sides"] = {}
        if geo["kind"] == "data":
            for side in sides_of(geo["labels"]):
                bilateral = geo["labels"].get("L") is not None and geo["labels"].get("L") == geo["labels"].get("R")
                mask, aff = vols.label_mask(geo["source"], geo["labels"][side], geo.get("zrange"), hemi=side if bilateral else None)
                vox = float(abs(np.linalg.det(aff[:3, :3])))
                volume = mask.sum() * vox
                target = 6000 if rec["style"] == "context" else (3500 if volume > 8000 else 1600)
                v, f = mask_to_mesh(mask, aff, target, sigma=0.8 if vox >= 0.9 else 1.2)
                c = mask_centroid(mask, aff)
                rec["sides"][side] = {"mesh": meshes.add(f"region:{r['id']}:{side}", v, f), "centroid": rnd(c), "volume_mm3": round(volume)}
                region_pos[(r["id"], side)] = c
        else:
            shape = geo["shape"]
            spec = geo["center"] if shape == "ellipsoid" else geo["path"]
            for side in sides_of(spec):
                if shape == "ellipsoid":
                    c = np.asarray(side_points(geo["center"], side), float)
                    rec["sides"][side] = {"shape": "ellipsoid", "center": rnd(c), "radii": geo["radii"], "centroid": rnd(c)}
                else:
                    path = catmull_rom(side_points(geo["path"], side), 1.0)
                    c = path[len(path) // 2]
                    rec["sides"][side] = {"shape": "capsule", "path": rnd(path), "radius": geo["radius"], "centroid": rnd(c)}
                region_pos[(r["id"], side)] = c
        for name, spec in (r.get("anchors") or {}).items():
            for side in ("L", "R"):
                region_anchor[(r["id"], side, name)] = np.asarray(side_points(spec, side), float)
        if r.get("anchors"):
            rec["anchors"] = {n: {s: rnd(region_anchor[(r["id"], s, n)]) for s in ("L", "R")} for n in r["anchors"]}
        regions_out.append(rec)

    # context: outer hemisphere surfaces built from all CerebrA cerebral labels
    print("context surfaces …", flush=True)
    d, aff = vols.data("cerebra")
    labels_txt = [(int(l.split("\t")[0]), l.split("\t")[1].strip()) for l in (raw / "mirror/CerebrA.txt").read_text().splitlines() if l.strip()]
    excl = ("Cerebellum", "Vermal", "Brainstem", "Ventricle", "Optic_Chiasm")
    context = []
    for side, prefix in (("L", "Left_"), ("R", "Right_")):
        labs = [v for v, n in labels_txt if n.startswith(prefix) and not any(e in n for e in excl)]
        m = np.isin(d, labs)
        m = ndimage.binary_closing(m, iterations=3)
        m = ndimage.binary_fill_holes(m)
        v, f = mask_to_mesh(m, aff, 12000, sigma=1.2)
        context.append({"id": f"hemisphere_{side}", "name": f"{'Left' if side == 'L' else 'Right'} cerebral hemisphere", "mesh": meshes.add(f"context:hemisphere:{side}", v, f)})
    hemis = {}
    for side, prefix in (("L", "Left_"), ("R", "Right_")):
        labs = [v for v, n in labels_txt if n.startswith(prefix) and not any(e in n for e in excl)]
        hemis[side] = ndimage.binary_fill_holes(ndimage.binary_closing(np.isin(d, labs), iterations=3))
    for c in context:
        c["kind"] = "shell"
    # brainstem and cerebellum outlines, so infratentorial tracts sit inside a glass shell too
    for cid, name, keys, faces in (
        ("brainstem", "Brainstem", ("Brainstem",), 5000),
        ("cerebellum", "Cerebellum", ("Cerebellum", "Vermal"), 9000),
    ):
        labs = [v for v, n in labels_txt if any(k in n for k in keys)]
        m = ndimage.binary_fill_holes(ndimage.binary_closing(np.isin(d, labs), iterations=2))
        v, f = mask_to_mesh(m, aff, faces, sigma=1.2)
        context.append({"id": cid, "name": name, "kind": "shell", "mesh": meshes.add(f"context:{cid}", v, f)})

    # tissue layers (toggleable): ventricles, grey matter, white matter
    print("tissue layers …", flush=True)
    vent = [v for v, n in labels_txt if "Ventricle" in n]
    m = np.isin(d, vent)
    v, f = mask_to_mesh(m, aff, 9000, sigma=0.9)
    context.append({"id": "ventricles", "name": "Ventricular system (lateral, third, fourth)", "kind": "ventricles", "mesh": meshes.add("context:ventricles", v, f)})
    deep = ("Thalamus", "Caudate", "Putamen", "Pallidum", "Hippocampus", "Amygdala", "Accumbens", "Basal_Forebrain")
    nonctx = ("Ventricle", "Brainstem", "Optic_Chiasm", "Ventral_Diencephalon", "Cerebellum_White", "Vermal")
    gm_labels = [v for v, n in labels_txt if not any(k in n for k in nonctx)]  # neocortex + deep grey + cerebellar cortex
    gm = np.isin(d, gm_labels)
    v, f = mask_to_mesh(gm, aff, 60000, sigma=0.7)
    context.append({"id": "grey_matter", "name": "Grey matter (cortex, deep nuclei, cerebellar cortex)", "kind": "grey", "mesh": meshes.add("context:grey_matter", v, f)})
    # cerebral white matter: bright T1 voxels inside the hemispheres that are not grey matter or CSF;
    # cerebellar white matter comes straight from CerebrA
    t1 = vols.t1
    ijk = np.argwhere(np.ones(d.shape, bool))
    t1_idx = np.rint(nib.affines.apply_affine(np.linalg.inv(t1.affine), nib.affines.apply_affine(aff, ijk))).astype(int)
    T = np.asanyarray(t1.dataobj)
    ok = np.all((t1_idx >= 0) & (t1_idx < np.array(T.shape)), axis=1)
    t1_on_grid = np.zeros(len(ijk), np.float32)
    t1_on_grid[ok] = T[t1_idx[ok, 0], t1_idx[ok, 1], t1_idx[ok, 2]]
    t1_on_grid = t1_on_grid.reshape(d.shape)
    ctx_vals = t1_on_grid[np.isin(d, [v for v, n in labels_txt if not any(k in n for k in deep + nonctx + ("Cerebellum",))])]
    wm_vals = t1_on_grid[np.isin(d, [v for v, n in labels_txt if "Cerebellum_White" in n])]
    thr = 0.5 * (np.median(ctx_vals) + np.median(wm_vals))
    wm = (hemis["L"] | hemis["R"]) & (t1_on_grid > thr) & ~gm & ~np.isin(d, vent)
    wm, n_comp = ndimage.label(wm)
    if n_comp > 1:
        sizes = ndimage.sum(np.ones_like(wm), wm, range(1, n_comp + 1))
        keep = 1 + np.argsort(sizes)[::-1][:2]  # the two hemispheric white-matter bodies (joined by the corpus callosum)
        wm = np.isin(wm, keep)
    else:
        wm = wm > 0
    wm |= np.isin(d, [v for v, n in labels_txt if "Cerebellum_White" in n])
    v, f = mask_to_mesh(wm, aff, 50000, sigma=0.8)
    context.append({"id": "white_matter", "name": "White matter (cerebral and cerebellar)", "kind": "white", "mesh": meshes.add("context:white_matter", v, f)})
    print(f"  white-matter T1 threshold {thr:.0f}", flush=True)

    # ---------------------------------------------------------------- tracts
    print("tracts …", flush=True)
    tract_polys: dict[tuple[str, str], list[np.ndarray]] = {}
    tracts_out = []
    for t in g["tracts"]:
        rec = {k: v for k, v in t.items() if k != "geometry"}
        rec["parts"] = []
        for pi, part in enumerate(t["geometry"]):
            prec = {"kind": part["kind"], "role": part.get("role", "main"), "label": part.get("label")}
            prec["sides"] = {}
            if part["kind"] == "data" and part["source"] == "hcp1065":
                prec["source"] = "hcp1065"
                for side, bname in part["bundles"].items():
                    cl = centerlines[bname]
                    prec["sides"][side] = {"bundle": bundle_index[bname], "centerline": rnd(cl)}
            elif part["kind"] == "data":
                prec["source"] = part["source"]  # hcp842 / thomas volumes
                for side, lab in part["labels"].items():
                    mask, aff = vols.label_mask(part["source"], lab)
                    v, f = mask_to_mesh(mask, aff, 2500, sigma=0.9 if part["source"] == "hcp842" else 1.0)
                    cl = mask_centerline(mask, aff)
                    prec["sides"][side] = {"mesh": meshes.add(f"tract:{t['id']}:{pi}:{side}", v, f), "centerline": rnd(cl)}
            else:
                prec["source"] = "schematic"
                prec["radius"] = part.get("radius", 0.8)
                for side in sides_of(part["path"]):
                    path = catmull_rom(side_points(part["path"], side), 0.75)
                    prec["sides"][side] = {"path": rnd(path, 2)}
            rec["parts"].append(prec)
        tracts_out.append(rec)
        for pi, prec in enumerate(rec["parts"]):
            for side, sd in prec["sides"].items():
                poly = np.asarray(sd.get("centerline") or sd.get("path"), float)
                tract_polys[(t["id"], pi, side)] = poly

    # ---------------------------------------------------------------- endpoints (tract-to-region)
    print("endpoints …", flush=True)
    tract_endpoints = compute_endpoints(g, vols, endpoints, tracts_out, sl_meta)
    for t in tracts_out:
        if t["id"] in tract_endpoints:
            t["endpoints"] = tract_endpoints[t["id"]]

    # ---------------------------------------------------------------- pathways
    print("pathways …", flush=True)
    tracts_by_id = {t["id"]: t for t in tracts_out}
    pathways_out = []
    edges: dict[tuple, dict] = {}
    for pw in g["pathways"]:
        rec = dict(pw)
        rec["routes"] = {}
        for start in ("L", "R"):
            other = "R" if start == "L" else "L"

            def res_side(s):
                return start if s == "ipsi" else other

            pts: list[np.ndarray] = []
            spans = []
            steps = pw["steps"]

            def step_point(st):
                side = res_side(st["side"])
                if "anchor" in st:
                    return region_anchor[(st["region"], side, st["anchor"])]
                key = (st["region"], side) if (st["region"], side) in region_pos else (st["region"], "M")
                return region_pos[key]

            for k, st in enumerate(steps):
                i0 = len(pts)
                if "region" in st:
                    pts.append(step_point(st))
                else:
                    trec = tracts_by_id[st["tract"]]
                    side = res_side(st["side"])
                    parts = st.get("parts") or [i for i, p in enumerate(trec["parts"]) if p["role"] != "branch"]
                    polys = []
                    for pi in parts:
                        sd = trec["parts"][pi]["sides"]
                        s_key = side if side in sd else "M"
                        polys.append(tract_polys[(st["tract"], pi, s_key)])
                    poly = chain_parts(polys)
                    a = pts[-1] if pts else None
                    nxt = next((s for s in steps[k + 1 :] if "region" in s), None)
                    b = step_point(nxt) if nxt is not None else None
                    seg = trim(poly, a, b)
                    pts.extend(list(seg))
                spans.append([i0, max(i0, len(pts) - 1)])
            route = np.asarray(pts)
            rec["routes"][start] = {"points": rnd(route), "spans": spans}
        pathways_out.append(rec)

        # edges between consecutive synaptic regions
        syn = [(k, s) for k, s in enumerate(pw["steps"]) if "region" in s and s.get("synapse", True)]
        for (k0, a), (k1, b) in zip(syn[:-1], syn[1:]):
            via = [s["tract"] for s in pw["steps"][k0 + 1 : k1] if "tract" in s]
            lat = "ipsilateral" if a["side"] == b["side"] else "contralateral"
            key = (a["region"], b["region"], lat)
            e = edges.setdefault(key, {"from": a["region"], "to": b["region"], "laterality": lat, "via": [], "pathways": [], "evidence": ["classical"]})
            for v in via:
                if v not in e["via"]:
                    e["via"].append(v)
            e["pathways"].append(pw["id"])
            if any(p["kind"] == "data" for v in via for p in tracts_by_id[v]["parts"]) and "human-tractography" not in e["evidence"]:
                e["evidence"].append("human-tractography")

    # ---------------------------------------------------------------- slices
    slices = None
    if not args.skip_slices:
        print("slices …", flush=True)
        slices = build_slices(vols.t1, out)

    meshes.write(out / "meshes.bin")
    graph = {
        "meta": {
            "title": "Ame's Connectomic Atlas",
            "space": "MNI ICBM152 2009 nonlinear asymmetric (RAS, mm)",
            "mesh_scale": MESH_SCALE,
            "version": "0.1.0",
        },
        "sources": g["sources"],
        "references": g["references"],
        "regions": regions_out,
        "context": context,
        "tracts": tracts_out,
        "pathways": pathways_out,
        "edges": list(edges.values()),
        "meshes": {"file": "meshes.bin", "items": meshes.items},
        "streamlines": sl_meta,
        "slices": slices,
    }
    (out / "graph.json").write_text(json.dumps(graph, separators=(",", ":"), ensure_ascii=False))
    sizes = {p.name: p.stat().st_size for p in out.iterdir()}
    print(json.dumps(sizes, indent=1))
    print(f"total {sum(sizes.values())/1e6:.1f} MB")
    return 0


# ============================================================================ endpoints
def compute_endpoints(g, vols: Volumes, endpoints, tracts_out, sl_meta, max_dist_mm=4.0):
    """Fraction of streamline end-points of each HCP1065 bundle falling in (or within a few mm
    of) each atlas region. Fine atlases (THOMAS, ATAG) take precedence over CerebrA."""
    d_c, aff_c = vols.data("cerebra")
    lab = np.zeros(d_c.shape, np.int32)
    names: list[tuple[str, str]] = [("", "")]
    inv = np.linalg.inv(aff_c)
    grid = np.stack(np.meshgrid(*[np.arange(n) for n in d_c.shape], indexing="ij"), -1).reshape(-1, 3)
    world = nib.affines.apply_affine(aff_c, grid)

    def sample(src):
        d, aff = vols.data(src)
        ijk = np.rint(nib.affines.apply_affine(np.linalg.inv(aff), world)).astype(int)
        ok = np.all((ijk >= 0) & (ijk < np.array(d.shape)), axis=1)
        out = np.zeros(len(world), np.int32)
        out[ok] = d[ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]]
        return out.reshape(d_c.shape)

    resampled = {"cerebra": d_c, "thomas": sample("thomas"), "atag": sample("atag"), "cit168": sample("cit168"), "harvard_aan": sample("harvard_aan")}
    zc = world[:, 2].reshape(d_c.shape)
    xc = world[:, 0].reshape(d_c.shape)
    for src in ("cerebra", "cit168", "harvard_aan", "atag", "thomas"):  # later sources overwrite earlier ones
        for r in g["regions"]:
            geo = r["geometry"]
            if geo["kind"] != "data" or geo["source"] != src or geo.get("style") in ("ventricle",) or r["id"] == "thalamus":
                continue
            for side, labs in geo["labels"].items():
                labs = labs if isinstance(labs, list) else [labs]
                m = np.isin(resampled[src], labs)
                if geo["labels"].get("L") is not None and geo["labels"].get("L") == geo["labels"].get("R"):
                    m &= (xc <= 0) if side == "L" else (xc > 0)
                if geo.get("zrange"):
                    m &= (zc >= geo["zrange"][0]) & (zc < geo["zrange"][1])
                names.append((r["id"], side))
                lab[m] = len(names) - 1
    dist, (ii, jj, kk) = ndimage.distance_transform_edt(lab == 0, return_indices=True)
    near = lab[ii, jj, kk]
    near[dist > max_dist_mm] = 0

    result = {}
    for t in tracts_out:
        for part in t["parts"]:
            if part.get("source") != "hcp1065":
                continue
            for side, sd in part["sides"].items():
                bname = sl_meta["bundles"][sd["bundle"]]["name"]
                E = endpoints[bname].reshape(-1, 3)
                ijk = np.rint(nib.affines.apply_affine(inv, E)).astype(int)
                ok = np.all((ijk >= 0) & (ijk < np.array(lab.shape)), axis=1)
                ids = near[ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]]
                ids = ids[ids > 0]
                if len(ids) == 0:
                    continue
                cnt = np.bincount(ids, minlength=len(names))
                frac = cnt / len(E)
                items = [{"region": names[i][0], "side": names[i][1], "fraction": round(float(frac[i]), 3)} for i in np.argsort(-frac) if frac[i] >= 0.03]
                result.setdefault(t["id"], {}).setdefault(side, [])
                result[t["id"]][side].extend(items)
    # merge duplicates (multi-part tracts)
    for tid, by_side in result.items():
        for side, items in by_side.items():
            acc: dict[tuple, float] = {}
            for it in items:
                acc[(it["region"], it["side"])] = acc.get((it["region"], it["side"]), 0) + it["fraction"]
            n_parts = sum(1 for t in tracts_out if t["id"] == tid for p in t["parts"] if p.get("source") == "hcp1065")
            by_side[side] = [{"region": k[0], "side": k[1], "fraction": round(v / n_parts, 3)} for k, v in sorted(acc.items(), key=lambda kv: -kv[1])][:12]
    return result


# ============================================================================ slices
def build_slices(t1img, out: Path, step_mm=2):
    from PIL import Image

    d = np.asanyarray(t1img.dataobj).astype(np.float32)
    aff = t1img.affine
    ds = int(round(1.0 / abs(aff[0, 0])))  # 0.5 mm -> 1 mm
    d = d[::ds, ::ds, ::ds]
    aff1 = aff.copy()
    aff1[:3, :3] *= ds
    lo, hi = np.percentile(d[d > 0], [1, 99.5])
    d8 = np.clip((d - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
    every = int(round(step_mm))
    meta = {"affine": rnd(aff1, 3), "shape": list(d8.shape), "step": every, "views": {}}
    for view, axis in (("axial", 2), ("coronal", 1), ("sagittal", 0)):
        idxs = list(range(0, d8.shape[axis], every))
        sl = [np.take(d8, i, axis=axis) for i in idxs]
        # orient each slice image: rows = second axis reversed (so up is superior/anterior)
        imgs = [np.flipud(s.T) for s in sl]
        h, w = imgs[0].shape
        cols = int(math.ceil(math.sqrt(len(imgs) * h / w)))
        rows = int(math.ceil(len(imgs) / cols))
        sheet = np.zeros((rows * h, cols * w), np.uint8)
        for n, im in enumerate(imgs):
            r, c = divmod(n, cols)
            sheet[r * h : (r + 1) * h, c * w : (c + 1) * w] = im
        fname = f"slice_{view}.jpg"
        Image.fromarray(sheet).save(out / fname, quality=82, optimize=True)
        meta["views"][view] = {"file": fname, "axis": axis, "indices": idxs, "tile": [w, h], "cols": cols, "rows": rows}
    return meta


if __name__ == "__main__":
    sys.exit(main())
