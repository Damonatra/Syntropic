#!/usr/bin/env python3
"""Remove the leftover old-grid fragment (lines 1862..1941, 1-based inclusive)."""
PATH = "/home/z/my-project/src/components/backbone/command-tower.tsx"

with open(PATH, encoding="utf-8") as f:
    lines = f.readlines()

# 1-based sanity checks before cutting
assert lines[1860].strip() == "</section>", f"line 1861 unexpected: {lines[1860]!r}"
assert lines[1861].strip() == ") : (", f"line 1862 unexpected: {lines[1861]!r}"
assert lines[1940].strip() == "</section>", f"line 1941 unexpected: {lines[1940]!r}"
assert lines[1941].strip() == ") : (", f"line 1942 unexpected: {lines[1941]!r}"

out = lines[:1861] + lines[1941:]
with open(PATH, "w", encoding="utf-8") as f:
    f.writelines(out)
print(f"Removed lines 1862..1941 ({1941 - 1862 + 1} lines). File now {len(out)} lines.")
