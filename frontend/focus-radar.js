// Focus Radar (owner only)
(function marketDockFocusRadar() {
  const page = document.getElementById("im-focus-radar");
  const navButton = document.querySelector('.nav-button[data-page="im-focus-radar"]');
  const body = document.getElementById("imFrBody");
  if (!page || !navButton || !body) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";

  let activeTab = "swings";     // 'swings' | 'breakouts' (Swings is the first tab)
  let dirFilter = "all";       // 'all' | 'bullish' | 'bearish'
  const MIN_VOLUME = 1.15, MIN_VOLUME_MCX = 1.3; // the same limits the scanner uses for breakouts
  let segment = "all";         // 'all' | 'nse' | 'mcx'
  const SEGMENTS = [["all", "All"], ["nse", "NSE Stocks"], ["mcx", "MCX Commodities"]];
  const inSegment = (s) => segment === "all" || (segment === "mcx") === (s.market === "mcx");
  let lastData = null;
  let isLoading = false;
  let indexQuotes = [];
  const FILTER_LABEL = { all: "All", bullish: "Bullish", bearish: "Bearish" };

  // After a page reload this can run before the login is restored, so wait a few seconds for the session
  // instead of giving up on the first empty answer.
  async function getOwnerToken(waitMs = 6000) {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase.auth.getSession();
        const token = session?.session?.access_token;
        if (token) return token;
      } catch (e) { /* the login client may not exist yet */ }
      if (Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- small helpers ----------
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const rupee = (value) => {
    const v = Number(value);
    return Number.isFinite(v) ? "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--";
  };
  const pct = (v, signed) => (Number.isFinite(v) ? (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%" : "--");
  const agoText = (ts) => {
    const t = typeof ts === "number" ? ts * 1000 : Date.parse(ts);
    if (!Number.isFinite(t)) return "just now";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  const COLOURS = ["#0052cc", "#172b4d", "#00875a", "#de350b", "#5243aa", "#00a3bf", "#ff5630", "#403294"];
  const COMMODITY_ICONS = {
    gold: ["🪙", "#b45309"], silver: ["🥈", "#475569"], crudeoil: ["🛢️", "#991b1b"], naturalgas: ["⚡", "#1d4ed8"],
    copper: ["🔶", "#c2410c"], zinc: ["⚙️", "#6d28d9"], aluminium: ["🪨", "#0f766e"],
  };
  function avatar(symbol, s) {
    if (s && s.market === "mcx") {
      const [icon, bg] = COMMODITY_ICONS[s.commodity_key] || ["📦", "#334155"];
      return `<span class="imfr-avatar" style="background:${bg};font-size:16px">${icon}</span>`;
    }
    let hash = 0;
    for (const ch of symbol) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
    return `<span class="imfr-avatar" style="background:${COLOURS[Math.abs(hash) % COLOURS.length]}">${esc(symbol.slice(0, 3))}</span>`;
  }
  function step(title, sub, state) { // state: ok | live | wait
    const mark = state === "ok" ? "✓" : state === "live" ? "⚡" : "⏳";
    return `<div class="imfr-step is-${state}"><b>${title}</b><i>${mark}</i><small>${sub}</small></div>`;
  }

  // Commodity cards trade the real current MCX contract (e.g. CRUDEOIL26DECFUT), stocks trade the NSE symbol.
  function orderData(s) {
    return s.market === "mcx"
      ? ` data-fr-mcx="1" data-fr-order="${esc(s.trading_symbol)}" data-fr-key="${esc(s.commodity_key)}" data-fr-cname="${esc(s.commodity_name)}" data-fr-lot="${esc(s.lot_size ?? "")}" data-fr-chg="${esc(s.change_pct ?? "")}"`
      : ` data-fr-order="${esc(s.symbol)}"`;
  }
  function openSheet(el, price) {
    const d = el.dataset;
    if (d.frMcx) {
      const base = String(d.frOrder).replace(/\d{2}[A-Z]{3}FUT$/, "");
      window.openImWatchlistActionSheet?.(d.frOrder, price, {
        chartSymbol: `MCX:${base}1!`, isCommodity: true, changePercent: Number(d.frChg), lotSize: Number(d.frLot) || undefined,
        commodityKey: d.frKey, commodityName: d.frCname,
      });
    } else {
      window.openImWatchlistActionSheet?.(d.frOrder, price);
    }
  }

  // ---------- cards (same look as the CryptoDock Focus Radar; the numbers come from the scanner as before) ----------
  function card(s) {
    const bull = s.type === "BULLISH";
    const change = Number(s.change_pct) || 0;
    const entry = Number(s.entry), price = Number(s.price);
    const gain = (v) => (entry ? Math.abs(Number(v) - entry) / entry * 100 : 0);
    const vr = Number(s.volume_ratio) || 0;
    // Entry, SL and targets (and the paper ticket) show only when all three confirm:
    // volume (1.15x for stocks, 1.3x for commodities), price on the right side of VWAP, RSI in the direction's band.
    const minVol = s.market === "mcx" ? MIN_VOLUME_MCX : MIN_VOLUME;
    const rsiNum = Number(s.rsi);
    const volOk = vr >= minVol;
    const vwapOk = bull ? price >= Number(s.vwap) : price <= Number(s.vwap);
    // MCX swing pullbacks: a dip normally has LOW volume and RSI near 40-45, so the breakout lock (1.3x volume, price beyond
    // VWAP, RSI 50-68) would block every pullback. For them Entry, SL, targets and the ticket show straight away and RSI
    // only has to sit in the pullback band (40-65 long, 35-60 short). Volume and VWAP are still shown as information.
    const pullbackFree = activeTab === "swings" && s.market === "mcx";
    const rsiOk = Number.isFinite(rsiNum) && (pullbackFree
      ? (bull ? rsiNum >= 40 && rsiNum <= 65 : rsiNum >= 35 && rsiNum <= 60)
      : (bull ? rsiNum >= 50 && rsiNum <= 68 : rsiNum >= 32 && rsiNum <= 50));
    const confirmed = pullbackFree || (volOk && vwapOk && rsiOk);
    const missing = [!volOk && "Volume", !vwapOk && "VWAP", !rsiOk && "RSI"].filter(Boolean);
    const steps = [
      step("Volume", volOk || pullbackFree ? `${vr.toFixed(2)}× avg` : `${vr.toFixed(2)}× · need ${minVol}×`, volOk ? "ok" : "wait"),
      step("VWAP", `${bull ? "Above" : "Below"} ${rupee(s.vwap)}`, vwapOk ? "ok" : "wait"),
      step("RSI", rsiOk ? esc(s.rsi) : `${esc(s.rsi)} · need ${pullbackFree ? (bull ? "40-65" : "35-60") : (bull ? "50-68" : "32-50")}`, rsiOk ? "ok" : "wait"),
    ].join("");
    const details = confirmed ? `
      <div class="imfr-levels">
        <div><span>Entry</span><b>${rupee(s.entry)}</b><em></em></div>
        <div><span>SL</span><b class="imfr-down">${rupee(s.stop_loss)}</b><em class="imfr-down">(−${Number(s.risk_pct).toFixed(1)}%)</em></div>
        <div><span>Target 1</span><b>${rupee(s.target_1)}</b><em class="imfr-up">(+${gain(s.target_1).toFixed(1)}%)</em></div>
        <div><span>Target 2</span><b>${rupee(s.target_2)}</b><em class="imfr-up">(+${gain(s.target_2).toFixed(1)}%)</em></div>
      </div>
      <small class="imfr-ema"><i>20 EMA</i> <b>${rupee(s.ema_20)}</b>${s.ema_50 ? ` · <i>50 EMA</i> <b>${rupee(s.ema_50)}</b>` : ""}</small>
      ${s.reason ? `<p class="imfr-reason">${esc(s.reason)}</p>` : ""}` : `
      <p class="imfr-wait">⏳ Waiting for ${missing.join(" + ")} to confirm. Entry, SL and targets show once Volume, VWAP and RSI are all ✓.</p>`;
    const ticket = confirmed
      ? `<button type="button" class="imfr-ticket ${bull ? "is-buy" : "is-sell"}" data-fr-ticket="1"${orderData(s)} data-fr-side="${bull ? "buy" : "sell"}" data-fr-price="${esc(s.price)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>` : "";
    return `<article class="imfr-card ${bull ? "is-bull" : "is-bear"}" data-symbol="${esc(s.symbol)}">
      <div class="imfr-head">
        <span class="imfr-avatar-wrap">${avatar(String(s.symbol), s)}</span>
        <div class="imfr-id"><strong>${esc(s.symbol)}<span>·${s.market === "mcx" ? "MCX" : "NSE"}</span></strong><small>${s.market === "mcx" ? esc(s.trading_symbol || s.name) : esc(s.name) + (s.sector ? " · " + esc(s.sector) : "")}</small></div>
        <div class="imfr-px"><b>${rupee(price)}</b><small class="${change >= 0 ? "imfr-up" : "imfr-down"}">${pct(change, true)}</small></div>
      </div>
      <div class="imfr-tags"><span class="imfr-pill">${bull ? "↗ BULLISH BUY · LONG" : "↘ BEARISH · SHORT"}</span><span class="imfr-tag">${esc(s.trigger)}</span></div>
      <div class="imfr-steps imfr-steps-wide">${steps}</div>
      ${details}
      <div class="imfr-actions${confirmed ? "" : " imfr-actions-one"}">
        ${ticket}
        <button type="button" class="imfr-analysis" data-fr-coin="1"${orderData(s)} data-fr-price="${esc(s.price)}">📊 Analysis</button>
      </div>
    </article>`;
  }

  function summary(data) {
    const row = (name, key) => {
      const q = indexQuotes.find((x) => String(x.symbol || "").toLowerCase() === key);
      const c = q ? Number(q.change_percent) : NaN;
      return Number.isFinite(c) ? `<div><span><i class="${c >= 0 ? "is-up" : "is-down"}"></i>${name}</span> <b class="${c >= 0 ? "imfr-up" : "imfr-down"}">${pct(c, true)}</b></div>` : "";
    };
    const live = data.market_status === "live" || data.mcx_status === "live";
    const sub = live ? `Updated ${agoText(data.updated_at)}` : "Market closed · last session";
    return `<div class="imfr-summary"><svg class="imfr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14"/></svg>
      <div><b>Scanning ${Number(data.scanned_count) || 0} markets</b><small>${sub}</small></div><div class="imfr-ticks">${row("NIFTY", "nifty")}${row("BANKNIFTY", "banknifty")}${row("SENSEX", "sensex")}</div></div>`;
  }

  const EMPTY = {
    breakouts: ["No breakout right now", "No stock or commodity is breaking out or down with volume. That is normal; check again later."],
    swings: ["No swing pullback right now", "No stock or commodity is retesting VWAP or the 20 EMA in its entry zone. That is normal; check again later."],
  };

  function shell(inner, metaText) {
    const bo = lastData ? (lastData.breakouts || []).filter(inSegment).length : null;
    const sw = lastData ? (lastData.swings || []).filter(inSegment).length : null;
    const label = (name, n) => `${name}${n === null ? "" : ` (${n})`}`;
    return `<div class="imfr-page">
      <div class="imfr-top">
        <span class="imfr-logo" aria-hidden="true">🎯</span>
        <div><small>TRADE SMARTER. FASTER.</small></div>
        <button id="imFrRefresh" class="imfr-iconbtn" type="button" aria-label="Refresh"><svg class="imfr-spin" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
      </div>
      <p class="imfr-notice">Owner-only · rule-based filter, not a prediction. Verify the chart and manage risk yourself.</p>
      <div class="imfr-bar">
        <div class="imfr-tabs"><button type="button" class="imfr-pilltab ${activeTab === "swings" ? "is-active" : ""}" data-fr-tab="swings">${label("Swings", sw)}</button><button type="button" class="imfr-pilltab ${activeTab === "breakouts" ? "is-active" : ""}" data-fr-tab="breakouts">${label("Breakouts", bo)}</button></div>
        <button id="imFrFilter" class="imfr-filter" type="button" aria-label="Filter direction"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg><span>${FILTER_LABEL[dirFilter]}</span></button>
      </div>
      <div class="imfr-seg">${SEGMENTS.map(([k, t]) => `<button type="button" class="imfr-segbtn ${segment === k ? "is-active" : ""}" data-fr-seg="${k}">${t}</button>`).join("")}</div>
      <p class="imfr-meta">${metaText}</p>
      <div class="imfr-results" aria-live="polite">${inner}</div>
    </div>`;
  }

  function renderLoading() {
    body.innerHTML = shell('<p class="imfr-loading">Scanning NSE stocks and MCX commodities… this can take a few seconds.</p>', "Checking market setup…");
  }

  function renderView(data) {
    if (!data) return;
    const all = (activeTab === "breakouts" ? (data.breakouts || []) : (data.swings || [])).filter(inSegment);
    const rows = all.filter((s) => dirFilter === "all" || String(s.type).toLowerCase() === dirFilter);
    const cards = rows.length
      ? rows.map(card).join("")
      : `<div class="imfr-empty"><strong>${EMPTY[activeTab][0]}</strong><p>${EMPTY[activeTab][1]}</p></div>`;
    const note = all.length
      ? '<p class="imfr-note">Research and paper trading guidance only. Setups come from volume, VWAP and 20 EMA rules, not a prediction. Breakout cards and NSE swing cards show Entry, SL and targets only when Volume, VWAP and RSI all confirm; MCX swing pullbacks show them straight away (RSI 40-65 long, 35-60 short). Breakouts also need a tight base before the move, price within 3% of the 20 EMA, RSI not overheated and, for commodities, 1.3× volume. Confirm with the chart and keep your stop-loss. NSE trades 9:15 to 15:30 IST and MCX until late evening; outside market hours the cards show the last session. Commodity cards trade the current MCX futures contract.</p>' : "";
    const bull = all.filter((s) => s.type === "BULLISH").length;
    body.innerHTML = shell(summary(data) + cards + note, `${bull} bullish, ${all.length - bull} bearish`);
  }

  async function loadIndexQuotes() {
    try {
      const r = await fetch(API + "/api/index-quotes");
      const j = await r.json();
      if (j && Array.isArray(j.data)) indexQuotes = j.data;
    } catch (e) { /* the strip just shows no index change */ }
  }

  // ---------- clicks (the content is re-rendered, so one listener on the page body) ----------
  const FILTERS = ["all", "bullish", "bearish"];
  body.addEventListener("click", (event) => {
    const segBtn = event.target.closest("[data-fr-seg]");
    if (segBtn) { segment = segBtn.dataset.frSeg; if (lastData) renderView(lastData); return; }
    const tabBtn = event.target.closest("[data-fr-tab]");
    if (tabBtn) { activeTab = tabBtn.dataset.frTab; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imFrFilter")) { dirFilter = FILTERS[(FILTERS.indexOf(dirFilter) + 1) % FILTERS.length]; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imFrRefresh")) { fetchRadarData(true); return; }
    const ticket = event.target.closest("[data-fr-ticket]");
    if (ticket) {
      const { frSide: side, frPrice: price } = ticket.dataset;
      openSheet(ticket, Number(price));
      // The stock sheet is open: tap its own Buy / Sell so the order form opens straight away.
      document.getElementById(side === "buy" ? "im-action-sheet-buy-btn" : "im-action-sheet-sell-btn")?.click();
      return;
    }
    const analysis = event.target.closest("[data-fr-coin]");
    if (analysis) openSheet(analysis, Number(analysis.dataset.frPrice));
  });

  async function fetchRadarData(force = false) {
    if (isLoading) return;
    isLoading = true;
    page.classList.add("is-loading"); // the target and the refresh arrow spin until the result shows
    const minSpin = new Promise((resolve) => setTimeout(resolve, 800));
    if (!lastData) renderLoading();

    try {
      const token = await getOwnerToken();
      if (!token) {
        body.innerHTML = shell(`<p class="imfr-error">Signing in… If this stays, sign in with your owner account, then tap the refresh arrow.</p>`, "Scan unavailable");
        return;
      }

      // A cold server or a flaky connection right after a reload: try again before showing an error.
      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch(`${API}/api/owner/focus-radar${force ? "?refresh=1" : ""}`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok || res.status === 401 || res.status === 403 || res.status < 500) break;
        } catch (e) { res = null; }
        if (attempt < 2) await sleep(1500 * (attempt + 1));
      }
      if (!res) throw new Error("Scan request failed");

      if (res.status === 401 || res.status === 403) {
        body.innerHTML = shell(`<p class="imfr-error">Focus Radar is locked. It is available only for the owner account.</p>`, "Scan unavailable");
        return;
      }

      if (!res.ok) {
        throw new Error("Scan request failed");
      }

      const [data] = await Promise.all([res.json(), loadIndexQuotes(), minSpin]);
      if (data.ok) {
        lastData = data;
        loadedAt = Date.now();
        renderView(data);
      } else {
        body.innerHTML = shell(`<p class="imfr-error">${esc(data.error || "Could not complete scan right now.")}</p>`, "Scan unavailable");
      }
    } catch (err) {
      if (!lastData) {
        body.innerHTML = shell('<p class="imfr-error">Could not connect to Focus Radar scanner. Tap the refresh arrow to try again.</p>', "Scan unavailable");
      }
    } finally {
      isLoading = false;
      page.classList.remove("is-loading");
    }
  }

  // Whenever the page opens (menu, back, or restored after a reload) load it if there is no fresh result yet.
  let loadedAt = 0;
  const STALE_MS = 90 * 1000;
  function ensureLoaded() {
    if (!page.classList.contains("active")) return;
    if (!lastData || Date.now() - loadedAt > STALE_MS) fetchRadarData();
  }
  navButton.addEventListener("click", () => setTimeout(ensureLoaded, 50));
  new MutationObserver(ensureLoaded).observe(page, { attributes: true, attributeFilter: ["class"] });
  ensureLoaded(); // restored on a reload

  // Pull down at the top of the page to refresh (instead of the browser reloading the whole page).
  (function pullToRefresh() {
    const THRESHOLD = 70;
    let startY = null, pulled = 0;
    const hint = document.createElement("div");
    hint.className = "imfr-ptr";
    hint.hidden = true;
    page.prepend(hint);
    const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;
    const reset = () => { startY = null; pulled = 0; hint.hidden = true; hint.style.height = "0px"; };
    page.addEventListener("touchstart", (e) => { startY = page.classList.contains("active") && atTop() && !isLoading && e.touches.length === 1 ? e.touches[0].clientY : null; pulled = 0; }, { passive: true });
    page.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0 || !atTop()) { reset(); return; }
      pulled = dy;
      hint.hidden = false;
      hint.style.height = Math.min(44, dy * 0.5) + "px";
      hint.textContent = dy >= THRESHOLD ? "Release to refresh" : "Pull down to refresh";
    }, { passive: true });
    page.addEventListener("touchend", () => { const go = pulled >= THRESHOLD; reset(); if (go) fetchRadarData(true); }, { passive: true });
    page.addEventListener("touchcancel", reset, { passive: true });
  })();

  // The login arrived after the page tried to load (a reload): load now.
  function reloadWhenSignedIn() { if (page.classList.contains("active") && !lastData && !isLoading) fetchRadarData(); }

  // Also support tabbar 'more' click
  document.addEventListener("click", (e) => {
    const tile = e.target.closest('[data-more="im-focus-radar"]');
    if (tile && !lastData) {
      setTimeout(fetchRadarData, 100);
    }
  });

  // Owner check logic
  const ALLOWED_KEY = "marketdock_focus_radar_allowed";
  const readCached = () => { try { return localStorage.getItem(ALLOWED_KEY) === "1"; } catch (e) { return false; } };
  const writeCached = (v) => { try { v ? localStorage.setItem(ALLOWED_KEY, "1") : localStorage.removeItem(ALLOWED_KEY); } catch (e) { /* ignore */ } };
  let retryTimer = null;
  async function checkAccess(attempt = 0) {
    let verdict = "error";
    try {
      const token = await getOwnerToken();
      if (!token) verdict = "no";
      else {
        const response = await fetch(API + "/api/owner/focus-radar/access", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
        verdict = response.ok ? "yes" : (response.status === 401 || response.status === 403) ? "no" : "error";
      }
    } catch (e) { verdict = "error"; }
    clearTimeout(retryTimer);
    if (verdict === "error") {
      if (attempt < 4) retryTimer = setTimeout(() => checkAccess(attempt + 1), [3000, 8000, 20000, 45000][attempt]);
      return;
    }
    const allowed = verdict === "yes";
    writeCached(allowed);
    navButton.hidden = !allowed;
    if (!allowed && page.classList.contains("active")) document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
  }
  if (readCached()) navButton.hidden = false;
  setTimeout(() => checkAccess(), 1200);

  let authWatched = false;
  function watchAuth() {
    if (authWatched) return;
    try {
      const auth = window.marketDockSupabase?.auth;
      if (auth?.onAuthStateChange) { auth.onAuthStateChange(() => { setTimeout(() => checkAccess(), 400); setTimeout(reloadWhenSignedIn, 600); }); authWatched = true; }
    } catch (e) { /* ignore */ }
  }
  watchAuth();
  setTimeout(watchAuth, 2000);
})();
