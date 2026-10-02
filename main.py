import json
import os
from fastapi import Body, FastAPI, Header, HTTPException
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

    if email not in users:
        # First time registration
        users[email] = {
            "email": email,
            "user_id": req.user_id,
            "created_at": now,
            "trial_expires_at": now + trial_duration,
            "plan": "trial",
            "is_paid": False
        }
        with open(USER_DB_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=2)
    
    user_data = users[email]
    
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

    # Validate allowed plan amounts (INR in Rupees -> paise)
    amount_in_paise = int(req.amount * 100)
    receipt_id = f"rcpt_{int(time.time())}_{req.amount}"

    try:
        r = requests.post(
            "https://api.razorpay.com/v1/orders",
            auth=(key_id, key_secret),
            json={
                "amount": amount_in_paise,
                "currency": "INR",
                "receipt": receipt_id,
                "notes": {
                    "email": req.email,
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

    # Save paid status to user_subscriptions.json
    email = req.email.strip().lower()
    if email:
        users = {}
        if os.path.exists(USER_DB_FILE):
            try:
                with open(USER_DB_FILE, "r", encoding="utf-8") as f:
                    users = json.load(f)
            except Exception:
                users = {}
        now = int(time.time())
        if email not in users:
            users[email] = {"email": email, "created_at": now}
        users[email]["is_paid"] = True
        users[email]["plan"] = req.plan_name
        users[email]["payment_id"] = req.razorpay_payment_id
        users[email]["paid_at"] = now
        users[email]["amount"] = req.amount
        plan_lower = (req.plan_name or "").lower()
        if "month" in plan_lower:
            days = 30
        elif "quarter" in plan_lower:
            days = 90
        elif "half" in plan_lower:
            days = 180
        else:
            days = 365
        users[email]["valid_until_ts"] = now + (days * 86400)
        with open(USER_DB_FILE, "w", encoding="utf-8") as f:
            json.dump(users, f, indent=2)

    return {
        "status": "success",
        "verified": True,
        "payment_id": req.razorpay_payment_id,
        "plan": req.plan_name
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

    return {
        "email": email,
        "is_paid": is_paid,
        "plan": user_info.get("plan"),
        "amount": user_info.get("amount"),
        "paid_at": paid_at,
        "valid_until_ts": valid_until_ts,
        "valid_until": valid_until_iso
    }

