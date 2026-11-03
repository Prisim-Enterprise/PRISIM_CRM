import time

import jwt

from app.config import _duration_seconds, _pg_url, settings
from app.security import RateLimiter, create_access_token, decode_access_token, hash_password, verify_password

# Hash produced by bcryptjs (what the NestJS API and seed script use).
BCRYPTJS_HASH = "$2b$12$Rtn8FTQIqaWh1c2cD2vkNuE.Gn5YFS5ilaIGPwoxnc45m2vtpfmGm"


def test_verifies_hashes_written_by_bcryptjs():
    assert verify_password("Secret@123", BCRYPTJS_HASH)
    assert verify_password("Secret@123", BCRYPTJS_HASH.replace("$2b$", "$2a$", 1))  # older bcryptjs prefix
    assert not verify_password("wrong", BCRYPTJS_HASH)


def test_hash_roundtrip_and_bad_inputs():
    h = hash_password("Another#Pass1")
    assert h.startswith("$2b$12$")
    assert verify_password("Another#Pass1", h)
    assert not verify_password("Another#Pass1", None)
    assert not verify_password("Another#Pass1", "not-a-hash")
    assert not verify_password("x" * 100, h)  # over bcrypt's 72-byte limit


def test_token_matches_api_format():
    token = create_access_token("8a7a8d1e-0000-4000-8000-000000000001")
    payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    assert payload["sub"] == "8a7a8d1e-0000-4000-8000-000000000001"
    assert payload["typ"] == "access"
    assert payload["exp"] - payload["iat"] == settings.jwt_ttl_seconds
    assert decode_access_token(token) == payload["sub"]


def test_rejects_bad_tokens():
    assert decode_access_token("garbage") is None
    forged = jwt.encode({"sub": "x", "exp": int(time.time()) + 60}, "wrong-secret-" * 4, algorithm="HS256")
    assert decode_access_token(forged) is None
    expired = jwt.encode({"sub": "x", "typ": "access", "exp": int(time.time()) - 1}, settings.jwt_secret, algorithm="HS256")
    assert decode_access_token(expired) is None
    refresh = jwt.encode({"sub": "x", "typ": "refresh", "exp": int(time.time()) + 60}, settings.jwt_secret, algorithm="HS256")
    assert decode_access_token(refresh) is None


def test_rate_limiter():
    rl = RateLimiter(3, window_seconds=60)
    assert [rl.allow("ip") for _ in range(4)] == [True, True, True, False]
    assert rl.allow("other-ip")


def test_config_helpers():
    assert _duration_seconds("12h") == 43200
    assert _duration_seconds("30m") == 1800
    assert _duration_seconds("3600") == 3600
    assert _pg_url("postgresql://u:p@h:5432/db?schema=public&sslmode=require") == "postgresql://u:p@h:5432/db?sslmode=require"
