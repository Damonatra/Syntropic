#!/usr/bin/env python3
"""Rebuild download/vertebra-engine.zip from in-memory file bytes.

The workspace mount serves eventually-consistent reads, so `zip` rereading
files from disk can capture stale snapshots. This script reads every payload
file exactly once, guarantees the pyproject dependency fix in memory, and
writes the archive directly from those bytes.
"""

from __future__ import annotations

import zipfile
from pathlib import Path

ROOT = Path("/home/z/my-project")
OUT = ROOT / "download" / "vertebra-engine.zip"

CORRUPT = '"httpxttp2]>=0.27",'
FIXED = '"httpx[http2]>=0.27",'

INCLUDE_DIRS = ["vertebra"]
INCLUDE_FILES = [
    "prisma/schema.prisma",
    "scripts/verify_vertebra.py",
    "scripts/verify_modules_5_9.py",
]
EXCLUDE_PARTS = {"__pycache__", ".ruff_cache", ".venv"}
EXCLUDE_SUFFIXES = {".pyc", ".pyo", ".tmp"}


def collect_files() -> list[Path]:
    files: list[Path] = []
    for dirname in INCLUDE_DIRS:
        for path in sorted((ROOT / dirname).rglob("*")):
            if not path.is_file():
                continue
            if any(part in EXCLUDE_PARTS for part in path.parts):
                continue
            if path.suffix in EXCLUDE_SUFFIXES:
                continue
            files.append(path)
    for name in INCLUDE_FILES:
        path = ROOT / name
        if path.is_file():
            files.append(path)
    return files


def main() -> int:
    # Pass 1: read every file exactly once, fixing pyproject in memory.
    payloads: list[tuple[str, bytes]] = []
    fixed_in_memory = False
    for path in collect_files():
        data = path.read_bytes()
        arcname = path.relative_to(ROOT).as_posix()
        if arcname == "vertebra/pyproject.toml":
            text = data.decode("utf-8")
            if CORRUPT in text:
                text = text.replace(CORRUPT, FIXED)
                fixed_in_memory = True
                # Best-effort: also push the fix back through this channel.
                path.write_text(text)
            if FIXED not in text:
                raise SystemExit(
                    f"pyproject.toml served an unrecognized variant over this channel: "
                    f"{[l for l in text.splitlines() if 'httpx' in l]}"
                )
            data = text.encode("utf-8")
        payloads.append((arcname, data))

    # Pass 2: write the archive straight from the in-memory bytes.
    # NOTE: this mount shadows os.replace() renames for other processes, so the
    # archive must be written directly to its final path (no tmp+rename).
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in payloads:
            info = zipfile.ZipInfo(arcname)
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    # Pass 3: verify the archive bytes directly (no shell reread of sources).
    with zipfile.ZipFile(OUT) as zf:
        names = zf.namelist()
        pyproject = zf.read("vertebra/pyproject.toml").decode("utf-8")
        assert "httpx[http2]>=0.27" in pyproject, "zip payload missing the dependency fix"
        assert "httpxttp2" not in pyproject, "zip payload still carries the corrupt dependency"
        assert any("tactical_jobs" in n for n in names), "tactical_jobs.py missing from archive"
        assert not any("__pycache__" in n for n in names), "cache junk in archive"
        print(f"archive: {len(names)} files, {OUT.stat().st_size} bytes")
        print(f"pyproject fix applied in-memory: {fixed_in_memory}")
        print("zip content verified: dependency fixed, tactical_jobs present, no caches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
