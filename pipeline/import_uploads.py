"""Import source files that had to be downloaded by hand (e.g. Dryad, which refuses anonymous
API downloads) and uploaded to the repository.

Two ways to upload, both handled here:

1. **GitHub release (recommended for anything > 25 MB).** Create a release with the tag
   `source-uploads` and attach the files (up to 2 GB each). Release assets never enter the git
   history. The "Fetch external data" workflow downloads them into `uploads/` before running
   this script.
2. **Small files via the web uploader (< 25 MB each).** Zip the files and upload the zip into
   the `uploads/` folder of the repository.

Accepted inputs: .zip, .tar, .tar.gz/.tgz, .nii, .nii.gz, .txt, .md (archives may be nested).
Files are recognised by name (see RULES), gzip-compressed, and written to data/external/<source>/.
Processed files in `uploads/` are deleted afterwards so they do not stay in the tree.

    python pipeline/import_uploads.py [--uploads uploads] [--out data/external]
"""

from __future__ import annotations

import argparse
import gzip
import io
import re
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (filename regex, destination directory under data/external)
RULES = [
    (r"^AAN_.*_MNI152_1mm_v2p0\.nii(\.gz)?$", "harvard_aan_v2"),
    (r"^AAN_Brainstem_v2p0_Color_LUT_FreeSurfer\.txt$", "harvard_aan_v2"),
    (r"^README\.md$", None),  # only taken when it comes from an archive matched to a source
]


def iter_members(name: str, data: bytes, depth: int = 0):
    """Yield (basename, bytes) for every file, descending into archives."""
    low = name.lower()
    if depth > 3:
        return
    if low.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            for info in z.infolist():
                if not info.is_dir():
                    yield from iter_members(info.filename, z.read(info), depth + 1)
    elif low.endswith((".tar", ".tar.gz", ".tgz")):
        with tarfile.open(fileobj=io.BytesIO(data)) as t:
            for m in t.getmembers():
                if m.isfile():
                    yield from iter_members(m.name, t.extractfile(m).read(), depth + 1)
    else:
        yield Path(name).name, data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uploads", default=str(ROOT / "uploads"))
    ap.add_argument("--out", default=str(ROOT / "data/external"))
    args = ap.parse_args()
    up, out = Path(args.uploads), Path(args.out)
    if not up.exists():
        print("no uploads/ directory — nothing to import")
        return 0
    imported: list[str] = []
    consumed: list[Path] = []
    skip = {up / ".gitkeep", up / "README.md"}  # the folder's own notes
    for f in sorted(p for p in up.rglob("*") if p.is_file() and p not in skip):
        members = list(iter_members(f.name, f.read_bytes()))
        dests = {d for n, _ in members for rx, d in RULES if d and re.match(rx, n)}
        used = False
        for n, data in members:
            dest = next((d for rx, d in RULES if re.match(rx, n) and d), None)
            if dest is None and n == "README.md" and len(dests) == 1:
                dest = next(iter(dests))
            if dest is None:
                continue
            target = out / dest / (n if n.endswith((".gz", ".txt", ".md")) else n + ".gz")
            target.parent.mkdir(parents=True, exist_ok=True)
            payload = gzip.compress(data, mtime=0) if target.suffix == ".gz" and not n.endswith(".gz") else data
            target.write_bytes(payload)
            imported.append(f"{f.name}:{n} -> {target.relative_to(out.parent.parent) if out.is_absolute() else target} ({len(payload)/1e6:.2f} MB)")
            used = True
        if used:
            consumed.append(f)
        else:
            print(f"skipped {f}: no recognised source files inside")
    for line in imported:
        print("imported", line)
    for f in consumed:
        f.unlink()
    print(f"{len(imported)} file(s) imported from {len(consumed)} upload(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
