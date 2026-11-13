"""Quiz Studio Pro API: Edge TTS plus SQLite-backed account management.

Kokoro and Piper are intentionally reported unavailable until their real runtimes/models
are installed and configured; this service never fabricates audio or voice availability.
"""
from __future__ import annotations
import asyncio, hashlib, hmac, os, secrets, sqlite3, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import edge_tts
import jwt
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("QSP_DB_PATH", str(ROOT / "quizstudio.sqlite3")))
JWT_SECRET = os.getenv("QSP_JWT_SECRET", "")
BOOTSTRAP_SECRET = os.getenv("QSP_BOOTSTRAP_SECRET", "")
REGISTRATION_CODE = os.getenv("QSP_REGISTRATION_CODE", "")
TOKEN_HOURS = int(os.getenv("QSP_TOKEN_HOURS", "72"))
CORS_ORIGINS = [x.strip() for x in os.getenv("QSP_CORS_ORIGINS", "").split(",") if x.strip()]
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
if not JWT_SECRET:
    # Dev fallback only. Production must set a persistent high-entropy secret.
    JWT_SECRET = secrets.token_urlsafe(48)

app = FastAPI(title="Quiz Studio Pro API", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS or ["*"], allow_credentials=False,
                   allow_methods=["GET", "POST", "PATCH", "OPTIONS"], allow_headers=["*"], expose_headers=["X-TTS-Engine"])
(ROOT / "admin-ui").mkdir(exist_ok=True)
app.mount("/admin-ui", StaticFiles(directory=ROOT / "admin-ui", html=True), name="admin-ui")


def connect():
    c = sqlite3.connect(DB_PATH, timeout=20); c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL"); c.execute("PRAGMA foreign_keys=ON")
    return c


def init_db():
    with connect() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
          plan TEXT NOT NULL DEFAULT 'Free', expires_at TEXT, enabled INTEGER NOT NULL DEFAULT 1,
          device_id TEXT, device_name TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          jti TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          device_id TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        """)


init_db()


def now(): return datetime.now(timezone.utc)
def iso(dt): return dt.astimezone(timezone.utc).isoformat()
def password_hash(password: str, salt: Optional[bytes] = None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return salt.hex() + "$" + digest.hex()
def password_ok(password: str, stored: str):
    try:
        salt_hex, digest_hex = stored.split("$", 1)
        return hmac.compare_digest(password_hash(password, bytes.fromhex(salt_hex)), salt_hex + "$" + digest_hex)
    except Exception: return False


def issue_token(user, device_id):
    jti = secrets.token_urlsafe(24); exp = now() + timedelta(hours=TOKEN_HOURS)
    token = jwt.encode({"sub": str(user["id"]), "role": user["role"], "jti": jti, "iat": now(), "exp": exp}, JWT_SECRET, algorithm="HS256")
    with connect() as c:
        c.execute("INSERT INTO sessions(jti,user_id,device_id,expires_at) VALUES(?,?,?,?)", (jti,user["id"],device_id,iso(exp)))
    return token, exp


def session_user(authorization: Optional[str], device_id: Optional[str] = None):
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "invalid_session")
    try: payload = jwt.decode(authorization.split(None,1)[1], JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError: raise HTTPException(401, "invalid_session")
    with connect() as c:
        row = c.execute("""SELECT u.*,s.device_id AS session_device,s.revoked,s.expires_at AS session_exp
          FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.jti=? AND u.id=?""", (payload["jti"], int(payload["sub"]))).fetchone()
    if not row or row["revoked"] or not row["enabled"]: raise HTTPException(401, "account_disabled" if row else "invalid_session")
    if datetime.fromisoformat(row["session_exp"]) <= now(): raise HTTPException(401, "invalid_session")
    if row["expires_at"] and datetime.fromisoformat(row["expires_at"]) <= now(): raise HTTPException(403, "plan_expired")
    if device_id and row["role"] != "admin" and row["session_device"] != device_id: raise HTTPException(403, "device_mismatch")
    return row


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    deviceId: str = Field(min_length=1, max_length=200)
    deviceName: str = Field(default="", max_length=120)
class RegisterBody(LoginBody):
    inviteCode: str = Field(min_length=1, max_length=200)
class BootstrapBody(BaseModel):
    bootstrapSecret: str
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=12, max_length=256)
class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=12, max_length=256)
    plan: str = Field(default="Standard", max_length=40)
    expiresAt: Optional[str] = None
class PasswordBody(BaseModel):
    oldPassword: str
    newPassword: str = Field(min_length=12, max_length=256)
    deviceId: str

@app.get("/api/health")
async def health():
    return {"ok": True, "engines": {"edge": {"available": True}, "kokoro": {"available": False, "reason": "Kokoro runtime/model not configured"}, "piper": {"available": False, "reason": "Piper runtime/model not configured"}}}

@app.get("/api/voices")
async def voices():
    try:
        items = await edge_tts.list_voices()
        return {"voices": [{"id":v["ShortName"], "label":v.get("FriendlyName",v["ShortName"]),
            "gender":v.get("Gender","Unknown").lower(), "lang":v.get("Locale","")} for v in items]}
    except Exception as e: raise HTTPException(503, "Edge TTS voice discovery failed: " + str(e))

class TTSBody(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    voice: str = Field(min_length=2, max_length=100)
    speed: float = Field(default=1.0, ge=0.7, le=1.5)
    engine: Optional[str] = None

@app.post("/api/tts")
async def synthesize(body: TTSBody):
    engine = body.engine or "edge"
    if engine != "edge": raise HTTPException(503, f"{engine} is unavailable: its inference runtime and model are not installed")
    try:
        rate = f"{round((body.speed - 1) * 100):+d}%"
        fd, path = tempfile.mkstemp(suffix=".mp3"); os.close(fd)
        try:
            await edge_tts.Communicate(body.text, body.voice, rate=rate).save(path)
            if os.path.getsize(path) < 256: raise RuntimeError("TTS returned an empty or incomplete audio file")
            return FileResponse(path, media_type="audio/mpeg", filename="narration.mp3", headers={"X-TTS-Engine":"edge"}, background=BackgroundTask(lambda: Path(path).unlink(missing_ok=True)))
        finally:
            pass
    except HTTPException: raise
    except Exception as e: raise HTTPException(502, "Edge TTS failed: " + str(e))

@app.post("/admin/bootstrap")
def bootstrap(body: BootstrapBody):
    if not BOOTSTRAP_SECRET or not hmac.compare_digest(body.bootstrapSecret, BOOTSTRAP_SECRET): raise HTTPException(403, "invalid_bootstrap_secret")
    with connect() as c:
        if c.execute("SELECT 1 FROM users WHERE role='admin' LIMIT 1").fetchone(): raise HTTPException(409, "admin_already_initialized")
        c.execute("INSERT INTO users(username,password_hash,role,plan,created_at) VALUES(?,?,?,?,?)", (body.username.lower(),password_hash(body.password),"admin","Admin",iso(now())))
    return {"ok":True,"message":"First administrator created"}

@app.post("/account/register")
def register(body: RegisterBody):
    if not REGISTRATION_CODE or not hmac.compare_digest(body.inviteCode, REGISTRATION_CODE): raise HTTPException(403, "invalid_registration_code")
    with connect() as c:
        try: c.execute("INSERT INTO users(username,password_hash,role,plan,device_id,device_name,created_at) VALUES(?,?,?,?,?,?,?)", (body.username.lower(),password_hash(body.password),"user","Free",body.deviceId,body.deviceName,iso(now())))
        except sqlite3.IntegrityError: raise HTTPException(409, "username_taken")
        user = c.execute("SELECT * FROM users WHERE username=?",(body.username.lower(),)).fetchone()
    token, exp = issue_token(user, body.deviceId)
    return {"ok":True,"token":token,"username":user["username"],"plan":user["plan"],"expiresAt":user["expires_at"],"tokenExpiresAt":iso(exp)}

@app.post("/account/login")
def login(body: LoginBody):
    with connect() as c: user = c.execute("SELECT * FROM users WHERE username=?",(body.username.lower(),)).fetchone()
    if not user or not password_ok(body.password,user["password_hash"]): raise HTTPException(401,"invalid_credentials")
    if not user["enabled"]: raise HTTPException(403,"account_disabled")
    if user["expires_at"] and datetime.fromisoformat(user["expires_at"]) <= now(): raise HTTPException(403,"plan_expired")
    if user["role"] != "admin" and user["device_id"] and user["device_id"] != body.deviceId: raise HTTPException(403,"device_mismatch")
    if user["role"] != "admin":
        with connect() as c:
            c.execute("UPDATE users SET device_id=COALESCE(device_id,?),device_name=? WHERE id=?",(body.deviceId,body.deviceName,user["id"]))
    token, exp = issue_token(user,body.deviceId)
    return {"ok":True,"token":token,"username":user["username"],"plan":user["plan"],"expiresAt":user["expires_at"],"tokenExpiresAt":iso(exp)}

@app.post("/account/validate")
def validate(request: Request, authorization: Optional[str] = Header(default=None)):
    device_id = request.headers.get("x-device-id")
    user = session_user(authorization, device_id)
    return {"ok":True,"username":user["username"],"plan":user["plan"],"expiresAt":user["expires_at"]}

@app.post("/account/change-password")
def change_password(body: PasswordBody, authorization: Optional[str] = Header(default=None)):
    user = session_user(authorization,body.deviceId)
    if not password_ok(body.oldPassword,user["password_hash"]): raise HTTPException(400,"wrong_old_password")
    with connect() as c:
        c.execute("UPDATE users SET password_hash=? WHERE id=?",(password_hash(body.newPassword),user["id"]))
        c.execute("UPDATE sessions SET revoked=1 WHERE user_id=?",(user["id"],))
    return {"ok":True,"reauthenticate":True}

@app.get("/admin/users")
def list_users(authorization: Optional[str] = Header(default=None)):
    admin = session_user(authorization)
    if admin["role"] != "admin": raise HTTPException(403,"admin_required")
    with connect() as c: rows = c.execute("SELECT id,username,role,plan,expires_at,enabled,device_name,created_at FROM users ORDER BY id").fetchall()
    return {"users":[dict(r) for r in rows]}

@app.post("/admin/users")
def create_user(body: UserCreate, authorization: Optional[str] = Header(default=None)):
    admin = session_user(authorization)
    if admin["role"] != "admin": raise HTTPException(403,"admin_required")
    with connect() as c:
        try: c.execute("INSERT INTO users(username,password_hash,role,plan,expires_at,created_at) VALUES(?,?,?,?,?,?)",(body.username.lower(),password_hash(body.password),"user",body.plan,body.expiresAt,iso(now())))
        except sqlite3.IntegrityError: raise HTTPException(409,"username_taken")
    return {"ok":True}

class UserUpdate(BaseModel):
    enabled: Optional[bool] = None
    newPassword: Optional[str] = Field(default=None, min_length=12, max_length=256)
    plan: Optional[str] = Field(default=None,max_length=40)
    expiresAt: Optional[str] = None
    resetDevice: bool = False

@app.patch("/admin/users/{user_id}")
def update_user(user_id: int, body: UserUpdate, authorization: Optional[str] = Header(default=None)):
    admin = session_user(authorization)
    if admin["role"] != "admin": raise HTTPException(403,"admin_required")
    with connect() as c:
        row = c.execute("SELECT id FROM users WHERE id=?",(user_id,)).fetchone()
        if not row: raise HTTPException(404,"user_not_found")
        if body.enabled is not None: c.execute("UPDATE users SET enabled=? WHERE id=?",(int(body.enabled),user_id))
        if body.plan is not None: c.execute("UPDATE users SET plan=? WHERE id=?",(body.plan,user_id))
        if "expiresAt" in body.model_fields_set: c.execute("UPDATE users SET expires_at=? WHERE id=?",(body.expiresAt,user_id))
        if body.resetDevice: c.execute("UPDATE users SET device_id=NULL,device_name=NULL WHERE id=?",(user_id,)); c.execute("UPDATE sessions SET revoked=1 WHERE user_id=?",(user_id,))
        if body.newPassword: c.execute("UPDATE users SET password_hash=? WHERE id=?",(password_hash(body.newPassword),user_id)); c.execute("UPDATE sessions SET revoked=1 WHERE user_id=?",(user_id,))
        if body.enabled is False: c.execute("UPDATE sessions SET revoked=1 WHERE user_id=?",(user_id,))
    return {"ok":True}

@app.post("/account/logout")
def logout(authorization: Optional[str] = Header(default=None)):
    user = session_user(authorization)
    payload = jwt.decode(authorization.split(None,1)[1], JWT_SECRET, algorithms=["HS256"])
    with connect() as c: c.execute("UPDATE sessions SET revoked=1 WHERE jti=?",(payload["jti"],))
    return {"ok":True}
