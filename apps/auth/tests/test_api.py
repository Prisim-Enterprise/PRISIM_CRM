"""API tests against the real database (the local dev PostgreSQL).

A temporary user is created for the test run and deleted afterwards.
Skipped automatically if the database isn't reachable.
"""
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app, login_limiter
from app.security import hash_password

PASSWORD = "Test@Pass123"


def _db_available() -> bool:
    try:
        with psycopg.connect(settings.database_url, connect_timeout=3):
            return True
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="database not reachable")


@pytest.fixture(scope="module")
def user():
    uid, email = str(uuid.uuid4()), f"pytest-{uuid.uuid4().hex[:8]}@prisim.test"
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        role_id = c.execute("SELECT id FROM roles WHERE key = 'employee'").fetchone()[0]
        c.execute(
            '''INSERT INTO users (id, "fullName", email, "passwordHash", "isActive", timezone, "createdAt", "updatedAt")
               VALUES (%s, 'Pytest User', %s, %s, true, 'Asia/Kolkata', now(), now())''',
            (uid, email, hash_password(PASSWORD)),
        )
        c.execute('INSERT INTO user_roles ("userId", "roleId") VALUES (%s, %s)', (uid, role_id))
    yield {"id": uid, "email": email}
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute('DELETE FROM audit_logs WHERE "actorId" = %s OR "entityId" = %s', (uid, uid))
        c.execute("DELETE FROM users WHERE id = %s", (uid,))


@pytest.fixture()
def client():
    login_limiter.reset()
    with TestClient(app) as c:
        yield c


def login(client, email, password=PASSWORD):
    return client.post("/api/v1/auth/login", json={"email": email, "password": password})


def test_login_and_me(client, user):
    r = login(client, user["email"].upper())  # emails are case-insensitive
    assert r.status_code == 200, r.text
    token = r.json()["accessToken"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).json()
    assert me["id"] == user["id"]
    assert me["roles"] == ["employee"]
    assert "leads.view.all" in me["permissions"]
    assert "isActive" not in me and "passwordHash" not in me


def test_per_user_overrides_apply(client, user):
    """A GRANT adds a permission the role lacks; a DENY removes one the role gives."""
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        perm = lambda k: c.execute("SELECT id FROM permissions WHERE key = %s", (k,)).fetchone()[0]  # noqa: E731
        c.execute('INSERT INTO user_permissions ("userId", "permissionId", effect) VALUES (%s, %s, %s)', (user["id"], perm("leads.export"), "GRANT"))
        c.execute('INSERT INTO user_permissions ("userId", "permissionId", effect) VALUES (%s, %s, %s)', (user["id"], perm("leads.view.all"), "DENY"))
    try:
        token = login(client, user["email"]).json()["accessToken"]
        perms = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).json()["permissions"]
        assert "leads.export" in perms
        assert "leads.view.all" not in perms
    finally:
        with psycopg.connect(settings.database_url, autocommit=True) as c:
            c.execute('DELETE FROM user_permissions WHERE "userId" = %s', (user["id"],))


def test_last_login_is_stored_in_utc(client, user):
    """Must match Prisma's convention (UTC in timestamp-without-time-zone columns)."""
    from datetime import datetime, timezone
    assert login(client, user["email"]).status_code == 200
    with psycopg.connect(settings.database_url) as c:
        stored = c.execute('SELECT "lastLoginAt" FROM users WHERE id = %s', (user["id"],)).fetchone()[0]
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs((now_utc - stored).total_seconds()) < 120


def test_wrong_password_and_unknown_email_look_the_same(client, user):
    a = login(client, user["email"], "nope")
    b = login(client, "nobody@prisim.test", "nope")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json() == {"statusCode": 401, "message": "Incorrect email or password"}


def test_validation_errors_use_api_shape(client):
    r = client.post("/api/v1/auth/login", json={"email": "not-an-email", "password": ""})
    assert r.status_code == 400
    assert isinstance(r.json()["message"], list)


def test_rate_limit(client, user):
    codes = [login(client, user["email"], "wrong").status_code for _ in range(settings.login_limit_per_minute + 1)]
    assert codes[-1] == 429


def test_requires_token(client):
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Authorization": "Bearer bad"}).status_code == 401


def test_update_phone_and_change_password(client, user):
    token = login(client, user["email"]).json()["accessToken"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.patch("/api/v1/auth/me", json={"phone": "98765 43210"}, headers=h).status_code == 200
    assert client.get("/api/v1/auth/me", headers=h).json()["phone"] == "+919876543210"
    assert client.patch("/api/v1/auth/me", json={"phone": "123"}, headers=h).status_code == 400

    assert client.post("/api/v1/auth/change-password", json={"currentPassword": "bad", "newPassword": "NewPass#456"}, headers=h).status_code == 400
    assert client.post("/api/v1/auth/change-password", json={"currentPassword": PASSWORD, "newPassword": "short"}, headers=h).status_code == 400
    assert client.post("/api/v1/auth/change-password", json={"currentPassword": PASSWORD, "newPassword": "NewPass#456"}, headers=h).status_code == 200
    assert login(client, user["email"], "NewPass#456").status_code == 200
    assert login(client, user["email"], PASSWORD).status_code == 401
    # restore for other tests
    t2 = login(client, user["email"], "NewPass#456").json()["accessToken"]
    client.post("/api/v1/auth/change-password", json={"currentPassword": "NewPass#456", "newPassword": PASSWORD}, headers={"Authorization": f"Bearer {t2}"})


def test_deactivated_user_cannot_sign_in(client, user):
    token = login(client, user["email"]).json()["accessToken"]
    with psycopg.connect(settings.database_url, autocommit=True) as c:
        c.execute('UPDATE users SET "isActive" = false WHERE id = %s', (user["id"],))
    try:
        assert login(client, user["email"]).json()["message"] == "This account has been deactivated"
        assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}).status_code == 401
    finally:
        with psycopg.connect(settings.database_url, autocommit=True) as c:
            c.execute('UPDATE users SET "isActive" = true WHERE id = %s', (user["id"],))
