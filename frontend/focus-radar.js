// Focus Radar (owner only): 1H swing setups (EMA 20/50 pullback) and 1H breakouts for Nifty 50 stocks.
// Rules on closed candles; not a prediction. Server: /api/owner/focus-radar (+ /swing, /access), shared caches.
// Only the signed-in owner can see it: the menu entry stays hidden until the server confirms the owner session,
// and every request is checked again on the server.
(function marketDockFocusRadar() {
  const page = document.getElementById("im-focus-radar");
  const navButton = document.querySelector('.nav-button[data-page="im-focus-radar"]');
  const results = document.getElementById("imFrResults");
  const meta = document.getElementById("imFrMeta");
  const refreshBtn = document.getElementById("imFrRefresh");
  if (!page || !navButton || !results || !meta) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const rupee = (value) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return "--";
    return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const pct = (v, signed) => (Number.isFinite(v) ? (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%" : "--");
  const agoText = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const COLOURS = ["#0052cc", "#172b4d", "#00875a", "#de350b", "#5243aa", "#00a3bf", "#ff5630", "#403294"];
  function avatar(symbol) {
    let hash = 0;
    for (const ch of symbol) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
    return `<span class="imfr-avatar" style="background:${COLOURS[Math.abs(hash) % COLOURS.length]}">${esc(symbol.slice(0, 3))}</span>`;
  }

  let scanning = false;
  let tab = "swing";
  let dirFilter = "all"; // all | bullish | bearish
  const FILTER_LABEL = { all: "All", bullish: "Bull", bearish: "Bear" };
  const data = { swing: null, breakouts: null };
  const errors = { swing: "", breakouts: "" };
  let indexQuotes = [];

  async function token() {
    const { data: session } = await window.marketDockSupabase.auth.getSession();
    const t = session?.session?.access_token;
    if (!t) throw new Error("Please sign in to access Focus Radar.");
    return t;
  }
  async function fetchJson(path) {
    const response = await fetch(API + path, { headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) { const error = new Error(body.error || "Focus Radar is unavailable."); error.status = response.status; throw error; }
    return body;
  }

  // ---------- owner check: show the menu entry only for the owner ----------
  async function checkAccess() {
    let allowed = false;
    try {
      const { data: session } = await window.marketDockSupabase.auth.getSession();
      if (session?.session?.access_token) {
        const response = await fetch(API + "/api/owner/focus-radar/access", { headers: { Authorization: `Bearer ${session.session.access_token}` }, cache: "no-store" });
        allowed = response.ok;
      }
    } catch (e) { allowed = false; }
    navButton.hidden = !allowed;
    if (!allowed && page.classList.contains("active")) document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
    // The page was restored after a reload before the check had finished: scan now that it is confirmed.
    if (allowed && page.classList.contains("active") && !data.swing && !data.breakouts && !scanning) load();
  }

  // ---------- small building blocks ----------
  function spark(values, up) {
    if (!Array.isArray(values) || values.length < 2) return "";
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(30 - ((v - lo) / span) * 28 - 1).toFixed(1)}`).join(" ");
    return `<svg class="imfr-spark ${up ? "is-up" : "is-down"}" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function ring(score, label, soft) {
    const has = Number.isFinite(score);
    return `<div class="imfr-ring${soft ? " is-soft" : ""}" style="--s:${has ? score : 0}"><div><b>${has ? score + "%" : "--"}</b><small>${label}</small></div></div>`;
  }
  function step(title, sub, state) { // state: ok | live | wait
    const mark = state === "ok" ? "✓" : state === "live" ? "⚡" : "⏳";
    return `<div class="imfr-step is-${state}"><b>${title}</b><i>${mark}</i><small>${sub}</small></div>`;
  }
  function head(item, price, change, sparkData, up) {
    return `<div class="imfr-head">
      <span class="imfr-avatar-wrap">${avatar(item.base)}</span>
      <div class="imfr-id"><strong>${esc(item.base)}<span>·NSE</span></strong>${item.name ? `<small>${esc(item.name)}</small>` : ""}</div>
      ${spark(sparkData, up)}
      <div class="imfr-px"><b>${rupee(price)}</b><small class="${change >= 0 ? "imfr-up" : "imfr-down"}">${pct(change, true)}</small></div>
    </div>`;
  }
  function actions(item, bull) {
    return `<div class="imfr-actions">
      <button type="button" class="imfr-ticket ${bull ? "is-buy" : "is-sell"}" data-fr-ticket="${esc(item.base)}" data-fr-side="${bull ? "buy" : "sell"}" data-fr-price="${esc(item.price)}">⚡ Open Paper Ticket · ${bull ? "Buy" : "Sell"}</button>
      <button type="button" class="imfr-analysis" data-fr-coin="${esc(item.base)}" data-fr-price="${esc(item.price)}">📊 Analysis</button>
    </div>`;
  }

  // ---------- swing setups ----------
  // Live price from the app's own watchlist feed is not available here, so the cards use the scan's price;
  // a refresh re-scans. (The server keeps one shared 5-minute scan.)
  function swingCard(item) {
    const bull = item.side === "bullish";
    const zone = item.state === "zone";
    const change = Number(item.change_percent) || 0;
    const s3 = item.state === "triggered" ? ["Trigger", `Active · ${bull ? "long" : "short"} entry live`, "live"]
      : item.state === "target1" ? ["Trigger", "Target 1 hit", "ok"]
      : item.state === "ready" ? ["Trigger", `${bull ? "Above " : "Below "}${rupee(item.entry)}`, "wait"]
      : ["Trigger", "After the rejection candle", "wait"];
    const steps = [
      step(bull ? "Uptrend" : "Downtrend", `EMA 20 ${bull ? "above" : "below"} 50`, "ok"),
      step("EMA Retest", zone ? "In zone · waiting for rejection" : `Rejection ${agoText(item.rejection_at)}`, zone ? "wait" : "ok"),
      step(s3[0], s3[1], s3[2]),
    ].join("");
    let levels = "";
    if (!zone) {
      const risk = Math.abs(item.entry - item.stop) / item.entry * 100;
      const g1 = Math.abs(item.t1 - item.entry) / item.entry * 100, g2 = Math.abs(item.t2 - item.entry) / item.entry * 100;
      levels = `<div class="imfr-levels">
        <div><span>Entry</span><b>${rupee(item.entry)}</b><em></em></div>
        <div><span>SL</span><b class="imfr-down">${rupee(item.stop)}</b><em class="imfr-down">(−${risk.toFixed(1)}%)</em></div>
        <div><span>Target 1</span><b>${rupee(item.t1)}</b><em class="imfr-up">(+${g1.toFixed(1)}%)</em></div>
        <div><span>Target 2</span><b>${rupee(item.t2)}</b><em class="imfr-up">(+${g2.toFixed(1)}%)</em></div>
      </div>`;
    }
    return `<article class="imfr-card ${bull ? "is-bull" : "is-bear"}" data-symbol="${esc(item.base)}">
      ${head(item, item.price, change, item.spark, bull)}
      <div class="imfr-tags"><span class="imfr-pill">${bull ? "↗ BULLISH PULLBACK · LONG" : "↘ BEARISH PULLBACK · SHORT"}</span><span class="imfr-tag">1H SETUP</span></div>
      <div class="imfr-mid">${ring(zone ? Math.round(0.4 * item.trend_score) : item.score, "Score", zone)}<div class="imfr-steps">${steps}</div></div>
      ${levels}
      <small class="imfr-ema"><i>EMA 20</i> <b>${rupee(item.ema20)}</b> · <i>EMA 50</i> <b>${rupee(item.ema50)}</b></small>
      ${actions(item, bull)}
    </article>`;
  }

  // ---------- breakouts ----------
  function breakoutCard(item) {
    const bull = item.direction === "BULLISH";
    const change = Number(item.change_percent) || 0;
    const steps = [
      step(bull ? "Uptrend" : "Downtrend", `EMA 20 ${bull ? "above" : "below"} 50`, "ok"),
      step("Breakout", `${bull ? "Above" : "Below"} ${rupee(item.break_level)}`, "ok"),
      step("Volume", `${Number(item.volume_ratio).toFixed(2)}× avg`, "live"),
    ].join("");
    return `<article class="imfr-card ${bull ? "is-bull" : "is-bear"}" data-symbol="${esc(item.base)}">
      ${head(item, item.price, change, item.spark, bull)}
      <div class="imfr-tags"><span class="imfr-pill">${bull ? "↗ BULLISH BREAKOUT · LONG WATCH" : "↘ BEARISH BREAKDOWN · SHORT WATCH"}</span><span class="imfr-tag">1H SETUP</span></div>
      <div class="imfr-steps imfr-steps-wide">${steps}</div>
      <div class="imfr-levels">
        <div><span>Break level</span><b>${rupee(item.break_level)}</b><em></em></div>
        <div><span>Price</span><b>${rupee(item.price)}</b><em></em></div>
        <div><span>Volume</span><b>${Number(item.volume_ratio).toFixed(2)}×</b><em></em></div>
        <div><span>Today</span><b class="${change >= 0 ? "imfr-up" : "imfr-down"}">${pct(change, true)}</b><em></em></div>
      </div>
      ${actions(item, bull)}
    </article>`;
  }

  // ---------- render ----------
  const EMPTY = {
    swing: ["No swing setup right now", "No Nifty 50 stock is in a 1H EMA 20/50 pullback. That is normal; check again later."],
    breakouts: ["No qualifying setups right now", "Wait for a confirmed 1-hour breakout or breakdown with volume and trend agreement."],
  };
  function summary() {
    const row = (name, key) => {
      const q = indexQuotes.find((x) => String(x.symbol || "").toLowerCase() === key);
      const c = q ? Number(q.change_percent) : NaN;
      return Number.isFinite(c) ? `<div><span><i class="${c >= 0 ? "is-up" : "is-down"}"></i>${name}</span> <b class="${c >= 0 ? "imfr-up" : "imfr-down"}">${pct(c, true)}</b></div>` : "";
    };
    const body = data[tab] || data.swing || data.breakouts;
    const scanned = body ? body.scanned : 0;
    const open = body ? body.market_open : null;
    const sub = body ? (open === false ? "Market closed · last session's candles" : `Updated ${agoText(body.at)}`) : "Live market opportunities";
    return `<div class="imfr-summary"><svg class="imfr-radar" viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27"/><circle cx="30" cy="30" r="18"/><circle cx="30" cy="30" r="9"/><path d="M30 30 L52 14"/></svg>
      <div><b>Scanning ${scanned} stocks</b><small>${sub}</small></div><div class="imfr-ticks">${row("NIFTY", "nifty")}${row("BANKNIFTY", "banknifty")}${row("SENSEX", "sensex")}</div></div>`;
  }
  function counts() {
    const sw = data.swing ? data.swing.setups.length : null;
    const br = data.breakouts ? (data.breakouts.signals || []).length : null;
    const sb = document.querySelector('#imFrTabs [data-fr-tab="swing"]'), bb = document.querySelector('#imFrTabs [data-fr-tab="breakouts"]');
    if (sb) sb.textContent = `1H Swings${sw === null ? "" : ` (${sw})`}`;
    if (bb) bb.textContent = `Breakouts${br === null ? "" : ` (${br})`}`;
  }
  function render() {
    counts();
    document.querySelectorAll("#imFrTabs button").forEach((b) => b.classList.toggle("is-active", b.dataset.frTab === tab));
    const body = data[tab];
    if (!body) {
      meta.textContent = errors[tab] ? "Scan unavailable" : "Using closed 1-hour candles";
      results.innerHTML = errors[tab] ? `<p class="imfr-error">${esc(errors[tab])}</p>` : '<p class="imfr-loading">Scanning the stocks… this can take a few seconds.</p>';
      return;
    }
    let cards;
    if (tab === "swing") {
      const rows = body.setups;
      const bull = rows.filter((r) => r.side === "bullish").length;
      meta.textContent = `Nifty 50 · ${bull} bullish, ${rows.length - bull} bearish`;
      cards = rows.filter((r) => dirFilter === "all" || r.side === dirFilter).map(swingCard);
    } else {
      meta.textContent = `Scanned ${body.scanned || 0} stocks · updated ${new Date((body.at || Date.now() / 1000) * 1000).toLocaleTimeString()}`;
      cards = (body.signals || []).filter((r) => dirFilter === "all" || r.direction.toLowerCase() === dirFilter).map(breakoutCard);
    }
    const note = tab === "swing"
      ? '<p class="imfr-note">Score = trend strength 40% + rejection candle quality 35% + stop tightness 25%. It rates how complete and clean the setup looks, not the chance of winning. A card still waiting in the zone has earned only the trend part, so its score stays low until a rejection candle forms. Trigger only becomes active after that candle forms and price crosses its high (bullish) or low (bearish). NSE hourly candles run 9:15 to 15:30 IST; outside market hours the cards show the last session.</p>' : "";
    results.innerHTML = summary() + (cards.length ? cards.join("") : `<div class="imfr-empty"><strong>${EMPTY[tab][0]}</strong><p>${EMPTY[tab][1]}</p></div>`) + note;
  }

  async function loadOne(kind) {
    try {
      data[kind] = await fetchJson(kind === "swing" ? "/api/owner/focus-radar/swing" : "/api/owner/focus-radar");
      errors[kind] = "";
    } catch (error) {
      errors[kind] = error.status === 401 || error.status === 403 ? "Owner session required." : (error.message || "Could not load Focus Radar.");
    }
  }
  async function loadIndexQuotes() {
    try {
      const response = await fetch(API + "/api/index-quotes", { cache: "no-store" });
      const body = await response.json();
      if (body && Array.isArray(body.data)) indexQuotes = body.data;
    } catch (e) { /* the strip just shows fewer numbers */ }
  }

  // While the scan runs, the target and the refresh arrow spin; they stop when the results show.
  // A scan answered from the server cache takes a blink, so the spin lasts at least 0.8 s to be seen.
  async function load() {
    if (scanning) return;
    scanning = true;
    page.classList.add("is-loading");
    refreshBtn.disabled = true;
    data.swing = null; data.breakouts = null; render();
    await Promise.all([loadOne("swing"), loadOne("breakouts"), loadIndexQuotes(), new Promise((done) => setTimeout(done, 800))]);
    refreshBtn.disabled = false;
    page.classList.remove("is-loading");
    scanning = false;
    render();
  }

  // ---------- events ----------
  document.getElementById("imFrTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-fr-tab]");
    if (!button || button.dataset.frTab === tab) return;
    tab = button.dataset.frTab;
    render();
  });
  const filterBtn = document.getElementById("imFrFilter");
  filterBtn?.addEventListener("click", () => {
    dirFilter = dirFilter === "all" ? "bullish" : dirFilter === "bullish" ? "bearish" : "all";
    filterBtn.querySelector("span").textContent = FILTER_LABEL[dirFilter];
    render();
  });
  refreshBtn?.addEventListener("click", load);
  results.addEventListener("click", (event) => {
    const ticket = event.target.closest("[data-fr-ticket]");
    if (ticket) {
      const { frTicket: symbol, frSide: side, frPrice: price } = ticket.dataset;
      window.openImWatchlistActionSheet?.(symbol, Number(price));
      // The stock sheet is open: tap its own Buy / Sell so the order form opens straight away.
      document.getElementById(side === "buy" ? "im-action-sheet-buy-btn" : "im-action-sheet-sell-btn")?.click();
      return;
    }
    const analysis = event.target.closest("[data-fr-coin]");
    if (analysis) window.openImWatchlistActionSheet?.(analysis.dataset.frCoin, Number(analysis.dataset.frPrice));
  });

  // Opening the page (from the menu, or coming back to it) starts a scan.
  let wasActive = false;
  new MutationObserver(() => {
    const active = page.classList.contains("active");
    if (active && !wasActive) load();
    wasActive = active;
  }).observe(page, { attributes: true, attributeFilter: ["class"] });

  // Owner check now and whenever the signed-in user changes.
  setTimeout(checkAccess, 1500);
  let authWatched = false;
  function watchAuth() {
    if (authWatched) return;
    try {
      const auth = window.marketDockSupabase?.auth;
      if (auth?.onAuthStateChange) { auth.onAuthStateChange(() => setTimeout(checkAccess, 400)); authWatched = true; }
    } catch (e) { /* ignore */ }
  }
  watchAuth();
  setTimeout(watchAuth, 2000);
})();
