// Smart MTF Scanner (owner only: amitkmrai21@gmail.com)
// Multi-timeframe institutional confluence: 1W Pivots + 1D S/R + 1H Golden Pocket & ADX + 15m Rejection Trigger.
// Supports both Indian Market Equities (NSE) and Commodities (MCX).
(function marketDockSmartMtf() {
  const page = document.getElementById("im-smart-mtf");
  const navButton = document.querySelector('.nav-button[data-page="im-smart-mtf"]');
  const body = document.getElementById("imMtfBody");
  if (!page || !navButton || !body) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";

  let activeSegment = "all";       // 'all' | 'nse' | 'mcx'
  let triggerFilter = "all";       // 'all' | 'confirmed' | 'in_zone'
  let dirFilter = "all";           // 'all' | 'bullish' | 'bearish'
  let lastData = null;
  let isLoading = false;
  const FILTERS = ["all", "bullish", "bearish"];
  const FILTER_LABEL = { all: "All Directions", bullish: "Bullish (Long)", bearish: "Bearish (Short)" };

  async function getOwnerToken(waitMs = 6000) {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase.auth.getSession();
        const token = session?.session?.access_token;
        if (token) return token;
      } catch (e) { /* session client loading */ }
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i) || "";
          if (key.startsWith("sb-") && key.endsWith("-auth-token")) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (parsed?.access_token) return parsed.access_token;
            }
          }
        }
      } catch (e) {}
      if (Date.now() >= until) return null;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

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
  function avatar(symbol) {
    let hash = 0;
    for (const ch of symbol) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
    return `<span class="imfr-avatar" style="background:${COLOURS[Math.abs(hash) % COLOURS.length]}">${esc(symbol.slice(0, 3))}</span>`;
  }

  function orderData(s) {
    if (s.market === "mcx") {
      return ` data-fr-order="${esc(s.trading_symbol || s.symbol)}" data-fr-mcx="1" data-fr-key="${esc(s.commodity_key)}" data-fr-cname="${esc(s.commodity_name)}" data-fr-lot="${esc(s.lot_size)}" data-fr-chg="${esc(s.change_pct)}"`;
    }
    return ` data-fr-order="${esc(s.symbol)}"`;
  }

  function openSheet(el, price) {
    const d = el.dataset;
    if (d.frMcx) {
      const base = String(d.frOrder).replace(/\d{2}[A-Z]{3}FUT$/, "");
      window.openImWatchlistActionSheet?.(d.frOrder, price, {
        chartSymbol: `MCX:${base}1!`,
        isCommodity: true,
        changePercent: Number(d.frChg),
        lotSize: Number(d.frLot) || undefined,
        commodityKey: d.frKey,
        commodityName: d.frCname,
      });
    } else {
      window.openImWatchlistActionSheet?.(d.frOrder, price);
    }
  }

  function card(s) {
    const bull = s.type === "BULLISH" || s.side === "bullish";
    const change = Number(s.change_pct) || 0;
    const entry = Number(s.entry), price = Number(s.price);
    const gain = (v) => (entry ? Math.abs(Number(v) - entry) / entry * 100 : 0);
    const isConfirmed = s.trigger_state === "CONFIRMED" || s.has_wick;

    const mtfGrid = `
      <div class="imfr-mtf-grid">
        <div class="imfr-mtf-box">
          <small>1W Turn Pivot</small>
          <b>${rupee(s.w_level)}</b>
        </div>
        <div class="imfr-mtf-box">
          <small>1D S/R Structure</small>
          <b>${rupee(s.d_level)}</b>
        </div>
        <div class="imfr-mtf-box">
          <small>1H Trend &amp; ADX</small>
          <b>${bull ? "EMA20 > 50" : "EMA20 < 50"} · ADX ${esc(s.adx || "--")}</b>
        </div>
        <div class="imfr-mtf-box ${isConfirmed ? "imfr-trigger-confirmed" : "imfr-trigger-zone"}">
          <small>15m Trigger</small>
          <b>${isConfirmed ? "⚡ Rejection Wick ✓" : "⏳ Retracing in Zone"}</b>
        </div>
      </div>
    `;

    const levels = `
      <div class="imfr-levels">
        <div><span>Entry</span><b>${rupee(s.entry)}</b><em></em></div>
        <div><span>Stop Loss</span><b class="imfr-down">${rupee(s.stop_loss)}</b><em class="imfr-down">(−${Number(s.risk_pct).toFixed(1)}%)</em></div>
        <div><span>Target 1</span><b>${rupee(s.target_1)}</b><em class="imfr-up">(+${gain(s.target_1).toFixed(1)}% · ${s.rr1 || "1.5"}R)</em></div>
        <div><span>Target 2</span><b>${rupee(s.target_2)}</b><em class="imfr-up">(+${gain(s.target_2).toFixed(1)}% · ${s.rr2 || "2.5"}R)</em></div>
      </div>
      <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:11px; color:var(--im-muted);">
        <span>Fib Golden Pocket: <b>${esc(s.fib_zone)}</b></span>
        <span>R:R <b>${esc(s.rr_ratio || "1:1.5+")}</b></span>
      </div>
      ${s.reason ? `<p class="imfr-reason" style="margin-top:8px;">${esc(s.reason)}</p>` : ""}
    `;

    const ticket = `<button type="button" class="imfr-ticket ${bull ? "is-buy" : "is-sell"}" data-mtf-ticket="1"${orderData(s)} data-fr-side="${bull ? "buy" : "sell"}" data-fr-price="${esc(s.price)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>`;

    const marketBadge = s.market === "mcx"
      ? `<span style="font-size:10px; font-weight:800; background:#f59e0b; color:#000; padding:2px 6px; border-radius:4px; margin-left:4px;">MCX</span>`
      : `<span style="font-size:10px; font-weight:800; background:#3b82f6; color:#fff; padding:2px 6px; border-radius:4px; margin-left:4px;">NSE</span>`;

    return `<article class="imfr-card ${bull ? "is-bull" : "is-bear"}" data-symbol="${esc(s.symbol)}">
      <div class="imfr-head">
        <span class="imfr-avatar-wrap">${avatar(String(s.symbol))}</span>
        <div class="imfr-id">
          <strong>${esc(s.symbol)}${marketBadge}</strong>
          <small>${esc(s.name) + (s.sector ? " · " + esc(s.sector) : "")}</small>
        </div>
        <div class="imfr-px">
          <b>${rupee(price)}</b>
          <small class="${change >= 0 ? "imfr-up" : "imfr-down"}">${pct(change, true)}</small>
        </div>
      </div>
      <div class="imfr-tags" style="margin: 8px 0 4px 0;">
        <span class="imfr-pill">${bull ? "↗ BULLISH BUY · LONG" : "↘ BEARISH · SHORT"}</span>
        <span class="imfr-tag ${isConfirmed ? "imfr-trigger-confirmed" : "imfr-trigger-zone"}">${isConfirmed ? "⚡ CONFIRMED TRIGGER" : "⏳ IN GOLDEN POCKET"}</span>
      </div>
      ${mtfGrid}
      ${levels}
      <div class="imfr-actions" style="margin-top:10px;">
        ${ticket}
        <button type="button" class="imfr-analysis" data-mtf-coin="1"${orderData(s)} data-fr-price="${esc(s.price)}">📊 Analysis</button>
      </div>
    </article>`;
  }

  function shell(inner, notice) {
    return `<div class="imfr-page">
      <div class="imfr-top">
        <span class="imfr-logo">🎯</span>
        <div>
          <strong>SMART MTF SCANNER</strong>
          <small>1W + 1D + 1H GOLDEN POCKET + 15M REJECTION</small>
        </div>
        <button type="button" class="imfr-iconbtn" id="imMtfRefresh" title="Refresh Smart MTF Scan" aria-label="Refresh">
          <svg class="imfr-spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/></svg>
        </button>
      </div>
      ${notice ? `<p class="imfr-notice">${notice}</p>` : ""}
      ${inner}
    </div>`;
  }

  function renderLoading() {
    body.innerHTML = shell(`
      <div class="imfr-summary"><p class="imfr-loading">Scanning NSE Equities &amp; MCX Commodities across 1W, 1D, 1H Fib Golden Pocket &amp; 15m Rejection triggers…</p></div>
    `, "Real-time Multi-Timeframe Institutional Confluence");
  }

  function renderView(data) {
    const rawSetups = Array.isArray(data?.setups) ? data.setups : [];
    
    // Segment filter
    let setups = rawSetups.filter((s) => {
      if (activeSegment === "nse") return s.market === "nse";
      if (activeSegment === "mcx") return s.market === "mcx";
      return true;
    });

    // Trigger state filter
    if (triggerFilter === "confirmed") {
      setups = setups.filter((s) => s.trigger_state === "CONFIRMED" || s.has_wick);
    } else if (triggerFilter === "in_zone") {
      setups = setups.filter((s) => !(s.trigger_state === "CONFIRMED" || s.has_wick));
    }

    // Direction filter
    if (dirFilter === "bullish") setups = setups.filter((s) => s.type === "BULLISH" || s.side === "bullish");
    if (dirFilter === "bearish") setups = setups.filter((s) => s.type === "BEARISH" || s.side === "bearish");

    const totalCount = rawSetups.length;
    const confirmedCount = rawSetups.filter((s) => s.trigger_state === "CONFIRMED" || s.has_wick).length;
    const inZoneCount = totalCount - confirmedCount;

    const segmentPills = `
      <div class="imfr-tabs" style="margin-bottom: 6px;">
        <button type="button" class="imfr-pilltab ${activeSegment === "all" ? "is-active" : ""}" data-mtf-seg="all">All Markets (${totalCount})</button>
        <button type="button" class="imfr-pilltab ${activeSegment === "nse" ? "is-active" : ""}" data-mtf-seg="nse">NSE Stocks (${rawSetups.filter(s => s.market === "nse").length})</button>
        <button type="button" class="imfr-pilltab ${activeSegment === "mcx" ? "is-active" : ""}" data-mtf-seg="mcx">MCX Commodities (${rawSetups.filter(s => s.market === "mcx").length})</button>
      </div>
    `;

    const statusPills = `
      <div class="imfr-bar">
        <div class="imfr-tabs">
          <button type="button" class="imfr-pilltab ${triggerFilter === "all" ? "is-active" : ""}" data-mtf-trigger="all">All Setups</button>
          <button type="button" class="imfr-pilltab ${triggerFilter === "confirmed" ? "is-active" : ""}" data-mtf-trigger="confirmed">⚡ Confirmed (${confirmedCount})</button>
          <button type="button" class="imfr-pilltab ${triggerFilter === "in_zone" ? "is-active" : ""}" data-mtf-trigger="in_zone">⏳ In Zone (${inZoneCount})</button>
        </div>
        <button type="button" class="imfr-filter" id="imMtfDirFilter" title="Toggle Bullish/Bearish/All">
          <svg viewBox="0 0 24 24"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
          <span>${FILTER_LABEL[dirFilter] || "All"}</span>
        </button>
      </div>
    `;

    const nseLive = data.market_status === "live";
    const mcxLive = data.mcx_status === "live";
    const niftyBias = esc(String(data.nifty_bias || "neutral").toUpperCase());

    const summaryBar = `
      <div class="imfr-summary" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <div style="font-size:11px; display:flex; gap:12px;">
          <span>NSE: <b class="${nseLive ? "imfr-up" : "imfr-down"}">${nseLive ? "● LIVE" : "○ CLOSED"}</b></span>
          <span>MCX: <b class="${mcxLive ? "imfr-up" : "imfr-down"}">${mcxLive ? "● LIVE" : "○ CLOSED"}</b></span>
          <span>NIFTY 50: <b style="color:var(--im-blue);">${niftyBias}</b></span>
        </div>
        <span class="imfr-meta">Updated ${agoText(data.updated_at)}</span>
      </div>
    `;

    let cardsHtml = "";
    if (setups.length === 0) {
      cardsHtml = `
        <div class="imfr-empty">
          <div style="font-size:28px; margin-bottom:6px;">🎯</div>
          <strong>No MTF Confluence Setups Right Now</strong>
          <p>
            Smart MTF uses a strict 4-layer institutional model:<br>
            <b>1.</b> 1W Turning Pivots &amp; 1D S/R structure level alignment<br>
            <b>2.</b> 1H Trend (EMA 20 &amp; 50) + ADX trend strength &gt; 14<br>
            <b>3.</b> 1H Fibonacci Golden Pocket (0.50–0.618 OTE) Retracement<br>
            <b>4.</b> 15m Rejection Trigger (wick &ge; 20% or reversal close)<br>
            Rather than forcing risky trades during choppy market hours, Smart MTF only alerts when high-probability confluence forms. Tap the refresh button above to rescan anytime.
          </p>
        </div>
      `;
    } else {
      cardsHtml = `<div class="imfr-results">${setups.map(card).join("")}</div>`;
    }

    body.innerHTML = shell(`
      ${summaryBar}
      ${segmentPills}
      ${statusPills}
      ${cardsHtml}
    `, "Real-time Multi-Timeframe Institutional Confluence");
  }

  body.addEventListener("click", (event) => {
    const segBtn = event.target.closest("[data-mtf-seg]");
    if (segBtn) {
      activeSegment = segBtn.dataset.mtfSeg;
      if (lastData) renderView(lastData);
      return;
    }

    const trigBtn = event.target.closest("[data-mtf-trigger]");
    if (trigBtn) {
      triggerFilter = trigBtn.dataset.mtfTrigger;
      if (lastData) renderView(lastData);
      return;
    }

    if (event.target.closest("#imMtfDirFilter")) {
      dirFilter = FILTERS[(FILTERS.indexOf(dirFilter) + 1) % FILTERS.length];
      if (lastData) renderView(lastData);
      return;
    }

    if (event.target.closest("#imMtfRefresh")) {
      fetchMtfData(true);
      return;
    }

    const ticket = event.target.closest("[data-mtf-ticket]");
    if (ticket) {
      const { frSide: side, frPrice: price } = ticket.dataset;
      openSheet(ticket, Number(price));
      document.getElementById(side === "buy" ? "im-action-sheet-buy-btn" : "im-action-sheet-sell-btn")?.click();
      return;
    }

    const analysis = event.target.closest("[data-mtf-coin]");
    if (analysis) {
      openSheet(analysis, Number(analysis.dataset.frPrice));
    }
  });

  async function fetchMtfData(force = false) {
    if (isLoading) return;
    isLoading = true;
    page.classList.add("is-loading");
    const minSpin = new Promise((resolve) => setTimeout(resolve, 800));
    if (!lastData) renderLoading();

    try {
      const token = await getOwnerToken();
      if (!token) {
        body.innerHTML = shell(`<p class="imfr-error">Signing in… If this stays, sign in with your owner account, then tap the refresh arrow.</p>`, "Sign in required");
        return;
      }
      let res;
      try {
        res = await fetch(`${API}/api/owner/smart-mtf${force ? "?refresh=1" : ""}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (netErr) {
        body.innerHTML = shell(`<p class="imfr-error">Could not reach the MarketDock server. Please check your network and tap refresh.</p>`, "Network error");
        return;
      }

      if (res.status === 401 || res.status === 403) {
        body.innerHTML = shell(`<p class="imfr-error">Smart MTF Scanner is locked. It is available only for the owner account (amitkmrai21@gmail.com).</p>`, "Scan unavailable");
        return;
      }
      if (!res.ok) {
        body.innerHTML = shell(`<p class="imfr-error">Server returned status ${res.status}. Please tap refresh to retry.</p>`, "Scan unavailable");
        return;
      }

      const json = await res.json();
      if (!json.ok) {
        body.innerHTML = shell(`<p class="imfr-error">${esc(json.error || "Could not read Smart MTF data.")}</p>`, "Scan unavailable");
        return;
      }

      lastData = json;
      renderView(json);
    } catch (e) {
      body.innerHTML = shell(`<p class="imfr-error">Failed to scan markets: ${esc(e.message || e)}</p>`, "Scan failed");
    } finally {
      await minSpin;
      isLoading = false;
      page.classList.remove("is-loading");
    }
  }

  // Auto-fetch when user navigates to the page
  let autoFetched = false;
  function onPageShow() {
    if (page.classList.contains("active") && !autoFetched) {
      autoFetched = true;
      fetchMtfData(false);
    }
  }
  new MutationObserver(onPageShow).observe(page, { attributes: true, attributeFilter: ["class"] });
  document.addEventListener("click", (e) => {
    const tile = e.target.closest('[data-more="im-smart-mtf"]');
    if (tile && !lastData) setTimeout(() => fetchMtfData(false), 200);
  });

  // Owner check: Unhide nav button for amitkmrai21@gmail.com
  const ALLOWED_KEY = "marketdock_smart_mtf_allowed";
  const readCached = () => {
    try {
      if (localStorage.getItem(ALLOWED_KEY) === "1") return true;
      if (localStorage.getItem("marketdock_focus_radar_allowed") === "1") return true;
      if (localStorage.getItem("marketdock_commodity_radar_allowed") === "1") return true;
    } catch (e) {}
    return false;
  };
  const writeCached = (v) => {
    try {
      if (v) {
        localStorage.setItem(ALLOWED_KEY, "1");
      } else {
        localStorage.removeItem(ALLOWED_KEY);
      }
    } catch (e) {}
  };
  let retryTimer = null;

  async function checkAccess(attempt = 0) {
    let verdict = "error";
    try {
      const token = await getOwnerToken();
      if (!token) verdict = "no";
      else {
        const response = await fetch(API + "/api/owner/smart-mtf/access", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store"
        });
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
    if (!allowed && page.classList.contains("active")) {
      document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
    }
  }

  if (readCached()) navButton.hidden = false;
  setTimeout(() => checkAccess(), 1200);

  let authWatched = false;
  function watchAuth() {
    if (authWatched) return;
    try {
      const auth = window.marketDockSupabase?.auth;
      if (auth?.onAuthStateChange) {
        auth.onAuthStateChange(() => {
          setTimeout(() => checkAccess(0), 400);
        });
        authWatched = true;
      }
    } catch (e) {}
  }
  watchAuth();
  setTimeout(watchAuth, 3000);
})();
