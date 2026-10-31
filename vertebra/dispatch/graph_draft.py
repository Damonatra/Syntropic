"""Microsoft Graph API Draft Injection for enterprise sales reps.

Injects pre-crafted, personalized audit and RFQ leakage pitches directly into the
operator or sales executive's personal Outlook / M365 Drafts folder (<90s total cycle),
allowing human review and 1-click personal dispatch without third-party email tracking smell.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any

import httpx

from vertebra.config.settings import get_settings
from vertebra.models.errors import DispatchError


@dataclass(frozen=True, slots=True)
class GraphDraftPayload:
    """Structure of an injected Outlook draft message."""

    subject: str
    recipient_email: str
    recipient_name: str | None
    html_body: str
    sender_user_principal: str  # e.g. "josias@syntropic.com"


class MicrosoftGraphDraftClient:
    """Client for Azure AD authentication and Outlook draft injection."""

    def __init__(
        self,
        tenant_id: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        graph_base_url: str = "https://graph.microsoft.com/v1.0",
    ):
        self.tenant_id = tenant_id or os.getenv("AZURE_TENANT_ID") or os.getenv("VERTEBRA_AZURE_TENANT_ID")
        self.client_id = client_id or os.getenv("AZURE_CLIENT_ID") or os.getenv("VERTEBRA_AZURE_CLIENT_ID")
        self.client_secret = client_secret or os.getenv("AZURE_CLIENT_SECRET") or os.getenv("VERTEBRA_AZURE_CLIENT_SECRET")
        self.graph_base_url = graph_base_url.rstrip("/")

    def format_draft_body(self, payload: GraphDraftPayload) -> dict[str, Any]:
        """Format the Microsoft Graph API message schema for a draft."""
        recipient: dict[str, Any] = {
            "emailAddress": {"address": payload.recipient_email}
        }
        if payload.recipient_name:
            recipient["emailAddress"]["name"] = payload.recipient_name

        return {
            "subject": payload.subject,
            "importance": "normal",
            "body": {
                "contentType": "HTML",
                "content": payload.html_body,
            },
            "toRecipients": [recipient],
            "isDraft": True,
        }

    async def inject_draft(
        self,
        payload: GraphDraftPayload,
        access_token: str | None = None,
    ) -> dict[str, Any]:
        """Inject an email draft into the specified user's Outlook mailbox.

        Endpoint: POST /v1.0/users/{user-principal}/messages
        """
        token = access_token
        if not token:
            # If no live token provided and credentials missing, raise informative error
            if not (self.tenant_id and self.client_id and self.client_secret):
                raise DispatchError("Microsoft Graph API credentials not configured (tenant_id/client_id/client_secret)")
            token = await self._acquire_token()

        url = f"{self.graph_base_url}/users/{payload.sender_user_principal}/messages"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        body = self.format_draft_body(payload)

        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=body)
            if resp.status_code not in {200, 201}:
                raise DispatchError(f"Graph API draft injection failed ({resp.status_code}): {resp.text}")
            return resp.json()

    async def _acquire_token(self) -> str:
        """Acquire an application bearer token via OAuth2 client_credentials grant."""
        token_url = f"https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token"
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "scope": "https://graph.microsoft.com/.default",
            "grant_type": "client_credentials",
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(token_url, data=data)
            if resp.status_code != 200:
                raise DispatchError(f"Azure AD token acquisition failed ({resp.status_code}): {resp.text}")
            return str(resp.json().get("access_token"))
