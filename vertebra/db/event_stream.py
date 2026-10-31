"""Victor Taelin style append-only cryptographic event log (stream.log).

Ensures all engagement, score, and dispatch events are written sequentially to an
immutable hash-chained log where each entry contains the SHA-256 hash of the preceding
entry, providing mathematical proof of zero history tampering.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
from typing import Any

from vertebra.models.domain import utcnow


@dataclass(frozen=True, slots=True)
class StreamLogEntry:
    """An immutable, hash-linked log entry in stream.log."""

    index: int
    timestamp: str
    kind: str
    payload: dict[str, Any]
    prev_hash: str
    entry_hash: str


GENESIS_HASH = "0" * 64


class EventStreamLogger:
    """Cryptographic append-only event stream writer."""

    def __init__(self, log_path: str | Path = "stream.log"):
        self.log_path = Path(log_path)
        self._last_index = -1
        self._last_hash = GENESIS_HASH
        self._initialize_from_disk()

    def _initialize_from_disk(self) -> None:
        """Scan existing entries to find head index and hash."""
        if not self.log_path.exists():
            return

        with self.log_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    self._last_index = data["index"]
                    self._last_hash = data["entry_hash"]
                except Exception:
                    continue

    def append(self, kind: str, payload: dict[str, Any]) -> StreamLogEntry:
        """Append an event to the stream log with cryptographic chaining."""
        idx = self._last_index + 1
        now_ts = utcnow().isoformat()
        prev = self._last_hash

        # Canonical JSON string for hashing
        payload_str = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        content_to_hash = f"{idx}:{now_ts}:{kind}:{prev}:{payload_str}"
        entry_hash = hashlib.sha256(content_to_hash.encode("utf-8")).hexdigest()

        entry = StreamLogEntry(
            index=idx,
            timestamp=now_ts,
            kind=kind,
            payload=payload,
            prev_hash=prev,
            entry_hash=entry_hash,
        )

        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(entry)) + "\n")

        self._last_index = idx
        self._last_hash = entry_hash
        return entry

    def verify_integrity(self) -> bool:
        """Verify the cryptographic hash-chain across all entries in the log."""
        if not self.log_path.exists():
            return True

        expected_prev = GENESIS_HASH
        expected_index = 0

        with self.log_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                data = json.loads(line)
                if data["index"] != expected_index:
                    return False
                if data["prev_hash"] != expected_prev:
                    return False

                payload_str = json.dumps(data["payload"], sort_keys=True, separators=(",", ":"))
                expected_content = f"{data['index']}:{data['timestamp']}:{data['kind']}:{expected_prev}:{payload_str}"
                recomputed_hash = hashlib.sha256(expected_content.encode("utf-8")).hexdigest()

                if recomputed_hash != data["entry_hash"]:
                    return False

                expected_prev = data["entry_hash"]
                expected_index += 1

        return True
