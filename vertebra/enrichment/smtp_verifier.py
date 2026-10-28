"""Real-time SMTP handshake verification.

The verifier performs the same dialogue a mail server would: MX resolution,
TCP connect to the highest-priority MX, ``EHLO`` → ``MAIL FROM`` →
``RCPT TO`` → ``QUIT``, and interprets the reply codes. A random-token probe
against the same domain distinguishes catch-all receivers, so accepting
servers are classified as *neutral* instead of falsely verified. Greylisting
(4xx) is reported as temporary and retried by the worker on a later cycle.

Connection plumbing uses raw asyncio streams for precise control and no
dependency on smtplib's blocking socket behaviour.
"""

from __future__ import annotations

import asyncio
import random
import string
from dataclasses import dataclass

from vertebra.config.settings import get_settings
from vertebra.enrichment.permutations import syntax_hygiene
from vertebra.logging_conf import get_logger
from vertebra.models.domain import SmtpVerification

log = get_logger("enrichment.smtp_verifier")

# RCPT reply-code buckets.
_DELIVER_CODES = {250, 251}
_REJECT_CODES = {550, 551, 553, 554}
_TEMP_CODES = {450, 451, 452, 421, 453}


@dataclass(slots=True)
class _MxHost:
    host: str
    preference: int


class SMTPVerifier:
    """Async SMTP RCPT-TO prober with catch-all discrimination."""

    def __init__(
        self,
        *,
        helo_domain: str | None = None,
        mail_from: str | None = None,
        timeout_sec: float = 12.0,
    ) -> None:
        settings = get_settings()
        self._helo = helo_domain or settings.email.sending_domains[0]
        self._mail_from = mail_from or f"verify@{self._helo}"
        self._timeout = timeout_sec

    # ------------------------------------------------------------------- MX
    async def resolve_mx(self, domain: str) -> list[_MxHost]:
        """Resolve MX records; fall back to A record per RFC 5321 §5.1."""
        try:
            import dns.asyncresolver  # dnspython, imported lazily
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError("dnspython is required for SMTP verification: pip install dnspython") from exc

        try:
            records = await dns.asyncresolver.resolve(domain, "MX")
            hosts = sorted(
                (_MxHost(host=str(r.exchange).rstrip(".").lower(), preference=r.preference) for r in records),
                key=lambda h: h.preference,
            )
            return hosts or [_MxHost(host=domain, preference=0)]
        except Exception:  # dns.resolver.NXDOMAIN / NoAnswer / Lifetimes...
            # No MX: RFC 5321 says treat A/AAAA as implicit MX.
            try:
                await dns.asyncresolver.resolve(domain, "A")
                return [_MxHost(host=domain, preference=0)]
            except Exception:
                return []

    # ---------------------------------------------------------------- verify
    async def verify(self, address: str) -> SmtpVerification:
        """Verify one address end-to-end (syntax → MX → handshake)."""
        local, _, domain = address.partition("@")
        ok, reason = syntax_hygiene(local or "", domain or "")
        if not ok:
            return SmtpVerification(address=address, deliverable=False, method="none", detail=f"syntax:{reason}")

        hosts = await self.resolve_mx(domain)
        if not hosts:
            return SmtpVerification(address=address, deliverable=False, method="mx", detail="no_mx_record")
        mx = hosts[0]

        # Catch-all discrimination: a random local part must be rejected.
        catch_all = await self._probe_rcpt(f"{''.join(random.choices(string.ascii_lowercase, k=24))}@{domain}", mx)
        code, detail = await self._probe_rcpt(address, mx)

        if code in _DELIVER_CODES:
            if catch_all[0] in _DELIVER_CODES:
                return SmtpVerification(
                    address=address, deliverable=False, method="catch_all_neutral",
                    smtp_code=code, mx_host=mx.host,
                    detail="catch_all_server_accepts_anything",
                )
            return SmtpVerification(
                address=address, deliverable=True, method="smtp_rcpt",
                smtp_code=code, mx_host=mx.host, detail=detail,
            )
        if code in _TEMP_CODES:
            return SmtpVerification(
                address=address, deliverable=False, method="smtp_rcpt",
                smtp_code=code, mx_host=mx.host, detail=f"temporary:{detail}",
            )
        return SmtpVerification(
            address=address, deliverable=False, method="smtp_rcpt",
            smtp_code=code, mx_host=mx.host, detail=detail or "rejected",
        )

    # -------------------------------------------------------------- handshake
    async def _probe_rcpt(self, address: str, mx: _MxHost) -> tuple[int | None, str | None]:
        """Run EHLO/MAIL/RCPT against one MX; returns ``(rcpt_code, detail)``."""
        reader: asyncio.StreamReader | None = None
        writer: asyncio.StreamWriter | None = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(mx.host, 25), timeout=self._timeout
            )
            await self._read_reply(reader)                       # 220 banner
            await self._send(writer, f"EHLO {self._helo}")
            ehlo = await self._read_reply(reader)
            if ehlo[0] is None or ehlo[0] >= 400:
                await self._send(writer, f"HELO {self._helo}")
                await self._read_reply(reader)
            await self._send(writer, f"MAIL FROM:<{self._mail_from}>")
            mail_reply = await self._read_reply(reader)
            if mail_reply[0] is not None and mail_reply[0] >= 400:
                return mail_reply[0], "mail_from_rejected"
            await self._send(writer, f"RCPT TO:<{address}>")
            rcpt_reply = await self._read_reply(reader)
            return rcpt_reply[0], rcpt_reply[1]
        except (asyncio.TimeoutError, TimeoutError):
            return None, "timeout"
        except (ConnectionError, OSError) as exc:
            return None, f"connection_error:{exc.__class__.__name__}"
        finally:
            if writer is not None:
                try:
                    writer.write(b"QUIT\r\n")
                    await writer.drain()
                    writer.close()
                    await writer.wait_closed()
                except (ConnectionError, OSError):  # best-effort teardown
                    pass

    async def _send(self, writer: asyncio.StreamWriter, line: str) -> None:
        writer.write(f"{line}\r\n".encode())
        await asyncio.wait_for(writer.drain(), timeout=self._timeout)

    async def _read_reply(self, reader: asyncio.StreamReader) -> tuple[int | None, str | None]:
        """Read a (possibly multiline) SMTP reply; returns ``(code, last_line)``."""
        code: int | None = None
        last: str | None = None
        while True:
            try:
                raw = await asyncio.wait_for(reader.readline(), timeout=self._timeout)
            except (asyncio.TimeoutError, TimeoutError):
                return code, last or "timeout"
            if not raw:
                return code, last or "connection_closed"
            line = raw.decode("utf-8", errors="replace").strip()
            last = line
            if len(line) >= 3 and line[:3].isdigit():
                code = int(line[:3])
                if len(line) == 3 or line[3] != "-":
                    return code, line[4:] if len(line) > 4 else None
            elif line:
                continue  # multiline continuation without code (rare) — keep reading
            else:
                return code, last
