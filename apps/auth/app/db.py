"""Database access. Uses the same PostgreSQL tables Prisma manages for the API.

Prisma generates ids and @updatedAt values on the client, so this module sets
"id" and "updatedAt" itself when writing.
"""
import json
import uuid
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import settings

pool: ConnectionPool | None = None


def open_pool() -> None:
    global pool
    # Prisma stores timestamps as UTC in "timestamp without time zone" columns, so this
    # session must use UTC too; otherwise now() would be written in the server's local time.
    pool = ConnectionPool(
        settings.database_url, min_size=1, max_size=5,
        kwargs={"row_factory": dict_row, "options": "-c timezone=UTC"}, open=True,
    )


def close_pool() -> None:
    if pool:
        pool.close()


@contextmanager
def conn():
    assert pool, "database pool not open"
    with pool.connection() as c:
        yield c


def find_user_by_email(email: str) -> dict | None:
    with conn() as c:
        return c.execute(
            'SELECT id::text, "passwordHash", "isActive" FROM users WHERE email = %s', (email,)
        ).fetchone()


def load_profile(user_id: str) -> dict | None:
    """User + team + roles + permissions + team scope, the same shape the web app expects."""
    with conn() as c:
        u = c.execute(
            '''SELECT u.id::text, u."fullName", u.email, u.phone, u.timezone, u."teamId"::text AS "teamId", u."isActive",
                      t.id::text AS team_id, t.name AS team_name
               FROM users u LEFT JOIN teams t ON t.id = u."teamId" WHERE u.id = %s''',
            (user_id,),
        ).fetchone()
        if not u:
            return None
        roles = [r["key"] for r in c.execute(
            'SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur."roleId" WHERE ur."userId" = %s ORDER BY r.key',
            (user_id,),
        ).fetchall()]
        # Effective permissions = role permissions + per-user grants - per-user denies
        # (same rule as the API's auth guard).
        perms = [r["key"] for r in c.execute(
            '''SELECT key FROM (
                 SELECT p.key FROM user_roles ur
                   JOIN role_permissions rp ON rp."roleId" = ur."roleId"
                   JOIN permissions p ON p.id = rp."permissionId"
                  WHERE ur."userId" = %(u)s
                 UNION
                 SELECT p.key FROM user_permissions up JOIN permissions p ON p.id = up."permissionId"
                  WHERE up."userId" = %(u)s AND up.effect = 'GRANT'
               ) eff
               WHERE key NOT IN (
                 SELECT p.key FROM user_permissions up JOIN permissions p ON p.id = up."permissionId"
                  WHERE up."userId" = %(u)s AND up.effect = 'DENY')
               ORDER BY key''',
            {"u": user_id},
        ).fetchall()]
        led = [r["id"] for r in c.execute('SELECT id::text FROM teams WHERE "leaderId" = %s', (user_id,)).fetchall()]
    team_ids = list(dict.fromkeys(led + ([u["teamId"]] if u["teamId"] else [])))
    return {
        "id": u["id"],
        "fullName": u["fullName"],
        "email": u["email"],
        "phone": u["phone"],
        "timezone": u["timezone"],
        "teamId": u["teamId"],
        "team": {"id": u["team_id"], "name": u["team_name"]} if u["team_id"] else None,
        "isActive": u["isActive"],
        "roles": roles,
        "permissions": perms,
        "teamIds": team_ids,
    }


def get_password_hash(user_id: str) -> str | None:
    with conn() as c:
        row = c.execute('SELECT "passwordHash" FROM users WHERE id = %s', (user_id,)).fetchone()
        return row["passwordHash"] if row else None


def update_user(user_id: str, **fields) -> None:
    allowed = {"phone", "timezone", "passwordHash", "lastLoginAt"}
    cols = {k: v for k, v in fields.items() if k in allowed}
    if not cols:
        return
    sets = ", ".join(f'"{k}" = %s' for k in cols) + ', "updatedAt" = now()'
    with conn() as c:
        c.execute(f"UPDATE users SET {sets} WHERE id = %s", (*cols.values(), user_id))


def touch_last_login(user_id: str) -> None:
    with conn() as c:
        c.execute('UPDATE users SET "lastLoginAt" = now(), "updatedAt" = now() WHERE id = %s', (user_id,))


def audit(action: str, actor_id: str | None, ip: str | None, entity_id: str | None = None, after: dict | None = None) -> None:
    """Writes to the shared audit log. Never raises: auth must not fail because auditing did."""
    try:
        with conn() as c:
            c.execute(
                '''INSERT INTO audit_logs (id, "actorId", action, "entityType", "entityId", after, ip, "createdAt")
                   VALUES (%s, %s, %s, 'user', %s, %s::jsonb, %s, now())''',
                (str(uuid.uuid4()), actor_id, action, entity_id, json.dumps(after) if after is not None else None, ip),
            )
    except Exception as e:  # noqa: BLE001
        print(f"[audit] failed to record {action}: {e}")
