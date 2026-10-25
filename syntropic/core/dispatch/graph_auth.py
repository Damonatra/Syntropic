"""Azure AD / Microsoft Graph OAuth 2.0 token management.

Zero-new-dependency implementation of the OAuth 2.0 client-credentials
flow over httpx (the same HTTP stack the ERP webhook worker already uses).
Application-permission only: no user interaction, no consent prompts, no
redirect flows — the daemon signs a tenant-scoped token request and runs
silently for the life of the process.

Behavior contract (Layer 4 Vector 1, criterion 1.1):
- Tenant authorization: token requests are scoped to
  ``https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token`` and
  the Graph ``.default`` scope. The tenant id is validated before any HTTP
  call (rejects whitespace, path separators — no URL injection).
- Token caching: a single in-flight token is reused for every dispatch;
  the token endpoint sees one request per token lifetime, not per draft.
- Silent background refresh: a token is proactively re-acquired when the
  clock is within ``TOKEN_EXPIRY_SKEW_SECONDS`` of expiry, so callers
  never observe an expired credential and no user is ever involved.
"""

from __future__ import annotations

import asyncio
import re
import time
from typing import Callable

import httpx

GRAPH_TOKEN_URL_TEMPLATE = (
    "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
)
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
TOKEN_EXPIRY_SKEW_SECONDS = 300

# Tenant ids are domain names (contoso.onmicrosoft.com), GUIDs, or short
# altnames. Anything carrying whitespace or path characters is malformed
# and would taint the token URL.
_TENANT_PATTERN = re.compile(r"^[A-Za-z0-9.\-_]+$")


class DispatchAuthError(RuntimeError):
    """Raised when Azure AD refuses the client-credentials request."""


class GraphTokenManager:
    """Cached, silently-renewing Azure AD token source for MS Graph."""

    def __init__(
        self,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        *,
        client: httpx.AsyncClient | None = None,
        now_fn: Callable[[], float] = time.time,
        expiry_skew_seconds: int = TOKEN_EXPIRY_SKEW_SECONDS,
    ) -> None:
        tenant_id = (tenant_id or "").strip()
        if not tenant_id or not _TENANT_PATTERN.match(tenant_id):
            raise ValueError(
                "GRAPH_TENANT_ID must be a tenant domain or GUID without "
                "whitespace or path characters."
            )
        if not client_id or not client_secret:
            raise ValueError(
                "GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET must be configured."
            )
        self._tenant_id = tenant_id
        self._client_id = client_id
        self._client_secret = client_secret
        self._now = now_fn
        self._expiry_skew = expiry_skew_seconds
        self._client = client or httpx.AsyncClient(timeout=15.0)
        self._owns_client = client is None
        self._lock = asyncio.Lock()
        self._cached_token: str | None = None
        self._cached_expires_at: float = 0.0

    @property
    def token_endpoint(self) -> str:
        return GRAPH_TOKEN_URL_TEMPLATE.format(tenant=self._tenant_id)

    async def get_access_token(self) -> str:
        """Return a valid access token, refreshing silently when needed."""
        async with self._lock:
            now = self._now()
            if (
                self._cached_token is not None
                and now < self._cached_expires_at - self._expiry_skew
            ):
                return self._cached_token
            response = await self._client.post(
                self.token_endpoint,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                    "scope": GRAPH_SCOPE,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if response.status_code != 200:
                raise DispatchAuthError(
                    "Azure AD token request failed with HTTP "
                    f"{response.status_code}: {response.text[:300]}"
                )
            payload = response.json()
            token = payload.get("access_token")
            if not token:
                raise DispatchAuthError(
                    "Azure AD token response carried no access_token."
                )
            try:
                expires_in = int(payload.get("expires_in", 3600))
            except (TypeError, ValueError):
                expires_in = 3600
            self._cached_token = token
            self._cached_expires_at = self._now() + max(expires_in, 0)
            return token

    async def invalidate(self) -> None:
        """Drop the cached token (called when Graph returns 401)."""
        async with self._lock:
            self._cached_token = None
            self._cached_expires_at = 0.0

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
