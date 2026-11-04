// Focus Radar (owner only): the menu entry and an empty page, ready for new content.
// Only the signed-in owner can see it: the menu entry stays hidden until the server confirms the owner session,
// and the server checks the owner again on every request.
(function marketDockFocusRadar() {
  const page = document.getElementById("im-focus-radar");
  const navButton = document.querySelector('.nav-button[data-page="im-focus-radar"]');
  if (!page || !navButton) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";

  // The menu entry is only a convenience (the server checks the owner on every request). A definite "no"
  // (signed out / not the owner) hides it; a temporary failure (server restarting, network) keeps what was
  // shown before and tries again a few times instead of hiding the entry for good.
  const ALLOWED_KEY = "marketdock_focus_radar_allowed";
  const readCached = () => { try { return localStorage.getItem(ALLOWED_KEY) === "1"; } catch (e) { return false; } };
  const writeCached = (v) => { try { v ? localStorage.setItem(ALLOWED_KEY, "1") : localStorage.removeItem(ALLOWED_KEY); } catch (e) { /* ignore */ } };
  let retryTimer = null;
  async function checkAccess(attempt = 0) {
    let verdict = "error"; // yes | no | error
    try {
      const { data: session } = await window.marketDockSupabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) verdict = "no";
      else {
        const response = await fetch(API + "/api/owner/focus-radar/access", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        verdict = response.ok ? "yes" : (response.status === 401 || response.status === 403) ? "no" : "error";
      }
    } catch (e) { verdict = "error"; }
    clearTimeout(retryTimer);
    if (verdict === "error") {
      if (attempt < 4) retryTimer = setTimeout(() => checkAccess(attempt + 1), [3000, 8000, 20000, 45000][attempt]);
      return; // keep the entry as it is
    }
    const allowed = verdict === "yes";
    writeCached(allowed);
    navButton.hidden = !allowed;
    if (!allowed && page.classList.contains("active")) document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
  }
  // Show the entry straight away for a browser that was confirmed as the owner before.
  if (readCached()) navButton.hidden = false;

  // Owner check now and whenever the signed-in user changes.
  setTimeout(() => checkAccess(), 1500);
  let authWatched = false;
  function watchAuth() {
    if (authWatched) return;
    try {
      const auth = window.marketDockSupabase?.auth;
      if (auth?.onAuthStateChange) { auth.onAuthStateChange(() => setTimeout(() => checkAccess(), 400)); authWatched = true; }
    } catch (e) { /* ignore */ }
  }
  watchAuth();
  setTimeout(watchAuth, 2000);
})();
