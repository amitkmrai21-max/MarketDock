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
