from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
import jwt
import pytest

from syntropic.core.matching.api import auth


@pytest.fixture
def oidc_keys(monkeypatch):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class FakeJwksClient:
        def get_signing_key_from_jwt(self, token):
            assert token
            return SimpleNamespace(key=private_key.public_key())

    issuer = "https://issuer.example.test/"
    jwks_url = "https://issuer.example.test/jwks"
    monkeypatch.setenv("OIDC_ISSUER", issuer)
    monkeypatch.setenv("OIDC_AUDIENCE", "syntropic-api")
    monkeypatch.setenv("OIDC_JWKS_URL", jwks_url)

    def fake_jwks_client(url):
        assert url == jwks_url
        return FakeJwksClient()

    monkeypatch.setattr(auth, "_jwks_client", fake_jwks_client)
    return private_key


def _token(private_key, **overrides):
    now = datetime.now(timezone.utc)
    claims = {
        "iss": "https://issuer.example.test/",
        "aud": "syntropic-api",
        "sub": "reviewer-1",
        "iat": now,
        "exp": now + timedelta(minutes=5),
    }
    claims.update(overrides)
    return jwt.encode(claims, private_key, algorithm="RS256")


def test_oidc_bearer_token_is_verified_and_claims_returned(oidc_keys):
    token = _token(oidc_keys)
    claims = auth.require_authenticated_user(
        auth.HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)
    )
    assert claims["sub"] == "reviewer-1"


def test_oidc_identity_token_validates_client_audience_and_nonce(oidc_keys):
    token = _token(oidc_keys, aud="syntropic-client", nonce="expected-nonce")

    auth.verify_oidc_id_token(token, "expected-nonce", "syntropic-client")

    with pytest.raises(HTTPException) as error:
        auth.verify_oidc_id_token(token, "different-nonce", "syntropic-client")
    assert error.value.status_code == 401


@pytest.mark.parametrize(
    "claims",
    [
        {"iss": "https://wrong.example.test/"},
        {"aud": "another-api"},
        {"exp": datetime.now(timezone.utc) - timedelta(minutes=1)},
    ],
)
def test_oidc_bearer_token_rejects_invalid_standard_claims(oidc_keys, claims):
    token = _token(oidc_keys, **claims)
    credentials = auth.HTTPAuthorizationCredentials(
        scheme="Bearer", credentials=token
    )
    with pytest.raises(HTTPException) as error:
        auth.require_authenticated_user(credentials)
    assert error.value.status_code == 401


def test_oidc_bearer_token_requires_credentials():
    with pytest.raises(HTTPException) as error:
        auth.require_authenticated_user(None)
    assert error.value.status_code == 401


def test_oidc_configuration_missing_fails_closed(oidc_keys, monkeypatch):
    token = _token(oidc_keys)
    monkeypatch.delenv("OIDC_AUDIENCE")
    credentials = auth.HTTPAuthorizationCredentials(
        scheme="Bearer", credentials=token
    )

    with pytest.raises(HTTPException) as error:
        auth.require_authenticated_user(credentials)
    assert error.value.status_code == 503
