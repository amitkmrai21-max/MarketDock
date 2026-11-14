// Catch Accuracy: owner-only Smart MTF & SFP Liquidity Swings for MarketDock.
// Aligned with NIFTY 50 trend bias, covering both NSE Stocks and MCX Commodities.
(function marketDockCatchAccuracy() {
  const page = document.getElementById("im-catch-accuracy");
  const navButton = document.querySelector('.nav-button[data-page="im-catch-accuracy"]');
  const body = document.getElementById("imCatchBody");
  if (!page || !navButton || !body) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";
  let activeTab = "fib";
  let marketFilter = "all";
  let dirFilter = "all";
  const MARKET_LABELS = { all: "All Markets", nse: "NSE Stocks", mcx: "MCX Commodity" };
  const MARKETS = ["all", "nse", "mcx"];
  const DIR_LABELS = { all: "All", bullish: "Bullish", bearish: "Bearish" };
  const DIRS = ["all", "bullish", "bearish"];
  let lastData = null;
  let isLoading = false;
  let loadedAt = 0;
  const STALE_MS = 90 * 1000;
  let indexQuotes = [];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rupee = (v) => { const n = Number(v); return Number.isFinite(n) ? "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--"; };
  const pct = (v, signed = false) => Number.isFinite(Number(v)) ? `${signed && Number(v) > 0 ? "+" : ""}${Number(v).toFixed(2)}%` : "--";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtTimestamp = (value) => { const t = typeof value === "number" ? (value > 1e11 ? value : value * 1000) : Date.parse(value); if (!Number.isFinite(t)) return "just now"; const minutes = Math.max(0, Math.round((Date.now() - t) / 60000)); return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`; };
  async function getOwnerToken(waitMs = 6000) {
    const until = Date.now() + waitMs;
    for (;;) { try { const { data: s } = await window.marketDockSupabase.auth.getSession(); if (s?.session?.access_token) return s.session.access_token; } catch (_) {} if (Date.now() >= until) return null; await sleep(400); }
  }
  const COLOURS = ["#0052cc", "#172b4d", "#00875a", "#de350b", "#5243aa", "#00a3bf", "#ff5630", "#403294"];
  function avatar(symbol) { let hash = 0; for (const ch of String(symbol || "")) hash = ch.charCodeAt(0) + ((hash << 5) - hash); return `<span class="im-catch-avatar" style="background:${COLOURS[Math.abs(hash) % COLOURS.length]}">${esc(String(symbol || "").slice(0, 3))}</span>`; }
  function ticketStar() { return ""; }
  function openActionSheet(symbol, price) { if (typeof window.openImWatchlistActionSheet === "function") window.openImWatchlistActionSheet(symbol, price); }
  function card(item) {
    const bull = item.side === "bullish" || item.type === "BULLISH";
    const dir = bull ? "LONG" : "SHORT";
    const sym = esc(item.symbol || item.base || "");
    const isMcx = item.market === "mcx";
    const price = Number(item.live_price ?? item.price) || 0;
    const isFib = item.kind === "fib" || item.timeframe === "fib";
    const isAplus = item.grade === "A+" || item.liquidity_swept === true;
    const change = Number(item.change_pct ?? 0) || 0;
    const badgePill = isFib ? (isAplus ? `🔥 A+ LIQUIDITY SWEEP · ${dir}` : (item.trigger_state === "CONFIRMED" ? `🎯 SMART MTF · ${dir}` : `⏳ MTF IN ZONE · ${dir}`)) : `✅ SFP CONFIRMED · ${dir}`;
    const tagText = isFib ? (isAplus ? "1W/1D PIVOT + FIB 0.618 + SFP GRAB" : "1W/1D PIVOT + FIB 0.618 + 15m REJECT") : `${esc(item.key_tf || "1D")} KEY LEVEL SWEEP & RECLAIM`;
    const step1Desc = `1W ${rupee(item.w_level)} · 1D ${rupee(item.d_level)}`;
    const step3Title = isFib ? "Fib Zone / OTE" : "Liquidity Sweep";
    const step3Desc = isFib ? (item.fib_zone || "0.50 – 0.618 OTE") : `${esc(item.key_tf || "1D")} level swept ${item.sweep_pct || 0.1}%`;
    const step4Title = isFib ? "15m Rejection" : "Reclaim / Risk";
    const step4Desc = isFib ? (item.trigger_state === "CONFIRMED" ? (isAplus ? "Rejection + Sweep ✓" : "Wick Rejection ✓") : "In Golden Pocket") : `Closed back inside · ${pct(item.risk_pct)}`;
    const infoLine = isFib ? `<i>1W Pivot</i> <b>${rupee(item.w_level)}</b> · <i>1D Level</i> <b>${rupee(item.d_level)}</b> · <i>Fib 0.618</i> <b>${rupee(item.fib_level)}</b> · ${item.liquidity_desc || ""}` : `<i>Key Level</i> <b>${rupee(item.level)}</b> · <i>SL</i> <b>${rupee(item.stop_loss || item.stop)}</b> · ${item.reason || ""}`;
    const move = (v) => ((Number(v) - Number(item.entry)) / Number(item.entry)) * 100;
    const targetLabel = (n) => `${n > 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`;
    return `<article class="im-catch-card ${bull ? "is-bull" : "is-bear"}" data-symbol="${sym}">
      <div class="im-catch-head">${avatar(sym)}<div class="im-catch-id"><strong>${sym}<span>·${isMcx ? "MCX" : "NSE"}</span></strong><small>${esc(item.name || "")} · ${esc(item.sector || "")}</small></div><div class="im-catch-px"><b>${rupee(price)}</b><small class="${change >= 0 ? "im-catch-up" : "im-catch-down"}">${pct(change, true)}</small></div>${ticketStar(sym)}</div>
      <div class="im-catch-tags"><span class="im-catch-pill${isAplus ? " is-a-plus" : ""}">${badgePill}</span><span class="im-catch-tag">${tagText}</span><span class="im-catch-tag">${item.timestamp ? fmtTimestamp(item.timestamp) : "Latest scan"}</span></div>
      <div class="im-catch-levels"><div><span>Entry</span><b>${rupee(item.entry)}</b><em></em></div><div><span>Stop · ${pct(item.risk_pct)}</span><b class="im-catch-down">${rupee(item.stop_loss || item.stop)}</b><em class="im-catch-down">${isFib ? "Past 0.786" : "Max 2%"}</em></div><div><span>T1 · 1:${item.rr1 || 1.5}</span><b>${rupee(item.target_1 || item.t1)}</b><em class="${bull ? "im-catch-up" : "im-catch-down"}">(${targetLabel(move(item.target_1 || item.t1))})</em></div><div><span>T2 · 1:${item.rr2 || 2.5}</span><b>${rupee(item.target_2 || item.t2)}</b><em class="${bull ? "im-catch-up" : "im-catch-down"}">(${targetLabel(move(item.target_2 || item.t2))})</em></div></div>
      <div class="im-catch-steps"><div class="im-catch-step is-ok"><b>1W/1D Levels</b><i>✓</i><small>${step1Desc}</small></div><div class="im-catch-step is-ok"><b>1H Trend & ADX</b><i>✓</i><small>ADX ${item.adx || 20}+ · EMA 20/50</small></div><div class="im-catch-step is-ok"><b>${step3Title}</b><i>✓</i><small>${step3Desc}</small></div><div class="im-catch-step ${item.trigger_state === "CONFIRMED" || !isFib ? "is-ok" : "is-wait"}"><b>${step4Title}</b><i>${item.trigger_state === "CONFIRMED" || !isFib ? "✓" : "⏳"}</i><small>${step4Desc}</small></div></div>
      <small class="im-catch-ema">${infoLine}</small><div class="im-catch-actions"><button type="button" class="im-catch-ticket ${bull ? "is-buy" : "is-sell"}" data-catch-ticket="${sym}" data-catch-side="${bull ? "buy" : "sell"}" data-catch-price="${esc(price)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button><button type="button" class="im-catch-analysis" data-catch-coin="${sym}" data-catch-price="${esc(price)}">📊 Analysis</button></div></article>`;
  }
  function summary(data) {
    const bias = data.nifty_bias || "neutral";
    const biasText = bias === "bullish" ? "NIFTY 50 BULLISH · LONGS ALIGNED" : bias === "bearish" ? "NIFTY 50 BEARISH · SHORTS ALIGNED" : "NIFTY 50 NEUTRAL · MTF ZONE FOCUS";
    return `<div class="im-catch-summary"><svg class="im-catch-radar" viewBox="0 0 60 60"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14"/></svg><div><b>${esc(biasText)}</b><small>Scanning ${Number(data.stocks_count) || 0} NSE stocks + ${Number(data.commodities_count) || 0} MCX commodities</small></div></div>`;
  }
  function shell(inner, metaText, counts = {}) {
    return `<div class="im-catch-page"><div class="im-catch-top"><span class="im-catch-logo">🏹</span><div><strong>CATCH ACCURACY</strong><small>NIFTY BIAS · SMART MTF · SFP LIQUIDITY SWINGS · OWNER ONLY</small></div><button id="imCatchRefresh" class="im-catch-iconbtn" type="button" aria-label="Refresh"><svg class="im-catch-spin" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button></div><p class="im-catch-notice">Owner-only · NIFTY-aligned Multi-Timeframe Confluence & Closed-Candle Liquidity Sweeps. Research and paper-trading guidance only.</p><div class="im-catch-bar"><div class="im-catch-tabs" id="imCatchTabs"><button class="im-catch-pilltab ${activeTab === "fib" ? "is-active" : ""}" data-catch-tab="fib">🎯 Smart MTF${counts.fib != null ? ` (${counts.fib})` : ""}</button><button class="im-catch-pilltab ${activeTab === "1h" ? "is-active" : ""}" data-catch-tab="1h">1H Swing${counts.h1 != null ? ` (${counts.h1})` : ""}</button><button class="im-catch-pilltab ${activeTab === "15m" ? "is-active" : ""}" data-catch-tab="15m">15m Swing${counts.m15 != null ? ` (${counts.m15})` : ""}</button></div><div class="im-catch-filters"><button id="imCatchMarketFilter" class="im-catch-filterbtn" type="button"><svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg><span>${MARKET_LABELS[marketFilter]}</span></button><button id="imCatchDirFilter" class="im-catch-filterbtn" type="button"><span>${DIR_LABELS[dirFilter]}</span></button></div></div><p class="im-catch-meta">${metaText}</p><div class="im-catch-results">${inner}</div></div>`;
  }
  function renderView(data) {
    if (!data) return;
    const all = data.setups || data.full || [];
    const countFib = all.filter((x) => x.kind === "fib" || x.timeframe === "fib").length;
    const count1h = all.filter((x) => x.timeframe === "1h" && x.kind !== "fib").length;
    const count15m = all.filter((x) => x.timeframe === "15m" && x.kind !== "fib").length;
    let rows = all.filter((x) => activeTab === "fib" ? (x.kind === "fib" || x.timeframe === "fib") : (x.timeframe === activeTab && x.kind !== "fib"));
    if (marketFilter === "nse") rows = rows.filter((x) => x.market !== "mcx"); else if (marketFilter === "mcx") rows = rows.filter((x) => x.market === "mcx");
    if (dirFilter === "bullish") rows = rows.filter((x) => x.side === "bullish" || x.type === "BULLISH"); else if (dirFilter === "bearish") rows = rows.filter((x) => x.side === "bearish" || x.type === "BEARISH");
    const cards = rows.length ? rows.map(card).join("") : `<div class="im-catch-empty"><strong>No ${activeTab === "fib" ? "Smart MTF" : activeTab.toUpperCase() + " SFP"} setups in this filter right now</strong><p>MarketDock currently imports the established Smart MTF confluence scanner. SFP swing setups will be listed only when their scan is implemented; they are not fabricated here.</p></div>`;
    const note = '<p class="im-catch-note">Closed-candle Multi-Timeframe Confluence and SFP Liquidity Sweep Scanner. Levels and setups are estimated from market data for research and paper trading only. Confirm live charts and manage your risk strictly.</p>';
    body.innerHTML = shell(summary(data) + cards + note, `${rows.length} setups matching filter · ${all.length} total across all markets`, { fib: countFib, h1: count1h, m15: count15m });
  }
  async function loadIndexQuotes() { try { const r = await fetch(API + "/api/index-quotes"); const j = await r.json(); if (j && Array.isArray(j.data)) indexQuotes = j.data; } catch (_) {} }
  body.addEventListener("click", (event) => {
    const tabBtn = event.target.closest("[data-catch-tab]"); if (tabBtn) { activeTab = tabBtn.dataset.catchTab; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imCatchMarketFilter")) { marketFilter = MARKETS[(MARKETS.indexOf(marketFilter) + 1) % MARKETS.length]; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imCatchDirFilter")) { dirFilter = DIRS[(DIRS.indexOf(dirFilter) + 1) % DIRS.length]; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imCatchRefresh")) { fetchCatchData(true); return; }
    const ticket = event.target.closest("[data-catch-ticket]"); if (ticket) { const { catchTicket: sym, catchSide: side, catchPrice: price } = ticket.dataset; openActionSheet(sym, Number(price)); document.getElementById(side === "buy" ? "im-action-sheet-buy-btn" : "im-action-sheet-sell-btn")?.click(); return; }
    const analysis = event.target.closest("[data-catch-coin]"); if (analysis) openActionSheet(analysis.dataset.catchCoin, Number(analysis.dataset.catchPrice));
  });
  async function fetchCatchData(force = false) {
    if (isLoading) return;
    isLoading = true; page.classList.add("is-loading");
    const minSpin = new Promise((resolve) => setTimeout(resolve, 800));
    if (!lastData) body.innerHTML = shell('<p class="im-catch-loading">Scanning liquid NSE stocks and MCX commodities on closed candles…</p>', "Checking Catch Accuracy setups…");
    try {
      const token = await getOwnerToken();
      if (!token) { body.innerHTML = shell('<p class="im-catch-error">Signing in… If this persists, sign in with your owner account and tap refresh.</p>', "Scan unavailable"); return; }
      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) { try { res = await fetch(`${API}/api/owner/catch-accuracy${force ? "?refresh=1" : ""}`, { headers: { Authorization: `Bearer ${token}` } }); if (res.ok || res.status === 401 || res.status === 403 || res.status < 500) break; } catch (_) { res = null; } if (attempt < 2) await sleep(1200 * (attempt + 1)); }
      if (!res) throw new Error("Catch Accuracy scan request failed");
      if (res.status === 401 || res.status === 403) { body.innerHTML = shell('<p class="im-catch-error">Catch Accuracy is locked. It is available only for the owner account.</p>', "Scan unavailable"); return; }
      if (!res.ok) throw new Error("Catch Accuracy request error");
      const [data] = await Promise.all([res.json(), loadIndexQuotes(), minSpin]);
      if (data && data.ok) { lastData = data; loadedAt = Date.now(); renderView(data); } else body.innerHTML = shell(`<p class="im-catch-error">${esc(data?.error || "Could not complete Catch Accuracy scan.")}</p>`, "Scan unavailable");
    } catch (_) { if (!lastData) body.innerHTML = shell('<p class="im-catch-error">Could not connect to Catch Accuracy scanner. Tap refresh to retry.</p>', "Scan unavailable"); }
    finally { isLoading = false; page.classList.remove("is-loading"); }
  }
  function ensureLoaded() { if (page.classList.contains("active") && (!lastData || Date.now() - loadedAt > STALE_MS)) fetchCatchData(); }
  navButton.addEventListener("click", () => setTimeout(ensureLoaded, 50));
  new MutationObserver(ensureLoaded).observe(page, { attributes: true, attributeFilter: ["class"] });
  ensureLoaded();
  (function pullToRefresh() {
    const THRESHOLD = 70; let startY = null, pulled = 0; const hint = document.createElement("div"); hint.className = "im-catch-ptr"; hint.hidden = true; page.prepend(hint);
    const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;
    const reset = () => { startY = null; pulled = 0; hint.hidden = true; hint.style.height = "0px"; };
    page.addEventListener("touchstart", (e) => { startY = page.classList.contains("active") && atTop() && !isLoading && e.touches.length === 1 ? e.touches[0].clientY : null; pulled = 0; }, { passive: true });
    page.addEventListener("touchmove", (e) => { if (startY === null) return; const dy = e.touches[0].clientY - startY; if (dy <= 0 || !atTop()) { reset(); return; } pulled = dy; hint.hidden = false; hint.style.height = Math.min(44, dy * 0.5) + "px"; hint.textContent = dy >= THRESHOLD ? "Release to refresh" : "Pull down to refresh"; }, { passive: true });
    page.addEventListener("touchend", () => { const go = pulled >= THRESHOLD; reset(); if (go) fetchCatchData(true); }, { passive: true }); page.addEventListener("touchcancel", reset, { passive: true });
  })();
  const ALLOWED_KEY = "marketdock_catch_accuracy_allowed";
  const readCached = () => { try { return localStorage.getItem(ALLOWED_KEY) === "1"; } catch (_) { return false; } };
  const writeCached = (v) => { try { if (v) { localStorage.setItem(ALLOWED_KEY, "1"); localStorage.setItem("marketdock_focus_radar_allowed", "1"); } else localStorage.removeItem(ALLOWED_KEY); } catch (_) {} };
  let retryTimer = null;
  async function checkAccess(attempt = 0) {
    let verdict = "error";
    try { const token = await getOwnerToken(); if (!token) verdict = "no"; else { const response = await fetch(API + "/api/owner/catch-accuracy/access", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }); verdict = response.ok ? "yes" : (response.status === 401 || response.status === 403) ? "no" : "error"; } } catch (_) { verdict = "error"; }
    clearTimeout(retryTimer);
    if (verdict === "error") { if (attempt < 4) retryTimer = setTimeout(() => checkAccess(attempt + 1), [3000, 8000, 20000, 45000][attempt]); return; }
    const allowed = verdict === "yes"; writeCached(allowed); navButton.hidden = !allowed;
    if (!allowed && page.classList.contains("active")) document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
  }
  if (readCached()) navButton.hidden = false;
  setTimeout(() => checkAccess(), 1200);
  let authWatched = false;
  function watchAuth() { if (authWatched) return; try { const auth = window.marketDockSupabase?.auth; if (auth?.onAuthStateChange) { auth.onAuthStateChange(() => { setTimeout(() => checkAccess(), 400); setTimeout(() => { if (page.classList.contains("active")) fetchCatchData(); }, 600); }); authWatched = true; } } catch (_) {} }
  watchAuth(); setTimeout(watchAuth, 2000);
})();
