# syntropic/core/stream/taelin.py
"""Taelin Memory Stream — append-only, tenant-partitioned, tamper-evident JSONL.

Layer 4 engine substrate. Every processed RFQ, OCR extraction, margin
adjustment (delta-margin) and draft injection is appended as one structured,
timestamped JSON line to ``{STREAM_ROOT}/{tenant_id}/stream.log``.

Design invariants (enterprise audit posture):

* **Append-only.** Files are opened in binary-append mode; existing bytes are
  never rewritten or truncated. Rotation renames the active file; it never
  mutates history.
* **Tamper-evident.** Each event carries ``prev`` (hash of the previous
  event, genesis = 64 zeros) and ``hash`` (SHA-256 over the canonical event
  tuple). Any deletion or mutation inside a file breaks the chain and is
  reported by :meth:`TaelinStream.verify`.
* **Tenant-partitioned.** One directory per tenant; tenant identifiers are
  strictly validated so the stream root can never be escaped.
* **Local-only.** The stream lives inside the deployment boundary — unlike
  the opt-in LangSmith tracing, no tenant data leaves the host.

Recall contract: tail and range queries for active tenant sessions must
complete in <= 30 ms at enterprise scale. Tail reads seek backwards from the
end-of-file; range queries use a sparse (every 64th event) byte-offset index
built lazily per tenant and kept warm in memory for the life of the process.

Concurrency model: a per-tenant re-entrant lock serialises emit + index
access. The deployment runs a single API worker process (uvicorn workers=1
with the dispatch worker as an in-process asyncio task), which is the
supported topology for this component.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

from syntropic.core.config import settings

logger = logging.getLogger(__name__)

TENANT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
ACTIVE_NAME = "stream.log"
ROTATE_SUFFIX = "stream.log.{}"
GENESIS_HASH = "0" * 64
INDEX_STRIDE = 64
MAX_RANGE_RESULTS = 10_000
TAIL_WINDOW_BYTES = 262_144

_ROTATE_NUMBER = re.compile(r"^stream\.log\.(\d+)$")


class TenantError(ValueError):
    """Raised when a tenant identifier is malformed or unsafe."""


def _canonical_json(payload: Dict[str, Any]) -> str:
    """Deterministic serialisation — the hash anchor for tamper evidence."""
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _event_hash(seq: int, ts: str, event: str, prev: str, canonical: str) -> str:
    material = "\x1f".join((str(seq), ts, event, prev, canonical))
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _parse_line(raw: bytes) -> Dict[str, Any] | None:
    """Parse one JSONL record; returns None for blank/corrupt fragments."""
    stripped = raw.strip()
    if not stripped:
        return None
    try:
        record = json.loads(stripped.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(record, dict) or "seq" not in record:
        return None
    return record


class _TenantState:
    """In-memory index for one tenant partition."""

    __slots__ = (
        "files",
        "sparse",
        "last_seq",
        "last_hash",
        "rot",
        "indexed",
        "handle",
    )

    def __init__(self) -> None:
        # files: ascending age order — rotated (oldest first) then active.
        self.files: List[Dict[str, Any]] = []
        # sparse: seq -> (file_idx, byte_offset of that line's start)
        self.sparse: Dict[int, Tuple[int, int]] = {}
        self.last_seq = 0
        self.last_hash = GENESIS_HASH
        self.rot = 0
        self.indexed = False
        # Persistent append handle — reopening per emit costs 2 extra
        # syscalls per event, which dominates on network filesystems.
        self.handle = None


class TaelinStream:
    """Append-only per-tenant JSONL event stream with hash-chain integrity."""

    def __init__(
        self,
        root: str | Path,
        rotate_mb: float = 64.0,
        fsync: bool = False,
        now_fn: Callable[[], float] | None = None,
    ) -> None:
        self._root = Path(root)
        self._rotate_bytes = max(int(float(rotate_mb) * 1024 * 1024), 1)
        self._fsync = fsync
        self._now_fn = now_fn or (lambda: time.time())
        self._lock = threading.RLock()
        self._tenants: Dict[str, _TenantState] = {}

    # ------------------------------------------------------------------
    # Tenant safety
    # ------------------------------------------------------------------

    @staticmethod
    def validate_tenant(tenant_id: str) -> str:
        if not isinstance(tenant_id, str) or not TENANT_PATTERN.match(tenant_id):
            raise TenantError(
                f"Unsafe tenant identifier for the memory stream: {tenant_id!r}"
            )
        return tenant_id

    def _tenant_dir(self, tenant_id: str) -> Path:
        return self._root / self.validate_tenant(tenant_id)

    # ------------------------------------------------------------------
    # Index construction (lazy, once per tenant per process)
    # ------------------------------------------------------------------

    def _discover_files(self, directory: Path) -> List[Path]:
        if not directory.is_dir():
            return []
        numbered: List[Tuple[int, Path]] = []
        for entry in directory.iterdir():
            match = _ROTATE_NUMBER.match(entry.name)
            if match and entry.is_file():
                numbered.append((int(match.group(1)), entry))
        numbered.sort()
        paths = [path for _, path in numbered]
        active = directory / ACTIVE_NAME
        if active.exists():
            paths.append(active)
        return paths

    def _ensure_index(self, tenant_id: str) -> _TenantState:
        state = self._tenants.get(tenant_id)
        if state is not None and state.indexed:
            return state
        state = _TenantState()
        directory = self._tenant_dir(tenant_id)
        paths = self._discover_files(directory)
        for file_idx, path in enumerate(paths):
            meta: Dict[str, Any] = {
                "path": path,
                "size": path.stat().st_size,
                "seq_min": None,
                "seq_max": None,
            }
            offset = 0
            with path.open("rb") as handle:
                for raw in handle:
                    line_len = len(raw)
                    record = _parse_line(raw)
                    offset += line_len
                    if record is None:
                        continue
                    seq = int(record["seq"])
                    if meta["seq_min"] is None:
                        meta["seq_min"] = seq
                    meta["seq_max"] = seq
                    state.last_seq = seq
                    state.last_hash = str(record.get("hash", state.last_hash))
                    if seq % INDEX_STRIDE == 0:
                        line_start = offset - line_len
                        state.sparse[seq] = (file_idx, line_start)
            if meta["seq_min"] is None:
                meta["seq_min"] = 0
                meta["seq_max"] = 0
            state.files.append(meta)
            if path.name != ACTIVE_NAME:
                match = _ROTATE_NUMBER.match(path.name)
                if match:
                    state.rot = max(state.rot, int(match.group(1)) + 1)
        state.indexed = True
        self._tenants[tenant_id] = state
        return state

    # ------------------------------------------------------------------
    # Write path
    # ------------------------------------------------------------------

    def emit(
        self,
        tenant_id: str,
        event: str,
        payload: Dict[str, Any],
        job_id: str | None = None,
    ) -> Dict[str, Any]:
        """Append one event. Returns the persisted record."""
        tenant_id = self.validate_tenant(tenant_id)
        with self._lock:
            state = self._ensure_index(tenant_id)
            directory = self._root / tenant_id

            seq = state.last_seq + 1
            now = self._now_fn()
            ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % (
                int((now % 1) * 1000)
            )
            canonical = _canonical_json(payload)
            digest = _event_hash(seq, ts, event, state.last_hash, canonical)
            record = {
                "seq": seq,
                "ts": ts,
                "event": event,
                "job_id": job_id,
                "prev": state.last_hash,
                "hash": digest,
                "payload": payload,
            }
            line = json.dumps(record, separators=(",", ":"), default=str)

            active_path = directory / ACTIVE_NAME
            if state.handle is None:
                directory.mkdir(parents=True, exist_ok=True)
                state.handle = active_path.open("ab")
            state.handle.write((line + "\n").encode("utf-8"))
            state.handle.flush()
            if self._fsync:
                import os

                os.fsync(state.handle.fileno())

            state.last_seq = seq
            state.last_hash = digest
            if state.files and state.files[-1]["path"] == active_path:
                meta = state.files[-1]
                meta["size"] += len(line) + 1
                meta["seq_max"] = seq
            else:  # active file appeared after restart with rotated history
                meta = {
                    "path": active_path,
                    "size": len(line) + 1,
                    "seq_min": seq,
                    "seq_max": seq,
                }
                state.files.append(meta)
            if seq % INDEX_STRIDE == 0:
                # Anchor points at THIS line's start inside the file it was
                # written to; rotation below renames but the offset holds.
                state.sparse[seq] = (
                    len(state.files) - 1,
                    meta["size"] - (len(line) + 1),
                )

            if meta["size"] >= self._rotate_bytes:
                # Rename, re-point the meta at the archived path, and leave
                # a fresh empty active segment behind. History is never
                # mutated — rotation is a rename, nothing more.
                if state.handle is not None:
                    state.handle.close()
                    state.handle = None
                rotated_name = ROTATE_SUFFIX.format(f"{state.rot:06d}")
                active_path.rename(directory / rotated_name)
                meta["path"] = directory / rotated_name
                state.rot += 1
                (directory / ACTIVE_NAME).touch()
                logger.debug(
                    "Taelin stream rotated for tenant %s -> %s",
                    tenant_id,
                    rotated_name,
                )
            return record

    # ------------------------------------------------------------------
    # Read paths — the <=30ms recall contract
    # ------------------------------------------------------------------

    def tail(self, tenant_id: str, last_n: int = 50) -> List[Dict[str, Any]]:
        """Most recent ``last_n`` events, ascending sequence order."""
        tenant_id = self.validate_tenant(tenant_id)
        with self._lock:
            state = self._ensure_index(tenant_id)
            collected: List[bytes] = []
            for meta in reversed(state.files):
                path: Path = meta["path"]
                size = path.stat().st_size
                if size == 0:
                    continue
                start = max(0, size - TAIL_WINDOW_BYTES)
                with path.open("rb") as handle:
                    handle.seek(start)
                    chunk = handle.read()
                if start > 0:
                    newline = chunk.find(b"\n")
                    if newline != -1:
                        chunk = chunk[newline + 1 :]
                collected.extend([raw for raw in chunk.splitlines() if raw.strip()])
                if len(collected) >= last_n:
                    break
            records = [
                parsed
                for parsed in (_parse_line(raw) for raw in collected)
                if parsed is not None
            ]
            # Chunks were collected newest-file-first while lines inside a
            # chunk ascend; sorting on seq makes the selection correct for
            # any file layout, then the newest ``last_n`` win.
            records.sort(key=lambda item: item["seq"])
            return records[-last_n:] if last_n < len(records) else records

    def range(
        self,
        tenant_id: str,
        from_seq: int = 1,
        to_seq: int | None = None,
        event: str | None = None,
    ) -> List[Dict[str, Any]]:
        """Events in ``[from_seq, to_seq]`` (optionally one event type)."""
        tenant_id = self.validate_tenant(tenant_id)
        with self._lock:
            state = self._ensure_index(tenant_id)
            results: List[Dict[str, Any]] = []
            if not state.files:
                return results

            anchors = sorted(state.sparse)
            start_seq = from_seq if from_seq > 0 else 1
            anchor_seq = 0
            for candidate in anchors:
                if candidate < start_seq:
                    anchor_seq = candidate
                else:
                    break
            if anchor_seq:
                file_idx, offset = state.sparse[anchor_seq]
            else:
                file_idx, offset = 0, 0

            for meta in state.files[file_idx:]:
                path: Path = meta["path"]
                with path.open("rb") as handle:
                    handle.seek(offset)
                    offset = 0  # only the first file starts at the anchor
                    for raw in handle:
                        record = _parse_line(raw)
                        if record is None:
                            continue
                        seq = int(record["seq"])
                        if seq < start_seq:
                            continue
                        if to_seq is not None and seq > to_seq:
                            return results
                        if event is None or record.get("event") == event:
                            results.append(record)
                            if len(results) >= MAX_RANGE_RESULTS:
                                return results
            return results

    # ------------------------------------------------------------------
    # Integrity
    # ------------------------------------------------------------------

    def verify(self, tenant_id: str) -> Dict[str, Any]:
        """Walk the full chain; report any seq gap, broken link or hash miss.

        The first existing record's ``prev`` is trusted as the chain anchor
        (older rotated segments may have been archived under a retention
        policy); continuity is enforced for every record after it.
        """
        tenant_id = self.validate_tenant(tenant_id)
        with self._lock:
            state = self._ensure_index(tenant_id)
            events = 0
            expected_seq: int | None = None
            prev: str | None = None
            for meta in state.files:
                path: Path = meta["path"]
                with path.open("rb") as handle:
                    for raw in handle:
                        record = _parse_line(raw)
                        if record is None:
                            continue
                        seq = int(record["seq"])
                        if expected_seq is None:
                            expected_seq = seq
                            prev = str(record.get("prev", GENESIS_HASH))
                        if seq != expected_seq:
                            return {
                                "events": events,
                                "ok": False,
                                "first_bad_seq": seq,
                                "reason": f"sequence gap: expected {expected_seq}",
                            }
                        if str(record.get("prev", "")) != prev:
                            return {
                                "events": events,
                                "ok": False,
                                "first_bad_seq": seq,
                                "reason": "broken prev-hash linkage",
                            }
                        canonical = _canonical_json(record.get("payload", {}))
                        digest = _event_hash(
                            seq,
                            str(record.get("ts", "")),
                            str(record.get("event", "")),
                            prev,
                            canonical,
                        )
                        if digest != record.get("hash"):
                            return {
                                "events": events,
                                "ok": False,
                                "first_bad_seq": seq,
                                "reason": "hash mismatch (content mutated)",
                            }
                        prev = str(record.get("hash", ""))
                        expected_seq = seq + 1
                        events += 1
            return {
                "events": events,
                "ok": True,
                "first_bad_seq": None,
                "reason": None,
            }

    def stats(self, tenant_id: str) -> Dict[str, Any]:
        tenant_id = self.validate_tenant(tenant_id)
        with self._lock:
            state = self._ensure_index(tenant_id)
            return {
                "events": state.last_seq,
                "files": len(state.files),
                "bytes": sum(meta["size"] for meta in state.files),
                "indexed_anchors": len(state.sparse),
            }


# ----------------------------------------------------------------------
# Process-wide default stream + fault-isolated emit helper
# ----------------------------------------------------------------------

_default_stream: TaelinStream | None = None


def get_stream() -> TaelinStream | None:
    """Process-wide stream built from settings; None when disabled."""
    global _default_stream
    if not getattr(settings, "STREAM_ENABLED", True):
        return None
    if _default_stream is None:
        _default_stream = TaelinStream(
            root=settings.STREAM_ROOT,
            rotate_mb=getattr(settings, "STREAM_ROTATE_MB", 64),
            fsync=getattr(settings, "STREAM_FSYNC", False),
        )
    return _default_stream


def reset_stream() -> None:
    """Test seam: drop the cached default stream."""
    global _default_stream
    _default_stream = None


def emit_event(
    event: str,
    tenant_id: str | None,
    payload: Dict[str, Any],
    job_id: str | None = None,
) -> Dict[str, Any] | None:
    """Fault-isolated emit for pipeline hooks.

    The stream is an audit surface, not a dependency: any failure (disabled,
    missing tenant, I/O error) is logged and swallowed so the RFQ pipeline
    and dispatch worker can never break because of it.
    """
    if not tenant_id:
        return None
    stream = get_stream()
    if stream is None:
        return None
    try:
        return stream.emit(tenant_id, event, payload, job_id=job_id)
    except Exception as error:  # noqa: BLE001 — audit must never break the pipeline
        logger.warning("Taelin stream emit failed for %s: %s", event, error)
        return None
