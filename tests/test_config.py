import os

import pytest
from pydantic import SecretStr

from syntropic.core.config import Settings


def test_langsmith_settings_export_modern_and_legacy_tracing_environment(monkeypatch):
    for name in (
        "LANGSMITH_TRACING",
        "LANGSMITH_API_KEY",
        "LANGSMITH_ENDPOINT",
        "LANGSMITH_PROJECT",
        "LANGCHAIN_TRACING_V2",
        "LANGCHAIN_API_KEY",
        "LANGCHAIN_ENDPOINT",
        "LANGCHAIN_PROJECT",
    ):
        monkeypatch.setenv(name, "")

    settings = Settings(
        _env_file=None,
        LANGSMITH_TRACING=True,
        LANGSMITH_API_KEY=SecretStr("lsv2_test_key"),
        LANGSMITH_ENDPOINT="https://smith.example.test/",
        LANGSMITH_PROJECT="syntropic-tests",
    )

    settings.configure_langsmith_tracing()

    assert os.environ["LANGSMITH_TRACING"] == "true"
    assert os.environ["LANGSMITH_API_KEY"] == "lsv2_test_key"
    assert os.environ["LANGSMITH_ENDPOINT"] == "https://smith.example.test"
    assert os.environ["LANGSMITH_PROJECT"] == "syntropic-tests"
    assert os.environ["LANGCHAIN_TRACING_V2"] == "true"
    assert os.environ["LANGCHAIN_PROJECT"] == "syntropic-tests"


def test_langsmith_tracing_requires_a_real_api_key():
    settings = Settings(
        _env_file=None,
        LANGSMITH_TRACING=True,
        LANGSMITH_API_KEY=SecretStr(""),
    )

    with pytest.raises(ValueError, match="LANGSMITH_API_KEY"):
        settings.configure_langsmith_tracing()


def test_disabled_langsmith_tracing_disables_legacy_tracing(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")

    Settings(_env_file=None, LANGSMITH_TRACING=False).configure_langsmith_tracing()

    assert os.environ["LANGSMITH_TRACING"] == "false"
    assert os.environ["LANGCHAIN_TRACING_V2"] == "false"
