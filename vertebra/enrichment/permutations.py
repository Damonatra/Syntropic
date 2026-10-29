"""Deterministic executive email permutations with syntax hygiene.

Given a contact's name and a company domain, the permutator produces a ranked
set of RFC-5322-clean candidate addresses using the address schemes that
dominate North American industrial distribution (``first.last@``,
``f.last@``, …). Ranking favours patterns observed most frequently in the
vertical, and every candidate is hygiene-checked before any SMTP probe is
spent on it.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from vertebra.logging_conf import get_logger
from vertebra.models.domain import Contact, EmailCandidate

log = get_logger("enrichment.permutations")

# --------------------------------------------------------------------------- #
# Name normalisation
# --------------------------------------------------------------------------- #

_APOSTROPHE_RE = re.compile(r"[’‘`´]")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s-]")


@dataclass(slots=True)
class NormalisedName:
    """Name split into components safe for email local-part construction."""

    first: str
    last: str
    first_initial: str
    last_initial: str
    middle_initials: str = ""


def normalise_name(first: str, last: str, *middles: str) -> NormalisedName:
    """ASCII-fold, strip punctuation and split a person's name for permutations."""
    def fold(value: str) -> str:
        value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
        value = _APOSTROPHE_RE.sub("", value)          # o'brien -> obrien
        value = _NON_ALNUM_RE.sub(" ", value.lower())   # keep hyphens as spaces
        return re.sub(r"\s+", " ", value).strip()

    first_clean = fold(first).split(" ")[0] if fold(first) else ""
    last_clean = fold(last).replace(" ", "") if fold(last) else ""
    mid_clean = " ".join(fold(m) for m in middles if fold(m))
    middle_initials = "".join(part[0] for part in mid_clean.split() if part)
    if not first_clean or not last_clean:
        raise ValueError("both first and last name are required for permutation")
    return NormalisedName(
        first=first_clean,
        last=last_clean,
        first_initial=first_clean[0],
        last_initial=last_clean[0],
        middle_initials=middle_initials,
    )


# --------------------------------------------------------------------------- #
# Permutation patterns
# --------------------------------------------------------------------------- #

#: Ordered by observed prevalence in US/CA industrial distribution; the order
#: is the probe priority so expensive SMTP verification is spent top-down.
PATTERNS: tuple[tuple[str, str], ...] = (
    ("first.last", "{first}.{last}"),
    ("flast", "{f}{last}"),
    ("first_last", "{first}_{last}"),
    ("firstlast", "{first}{last}"),
    ("f.last", "{f}.{last}"),
    ("first", "{first}"),
    ("firstl", "{first}{l}"),
    ("last", "{last}"),
    ("lastfirst", "{last}{first}"),
    ("last.first", "{last}.{first}"),
    ("lfirst", "{l}{first}"),
    ("first.mi.last", "{first}.{mi}.{last}"),
    ("firstmlast", "{first}{mi}{last}"),
)


def build_local_parts(name: NormalisedName) -> list[tuple[str, str]]:
    """Return ``(pattern, local_part)`` pairs, deduplicated, priority ordered."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for pattern, template in PATTERNS:
        local = template.format(
            first=name.first,
            last=name.last,
            f=name.first_initial,
            l=name.last_initial,
            mi=name.middle_initials or name.first_initial,
        )
        local = local.strip(".")
        if not local or local in seen:
            continue
        seen.add(local)
        out.append((pattern, local))
    return out


# --------------------------------------------------------------------------- #
# Syntax hygiene (RFC 5322 / 5321 practical rules)
# --------------------------------------------------------------------------- #

_LOCAL_RE = re.compile(
    r"^(?!^[.])[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}(?<!\.)$"
)
_DOMAIN_RE = re.compile(
    r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
)


def syntax_hygiene(local_part: str, domain: str) -> tuple[bool, str | None]:
    """Validate a local part + domain pair. Returns ``(ok, reason)``."""
    if not local_part or len(local_part) > 64:
        return False, "local_part_length"
    if local_part.startswith(".") or local_part.endswith(".") or ".." in local_part:
        return False, "dot_placement"
    if not _LOCAL_RE.match(local_part):
        return False, "local_part_charset"
    if not _DOMAIN_RE.match(domain):
        return False, "domain_format"
    if len(local_part) + len(domain) + 1 > 254:
        return False, "address_length"
    return True, None


# --------------------------------------------------------------------------- #
# Permutator
# --------------------------------------------------------------------------- #


class EmailPermutator:
    """Generates hygiene-checked :class:`EmailCandidate` sets for contacts."""

    def __init__(self, max_candidates: int = 6) -> None:
        if max_candidates < 1:
            raise ValueError("max_candidates must be >= 1")
        self._max = max_candidates

    def generate(
        self,
        contact: Contact,
        domain: str,
        *,
        casl_scope: bool = False,
        known_pattern: str | None = None,
    ) -> list[EmailCandidate]:
        """Produce candidates for one contact/domain pair.

        ``known_pattern`` (from a previously verified mailbox at the same
        domain) is promoted to the front so verification spends probes on the
        highest-probability address first.
        """
        domain = domain.strip().lower().lstrip("@")
        name = normalise_name(contact.first_name, contact.last_name)
        candidates: list[EmailCandidate] = []
        pairs = build_local_parts(name)

        if known_pattern:
            pairs.sort(key=lambda p: p[0] != known_pattern)

        for pattern, local in pairs[: self._max]:
            ok, _reason = syntax_hygiene(local, domain)
            candidates.append(
                EmailCandidate(
                    contact_id=contact.id,
                    address=f"{local}@{domain}",
                    pattern=pattern,
                    domain=domain,
                    is_casl_scope=casl_scope,
                    syntax_valid=ok,
                )
            )
        log.debug(
            "permutations_generated",
            contact=f"{contact.first_name} {contact.last_name}",
            domain=domain,
            count=len(candidates),
            known_pattern=known_pattern,
        )
        return candidates

    def generate_for_domain(
        self,
        contacts: list[Contact],
        domain: str,
        *,
        casl_scope: bool = False,
    ) -> list[EmailCandidate]:
        """Generate the union of candidates across a company's contacts."""
        seen: set[str] = set()
        merged: list[EmailCandidate] = []
        for contact in contacts:
            for candidate in self.generate(contact, domain, casl_scope=casl_scope):
                if candidate.address not in seen:
                    seen.add(candidate.address)
                    merged.append(candidate)
        return merged
