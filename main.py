import json
import os
import math
from fastapi import Body, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
import requests

app = FastAPI(title="MarketDock - Indian Stock Market")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

NO_CACHE_PATHS = {"/", "/frontend/index.html", "/frontend/sw.js"}


@app.middleware("http")
async def no_cache_app_shell(request, call_next):
    response = await call_next(request)
    if request.url.path in NO_CACHE_PATHS:
        response.headers["Cache-Control"] = "no-cache"
    return response


SUPABASE_URL = "https://qvgfxtjwgrtytjdjcebj.supabase.co"
SUPABASE_ANON_KEY = "sb_publishable_DRsCPkKaKRYPrQDFtqV0xQ_7QeP4kYh"


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "MarketDock Indian Market"}


@app.post("/api/account/delete")
def delete_account(
    authorization: str = Header(None),
    body: dict = Body(default={}),
):
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    if not token:
        token = body.get("access_token")

    if not token:
        raise HTTPException(status_code=401, detail="Missing authorization token")

    user_resp = requests.get(
        f"{SUPABASE_URL}/auth/v1/user",
        headers={
            "apikey": SUPABASE_ANON_KEY,
            "Authorization": f"Bearer {token}",
        },
        timeout=10,
    )
    if user_resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid session token")

    user_id = user_resp.json().get("id")
    if not user_id:
        raise HTTPException(status_code=400, detail="Could not identify user")

    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not service_role_key:
        raise HTTPException(
            status_code=500,
            detail="Account deletion is not configured on the server (missing service role key)",
        )

    del_resp = requests.delete(
        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        headers={
            "apikey": service_role_key,
            "Authorization": f"Bearer {service_role_key}",
        },
        timeout=10,
    )
    if del_resp.status_code not in (200, 204):
        raise HTTPException(
            status_code=502,
            detail="Failed to delete user account via auth service",
        )

    return {"status": "deleted", "user_id": user_id}


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def read_root():
    return FileResponse("frontend/index.html")


@app.get("/favicon.ico")
def favicon():
    return FileResponse("frontend/favicon.ico")


@app.get("/robots.txt")
def robots():
    content = "User-agent: *\nAllow: /\nSitemap: https://marketdock.in/sitemap.xml\n"
    return Response(content=content, media_type="text/plain")


@app.get("/sitemap.xml")
def sitemap():
    content = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://marketdock.in/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>"""
    return Response(content=content, media_type="application/xml")


# ================= ANDROID DIGITAL ASSET LINKS =================
@app.get("/.well-known/assetlinks.json")
def get_assetlinks():
    try:
        with open("/opt/marketdock/frontend/.well-known/assetlinks.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception as e:
        return [{
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": "in.marketdock.app",
                "sha256_cert_fingerprints": ["SHA256_FINGERPRINT_PLACEHOLDER"]
            }
        }]


# ================= USER TRIAL & SUBSCRIPTION TRACKER =================
import time, json, os
from pydantic import BaseModel

USER_DB_FILE = "/opt/marketdock/user_subscriptions.json"

# Trial / plan records (and broker links below) are JSON files that several
# requests — and both MarketDock services — change at the same time. JsonStore
# serialises every read-modify-write (thread lock + file lock), writes to a
# unique temp file and swaps it in atomically, and keeps the last good file as
# .bak. An unreadable file is never treated as empty — that would let the
# next save wipe every trial and payment — the .bak is used instead, or the
# request fails until someone looks at it.
import contextlib
import copy
import shutil
import threading

try:
    import fcntl
except ImportError:  # not on Linux; the thread lock still applies
    fcntl = None


class StoreUnavailable(Exception):
    pass


class JsonStore:
    def __init__(self, path):
        self.path = path
        self._lock = threading.RLock()
        self._stamp = None
        self._data = None

    @contextlib.contextmanager
    def locked(self):
        with self._lock:
            handle = None
            try:
                if fcntl:
                    handle = open(self.path + ".lock", "a")
                    fcntl.flock(handle, fcntl.LOCK_EX)
                yield
            finally:
                if handle:
                    fcntl.flock(handle, fcntl.LOCK_UN)
                    handle.close()

    @staticmethod
    def _read(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("not a JSON object")
        return data

    def load(self):
        """All records — read-only; use load_for_update() under locked() to change them."""
        backup = self.path + ".bak"
        if not os.path.exists(self.path):
            return self._read(backup) if os.path.exists(backup) else {}
        info = os.stat(self.path)
        stamp = (info.st_mtime_ns, info.st_size)
        if self._stamp == stamp:
            return self._data
        try:
            data = self._read(self.path)
        except (OSError, ValueError) as error:
            print(f"{self.path} unreadable ({error}); using the backup copy.")
            try:
                return self._read(backup)
            except (OSError, ValueError) as backup_error:
                raise StoreUnavailable(f"{self.path} and its backup are unreadable: {backup_error}") from error
        self._stamp, self._data = stamp, data
        return data

    def load_for_update(self):
        return copy.deepcopy(self.load())

    def save(self, data):
        tmp = f"{self.path}.{os.getpid()}.{threading.get_ident()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(self.path):
            try:
                self._read(self.path)
                shutil.copyfile(self.path, self.path + ".bak")
            except (OSError, ValueError):
                pass  # never back up a broken file over a good backup
        os.replace(tmp, self.path)
        info = os.stat(self.path)
        self._stamp, self._data = (info.st_mtime_ns, info.st_size), data


user_store = JsonStore(USER_DB_FILE)


def _load_users_or_503():
    try:
        return user_store.load()
    except StoreUnavailable as error:
        print(error)
        raise HTTPException(status_code=503, detail="Account records are temporarily unavailable. Please try again in a minute.")

class TrialCheckRequest(BaseModel):
    email: str
    user_id: str = ""

@app.post("/api/user/sync-trial")
def sync_user_trial(req: TrialCheckRequest):
    email = req.email.strip().lower()
    if not email:
        return {"error": "Email is required"}
    
    now = int(time.time())
    trial_duration = 7 * 24 * 3600  # 7 Days in seconds

    # An email keeps its first record for good (logout / account delete never
    # remove it), so signing up again doesn't start a fresh trial. A record
    # made earlier by /api/subscription/status may lack the sign-up fields.
    user_data = _load_users_or_503().get(email)
    if not user_data or not user_data.get("created_at") or not user_data.get("trial_expires_at"):
        with user_store.locked():
            try:
                users = user_store.load_for_update()
            except StoreUnavailable as error:
                print(error)
                raise HTTPException(status_code=503, detail="Account records are temporarily unavailable. Please try again in a minute.")
            user_data = users.get(email)
            if not user_data or not user_data.get("created_at") or not user_data.get("trial_expires_at"):
                user_data = user_data or {"plan": "trial", "is_paid": False}
                started = user_data.get("created_at") or user_data.get("trial_start_ts") or now
                user_data.setdefault("email", email)
                user_data.setdefault("user_id", req.user_id)
                user_data["created_at"] = started
                user_data["trial_expires_at"] = started + trial_duration
                users[email] = user_data
                user_store.save(users)
    
    # Calculate days
    seconds_passed = now - user_data["created_at"]
    days_passed = seconds_passed // 86400
    days_left = max(0, 7 - days_passed)
    is_expired = now > user_data["trial_expires_at"] and not user_data.get("is_paid", False)

    return {
        "email": email,
        "is_expired": is_expired,
        "days_left": days_left,
        "days_passed": days_passed,
        "is_paid": user_data.get("is_paid", False),
        "plan": user_data.get("plan", "trial")
    }



# ================= OWNER ANALYTICS (amitkmrai21@gmail.com Only) =================
def _verified_session_email(authorization: str = None) -> str:
    """Email of the signed-in Supabase user behind a Bearer token, or "" when
    there is none. An email typed into the URL proves nothing, so it is never used."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return ""
    token = authorization.split(" ", 1)[1].strip()
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/auth/v1/user",
            headers={"apikey": SUPABASE_ANON_KEY, "Authorization": f"Bearer {token}"},
            timeout=5,
        )
        if resp.status_code == 200:
            return (resp.json().get("email") or "").strip().lower()
    except Exception:
        pass
    return ""

# ================= WHO IS USING MARKETDOCK RIGHT NOW (owner sees the count) =================
# The app and the website send a small "I am here" beat every 30 seconds while
# they are open and visible. A signed-in person counts once by email, however
# many phones, tabs or browsers they have open; someone not signed in counts
# once per device. Only the counts leave this module, never who they are.
PRESENCE_WINDOW_SECONDS = 60
PRESENCE_FIVE_MIN_SECONDS = 300
PRESENCE_KEEP_SECONDS = 900
_presence = {}          # key -> last seen (key is "e:<email>" or "d:<device hash>")
_presence_lock = threading.Lock()
_presence_token_emails = {}   # sha256(token) -> (email, expires_at): spares Supabase a call per beat
PRESENCE_TOKEN_CACHE_SECONDS = 300


def _presence_email(authorization):
    if not authorization or not authorization.lower().startswith("bearer "):
        return ""
    token = authorization.split(" ", 1)[1].strip()
    key = hashlib.sha256(token.encode("utf-8", "ignore")).hexdigest()
    now = time.time()
    cached = _presence_token_emails.get(key)
    if cached and cached[1] > now:
        return cached[0]
    email = _verified_session_email(authorization)
    if len(_presence_token_emails) > 2000:
        for stale in [k for k, (_, exp) in _presence_token_emails.items() if exp <= now]:
            _presence_token_emails.pop(stale, None)
    if email:
        _presence_token_emails[key] = (email, now + PRESENCE_TOKEN_CACHE_SECONDS)
    return email


def _presence_device_key(request):
    forwarded = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = forwarded or (request.client.host if request.client else "")
    raw = f"{ip}|{request.headers.get('user-agent', '')}"
    return "d:" + hashlib.sha256(raw.encode("utf-8", "ignore")).hexdigest()[:16]


@app.post("/api/presence")
def presence_beat(request: Request, authorization: str = Header(None)):
    email = _presence_email(authorization)
    key = f"e:{email}" if email else _presence_device_key(request)
    now = time.time()
    with _presence_lock:
        _presence[key] = now
        if len(_presence) > 5000:
            for stale in [k for k, seen in _presence.items() if now - seen > PRESENCE_KEEP_SECONDS]:
                _presence.pop(stale, None)
    return {"ok": True}


def _presence_counts():
    now = time.time()
    with _presence_lock:
        recent = [(key, now - seen) for key, seen in _presence.items()]
    last_minute = [key for key, age in recent if age <= PRESENCE_WINDOW_SECONDS]
    five_min = [key for key, age in recent if age <= PRESENCE_FIVE_MIN_SECONDS]
    return {
        "now": len(last_minute),
        "five_min": len(five_min),
        "logged_in_now": sum(1 for key in last_minute if key.startswith("e:")),
        "guests_now": sum(1 for key in last_minute if key.startswith("d:")),
    }


@app.get("/api/owner/active")
def get_owner_active(authorization: str = Header(None)):
    if _verified_session_email(authorization) != "amitkmrai21@gmail.com":
        raise HTTPException(status_code=403, detail="Unauthorized: Owner account only")
    return {"ok": True, **_presence_counts()}


@app.get("/api/owner/analytics")
def get_owner_analytics(authorization: str = Header(None)):
    owner_mail = "amitkmrai21@gmail.com"
    # Only the signed-in owner (verified through the Supabase session token).
    if _verified_session_email(authorization) != owner_mail:
        raise HTTPException(status_code=403, detail="Unauthorized: Owner account only")

    users = _load_users_or_503()
    now = int(time.time())
    active_subscribers = 0
    total_paid_ever = 0
    subscribers_list = []
    all_emails = set(users.keys())

    # Include paper trade users if exists
    for p_path in ["/opt/marketdock/user_paper_trades.json", "user_paper_trades.json"]:
        if os.path.exists(p_path):
            try:
                with open(p_path, "r", encoding="utf-8") as f:
                    pdata = json.load(f)
                    if isinstance(pdata, dict):
                        all_emails.update(pdata.keys())
            except Exception:
                pass

    for u_email, u in users.items():
        if not isinstance(u, dict):
            continue
        is_paid = bool(u.get("is_paid", False))
        valid_until = u.get("valid_until_ts") or 0
        has_payments = bool(u.get("payment_ids") or (is_paid and valid_until > 0) or u.get("payment_id"))
        is_active = bool(is_paid and valid_until > now)

        if has_payments:
            total_paid_ever += 1
        if is_active:
            active_subscribers += 1

        if has_payments:
            import datetime
            valid_until_str = ""
            if valid_until:
                valid_until_str = datetime.datetime.fromtimestamp(valid_until).strftime("%d %b %Y, %I:%M %p")
            paid_at_str = ""
            if u.get("paid_at"):
                paid_at_str = datetime.datetime.fromtimestamp(u["paid_at"]).strftime("%d %b %Y")

            subscribers_list.append({
                "email": u_email,
                "plan": u.get("plan") or "Subscription",
                "amount": u.get("amount") or (PLAN_CATALOG.get(u.get("plan", ""), {}).get("amount", 0)),
                "is_active": is_active,
                "status": "Active" if is_active else "Expired",
                "valid_until_ts": valid_until,
                "valid_until": valid_until_str,
                "paid_at": paid_at_str,
                "payment_id": u.get("payment_id") or (u.get("payment_ids")[-1] if u.get("payment_ids") else "")
            })

    subscribers_list.sort(key=lambda s: (1 if s["is_active"] else 0, s["valid_until_ts"]), reverse=True)

    supabase_count = 0
    service_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if service_key:
        try:
            resp = requests.get(
                f"{SUPABASE_URL}/auth/v1/admin/users?per_page=1",
                headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
                timeout=3,
            )
            if resp.status_code == 200:
                cr = resp.headers.get("Content-Range", "")
                if "/" in cr:
                    supabase_count = int(cr.split("/")[-1])
        except Exception:
            pass

    total_registered = max(len(all_emails), supabase_count)

    return {
        "ok": True,
        "total_registered": total_registered,
        "total_subscribers": total_paid_ever,
        "active_subscribers": active_subscribers,
        "subscribers": subscribers_list,
        "timestamp": now,
    }

# ================= RAZORPAY INTEGRATION =================
import hmac
import hashlib

def _load_env():
    for p in ["/opt/marketdock/.env", ".env"]:
        if os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            k = k.strip()
                            v = v.strip().strip("\"'")
                            if k and not os.environ.get(k):
                                os.environ[k] = v
            except Exception:
                pass

_load_env()

class RazorpayOrderRequest(BaseModel):
    plan_name: str = "Annual Plan"
    amount: int = 999
    email: str = ""

class RazorpayVerifyRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str
    email: str = ""
    plan_name: str = "Annual Plan"
    amount: int = 999

# Plan prices and lengths live on the server: the browser only names a plan,
# and the paid amount is checked against this table before access is given.
PLAN_CATALOG = {
    "Monthly Plan": {"amount": 99, "days": 30},
    "Quarterly Plan": {"amount": 299, "days": 90},
    "Half-Yearly Plan": {"amount": 499, "days": 180},
    "Annual Plan": {"amount": 999, "days": 365},
}


@app.get("/api/payment/config")
def get_payment_config():
    _load_env()
    key_id = os.environ.get("RAZORPAY_KEY_ID", "")
    return {"key_id": key_id}

@app.post("/api/payment/create-order")
def create_razorpay_order(req: RazorpayOrderRequest):
    _load_env()
    key_id = os.environ.get("RAZORPAY_KEY_ID")
    key_secret = os.environ.get("RAZORPAY_KEY_SECRET")
    if not key_id or not key_secret:
        raise HTTPException(status_code=500, detail="Razorpay credentials not configured in server .env")

    plan = PLAN_CATALOG.get(req.plan_name)
    if not plan:
        raise HTTPException(status_code=400, detail="Unknown plan")
    # A payment without an account email can't be given a plan, so don't take it.
    if "@" not in (req.email or ""):
        raise HTTPException(status_code=400, detail="Please sign in first, then choose a plan.")
    amount_in_paise = plan["amount"] * 100
    receipt_id = f"rcpt_{int(time.time())}_{plan['amount']}"

    try:
        r = requests.post(
            "https://api.razorpay.com/v1/orders",
            auth=(key_id, key_secret),
            json={
                "amount": amount_in_paise,
                "currency": "INR",
                "receipt": receipt_id,
                "notes": {
                    "app": "marketdock",
                    "email": (req.email or "").strip().lower(),
                    "plan": req.plan_name
                }
            },
            timeout=10
        )
        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Razorpay order failed: {r.text}")
        order_data = r.json()
        return {
            "order_id": order_data.get("id"),
            "amount": amount_in_paise,
            "currency": "INR",
            "key_id": key_id,
            "plan_name": req.plan_name
        }
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        raise HTTPException(status_code=500, detail=f"Error connecting to Razorpay: {str(e)}")

def _grant_plan_for_payment(order_id, payment_id, email_hint=""):
    """Asks Razorpay itself about the payment and, if it is a real MarketDock
    plan payment, gives the plan (once per payment id). Used by the browser's
    verify step and by the webhook, so a payment is never lost when the tab
    closes before verify runs."""
    key_id = os.environ.get("RAZORPAY_KEY_ID")
    key_secret = os.environ.get("RAZORPAY_KEY_SECRET")
    # The plan, amount and email come from Razorpay's own order/payment
    # records, not the browser — so paying for one plan can't unlock another.
    try:
        order_res = requests.get(f"https://api.razorpay.com/v1/orders/{order_id}", auth=(key_id, key_secret), timeout=10)
        payment_res = requests.get(f"https://api.razorpay.com/v1/payments/{payment_id}", auth=(key_id, key_secret), timeout=10)
    except Exception:
        raise HTTPException(status_code=502, detail="Could not confirm the payment with Razorpay")
    if order_res.status_code != 200 or payment_res.status_code != 200:
        print(f"Razorpay lookup failed for {payment_id}: orders {order_res.status_code}, payments {payment_res.status_code}")
        raise HTTPException(status_code=502, detail="Could not confirm the payment with Razorpay")
    order, payment = order_res.json(), payment_res.json()

    notes = order.get("notes") or {}
    plan_name = notes.get("plan") if isinstance(notes, dict) else None
    plan = PLAN_CATALOG.get(plan_name)
    expected_paise = plan["amount"] * 100 if plan else None
    # CryptoDock bills through the same Razorpay account; its orders say
    # app=cryptodock and must not unlock MarketDock. (Older MarketDock orders
    # have no "app" note.)
    if (
        notes.get("app") not in (None, "marketdock")
        or not plan
        or order.get("amount") != expected_paise
        or payment.get("order_id") != order_id
        or payment.get("amount") != expected_paise
        or payment.get("status") not in ("captured", "authorized")
    ):
        raise HTTPException(status_code=400, detail="Payment does not match the plan")

    email = ((notes.get("email") if isinstance(notes, dict) else "") or email_hint or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Payment has no account email")

    with user_store.locked():
        try:
            users = user_store.load_for_update()
        except StoreUnavailable as error:
            # The payment is real; say so instead of losing it silently.
            print(f"Could not record payment {payment_id} for {email}: {error}")
            raise HTTPException(status_code=503, detail=f"Payment received but could not be saved yet. Please contact support with payment ID {payment_id}.")
        now = int(time.time())
        user = users.setdefault(email, {"email": email, "created_at": now})
        seen = user.setdefault("payment_ids", [])
        if payment_id not in seen:
            # Renewing early adds to the time already paid for instead of resetting it.
            current_until = user.get("valid_until_ts") or 0
            start = current_until if user.get("is_paid") and current_until > now else now
            user["is_paid"] = True
            user["plan"] = plan_name
            user["payment_id"] = payment_id
            user["paid_at"] = now
            user["amount"] = plan["amount"]
            user["valid_until_ts"] = start + plan["days"] * 86400
            seen.append(payment_id)
            user_store.save(users)
    return {"plan": plan_name, "valid_until_ts": user["valid_until_ts"]}


@app.post("/api/payment/verify")
def verify_razorpay_payment(req: RazorpayVerifyRequest):
    _load_env()
    key_secret = os.environ.get("RAZORPAY_KEY_SECRET")
    if not key_secret:
        raise HTTPException(status_code=500, detail="RAZORPAY_KEY_SECRET missing on server")

    # Verify signature: HMAC-SHA256(order_id + "|" + payment_id, secret)
    msg = f"{req.razorpay_order_id}|{req.razorpay_payment_id}".encode("utf-8")
    generated = hmac.new(key_secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(generated, req.razorpay_signature):
        raise HTTPException(status_code=400, detail="Invalid payment signature")

    granted = _grant_plan_for_payment(req.razorpay_order_id, req.razorpay_payment_id, req.email)
    return {
        "status": "success",
        "verified": True,
        "payment_id": req.razorpay_payment_id,
        "plan": granted["plan"],
        "valid_until_ts": granted["valid_until_ts"],
    }


@app.post("/api/payment/webhook")
async def razorpay_webhook(request: Request):
    """Razorpay tells us about every captured payment, so a plan is still given
    when the customer's browser never got to call /verify (UPI app switch,
    closed tab, lost network). Needs RAZORPAY_WEBHOOK_SECRET on the server and
    a webhook for payment.captured in the Razorpay dashboard."""
    _load_env()
    secret = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")
    if not secret:
        raise HTTPException(status_code=404, detail="Not found")
    body = await request.body()
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("x-razorpay-signature", "")):
        raise HTTPException(status_code=400, detail="Invalid webhook signature")
    try:
        event = json.loads(body)
        payment = event["payload"]["payment"]["entity"]
        order_id, payment_id = payment["order_id"], payment["id"]
    except (ValueError, KeyError, TypeError):
        return {"status": "ignored"}
    if event.get("event") not in ("payment.captured", "order.paid"):
        return {"status": "ignored"}
    try:
        _grant_plan_for_payment(order_id, payment_id)
    except HTTPException as error:
        # Not ours (another app, wrong amount): nothing to retry. A temporary
        # problem (Razorpay unreachable, store busy): answer 5xx so Razorpay retries.
        if error.status_code >= 500:
            raise
        return {"status": "ignored", "reason": error.detail}
    return {"status": "ok"}


@app.get("/api/subscription/status")
def get_subscription_status(email: str = ""):
    email = (email or "").strip().lower()
    if not email:
        return {"is_paid": False, "plan": None, "active": False}
    user_info = dict(_load_users_or_503().get(email, {}))
    is_paid = bool(user_info.get("is_paid", False))
    now = int(time.time())
    paid_at = user_info.get("paid_at", 0)
    valid_until_ts = user_info.get("valid_until_ts")
    if is_paid and not valid_until_ts and paid_at:
        plan_lower = (user_info.get("plan") or "").lower()
        if "month" in plan_lower:
            days = 30
        elif "quarter" in plan_lower:
            days = 90
        elif "half" in plan_lower:
            days = 180
        else:
            days = 365
        valid_until_ts = paid_at + (days * 86400)

    # Check if expired
    if valid_until_ts and now > valid_until_ts:
        is_paid = False

    valid_until_iso = None
    if valid_until_ts:
        import datetime
        valid_until_iso = datetime.datetime.fromtimestamp(valid_until_ts, tz=datetime.timezone.utc).isoformat()

    # Track 7-day trial per email — one clock per email for good: it starts
    # at the first sign-up (created_at, from /api/user/sync-trial) and is
    # never reset by logging out, deleting the account or signing up again.
    trial_start_ts = user_info.get("trial_start_ts") or user_info.get("created_at")
    trial_duration = 7 * 86400
    if not is_paid:
        if not user_info.get("trial_start_ts"):
            trial_start_ts = trial_start_ts or now
            user_info["trial_start_ts"] = trial_start_ts
            try:
                with user_store.locked():
                    users = user_store.load_for_update()
                    record = users.get(email, {})
                    if not record.get("trial_start_ts"):
                        record["trial_start_ts"] = trial_start_ts
                        users[email] = record
                        user_store.save(users)
                    trial_start_ts = record["trial_start_ts"]
            except (StoreUnavailable, OSError) as error:
                print(f"Could not record trial start for {email}: {error}")
    
    trial_end_ts = (trial_start_ts + trial_duration) if trial_start_ts else (now + trial_duration)
    time_left = trial_end_ts - now
    trial_days_remaining = max(0, int(math.ceil(time_left / 86400.0))) if time_left > 0 else 0
    trial_expired = bool(now >= trial_end_ts)
    trial_active = bool(not is_paid and not trial_expired)

    trial_end_iso = None
    if trial_end_ts:
        import datetime
        trial_end_iso = datetime.datetime.fromtimestamp(trial_end_ts, tz=datetime.timezone.utc).isoformat()

    return {
        "email": email,
        "is_paid": is_paid,
        "plan": user_info.get("plan"),
        "amount": user_info.get("amount"),
        "paid_at": paid_at,
        "valid_until_ts": valid_until_ts,
        "valid_until": valid_until_iso,
        "trial_start_ts": trial_start_ts,
        "trial_end_ts": trial_end_ts,
        "trial_end_iso": trial_end_iso,
        "trial_days_remaining": trial_days_remaining,
        "trial_expired": trial_expired,
        "trial_active": trial_active
    }

