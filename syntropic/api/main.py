"""Compatibility entry point for the Syntropic API."""

import importlib
from pathlib import Path
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

_implementation = importlib.import_module("syntropic.core.matching.api.main")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("syntropic.api.main:app", host="127.0.0.1", port=8000, reload=True)
else:
    sys.modules[__name__] = _implementation