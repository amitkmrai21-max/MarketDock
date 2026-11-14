// Commodity Radar (owner only): the MCX commodity setups of Focus Radar (Swings + Breakouts) with an extra ADX filter.
// Same server scan as Focus Radar (/api/owner/commodity-radar, shared cache); only MCX cards are shown here. ADX(14) is
// measured on 1-hour candles of the current MCX future (Wilder smoothing) and must be above 20, like the crypto Catch
// Accuracy rule. Entry / SL / targets and the paper ticket show only when ADX and the setup checks all pass.
(function marketDockCommodityRadar() {
  const page = document.getElementById("im-commodity-radar");
  const navButton = document.querySelector('.nav-button[data-page="im-commodity-radar"]');
  const body = document.getElementById("imCrBody");
  if (!page || !navButton || !body) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";

  let activeTab = "swings";     // 'swings' | 'breakouts'
  let dirFilter = "all";        // 'all' | 'bullish' | 'bearish'
  const MIN_VOLUME_MCX = 1.3;   // breakouts: the scanner's commodity volume limit
  const ADX_MIN = 20;
  let lastData = null;
  let isLoading = false;
  let loadedAt = 0;
  const STALE_MS = 90 * 1000;
  const FILTER_LABEL = { all: "All", bullish: "Bullish", bearish: "Bearish" };
  const FILTERS = ["all", "bullish", "bearish"];

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

  // ---------- cards (same look as the Focus Radar cards, plus the ADX step) ----------
  function card(s) {
    const bull = s.type === "BULLISH";
    const change = Number(s.change_pct) || 0;
    const entry = Number(s.entry), price = Number(s.price);
    const gain = (v) => (entry ? Math.abs(Number(v) - entry) / entry * 100 : 0);
    const vr = Number(s.volume_ratio) || 0;
    const rsiNum = Number(s.rsi);
    const adx = Number(s.adx);
    const adxOk = Number.isFinite(adx) && adx > ADX_MIN;
    const swing = activeTab === "swings";
    // Swings (pullbacks): a dip normally has low volume and RSI near 40-45, so only the RSI band is checked (40-65 long,
    // 35-60 short). Breakouts keep the full lock: volume 1.3x, price beyond VWAP, RSI 50-68 / 32-50.
    const volOk = vr >= MIN_VOLUME_MCX;
    const vwapOk = bull ? price >= Number(s.vwap) : price <= Number(s.vwap);
    const rsiOk = Number.isFinite(rsiNum) && (swing
      ? (bull ? rsiNum >= 40 && rsiNum <= 65 : rsiNum >= 35 && rsiNum <= 60)
      : (bull ? rsiNum >= 50 && rsiNum <= 68 : rsiNum >= 32 && rsiNum <= 50));
    const setupOk = swing ? rsiOk : volOk && vwapOk && rsiOk;
    const confirmed = adxOk && setupOk;
    const missing = [!adxOk && "ADX", !swing && !volOk && "Volume", !swing && !vwapOk && "VWAP", !rsiOk && "RSI"].filter(Boolean);
    const rsiNeed = swing ? (bull ? "40-65" : "35-60") : (bull ? "50-68" : "32-50");
    const steps = [
      step("ADX", Number.isFinite(adx) ? (adxOk ? `${adx} (over ${ADX_MIN})` : `${adx} · need over ${ADX_MIN}`) : "not available", adxOk ? "ok" : "wait"),
      step("Volume", swing || volOk ? `${vr.toFixed(2)}× avg` : `${vr.toFixed(2)}× · need ${MIN_VOLUME_MCX}×`, volOk ? "ok" : "wait"),
      step("VWAP", `${bull ? "Above" : "Below"} ${rupee(s.vwap)}`, vwapOk ? "ok" : "wait"),
      step("RSI", rsiOk ? esc(s.rsi) : `${esc(s.rsi)} · need ${rsiNeed}`, rsiOk ? "ok" : "wait"),
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
      <p class="imfr-wait">⏳ Waiting for ${missing.join(" + ")} to confirm. Entry, SL and targets show once ${swing ? "ADX and RSI are" : "ADX, Volume, VWAP and RSI are all"} ✓.</p>`;
    const ticket = confirmed
      ? `<button type="button" class="imfr-ticket ${bull ? "is-buy" : "is-sell"}" data-fr-ticket="1"${orderData(s)} data-fr-side="${bull ? "buy" : "sell"}" data-fr-price="${esc(s.price)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>` : "";
    return `<article class="imfr-card ${bull ? "is-bull" : "is-bear"}" data-symbol="${esc(s.symbol)}">
      <div class="imfr-head">
        <span class="imfr-avatar-wrap">${avatar(String(s.symbol), s)}</span>
        <div class="imfr-id"><strong>${esc(s.symbol)}<span>·MCX</span></strong><small>${esc(s.trading_symbol || s.name)}</small></div>
        <div class="imfr-px"><b>${rupee(price)}</b><small class="${change >= 0 ? "imfr-up" : "imfr-down"}">${pct(change, true)}</small></div>
      </div>
      <div class="imfr-tags"><span class="imfr-pill">${bull ? "↗ BULLISH BUY · LONG" : "↘ BEARISH · SHORT"}</span><span class="imfr-tag">${esc(s.trigger)}</span></div>
      <div class="imfr-steps imfr-steps-four">${steps}</div>
      ${details}
      <div class="imfr-actions${confirmed ? "" : " imfr-actions-one"}">
        ${ticket}
        <button type="button" class="imfr-analysis" data-fr-coin="1"${orderData(s)} data-fr-price="${esc(s.price)}">📊 Analysis</button>
      </div>
    </article>`;
  }

  function summary(data) {
    const live = data.mcx_status === "live";
    const sub = live ? `Updated ${agoText(data.updated_at)}` : "MCX closed · last session";
    const n = (data.swings || []).concat(data.breakouts || []).filter((x) => x.market === "mcx").length;
    return `<div class="imfr-summary"><svg class="imfr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14"/></svg>
      <div><b>MCX commodities</b><small>${sub}</small></div><div class="imfr-ticks"><div><span><i class="${n ? "is-up" : ""}"></i>Setups</span> <b>${n}</b></div><div><span><i></i>ADX</span> <b>over ${ADX_MIN}</b></div></div></div>`;
  }

  const EMPTY = {
    breakouts: ["No commodity breakout right now", "No MCX commodity is breaking out or down with volume. That is normal; check again later."],
    swings: ["No commodity swing right now", "No MCX commodity is pulling back to VWAP or its 20 EMA in its entry zone. That is normal; check again later."],
  };

  function shell(inner, metaText) {
    const mcx = (list) => (list || []).filter((s) => s.market === "mcx");
    const bo = lastData ? mcx(lastData.breakouts).length : null;
    const sw = lastData ? mcx(lastData.swings).length : null;
    const label = (name, n) => `${name}${n === null ? "" : ` (${n})`}`;
    return `<div class="imfr-page">
      <div class="imfr-top">
        <span class="imfr-logo" aria-hidden="true">🛢️</span>
        <div><small>MCX · ADX FILTER</small></div>
        <button id="imCrRefresh" class="imfr-iconbtn" type="button" aria-label="Refresh"><svg class="imfr-spin" viewBox="0 0 24 24" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
      </div>
      <p class="imfr-notice">Owner-only · the Focus Radar commodity setups with an extra ADX check (ADX over ${ADX_MIN}: the market is trending, not sideways). Verify the chart and manage risk yourself.</p>
      <div class="imfr-bar">
        <div class="imfr-tabs"><button type="button" class="imfr-pilltab ${activeTab === "swings" ? "is-active" : ""}" data-fr-tab="swings">${label("Swings", sw)}</button><button type="button" class="imfr-pilltab ${activeTab === "breakouts" ? "is-active" : ""}" data-fr-tab="breakouts">${label("Breakouts", bo)}</button></div>
        <button id="imCrFilter" class="imfr-filter" type="button" aria-label="Filter direction"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg><span>${FILTER_LABEL[dirFilter]}</span></button>
      </div>
      <p class="imfr-meta">${metaText}</p>
      <div class="imfr-results" aria-live="polite">${inner}</div>
    </div>`;
  }

  function renderLoading() {
    body.innerHTML = shell('<p class="imfr-loading">Scanning MCX commodities… this can take a few seconds.</p>', "Checking market setup…");
  }

  function renderView(data) {
    if (!data) return;
    const all = (activeTab === "breakouts" ? (data.breakouts || []) : (data.swings || [])).filter((s) => s.market === "mcx");
    const rows = all.filter((s) => dirFilter === "all" || String(s.type).toLowerCase() === dirFilter);
    const cards = rows.length
      ? rows.map(card).join("")
      : `<div class="imfr-empty"><strong>${EMPTY[activeTab][0]}</strong><p>${EMPTY[activeTab][1]}</p></div>`;
    const note = '<p class="imfr-note">Research and paper trading guidance only, not a prediction. Swings: price pulling back to VWAP or the 20 EMA, RSI 40-65 (long) / 35-60 (short). Breakouts: price beyond the base with 1.3× volume, VWAP side and RSI 50-68 / 32-50. Both also need ADX(14) over 20 on 1-hour candles; Entry, SL and targets show only when every check passes. Each card trades the current MCX futures contract. MCX trades until late evening; outside hours the cards show the last session.</p>';
    const bull = all.filter((s) => s.type === "BULLISH").length;
    body.innerHTML = shell(summary(data) + cards + note, `${bull} bullish, ${all.length - bull} bearish`);
  }

  body.addEventListener("click", (event) => {
    const tabBtn = event.target.closest("[data-fr-tab]");
    if (tabBtn) { activeTab = tabBtn.dataset.frTab; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imCrFilter")) { dirFilter = FILTERS[(FILTERS.indexOf(dirFilter) + 1) % FILTERS.length]; if (lastData) renderView(lastData); return; }
    if (event.target.closest("#imCrRefresh")) { fetchRadarData(true); return; }
    const ticket = event.target.closest("[data-fr-ticket]");
    if (ticket) {
      const { frSide: side, frPrice: price } = ticket.dataset;
      openSheet(ticket, Number(price));
      document.getElementById(side === "buy" ? "im-action-sheet-buy-btn" : "im-action-sheet-sell-btn")?.click();
      return;
    }
    const analysis = event.target.closest("[data-fr-coin]");
    if (analysis) openSheet(analysis, Number(analysis.dataset.frPrice));
  });

  async function fetchRadarData(force = false) {
    if (isLoading) return;
    isLoading = true;
    page.classList.add("is-loading"); // the refresh arrow spins until the result shows
    const minSpin = new Promise((resolve) => setTimeout(resolve, 800));
    if (!lastData) renderLoading();
    try {
      const token = await getOwnerToken();
      if (!token) {
        body.innerHTML = shell('<p class="imfr-error">Signing in… If this stays, sign in with your owner account, then tap the refresh arrow.</p>', "Scan unavailable");
        return;
      }
      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await fetch(`${API}/api/owner/commodity-radar${force ? "?refresh=1" : ""}`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok || res.status < 500) break;
        } catch (e) { res = null; }
        if (attempt < 2) await sleep(1500 * (attempt + 1));
      }
      if (!res) throw new Error("Scan request failed");
      if (res.status === 401 || res.status === 403) {
        body.innerHTML = shell('<p class="imfr-error">Commodity Radar is locked. It is available only for the owner account.</p>', "Scan unavailable");
        return;
      }
      if (!res.ok) throw new Error("Scan request failed");
      const [data] = await Promise.all([res.json(), minSpin]);
      if (data.ok) {
        lastData = data;
        loadedAt = Date.now();
        renderView(data);
      } else {
        body.innerHTML = shell(`<p class="imfr-error">${esc(data.error || "Could not complete scan right now.")}</p>`, "Scan unavailable");
      }
    } catch (err) {
      if (!lastData) body.innerHTML = shell('<p class="imfr-error">Could not connect to the scanner. Tap the refresh arrow to try again.</p>', "Scan unavailable");
    } finally {
      isLoading = false;
      page.classList.remove("is-loading");
    }
  }

  // Load when the page is OPENED (menu, back, or restored after a reload). Only the open event counts: the spinner
  // class changes on this element too, and reacting to that restarted a failed scan again and again.
  const pageActive = () => page.classList.contains("active");
  function ensureLoaded() {
    if (!pageActive() || isLoading) return;
    if (!lastData || Date.now() - loadedAt > STALE_MS) fetchRadarData();
  }
  let wasActive = pageActive();
  new MutationObserver(() => { const now = pageActive(); if (now && !wasActive) ensureLoaded(); wasActive = now; }).observe(page, { attributes: true, attributeFilter: ["class"] });
  navButton.addEventListener("click", () => setTimeout(ensureLoaded, 50));
  ensureLoaded(); // restored on a reload

  // Pull down at the top of the page to refresh.
  (function pullToRefresh() {
    const THRESHOLD = 70;
    let startY = null, pulled = 0;
    const hint = document.createElement("div");
    hint.className = "imfr-ptr";
    hint.hidden = true;
    page.prepend(hint);
    const atTop = () => (document.scrollingElement || document.documentElement).scrollTop <= 0;
    const reset = () => { startY = null; pulled = 0; hint.hidden = true; hint.style.height = "0px"; };
    page.addEventListener("touchstart", (e) => { startY = pageActive() && atTop() && !isLoading && e.touches.length === 1 ? e.touches[0].clientY : null; pulled = 0; }, { passive: true });
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

  // Owner check: the menu entry shows only for the owner account (the server decides on every request).
  const ALLOWED_KEY = "marketdock_commodity_radar_allowed";
  const readCached = () => { try { return localStorage.getItem(ALLOWED_KEY) === "1"; } catch (e) { return false; } };
  const writeCached = (v) => { try { v ? localStorage.setItem(ALLOWED_KEY, "1") : localStorage.removeItem(ALLOWED_KEY); } catch (e) { /* ignore */ } };
  let retryTimer = null;
  async function checkAccess(attempt = 0) {
    let verdict = "error";
    try {
      const token = await getOwnerToken();
      if (!token) verdict = "no";
      else {
        const response = await fetch(API + "/api/owner/commodity-radar/access", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
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
    if (!allowed && pageActive()) document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
  }
  if (readCached()) navButton.hidden = false;
  setTimeout(() => checkAccess(), 1400);
  let authWatched = false;
  function watchAuth() {
    if (authWatched) return;
    try {
      const auth = window.marketDockSupabase?.auth;
      if (auth?.onAuthStateChange) { auth.onAuthStateChange(() => { setTimeout(() => checkAccess(), 500); setTimeout(() => { if (pageActive() && !lastData && !isLoading) fetchRadarData(); }, 700); }); authWatched = true; }
    } catch (e) { /* ignore */ }
  }
  watchAuth();
  setTimeout(watchAuth, 2000);
})();
