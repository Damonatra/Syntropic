"""Canadian CASL (Anti-Spam Legislation) compliance machinery.

Any prospect resolved to a Canadian jurisdiction (``.ca`` domain, Canadian
province/postal code, or explicit Canadian HQ) is flagged as CASL-scope.
Channel A sends to those prospects are forced to carry:

- an identification footer naming the sender with physical contact details,
- ``List-Unsubscribe`` / ``List-Unsubscribe-Post`` headers implementing
  RFC 8058 one-click unsubscribe.

CASL permits CEMs (commercial electronic messages) under implied consent for
existing business relationships and conspicuous contact identification, but
the engine treats *any* Canadian dispatch as CASL-scope and always attaches
the compliance kit — the conservative posture is the correct one for Q4.
"""

from __future__ import annotations

import hashlib
import hmac
from urllib.parse import quote_plus

from vertebra.config.settings import CaslSettings, get_settings
from vertebra.ingestion.normalizer import is_canadian_domain
from vertebra.models.domain import Region

#: Provinces that unambiguously place a prospect in CASL jurisdiction.
CA_REGION_HINTS: frozenset[str] = frozenset(
    {"alberta", "british columbia", "manitoba", "new brunswick", "newfoundland", "nova scotia",
     "ontario", "prince edward island", "quebec", "saskatchewan", "yukon", "nunavut",
     "northwest territories"}
)


def evaluate_casl_scope(
    *,
    domain: str | None,
    region: Region | None,
    state_province: str | None = None,
    country: str | None = None,
) -> tuple[bool, str | None]:
    """Decide whether a prospect is under CASL. Returns ``(scope, reason)``."""
    if is_canadian_domain(domain):
        return True, "ca_domain"
    if country and country.strip().lower() in {"canada", "ca", "can"}:
        return True, "ca_country"
    if region is Region.CA:
        return True, "ca_region"
    prov = (state_province or "").strip().lower()
    if prov and prov in CA_REGION_HINTS:
        return True, "ca_province"
    return False, None


def unsubscribe_url(prospect_id: str, address: str, *, settings: CaslSettings | None = None) -> str:
    """Build a signed single-click unsubscribe URL (RFC 8058 target)."""
    settings = settings or get_settings().casl
    token = hmac.new(
        settings.unsubscribe_base_url.encode(), f"{prospect_id}:{address}".encode(), hashlib.sha256
    ).hexdigest()[:32]
    return f"{settings.unsubscribe_base_url}?p={quote_plus(prospect_id)}&a={quote_plus(address)}&t={token}"


def build_casl_footer(
    *,
    prospect_id: str,
    address: str,
    region: Region | None,
    settings: CaslSettings | None = None,
) -> str:
    """Return the compliance footer for the prospect's jurisdiction."""
    settings = settings or get_settings().casl
    link = unsubscribe_url(prospect_id, address, settings=settings)
    template = settings.default_footer_ca if region is Region.CA else settings.default_footer_us
    return template.format(unsubscribe_url=link)


def build_email_headers(
    *,
    prospect_id: str,
    address: str,
    casl_scope: bool,
    settings: CaslSettings | None = None,
) -> dict[str, str]:
    """Compose the mandatory compliance headers for an outbound send.

    ``List-Unsubscribe-Post: List-Unsubscribe=One-Click`` (RFC 8058) powers the
    mailbox-provider single-click unsubscribe button required by CASL policy.
    """
    settings = settings or get_settings().casl
    link = unsubscribe_url(prospect_id, address, settings=settings)
    headers: dict[str, str] = {
        "List-Unsubscribe": f"<{link}>",
    }
    if casl_scope:
        # RFC 8058 one-click POST is mandatory for CASL-scope sends; other
        # regions keep the GET link only.
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    return headers
