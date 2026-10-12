"""Download the source atlases that are mirrored on GitHub (pinned by commit and SHA-256).

    python pipeline/fetch_mirror.py [--raw data/raw]

These are the files the build needs (see data/sources.yaml for licences). Files are re-used
when already present with the right checksum.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIRROR = "https://raw.githubusercontent.com/frankyeh/data-atlas/9b9e9fbf9e0d0e56b9c640a022037ccf7008d6c9/human"
RELEASE = "https://github.com/frankyeh/data-atlas/releases/download/ICBM152_adult"

FILES = {
    "yeh/ICBM152_adult.tt.gz": (f"{RELEASE}/ICBM152_adult.tt.gz", "481d62767b77e4196ff74dcbc444b0cf302d9e86bdd7fc7a92ffcbc13e0adc93"),
    "yeh/ICBM152_adult.tt.gz.txt": (f"{RELEASE}/ICBM152_adult.tt.gz.txt", "20d9ca860c4395fa8d1c4296eef35cc3d7773ad7742800ec90f074c266769125"),
    "mirror/CerebrA.nii.gz": (f"{MIRROR}/CerebrA.nii.gz", "f1463a310431ced276fae4f97283620b5fe2b4a9132f0da7b11148111d24cca6"),
    "mirror/CerebrA.txt": (f"{MIRROR}/CerebrA.txt", "ba66406c9efd67fe4064c79ef87f5a738015ac6180c24a2f2657f72f4b0829a3"),
    "mirror/THOMAS.nii.gz": (f"{MIRROR}/THOMAS.nii.gz", "d20da544a60cfcc2840d7a1b3c09a76c84f03dbcd635e946f9aa3729e8980dce"),
    "mirror/THOMAS.txt": (f"{MIRROR}/THOMAS.txt", "abf9c886a20a0e3a79e357fef063fe72fcd53b23dabb7b98f2219cfa7ea984fc"),
    "mirror/ATAG_basal_ganglia.nii.gz": (f"{MIRROR}/ATAG_basal_ganglia.nii.gz", "226fa9ff4d841ad2e13efeb791950901f4b9e69da37ca61e0e4730c31ca7057a"),
    "mirror/ATAG_basal_ganglia.txt": (f"{MIRROR}/ATAG_basal_ganglia.txt", "214b13724ce01787a24d6ccaa008b939431320905b4ca6b12c269b42a97ca702"),
    "mirror/HCP842_tractography.nii.gz": (f"{MIRROR}/HCP842_tractography.nii.gz", "51e9143a4bc776d6675290b7b4229dd8606cee6ac5e5f746d3d81c3b33561db6"),
    "mirror/HCP842_tractography.txt": (f"{MIRROR}/HCP842_tractography.txt", "4bec93ef5d4c2442398444e17ff0b8451bb89bc76078f19feeca0284dbb390a7"),
    "mirror/human_T1w.nii.gz": (f"{MIRROR}/human_T1w.nii.gz", "aa43d19ea5d1a2f60671ce289f626e5dce272ff70a5006394ef26021227c9f8f"),
}


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=str(ROOT / "data/raw"))
    args = ap.parse_args()
    raw = Path(args.raw)
    bad = 0
    for rel, (url, digest) in FILES.items():
        dest = raw / rel
        if dest.exists() and sha256(dest) == digest:
            print(f"ok      {rel}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=300) as r:
                    dest.write_bytes(r.read())
                break
            except Exception as e:  # noqa: BLE001
                print(f"retry   {rel}: {e}")
                time.sleep(2 ** (attempt + 1))
        if not dest.exists() or sha256(dest) != digest:
            print(f"FAILED  {rel} (checksum mismatch or download error)")
            bad += 1
        else:
            print(f"fetched {rel}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
