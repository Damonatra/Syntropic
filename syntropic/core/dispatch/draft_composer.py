"""Deterministic quote-draft renderer: approved RFQ -> Outlook draft payload.

Pure module: no I/O, no dependencies beyond the standard library, fully
golden-testable. Every dynamic string is HTML-escaped — RFQ extraction
output is untrusted input and must never reach Outlook as markup.

The draft is composed from the frozen approved payload persisted in the
``dispatch_outbox`` row (``approved_draft_payload`` in the API database
module), so what the estimator later sees in their Drafts folder is
byte-identical to what was approved, with margin-defense results applied:

- Unit prices come from the effective (post-Margin-Defender) values —
  ``price_deltas[i]["pushed_price"]`` when present, else the line item's
  ``unit_price`` (which ``apply_margin_decisions`` already repriced).
- Lines where the pushed price differs from the quoted price carry an
  explicit "repriced to margin floor" annotation, so the estimator sees
  every automated defense action before sending the quote to the customer.
"""

from __future__ import annotations

import html
from typing import Any

# Recipient sourcing order at enqueue time (first hit wins).
RECIPIENT_KEYS = (
    "customer_email",
    "contact_email",
    "recipient_email",
    "customer_contact_email",
)

DEFAULT_PAYMENT_TERMS = "NET 30"
PRICING_VALIDITY_DAYS = 30

_REPRICED_NOTE = (
    "Unit price repriced automatically to the catalog margin floor "
    "(margin defense policy). Original quoted price: {quoted}."
)


class DraftCompositionError(ValueError):
    """Raised when a valid customer draft cannot be composed.

    Carries a machine-readable ``reason`` used by the dispatch worker for
    Backbone escalation (e.g. ``missing_recipient``).
    """

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def extract_recipient_email(*sources: dict[str, Any] | None) -> str | None:
    """Return the first usable customer email address from ``sources``.

    A usable address is non-empty, contains exactly one ``@`` and a dotted
    domain. Returns ``None`` when no source carries one (the caller routes
    the job to the Backbone instead of silently dropping it).
    """
    for source in sources:
        if not isinstance(source, dict):
            continue
        for key in RECIPIENT_KEYS:
            value = source.get(key)
            if not isinstance(value, str):
                continue
            candidate = value.strip()
            local, _, domain = candidate.partition("@")
            if local and domain and "." in domain and candidate.count("@") == 1:
                return candidate
    return None


def _money(amount: float) -> str:
    return f"${amount:,.2f}"


def _delta_for(index: int, payload: dict[str, Any]) -> dict[str, Any] | None:
    """Price-delta telemetry record for line ``index`` (``line_index`` key)."""
    for delta in payload.get("price_deltas") or []:
        if isinstance(delta, dict) and delta.get("line_index") == index:
            return delta
    return None


def _effective_price(index: int, line_item: dict[str, Any], payload: dict[str, Any]) -> float:
    """Effective post-margin-defense unit price for line ``index``."""
    delta = _delta_for(index, payload)
    if delta is not None and delta.get("pushed_price") is not None:
        try:
            return float(delta["pushed_price"])
        except (TypeError, ValueError):
            pass
    try:
        return float(line_item.get("unit_price", 0.0) or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _line_rows(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], float]:
    rows: list[dict[str, Any]] = []
    total = 0.0
    line_items = payload.get("line_items") or []
    for index, item in enumerate(line_items):
        if not isinstance(item, dict):
            continue
        try:
            quantity = float(item.get("quantity", 1) or 1)
        except (TypeError, ValueError):
            quantity = 1.0
        unit_price = _effective_price(index, item, payload)
        extended = round(quantity * unit_price, 2)
        total += extended
        delta = _delta_for(index, payload)
        quoted = None
        if delta is not None and delta.get("quoted_price") is not None:
            try:
                quoted = float(delta["quoted_price"])
            except (TypeError, ValueError):
                quoted = None
        repriced = bool(delta.get("repriced", False)) if delta else False
        if not repriced and quoted is not None:
            repriced = abs(quoted - unit_price) > 0.005
        rows.append(
            {
                "part_number": str(item.get("part_number", "")),
                "description": str(item.get("description", "")),
                "quantity": quantity,
                "unit_of_measure": str(item.get("unit_of_measure", "EA")),
                "unit_price": unit_price,
                "extended": extended,
                "repriced": repriced,
                "quoted_price": quoted,
            }
        )
    return rows, round(total, 2)


def compose_quote_draft(payload: dict[str, Any]) -> dict[str, Any]:
    """Compose the Outlook draft (subject / HTML / recipients) for a job.

    Raises :class:`DraftCompositionError` with ``reason="missing_recipient"``
    when no usable customer address exists — the dispatch worker escalates
    that to the Backbone immediately.
    """
    recipient = payload.get("recipient_email")
    if not isinstance(recipient, str) or not recipient.strip():
        raise DraftCompositionError(
            "missing_recipient",
            "Approved RFQ carries no customer recipient address; routing to "
            "the Backbone for manual resolution.",
        )
    recipient = recipient.strip()

    job_id = str(payload.get("job_id", ""))
    filename = str(payload.get("filename", ""))
    subject = f"Quote: {filename} [Job {job_id[:8]}]"

    rows, total = _line_rows(payload)
    terms = str(payload.get("payment_terms") or DEFAULT_PAYMENT_TERMS)
    ingested_at = str(payload.get("quote_ingested_at") or "n/a")

    escaped_rows: list[str] = []
    for row in rows:
        reprice_note = ""
        if row["repriced"]:
            reprice_note = (
                "<div class=\"note\">"
                + html.escape(
                    _REPRICED_NOTE.format(quoted=_money(row["quoted_price"]))
                )
                + "</div>"
            )
        escaped_rows.append(
            "<tr>"
            f"<td>{html.escape(row['part_number'])}</td>"
            f"<td>{html.escape(row['description'])}{reprice_note}</td>"
            f"<td class=\"num\">{row['quantity']:g}</td>"
            f"<td>{html.escape(row['unit_of_measure'])}</td>"
            f"<td class=\"num\">{_money(row['unit_price'])}</td>"
            f"<td class=\"num\">{_money(row['extended'])}</td>"
            "</tr>"
        )

    repriced_count = sum(1 for row in rows if row["repriced"])
    margin_block = (
        f"<p><strong>Margin defense:</strong> {len(rows)} line item(s) verified "
        f"against catalog cost/floor policy; {repriced_count} repriced to floor.</p>"
        if rows
        else "<p><strong>Margin defense:</strong> no line items to verify.</p>"
    )

    body = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>{html.escape(subject)}</title></head>
<body>
<h2>Quotation</h2>
<p>Reference: {html.escape(filename)} &mdash; Job {html.escape(job_id)}<br>
Ingested: {html.escape(ingested_at)}</p>
<table border="1" cellspacing="0" cellpadding="6">
<thead>
<tr><th>Part Number</th><th>Description</th><th>Qty</th><th>UOM</th>
<th>Unit Price</th><th>Extended</th></tr>
</thead>
<tbody>
{"".join(escaped_rows)}
</tbody>
<tfoot>
<tr><td colspan="5"><strong>Total</strong></td>
<td class="num"><strong>{_money(total)}</strong></td></tr>
</tfoot>
</table>
{margin_block}
<p><strong>Terms:</strong> Payment {html.escape(terms)}. Pricing valid for
{PRICING_VALIDITY_DAYS} days from send date. Prices exclude taxes and freight.</p>
<p style="color:#555;font-size:0.9em">This draft was generated by Syntropic
margin automation and placed in your Drafts folder for review. Nothing is
sent until you personally click Send.</p>
</body>
</html>"""

    return {
        "subject": subject,
        "html": body,
        "to_recipients": [{"emailAddress": {"address": recipient}}],
        "recipient_email": recipient,
        "line_count": len(rows),
        "total_value": total,
    }
