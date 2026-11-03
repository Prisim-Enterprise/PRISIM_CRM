"""Password hashing, tokens and login rate limiting.

Tokens must stay compatible with the NestJS API, which verifies them with the same
JWT_SECRET (HS256) and expects {"sub": <user id>, "typ": "access"}.
Password hashes are bcrypt ($2a$/$2b$), the same format the API writes with bcryptjs.
"""
import threading
import time
from collections import defaultdict, deque

import bcrypt
import jwt

from .config import settings

BCRYPT_ROUNDS = 12
MAX_PASSWORD_BYTES = 72  # bcrypt's hard limit
# Used when the email is unknown, so failed logins take the same time either way.
_DUMMY_HASH = bcrypt.hashpw(b"not-a-real-password", bcrypt.gensalt(BCRYPT_ROUNDS))


def password_too_long(password: str) -> bool:
    return len(password.encode("utf-8")) > MAX_PASSWORD_BYTES


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(BCRYPT_ROUNDS)).decode("ascii")


def verify_password(password: str, password_hash: str | None) -> bool:
    if password_too_long(password):
        bcrypt.checkpw(b"x", _DUMMY_HASH)
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), (password_hash or "").encode("ascii") or _DUMMY_HASH)
    except ValueError:
        # Malformed or missing hash: still spend the time, then fail.
        bcrypt.checkpw(b"x", _DUMMY_HASH)
        return False


def create_access_token(user_id: str) -> str:
    now = int(time.time())
    payload = {"sub": user_id, "typ": "access", "iat": now, "exp": now + settings.jwt_ttl_seconds}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_access_token(token: str) -> str | None:
    """Returns the user id, or None if the token is invalid or expired."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"], options={"require": ["exp", "sub"]})
    except jwt.PyJWTError:
        return None
    if payload.get("typ", "access") != "access":
        return None
    sub = payload.get("sub")
    return sub if isinstance(sub, str) else None


class RateLimiter:
    """Sliding-window limiter (per key, in memory). Fine for a single auth instance."""

    def __init__(self, limit: int, window_seconds: float = 60.0):
        self.limit = limit
        self.window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
