import json
import os
import math
from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, RedirectResponse
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

class TrialCheckRequest(BaseModel):
    email: str
    user_id: str = ""

@app.post("/api/user/sync-trial")
def sync_user_trial(req: TrialCheckRequest):
    email = req.email.strip().lower()
    if not email:
        return {"error": "Email is required"}
    
    users = {}
    if os.path.exists(USER_DB_FILE):
        try:
            with open(USER_DB_FILE, "r", encoding="utf-8") as f:
                users = json.load(f)
        except Exception:
            users = {}

    now = int(time.time())
    trial_duration = 7 * 24 * 3600  # 7 Days in seconds

    # An email keeps its first record for good (logout / account delete never
    # remove it), so signing up again doesn't start a fresh trial. A record
    # made earlier by /api/subscription/status may lack the sign-up fields.
    user_data = users.get(email)
    if not user_data or not user_data.get("created_at") or not user_data.get("trial_expires_at"):
        user_data = user_data or {"plan": "trial", "is_paid": False}
        started = user_data.get("created_at") or user_data.get("trial_start_ts") or now
        user_data.setdefault("email", email)
        user_data.setdefault("user_id", req.user_id)
        user_data["created_at"] = started
        user_data["trial_expires_at"] = started + trial_duration
        users[email] = user_data
        with open(USER_DB_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=2)
    
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

    # The plan, amount and email come from Razorpay's own order/payment
    # records, not the browser — so paying for one plan can't unlock another.
    key_id = os.environ.get("RAZORPAY_KEY_ID")
    try:
        order = requests.get(f"https://api.razorpay.com/v1/orders/{req.razorpay_order_id}", auth=(key_id, key_secret), timeout=10).json()
        payment = requests.get(f"https://api.razorpay.com/v1/payments/{req.razorpay_payment_id}", auth=(key_id, key_secret), timeout=10).json()
    except Exception:
        raise HTTPException(status_code=502, detail="Could not confirm the payment with Razorpay")

    notes = order.get("notes") or {}
    plan_name = notes.get("plan") if isinstance(notes, dict) else None
    plan = PLAN_CATALOG.get(plan_name)
    expected_paise = plan["amount"] * 100 if plan else None
    if (
        not plan
        or order.get("amount") != expected_paise
        or payment.get("order_id") != req.razorpay_order_id
        or payment.get("amount") != expected_paise
        or payment.get("status") not in ("captured", "authorized")
    ):
        raise HTTPException(status_code=400, detail="Payment does not match the plan")

    email = ((notes.get("email") if isinstance(notes, dict) else "") or req.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Payment has no account email")

    users = {}
    if os.path.exists(USER_DB_FILE):
        try:
            with open(USER_DB_FILE, "r", encoding="utf-8") as f:
                users = json.load(f)
        except Exception:
            users = {}
    now = int(time.time())
    user = users.setdefault(email, {"email": email, "created_at": now})
    seen = user.setdefault("payment_ids", [])
    if req.razorpay_payment_id not in seen:
        # Renewing early adds to the time already paid for instead of resetting it.
        current_until = user.get("valid_until_ts") or 0
        start = current_until if user.get("is_paid") and current_until > now else now
        user["is_paid"] = True
        user["plan"] = plan_name
        user["payment_id"] = req.razorpay_payment_id
        user["paid_at"] = now
        user["amount"] = plan["amount"]
        user["valid_until_ts"] = start + plan["days"] * 86400
        seen.append(req.razorpay_payment_id)
        with open(USER_DB_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=2)

    return {
        "status": "success",
        "verified": True,
        "payment_id": req.razorpay_payment_id,
        "plan": plan_name,
        "valid_until_ts": user["valid_until_ts"],
    }

@app.get("/api/subscription/status")
def get_subscription_status(email: str = ""):
    email = (email or "").strip().lower()
    if not email:
        return {"is_paid": False, "plan": None, "active": False}
    users = {}
    if os.path.exists(USER_DB_FILE):
        try:
            with open(USER_DB_FILE, "r", encoding="utf-8") as f:
                users = json.load(f)
        except Exception:
            users = {}
    user_info = users.get(email, {})
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
            users[email] = user_info
            try:
                with open(USER_DB_FILE, "w", encoding="utf-8") as f:
                    json.dump(users, f, indent=2)
            except Exception:
                pass
    
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



# ================= BROKER OAUTH (UPSTOX) =================
# Each MarketDock user connects their *own* Upstox account. The connection is
# keyed by that user's MarketDock email, carried through Upstox's OAuth
# `state` in a signed (HMAC) form so a callback can't be pointed at someone
# else's email. Status / disconnect only ever touch the email asked about.
import base64
import time as _time
import urllib.parse

UPSTOX_APP_KEY = os.environ.get("UPSTOX_APP_KEY", "").strip()
UPSTOX_APP_SECRET = os.environ.get("UPSTOX_APP_SECRET", "").strip()
UPSTOX_REDIRECT_URI = os.environ.get("UPSTOX_REDIRECT_URI", "https://marketdock.in/api/broker/callback").strip()
BROKER_STORAGE_FILE = os.path.join(os.path.dirname(__file__), "user_brokers.json")
BROKER_STATE_MAX_AGE_SECONDS = 15 * 60


def load_user_brokers():
    if not os.path.exists(BROKER_STORAGE_FILE):
        return {}
    try:
        with open(BROKER_STORAGE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_user_brokers(data):
    try:
        with open(BROKER_STORAGE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def _normalize_email(email):
    email = (email or "").strip().lower()
    return email if "@" in email and len(email) <= 254 else ""


def _sign_broker_state(email):
    payload = base64.urlsafe_b64encode(json.dumps({"e": email, "t": int(_time.time())}).encode()).decode().rstrip("=")
    sig = hmac.new(UPSTOX_APP_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{payload}.{sig}"


def _verify_broker_state(state):
    """The MarketDock email a login was started for, or "" if the state is
    missing, tampered with or older than BROKER_STATE_MAX_AGE_SECONDS."""
    try:
        payload, sig = (state or "").rsplit(".", 1)
        expected = hmac.new(UPSTOX_APP_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()[:32]
        if not hmac.compare_digest(sig, expected):
            return ""
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if _time.time() - int(data.get("t", 0)) > BROKER_STATE_MAX_AGE_SECONDS:
            return ""
        return _normalize_email(data.get("e"))
    except Exception:
        return ""


def _broker_redirect(**params):
    return RedirectResponse(url="/?" + urllib.parse.urlencode(params) + "#broker", status_code=303)


@app.get("/api/broker/login")
def broker_login(broker: str = "upstox", email: str = ""):
    if broker.lower() != "upstox":
        raise HTTPException(status_code=400, detail="Unsupported broker")
    if not UPSTOX_APP_KEY or not UPSTOX_APP_SECRET:
        return _broker_redirect(broker_error="upstox_not_configured")
    email = _normalize_email(email)
    if not email:
        return _broker_redirect(broker_error="login_required")

    auth_url = "https://api.upstox.com/v2/login/authorization/dialog?" + urllib.parse.urlencode({
        "response_type": "code",
        "client_id": UPSTOX_APP_KEY,
        "redirect_uri": UPSTOX_REDIRECT_URI,
        "state": _sign_broker_state(email),
    })
    return RedirectResponse(url=auth_url, status_code=303)


@app.get("/api/broker/callback")
def broker_callback(code: str = None, error: str = None, error_description: str = None, state: str = ""):
    if error:
        return _broker_redirect(broker_error=error_description or error)
    if not code:
        return _broker_redirect(broker_error="missing_auth_code")
    if not UPSTOX_APP_KEY or not UPSTOX_APP_SECRET:
        return _broker_redirect(broker_error="upstox_not_configured")

    email = _verify_broker_state(state)
    if not email:
        return _broker_redirect(broker_error="session_expired")

    try:
        resp = requests.post(
            "https://api.upstox.com/v2/login/authorization/token",
            headers={"accept": "application/json", "Api-Version": "2.0", "Content-Type": "application/x-www-form-urlencoded"},
            data={
                "code": code,
                "client_id": UPSTOX_APP_KEY,
                "client_secret": UPSTOX_APP_SECRET,
                "redirect_uri": UPSTOX_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            timeout=15,
        )
        token_data = resp.json()
    except Exception:
        return _broker_redirect(broker_error="upstox_unreachable")

    if resp.status_code != 200 or not token_data.get("access_token"):
        return _broker_redirect(broker_error=token_data.get("message") or token_data.get("error") or "token_exchange_failed")

    user_name = token_data.get("user_name") or "Upstox User"
    brokers = load_user_brokers()
    brokers[email] = {
        "broker": "upstox",
        "user_name": user_name,
        "user_id": token_data.get("user_id", ""),
        "connected_at": int(_time.time()),
        "is_paper_trading": True,
        "status": "connected",
    }
    save_user_brokers(brokers)
    return _broker_redirect(broker_connected="upstox", user_name=user_name)


@app.get("/api/broker/status")
def broker_status(email: str = ""):
    email = _normalize_email(email)
    user_data = load_user_brokers().get(email) if email else None
    if user_data and user_data.get("status") == "connected":
        return {
            "connected": True,
            "broker": user_data.get("broker", "upstox"),
            "user_name": user_data.get("user_name", "Upstox User"),
            "user_id": user_data.get("user_id", ""),
            "connected_at": user_data.get("connected_at"),
            "is_paper_trading": True,
        }
    return {"connected": False, "broker": "none", "is_paper_trading": True}


@app.post("/api/broker/disconnect")
def broker_disconnect(payload: dict = Body(default={})):
    email = _normalize_email(payload.get("email", "") if isinstance(payload, dict) else "")
    if not email:
        raise HTTPException(status_code=400, detail="email is required")
    brokers = load_user_brokers()
    if brokers.pop(email, None) is not None:
        save_user_brokers(brokers)
    return {"success": True, "connected": False}
