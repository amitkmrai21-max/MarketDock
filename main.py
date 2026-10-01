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
