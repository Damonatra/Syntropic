# syntropic/core/stream/__init__.py
"""Taelin Memory Stream (Layer 4): append-only tenant JSONL audit engine.

Public surface:
* :class:`TaelinStream` — emit / tail / range / verify / stats.
* :func:`get_stream` / :func:`reset_stream` — process-wide default instance.
* :func:`emit_event` — fault-isolated helper for pipeline hooks.
* :mod:`finetune_export` — nightly QLoRA export (PII-safe by allowlist).
"""

from syntropic.core.stream.taelin import (
    TaelinStream,
    TenantError,
    emit_event,
    get_stream,
    reset_stream,
)

__all__ = [
    "TaelinStream",
    "TenantError",
    "emit_event",
    "get_stream",
    "reset_stream",
]
