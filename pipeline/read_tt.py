"""Reader for DSI Studio `.tt.gz` tractography files.

A `.tt.gz` file is a gzipped MATLAB v4 container holding:

- ``dimension`` (int32 x3), ``voxel_size`` (float32 x3)
- ``trans_to_mni`` (float32 x16, row-major 4x4, voxel -> MNI mm)
- ``cluster`` (uint16, one bundle label per streamline)
- ``track`` (uint8 byte stream). For each streamline, the stream holds:
    uint32  n         number of coordinates (3 x number of points)
    int32   x0,y0,z0  first point, in voxel units x 32
    int8    dx,dy,dz  (n/3 - 1) delta triplets, cumulative, in voxel units x 32
"""

from __future__ import annotations

import gzip
import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_MAT4_TYPES = {0: "<f8", 1: "<f4", 2: "<i4", 3: "<i2", 4: "<u2", 5: "<u1"}


def read_mat4(buf: bytes) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    p = 0
    while p + 20 <= len(buf):
        mopt, mrows, ncols, _imagf, namlen = struct.unpack("<5i", buf[p : p + 20])
        p += 20
        name = buf[p : p + namlen - 1].decode("ascii")
        p += namlen
        dt = np.dtype(_MAT4_TYPES[(mopt // 10) % 10])
        n = mrows * ncols
        out[name] = np.frombuffer(buf, dtype=dt, count=n, offset=p)
        p += n * dt.itemsize
    return out


@dataclass
class Tractogram:
    streamlines: list[np.ndarray]  # each (k, 3) float32 in MNI mm
    labels: np.ndarray  # (n_streamlines,) int
    names: list[str]  # bundle name per label


def decode_tracks(track: np.ndarray, n_expected: int) -> list[np.ndarray]:
    raw = track.tobytes()
    lines: list[np.ndarray] = []
    p = 0
    while p < len(raw):
        (count,) = struct.unpack_from("<I", raw, p)
        x0 = np.frombuffer(raw, dtype="<i4", count=3, offset=p + 4).astype(np.int64)
        npts = count // 3
        deltas = np.frombuffer(raw, dtype="<i1", count=count - 3, offset=p + 16).astype(np.int64).reshape(-1, 3)
        pts = np.vstack([x0, deltas]).cumsum(axis=0)
        lines.append((pts / 32.0).astype(np.float32))
        assert len(pts) == npts
        p += 16 + count - 3
    if len(lines) != n_expected:
        raise ValueError(f"decoded {len(lines)} streamlines, expected {n_expected}")
    return lines


def read_tt(path: str | Path, names_path: str | Path | None = None) -> Tractogram:
    m = read_mat4(gzip.open(path, "rb").read())
    labels = m["cluster"].astype(np.int64)
    vox = decode_tracks(m["track"], len(labels))
    aff = m["trans_to_mni"].astype(np.float64).reshape(4, 4)
    mni = [(v @ aff[:3, :3].T + aff[:3, 3]).astype(np.float32) for v in vox]
    names: list[str] = []
    if names_path is not None:
        names = [l.strip() for l in Path(names_path).read_text().splitlines() if l.strip()]
    return Tractogram(mni, labels, names)


if __name__ == "__main__":
    import sys

    t = read_tt(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    print(f"{len(t.streamlines)} streamlines, {len(set(t.labels.tolist()))} bundles")
    for lab in sorted(set(t.labels.tolist())):
        idx = np.flatnonzero(t.labels == lab)
        pts = np.concatenate([t.streamlines[i] for i in idx])
        name = t.names[lab] if lab < len(t.names) else str(lab)
        print(f"{lab:3d} {name:60s} n={len(idx):4d} mean={pts.mean(0).round(1)}")
