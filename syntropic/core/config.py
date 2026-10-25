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

    # Qdrant hybrid catalog topology. An empty QDRANT_URL keeps the engine
    # on in-memory storage (development); a real URL targets the Qdrant
    # service deployed in docker-compose.
    QDRANT_URL: str = Field(default="", env="QDRANT_URL")
    QDRANT_SEED_DEMO: bool = Field(default=False, env="QDRANT_SEED_DEMO")

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