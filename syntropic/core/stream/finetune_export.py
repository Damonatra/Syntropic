# syntropic/core/stream/finetune_export.py
"""Nightly QLoRA fine-tuning export from the Taelin Memory Stream.

Converts tenant stream events into Alpaca-style instruction/input/output
JSONL for nightly QLoRA fine-tuning, under a hard privacy contract:

* **Allowlist, not blocklist.** Only whitelisted fields per event type ever
  reach the export. Any field not explicitly allowed is dropped — new
  pipeline fields cannot leak into training data by accident.
* **No raw supplier cost files.** Cost, floor and supplier fields are not in
  any allowlist; only downstream margin *deltas* (the training signal) pass.
* **No PII.** Recipient/customer/contact fields are dropped by the
  allowlist; free-text is scrubbed by regex (emails -> ``EMAIL_<sha8>``).
* **Validated before use.** :func:`validate_export` re-opens the produced
  file and rejects it if any forbidden key or email pattern appears
  anywhere, so a nightly job can gate itself.

CLI: ``python -m syntropic.core.stream.finetune_export --tenant alpha \
--stream-root data/streams --out datasets/qlora-nightly.jsonl``
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List

from syntropic.core.stream.taelin import TaelinStream

# ---------------------------------------------------------------------------
# Privacy contract
# ---------------------------------------------------------------------------

# Field names that must NEVER appear anywhere in an export file.
FORBIDDEN_KEYS = frozenset(
    {
        "email",
        "emails",
        "recipient",
        "recipient_email",
        "customer",
        "customer_name",
        "contact",
        "contact_email",
        "mailbox",
        "unit_cost",
        "cost",
        "costs",
        "supplier",
        "supplier_cost",
        "cost_sheet",
        "cost_sheet_updated",
        "price_floor",
        "raw_input",
        "raw_text",
        "text",
        "body",
        "html",
        "document_layout",
        "provenance",
    }
)

EMAIL_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

# Allowlist: the ONLY fields the export may carry, per event type.
ALLOWED_FIELDS: Dict[str, frozenset] = {
    "rfq_ingested": frozenset({"size_bytes", "sha256_16", "filename_ext"}),
    "ocr_extracted": frozenset({"text_chars", "tables", "text_blocks"}),
    "margin_adjusted": frozenset(
        {
            "decision",
            "line_count",
            "repriced_count",
            "veto_count",
            "margin_delta",
            "sku_ids",
        }
    ),
    "draft_injected": frozenset({"sla_ms", "sla_breached", "line_count"}),
}

INSTRUCTIONS: Dict[str, str] = {
    "rfq_ingested": (
        "Profile this industrial RFQ intake from its document metrics."
    ),
    "ocr_extracted": (
        "Predict the OCR extraction profile for an industrial RFQ document."
    ),
    "margin_adjusted": (
        "Predict the margin-defender outcome for an industrial RFQ from its "
        "intake profile (line count, SKU mix and observed price delta)."
    ),
    "draft_injected": (
        "Predict whether the Outlook draft dispatch met the 90-second SLA "
        "for an approved quote."
    ),
}


class PrivacyViolation(ValueError):
    """Raised when an export violates the PII / cost-file contract."""


def scrub_text(value: str) -> str:
    """Replace email addresses with irreversible, non-identifying tokens."""
    return EMAIL_PATTERN.sub(
        lambda match: "EMAIL_" + hashlib.sha256(
            match.group(0).lower().encode("utf-8")
        ).hexdigest()[:8],
        value,
    )


def _whiten(event: str, payload: Dict[str, Any]) -> Dict[str, Any] | None:
    """Apply the per-event allowlist; None when nothing may pass."""
    allowed = ALLOWED_FIELDS.get(event)
    if not allowed:
        return None
    kept = {key: value for key, value in payload.items() if key in allowed}
    if not kept:
        return None
    return {
        key: (scrub_text(value) if isinstance(value, str) else value)
        for key, value in kept.items()
    }


def _scrub_tree(node: Any) -> Any:
    """Recursive safety net: scrub any string, drop any forbidden key."""
    if isinstance(node, dict):
        return {
            key: _scrub_tree(value)
            for key, value in node.items()
            if str(key).lower() not in FORBIDDEN_KEYS
        }
    if isinstance(node, list):
        return [_scrub_tree(item) for item in node]
    if isinstance(node, str):
        return scrub_text(node)
    return node


def build_sample(event: str, whitened: Dict[str, Any]) -> Dict[str, Any]:
    """One Alpaca-style instruction/input/output training sample."""
    return {
        "instruction": INSTRUCTIONS[event],
        "input": whitened,
        "output": _sample_output(event, whitened),
    }


def _sample_output(event: str, whitened: Dict[str, Any]) -> Dict[str, Any]:
    if event == "rfq_ingested":
        return {"intake_profile": "documented"}
    if event == "ocr_extracted":
        return {
            "text_chars": whitened.get("text_chars"),
            "tables": whitened.get("tables"),
        }
    if event == "margin_adjusted":
        return {
            "decision": whitened.get("decision"),
            "repriced_count": whitened.get("repriced_count"),
            "veto_count": whitened.get("veto_count"),
        }
    if event == "draft_injected":
        return {
            "sla_breached": bool(whitened.get("sla_breached", False)),
        }
    return {}


def export_qlora(
    stream_root: str | Path,
    tenants: Iterable[str],
    out_path: str | Path,
    limit_per_tenant: int | None = None,
) -> Dict[str, Any]:
    """Export tenant streams to QLoRA training JSONL (validated)."""
    stream = TaelinStream(stream_root)
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    samples = 0
    per_tenant: Dict[str, int] = {}
    with out.open("w", encoding="utf-8") as handle:
        for tenant_id in tenants:
            count = 0
            for record in stream.range(tenant_id, from_seq=1):
                if limit_per_tenant is not None and count >= limit_per_tenant:
                    break
                event = str(record.get("event", ""))
                whitened = _whiten(event, dict(record.get("payload", {})))
                if whitened is None:
                    continue
                sample = _scrub_tree(build_sample(event, whitened))
                handle.write(
                    json.dumps(sample, separators=(",", ":"), default=str) + "\n"
                )
                count += 1
                samples += 1
            per_tenant[tenant_id] = count
    report = validate_export(out)
    if not report["ok"]:
        raise PrivacyViolation(
            "Export failed the privacy validator: "
            + "; ".join(report["violations"][:5])
        )
    return {"samples": samples, "per_tenant": per_tenant, "out": str(out), **report}


# ---------------------------------------------------------------------------
# Validator — the nightly job gates itself with this before any training use
# ---------------------------------------------------------------------------

def _iter_strings(node: Any) -> Iterable[str]:
    if isinstance(node, dict):
        for key, value in node.items():
            yield str(key)
            yield from _iter_strings(value)
    elif isinstance(node, list):
        for item in node:
            yield from _iter_strings(item)
    elif isinstance(node, str):
        yield node


def validate_export(path: str | Path) -> Dict[str, Any]:
    """Re-open an export file and enforce the privacy contract on it."""
    violations: List[str] = []
    lines = 0
    with Path(path).open("r", encoding="utf-8") as handle:
        for line_no, raw in enumerate(handle, start=1):
            stripped = raw.strip()
            if not stripped:
                continue
            try:
                record = json.loads(stripped)
            except json.JSONDecodeError as error:
                violations.append(f"line {line_no}: unparseable JSON ({error})")
                continue
            lines += 1
            for text in _iter_strings(record):
                lowered = text.lower()
                if lowered in FORBIDDEN_KEYS:
                    violations.append(f"line {line_no}: forbidden key '{text}'")
                if "@" in text and EMAIL_PATTERN.search(text):
                    violations.append(f"line {line_no}: email-like PII detected")
    return {"ok": not violations, "lines": lines, "violations": violations[:20]}


# ---------------------------------------------------------------------------
# CLI — the nightly entrypoint
# ---------------------------------------------------------------------------

def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Nightly QLoRA fine-tuning export from Taelin streams "
        "(PII-safe by allowlist, self-validating)."
    )
    parser.add_argument(
        "--stream-root",
        default="data/streams",
        help="Taelin stream root directory (default: data/streams).",
    )
    parser.add_argument(
        "--tenant",
        action="append",
        default=None,
        help="Tenant to export; repeatable. Omit to export all tenant dirs.",
    )
    parser.add_argument(
        "--out",
        default="datasets/qlora-nightly.jsonl",
        help="Output training JSONL path (default: datasets/qlora-nightly.jsonl).",
    )
    parser.add_argument(
        "--limit-per-tenant",
        type=int,
        default=None,
        help="Optional cap on samples per tenant (for smoke runs).",
    )
    parser.add_argument(
        "--validate-only",
        type=str,
        default=None,
        metavar="EXPORT_PATH",
        help="Validate an existing export file and exit.",
    )
    args = parser.parse_args(argv)

    if args.validate_only:
        report = validate_export(args.validate_only)
        print(json.dumps(report, indent=2))
        return 0 if report["ok"] else 1

    root = Path(args.stream_root)
    if args.tenant:
        tenants = list(args.tenant)
    else:
        if not root.is_dir():
            print(f"Stream root not found: {root}", file=sys.stderr)
            return 2
        tenants = sorted(entry.name for entry in root.iterdir() if entry.is_dir())
    if not tenants:
        print("No tenant streams found; nothing to export.", file=sys.stderr)
        return 2

    summary = export_qlora(
        root,
        tenants,
        args.out,
        limit_per_tenant=args.limit_per_tenant,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
