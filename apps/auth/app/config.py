"""Settings, read from the repo-root .env (same file the NestJS API uses)."""
import os
import re
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[3]
load_dotenv(ROOT / ".env")


def _duration_seconds(value: str) -> int:
    """Parses the same format as the API's JWT_EXPIRES_IN (e.g. 12h, 30m, 7d, 3600)."""
    m = re.fullmatch(r"\s*(\d+)\s*([smhd]?)\s*", value or "")
    if not m:
        raise ValueError(f"Invalid JWT_EXPIRES_IN: {value!r}")
    n, unit = int(m.group(1)), m.group(2) or "s"
    return n * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def _pg_url(url: str) -> str:
    """Drops Prisma-only query params (e.g. ?schema=public) that libpq doesn't understand."""
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k not in {"schema", "connection_limit", "pool_timeout"}]
    return urlunsplit(parts._replace(query=urlencode(query)))


class Settings:
    database_url: str = _pg_url(os.environ.get("DATABASE_URL", ""))
    jwt_secret: str = os.environ.get("JWT_SECRET", "")
    jwt_ttl_seconds: int = _duration_seconds(os.environ.get("JWT_EXPIRES_IN", "12h"))
    default_country: str = os.environ.get("DEFAULT_COUNTRY", "IN")
    web_origins: list[str] = [o.strip() for o in os.environ.get("WEB_ORIGIN", "http://localhost:5173").split(",") if o.strip()]
    login_limit_per_minute: int = int(os.environ.get("LOGIN_LIMIT_PER_MINUTE", "10"))
    trust_proxy: bool = os.environ.get("NODE_ENV") == "production" or os.environ.get("TRUST_PROXY") == "true"

    def validate(self) -> None:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL is not set")
        if len(self.jwt_secret) < 32:
            raise RuntimeError("JWT_SECRET must be set to at least 32 characters (shared with the API)")


settings = Settings()
