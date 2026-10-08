"""OIDC JWT bearer-token validation for the RFQ API."""

from functools import lru_cache
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any
from urllib.parse import urlencode, urlsplit

import jwt
import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient, PyJWKClientConnectionError, PyJWKClientError


bearer_scheme = HTTPBearer(auto_error=False)
OIDC_FLOW_COOKIE = "syntropic_oidc_flow"
OIDC_FLOW_TTL_SECONDS = 600


def get_oidc_client_config() -> dict[str, str]:
    config = {
        "issuer": os.getenv("OIDC_ISSUER", "").strip(),
        "client_id": os.getenv("OIDC_CLIENT_ID", "").strip(),
        "redirect_uri": os.getenv("OIDC_REDIRECT_URI", "").strip(),
        "state_secret": os.getenv("OIDC_STATE_SECRET", ""),
    }
    if not all(config.values()):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC client ID, redirect URI, issuer and state secret must be configured.",
        )
    if (
        len(config["state_secret"].encode("utf-8")) < 32
        or config["state_secret"].startswith("replace-")
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC_STATE_SECRET must contain at least 32 bytes.",
        )
    if not _is_secure_url(config["issuer"]) or not _is_secure_url(
        config["redirect_uri"]
    ):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC issuer and redirect URI must use HTTPS, except for localhost development.",
        )
    redirect = urlsplit(config["redirect_uri"])
    if redirect.path != "/api/v1/auth/callback" or redirect.query or redirect.fragment:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC_REDIRECT_URI must target /api/v1/auth/callback without query or fragment parameters.",
        )
    return config


def _is_secure_url(value: str) -> bool:
    parsed = urlsplit(value)
    return bool(
        parsed.hostname
        and not parsed.username
        and not parsed.password
        and (
            parsed.scheme == "https"
            or (
                parsed.scheme == "http"
                and parsed.hostname in {"localhost", "127.0.0.1"}
            )
        )
    )


async def _oidc_metadata(issuer: str) -> dict[str, Any]:
    discovery_url = f"{issuer.rstrip('/')}/.well-known/openid-configuration"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(discovery_url)
            response.raise_for_status()
            metadata = response.json()
    except httpx.HTTPStatusError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC discovery is unavailable.",
        ) from error
    except (httpx.RequestError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC discovery is unavailable.",
        ) from error

    if not isinstance(metadata, dict) or metadata.get("issuer") != issuer:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC discovery issuer does not match the configured issuer.",
        )
    for endpoint_name in ("authorization_endpoint", "token_endpoint"):
        endpoint = metadata.get(endpoint_name)
        if not isinstance(endpoint, str) or not _is_secure_url(endpoint):
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"OIDC discovery returned an invalid {endpoint_name}.",
            )
    return metadata


def _sign_flow_state(payload: dict[str, Any], state_secret: str) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).rstrip(b"=")
    signature = hmac.new(
        state_secret.encode("utf-8"), encoded, hashlib.sha256
    ).digest()
    return f"{encoded.decode('ascii')}.{base64.urlsafe_b64encode(signature).rstrip(b'=').decode('ascii')}"


def _read_flow_state(value: str, state_secret: str) -> dict[str, Any]:
    try:
        encoded, supplied_signature = value.split(".", 1)
        expected_signature = hmac.new(
            state_secret.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256
        ).digest()
        actual_signature = base64.urlsafe_b64decode(
            supplied_signature + "=" * (-len(supplied_signature) % 4)
        )
        if not hmac.compare_digest(expected_signature, actual_signature):
            raise ValueError("Invalid OIDC state signature.")
        payload = json.loads(
            base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        )
        if not isinstance(payload, dict) or payload.get("expires_at", 0) < time.time():
            raise ValueError("Expired OIDC state.")
        if not all(
            isinstance(payload.get(key), str)
            for key in ("state", "nonce", "code_verifier")
        ):
            raise ValueError("Invalid OIDC state payload.")
        return payload
    except (ValueError, TypeError, json.JSONDecodeError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The OIDC login state is invalid or expired.",
        ) from error


def create_oidc_authorization_request(
    metadata: dict[str, Any], config: dict[str, str]
) -> tuple[str, str]:
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    code_verifier = secrets.token_urlsafe(64)
    code_challenge = base64.urlsafe_b64encode(
        hashlib.sha256(code_verifier.encode("ascii")).digest()
    ).rstrip(b"=").decode("ascii")
    signed_state = _sign_flow_state(
        {
            "state": state,
            "nonce": nonce,
            "code_verifier": code_verifier,
            "expires_at": time.time() + OIDC_FLOW_TTL_SECONDS,
        },
        config["state_secret"],
    )
    authorization_url = f"{metadata['authorization_endpoint']}?{urlencode({
        'client_id': config['client_id'],
        'redirect_uri': config['redirect_uri'],
        'response_type': 'code',
        'scope': 'openid profile',
        'state': state,
        'nonce': nonce,
        'code_challenge': code_challenge,
        'code_challenge_method': 'S256',
    })}"
    return authorization_url, signed_state


async def exchange_oidc_code(
    code: str, code_verifier: str, config: dict[str, str], metadata: dict[str, Any]
) -> dict[str, Any]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                metadata["token_endpoint"],
                data={
                    "grant_type": "authorization_code",
                    "client_id": config["client_id"],
                    "redirect_uri": config["redirect_uri"],
                    "code": code,
                    "code_verifier": code_verifier,
                },
            )
            response.raise_for_status()
            token_response = response.json()
    except httpx.HTTPStatusError as error:
        status_code = (
            status.HTTP_401_UNAUTHORIZED
            if error.response.status_code in {400, 401}
            else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(
            status_code=status_code,
            detail="The OIDC provider rejected the authorization code.",
        ) from error
    except (httpx.RequestError, ValueError) as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The OIDC token endpoint is unavailable or returned invalid data.",
        ) from error

    if not isinstance(token_response, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The OIDC token endpoint returned invalid data.",
        )
    return token_response


def verify_oidc_id_token(token: str, nonce: str, client_id: str) -> None:
    issuer = os.getenv("OIDC_ISSUER", "").strip()
    jwks_url = os.getenv("OIDC_JWKS_URL", "").strip()
    if not issuer or not jwks_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC issuer and JWKS URL must be configured.",
        )
    try:
        signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=issuer,
            options={"require": ["exp", "iss", "sub", "nonce"]},
        )
        if not hmac.compare_digest(str(claims["nonce"]), nonce):
            raise jwt.InvalidTokenError("OIDC nonce does not match.")
    except PyJWKClientConnectionError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The OIDC signing keys could not be reached.",
        ) from error
    except (jwt.PyJWTError, PyJWKClientError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The OIDC identity token is invalid or expired.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error


@lru_cache(maxsize=8)
def _jwks_client(jwks_url: str) -> PyJWKClient:
    return PyJWKClient(jwks_url, cache_jwk_set=True, timeout=5)


def require_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict[str, Any]:
    """Validate an OIDC access token, including signature, issuer, audience and expiry."""
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A bearer access token is required.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    issuer = os.getenv("OIDC_ISSUER", "").strip()
    audience = os.getenv("OIDC_AUDIENCE", "").strip()
    jwks_url = os.getenv("OIDC_JWKS_URL", "").strip()
    if not issuer or not audience or not jwks_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OIDC issuer, audience and JWKS URL must be configured.",
        )

    try:
        signing_key = _jwks_client(jwks_url).get_signing_key_from_jwt(
            credentials.credentials
        )
        return jwt.decode(
            credentials.credentials,
            signing_key.key,
            algorithms=["RS256"],
            audience=audience,
            issuer=issuer,
            options={"require": ["exp", "iss", "sub"]},
        )
    except PyJWKClientConnectionError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The OIDC signing keys could not be reached.",
        ) from error
    except (jwt.PyJWTError, PyJWKClientError) as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="The bearer access token is invalid or expired.",
            headers={"WWW-Authenticate": "Bearer"},
        ) from error
