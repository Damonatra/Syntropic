# syntropic/core/config.py
import os

from pydantic_settings import BaseSettings
from pydantic import Field, SecretStr

class Settings(BaseSettings):
    ENVIRONMENT: str = Field(default="development", env="ENV")
    SECRET_KEY: str = Field(default="SUPER_SECRET_JWT_KEY_CHANGE_IN_PRODUCTION")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    # PostgreSQL Persistence
    POSTGRES_USER: str = Field(default="postgres")
    POSTGRES_PASSWORD: str = Field(default="syntropic_pass")
    POSTGRES_HOST: str = Field(default="localhost")
    POSTGRES_PORT: int = Field(default=5432)
    POSTGRES_DB: str = Field(default="syntropic_db")
    DATABASE_URL: str | None = None

    # Margin Defender policy (Layer 3 V4). The floor price for a SKU is its
    # explicit catalog `price_floor` when present, otherwise derived from
    # unit_cost as cost / (1 - MARGIN_FLOOR_PCT). Quotes below unit_cost are
    # always vetoed to human review; quotes below the floor are repriced up
    # to the floor when MARGIN_REPRICE_ENABLED is set, otherwise vetoed.
    MARGIN_FLOOR_PCT: float = Field(default=0.15, env="MARGIN_FLOOR_PCT")
    MARGIN_REPRICE_ENABLED: bool = Field(default=True, env="MARGIN_REPRICE_ENABLED")

    # Qdrant hybrid catalog topology. An empty QDRANT_URL keeps the engine
    # on in-memory storage (development); a real URL targets the Qdrant
    # service deployed in docker-compose.
    QDRANT_URL: str = Field(default="", env="QDRANT_URL")
    QDRANT_SEED_DEMO: bool = Field(default=False, env="QDRANT_SEED_DEMO")

    # Taelin Memory Stream (Layer 4). Append-only, tenant-partitioned JSONL
    # audit stream with tamper-evident hash chaining. Local filesystem by
    # design: no tenant data leaves the deployment boundary (contrast the
    # opt-in LangSmith tracing above). The <=30ms recall SLA for active
    # tenant sessions is benchmarked in scripts/vector2_stream_benchmark.py.
    STREAM_ENABLED: bool = Field(default=True, env="STREAM_ENABLED")
    STREAM_ROOT: str = Field(default="data/streams", env="STREAM_ROOT")
    STREAM_ROTATE_MB: int = Field(default=64, env="STREAM_ROTATE_MB")
    STREAM_FSYNC: bool = Field(default=False, env="STREAM_FSYNC")

    # Commercial instrumentation (Layer 5). The ROI value ledger records
    # every margin-defender intervention as immutable per-job money math;
    # the revenue-share statement is the contractual surface for the
    # 20%-of-net-margin billing model. Share math is currency-scoped —
    # statements never sum across ISO codes; the reporting currency is the
    # deployment's primary billing currency.
    ROI_LEDGER_ENABLED: bool = Field(default=True, env="ROI_LEDGER_ENABLED")
    ROI_SHARE_PCT: float = Field(default=0.20, env="ROI_SHARE_PCT")
    ROI_DEPLOYMENT_COST: float = Field(default=50_000.0, env="ROI_DEPLOYMENT_COST")
    ROI_REPORTING_CURRENCY: str = Field(default="USD", env="ROI_REPORTING_CURRENCY")

    LANGSMITH_TRACING: bool = False
    LANGSMITH_ENDPOINT: str = "https://api.smith.langchain.com"
    LANGSMITH_API_KEY: SecretStr | None = None
    LANGSMITH_PROJECT: str = "syntropic-enterprise-production"

    def configure_langsmith_tracing(self) -> None:
        """Expose validated settings to LangChain's tracing callback provider."""
        if not self.LANGSMITH_TRACING:
            os.environ["LANGSMITH_TRACING"] = "false"
            os.environ["LANGCHAIN_TRACING_V2"] = "false"
            return

        api_key = (
            self.LANGSMITH_API_KEY.get_secret_value()
            if self.LANGSMITH_API_KEY is not None
            else ""
        ).strip()
        if not api_key or api_key == "ls__your_api_key_here":
            raise ValueError(
                "LANGSMITH_API_KEY must contain a real LangSmith API key "
                "when LANGSMITH_TRACING is enabled."
            )

        endpoint = self.LANGSMITH_ENDPOINT.rstrip("/")
        project = self.LANGSMITH_PROJECT.strip()
        if not endpoint or not project:
            raise ValueError(
                "LANGSMITH_ENDPOINT and LANGSMITH_PROJECT must be configured "
                "when tracing is enabled."
            )

        for name, value in {
            "LANGSMITH_TRACING": "true",
            "LANGSMITH_API_KEY": api_key,
            "LANGSMITH_ENDPOINT": endpoint,
            "LANGSMITH_PROJECT": project,
            "LANGCHAIN_TRACING_V2": "true",
            "LANGCHAIN_API_KEY": api_key,
            "LANGCHAIN_ENDPOINT": endpoint,
            "LANGCHAIN_PROJECT": project,
        }.items():
            os.environ[name] = value

    @property
    def sync_database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL.replace(
                "postgresql+asyncpg://", "postgresql://", 1
            )
        return (
            f"postgresql://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def async_database_url(self) -> str:
        if self.DATABASE_URL:
            return self.DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    class Config:
        env_file = ".env"
        extra = "ignore"

settings = Settings()