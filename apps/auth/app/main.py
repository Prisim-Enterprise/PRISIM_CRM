"""Prisim CRM authentication service (FastAPI).

Owns sign-in and the signed-in user's own account:
  POST  /api/v1/auth/login            email + password -> access token
  GET   /api/v1/auth/me               current user, roles, permissions, team scope
  PATCH /api/v1/auth/me               update own phone / timezone
  POST  /api/v1/auth/change-password  change own password
Everything else (leads, calls, users admin, ...) stays in the NestJS API, which
accepts the tokens issued here.
"""
from contextlib import asynccontextmanager
from typing import Annotated

import phonenumbers
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from . import db
from .config import settings
from .security import (
    RateLimiter, create_access_token, decode_access_token, hash_password, password_too_long, verify_password,
)

login_limiter = RateLimiter(settings.login_limit_per_minute)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.validate()
    db.open_pool()
    yield
    db.close_pool()


app = FastAPI(
    title="Prisim CRM Auth",
    version="1.0",
    lifespan=lifespan,
    docs_url="/api/v1/auth/docs",
    openapi_url="/api/v1/auth/openapi.json",
    redoc_url=None,
)
app.add_middleware(
    CORSMiddleware, allow_origins=settings.web_origins, allow_methods=["GET", "POST", "PATCH"], allow_headers=["Authorization", "Content-Type"],
)


# Same error shape as the NestJS API ({statusCode, message}) so the web app handles both alike.
@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse({"statusCode": exc.status_code, "message": exc.detail}, status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    msgs = [f"{'.'.join(str(p) for p in e['loc'][1:]) or 'body'}: {e['msg']}" for e in exc.errors()]
    return JSONResponse({"statusCode": 400, "message": msgs, "error": "Bad Request"}, status_code=400)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Cache-Control", "no-store")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


def client_ip(request: Request) -> str:
    if settings.trust_proxy:
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ───────────── models ─────────────

class LoginIn(BaseModel):
    # Plain format check (not deliverability), so internal domains like admin@prisim.local work.
    email: str = Field(min_length=3, max_length=254, pattern=r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
    password: str = Field(min_length=1, max_length=200)


class TokenOut(BaseModel):
    accessToken: str


class UpdateMeIn(BaseModel):
    phone: str | None = None
    timezone: str | None = Field(default=None, max_length=64)


class ChangePasswordIn(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=200)
    newPassword: str = Field(min_length=8, max_length=200)


# ───────────── dependencies ─────────────

async def current_user(authorization: Annotated[str | None, Header()] = None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Not signed in")
    user_id = decode_access_token(authorization[7:])
    if not user_id:
        raise HTTPException(401, "Session expired. Please sign in again.")
    profile = await run_in_threadpool(db.load_profile, user_id)
    if not profile or not profile["isActive"]:
        raise HTTPException(401, "Account is inactive")
    return profile


CurrentUser = Annotated[dict, Depends(current_user)]


def normalize_phone(raw: str) -> str | None:
    s = raw.strip()
    if s.lower().startswith("p:"):
        s = s[2:]
    try:
        n = phonenumbers.parse(s, settings.default_country)
    except phonenumbers.NumberParseException:
        return None
    return phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164) if phonenumbers.is_valid_number(n) else None


# ───────────── routes ─────────────

@app.get("/api/v1/auth/health", include_in_schema=False)
async def health():
    def ping():
        with db.conn() as c:
            c.execute("SELECT 1")
    await run_in_threadpool(ping)
    return {"status": "ok", "service": "auth"}


@app.post("/api/v1/auth/login", response_model=TokenOut)
async def login(body: LoginIn, request: Request):
    ip = client_ip(request)
    if not login_limiter.allow(ip):
        raise HTTPException(429, "Too many sign-in attempts. Please wait a minute and try again.", headers={"Retry-After": "60"})
    email = body.email.lower().strip()
    user = await run_in_threadpool(db.find_user_by_email, email)
    # Same message and similar timing whether the email exists or not.
    ok = await run_in_threadpool(verify_password, body.password, user["passwordHash"] if user else None)
    if not user or not ok:
        await run_in_threadpool(db.audit, "auth.login_failed", user["id"] if user else None, ip, user["id"] if user else None)
        raise HTTPException(401, "Incorrect email or password")
    if not user["isActive"]:
        raise HTTPException(401, "This account has been deactivated")
    await run_in_threadpool(db.touch_last_login, user["id"])
    await run_in_threadpool(db.audit, "auth.login", user["id"], ip, user["id"])
    return {"accessToken": create_access_token(user["id"])}


@app.get("/api/v1/auth/me")
async def me(user: CurrentUser):
    return {k: v for k, v in user.items() if k != "isActive"}


@app.patch("/api/v1/auth/me")
async def update_me(body: UpdateMeIn, user: CurrentUser):
    changes: dict = {}
    if "phone" in body.model_fields_set:
        if body.phone:
            phone = normalize_phone(body.phone)
            if not phone:
                raise HTTPException(400, "Phone number is not valid")
            changes["phone"] = phone
        else:
            changes["phone"] = None
    if body.timezone:
        changes["timezone"] = body.timezone
    await run_in_threadpool(lambda: db.update_user(user["id"], **changes))
    return {"ok": True}


@app.post("/api/v1/auth/change-password")
async def change_password(body: ChangePasswordIn, user: CurrentUser, request: Request):
    if password_too_long(body.newPassword):
        raise HTTPException(400, "Password is too long (maximum 72 bytes)")
    current_hash = await run_in_threadpool(db.get_password_hash, user["id"])
    if not await run_in_threadpool(verify_password, body.currentPassword, current_hash):
        raise HTTPException(400, "Current password is incorrect")
    new_hash = await run_in_threadpool(hash_password, body.newPassword)
    await run_in_threadpool(lambda: db.update_user(user["id"], passwordHash=new_hash))
    await run_in_threadpool(db.audit, "auth.password_changed", user["id"], client_ip(request), user["id"])
    return {"ok": True}
