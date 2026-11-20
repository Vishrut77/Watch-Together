from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"
    secret_key: str = "change-this-secret"
    database_url: str = "sqlite:///./watch_together.db"

    livekit_url: str = ""
    livekit_api_key: str = ""
    livekit_api_secret: str = ""
    livekit_token_ttl_minutes: int = 60

    frontend_url: str = "http://localhost:5173"
    cors_origins: str = "http://localhost:5173"
    frontend_dist: str = "../frontend/dist"

    session_ttl_hours: int = 12
    rate_limit_enabled: bool = True
    trust_proxy_headers: bool = True

    presence_enabled: bool = True
    presence_grace_seconds: int = 45
    streamer_grace_seconds: int = 20
    join_grace_seconds: int = 60
    rejoin_window_seconds: int = 900

    @property
    def sqlalchemy_url(self) -> str:
        url = self.database_url
        if url.startswith("postgres://"):  # some hosts still hand out the old scheme
            url = "postgresql://" + url[len("postgres://"):]
        return url

    @property
    def cors_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]

    @property
    def livekit_configured(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)

    @property
    def livekit_http_url(self) -> str:
        """The server SDK talks HTTP(S); browsers talk WS(S)."""
        url = self.livekit_url
        if url.startswith("wss://"):
            return "https://" + url[6:]
        if url.startswith("ws://"):
            return "http://" + url[5:]
        return url

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
