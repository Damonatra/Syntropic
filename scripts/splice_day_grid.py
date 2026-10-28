#!/usr/bin/env python3
"""Splice the transposed day grid into command-tower.tsx.

Replaces everything between the marker line containing "{schedView === 'day' ? ("
and the first following line that is exactly "                  ) : (".
Keeps both marker lines intact.
"""
import io

PATH = "/home/z/my-project/src/components/backbone/command-tower.tsx"
NEW = "/home/z/my-project/scripts/new-day-grid.tsx"

with io.open(PATH, encoding="utf-8") as f:
    lines = f.readlines()

start_idx = None
for i, ln in enumerate(lines):
    if "{schedView === 'day' ? (" in ln:
        start_idx = i
        break
assert start_idx is not None, "start marker not found"

end_idx = None
for j in range(start_idx + 1, len(lines)):
    if lines[j].strip() == ") : (":
        end_idx = j
        break
assert end_idx is not None, "end marker not found"

with io.open(NEW, encoding="utf-8") as f:
    new_block = f.read()
if not new_block.endswith("\n"):
    new_block += "\n"

out = lines[: start_idx + 1] + [new_block] + lines[end_idx:]
with io.open(PATH, "w", encoding="utf-8") as f:
    f.writelines(out)

print(f"Replaced lines {start_idx + 2}..{end_idx} (1-based) with {len(new_block.splitlines())} new lines.")
