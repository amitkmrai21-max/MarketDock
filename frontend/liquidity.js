// MarketDock Liquidity Hunter (5m & 15m) - Dedicated to NSE Equities & MCX Commodities
// Strictly owner-only (amitkmrai21@gmail.com)
// Styled to match Commodity Radar and Focus Radar natively.
(function marketDockLiquidityHunter() {
  const page = document.getElementById("im-liquidity");
  const navButton = document.querySelector('.nav-button[data-page="im-liquidity"]');
  const body = document.getElementById("imLiquidityBody");
  if (!page || !body) return;

  const API = window.MD_API_BASE || "https://api.marketdock.in";

  let activeTf = "all";         // 'all' | '5m' | '15m'
  let activeMarket = "all";     // 'all' | 'nse' | 'mcx'
  let dirFilter = "all";        // 'all' | 'bullish' | 'bearish'
  let lastData = null;
  let isLoading = false;
  let loadedAt = 0;
  let autoTimer = null;
  let isOwnerAllowed = false;

  const FILTERS = ["all", "bullish", "bearish"];
  const FILTER_LABEL = { all: "All Sides", bullish: "Bullish (Long)", bearish: "Bearish (Short)" };

  const ALLOWED_KEY = "marketdock_liquidity_allowed";
  const readCached = () => {
    try {
      if (localStorage.getItem(ALLOWED_KEY) === "1") return true;
      if (localStorage.getItem("marketdock_smart_mtf_allowed") === "1") return true;
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

  async function getOwnerToken(waitMs = 5000) {
    const until = Date.now() + waitMs;
    for (;;) {
      try {
        const { data: session } = await window.marketDockSupabase.auth.getSession();
        const token = session?.session?.access_token;
        if (token) return token;
      } catch (e) {}
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
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const rupee = (value) => {
    const v = Number(value);
    return Number.isFinite(v) ? "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "--";
  };
  const pct = (v, signed) => (Number.isFinite(v) ? (signed && v > 0 ? "+" : "") + v.toFixed(2) + "%" : "--");

  const agoText = (ts) => {
    if (!ts) return "just now";
    const t = typeof ts === "number" ? (ts < 1e11 ? ts * 1000 : ts) : Date.parse(ts);
    if (!Number.isFinite(t)) return "just now";
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 45) return "just now";
    const m = Math.round(sec / 60);
    return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };

  const COMMODITY_ICONS = {
    gold: ["🪙", "#b45309"], silver: ["🥈", "#475569"], crudeoil: ["🛢️", "#991b1b"], naturalgas: ["⚡", "#1d4ed8"],
    copper: ["🔶", "#c2410c"], zinc: ["⚙️", "#6d28d9"], aluminium: ["🪨", "#0f766e"],
  };

  function getAvatar(s) {
    const symLower = String(s.symbol || "").toLowerCase().replace(/[^a-z]/g, "");
    if (s.market === "mcx" || COMMODITY_ICONS[symLower]) {
      const [icon, bg] = COMMODITY_ICONS[symLower] || ["📦", "#334155"];
      return { icon, bg };
    }
    const hues = [210, 160, 280, 35, 190, 340, 45];
    let hash = 0;
    for (let i = 0; i < (s.symbol || "").length; i++) hash = s.symbol.charCodeAt(i) + ((hash << 5) - hash);
    const bg = `hsl(${hues[Math.abs(hash) % hues.length]}, 70%, 42%)`;
    return { icon: (s.symbol || "").slice(0, 3).toUpperCase(), bg };
  }

  let retryTimer = null;
  async function checkAccess(attempt = 0) {
    let verdict = "error";
    try {
      const token = await getOwnerToken();
      if (!token) {
        verdict = "no";
      } else {
        const res = await fetch(`${API}/api/owner/liquidity/access`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store"
        });
        verdict = res.ok ? "yes" : (res.status === 401 || res.status === 403) ? "no" : "error";
      }
    } catch (e) {
      verdict = "error";
    }

    clearTimeout(retryTimer);
    if (verdict === "error") {
      if (attempt < 4) retryTimer = setTimeout(() => checkAccess(attempt + 1), [3000, 8000, 20000, 45000][attempt]);
      return;
    }

    isOwnerAllowed = (verdict === "yes");
    writeCached(isOwnerAllowed);
    if (navButton) navButton.hidden = !isOwnerAllowed;

    if (!isOwnerAllowed && page.classList.contains("active")) {
      document.querySelector('.nav-button[data-page="im-dashboard"]')?.click();
    }
  }

  if (readCached() && navButton) navButton.hidden = false;
  setTimeout(() => checkAccess(), 1200);

  try {
    const auth = window.marketDockSupabase?.auth;
    if (auth?.onAuthStateChange) {
      auth.onAuthStateChange(() => {
        setTimeout(() => checkAccess(0), 400);
      });
    }
  } catch (e) {}

  function card(s) {
    const bull = String(s.direction).toLowerCase() === "bullish";
    const { icon: avatarIcon, bg: avatarBg } = getAvatar(s);
    const price = Number(s.price || s.current_price || s.entry_price || s.entry || 0);
    const entry = Number(s.entry_price || s.entry || price);
    const sl = Number(s.stop_loss || 0);
    const tp1 = Number(s.target_1 || s.target_price || 0);
    const tp2 = Number(s.target_2 || (tp1 ? tp1 * (bull ? 1.015 : 0.985) : 0));

    const slDiff = price > 0 ? ((sl - price) / price) * 100 : 0;
    const tp1Diff = price > 0 ? ((tp1 - price) / price) * 100 : 0;
    const tp2Diff = price > 0 ? ((tp2 - price) / price) * 100 : 0;

    const detectedText = agoText(s.detected_at);

    return `
      <article class="imfr-card ${bull ? 'is-bull' : 'is-bear'}" data-symbol="${esc(s.symbol)}">
        <div class="imfr-head">
          <span class="imfr-avatar" style="background:${avatarBg};">${avatarIcon}</span>
          <div class="imfr-id">
            <strong>${esc(s.symbol)}<span>&bull;${esc(String(s.market).toUpperCase())}</span></strong>
            <small>${esc(s.name || s.symbol)} &bull; ${detectedText}</small>
          </div>
          <div class="imfr-px">
            <b>${rupee(price)}</b>
            <small style="color:var(--im-muted);">${esc(s.timeframe).toUpperCase()}</small>
          </div>
        </div>

        <div class="imfr-tags">
          <span class="imfr-pill">${bull ? "↗ BULLISH · LONG" : "↘ BEARISH · SHORT"}</span>
          <span class="imfr-tag">${esc(s.setup_name || s.pattern_name)}</span>
        </div>

        <div class="imfr-levels">
          <div><span>Entry</span><b>${rupee(entry)}</b></div>
          <div><span>SL</span><b>${rupee(sl)}</b><em class="${slDiff >= 0 ? 'imfr-up' : 'imfr-down'}">${pct(slDiff, true)}</em></div>
          <div><span>Target 1</span><b>${rupee(tp1)}</b><em class="${tp1Diff >= 0 ? 'imfr-up' : 'imfr-down'}">${pct(tp1Diff, true)}</em></div>
          <div><span>Target 2</span><b>${rupee(tp2)}</b><em class="${tp2Diff >= 0 ? 'imfr-up' : 'imfr-down'}">${pct(tp2Diff, true)}</em></div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;color:var(--im-muted);padding:0 2px;">
          <span>Trigger: <strong style="color:var(--im-text);">${esc(s.trigger_event)}</strong></span>
          <span>R:R: <strong style="color:var(--im-text);">1 : ${s.risk_reward}</strong></span>
        </div>

        <div class="imfr-story">
          ${esc(s.explanation)}
        </div>
      </article>
    `;
  }

  function shell(inner) {
    const rawSetups = (lastData && lastData.setups) || [];
    const totalCount = rawSetups.length;
    const c5m = rawSetups.filter(s => String(s.timeframe).toLowerCase() === "5m").length;
    const c15m = rawSetups.filter(s => String(s.timeframe).toLowerCase() === "15m").length;
    const nseCount = rawSetups.filter(s => String(s.market).toLowerCase() === "nse").length;
    const mcxCount = rawSetups.filter(s => String(s.market).toLowerCase() === "mcx").length;

    const updatedText = loadedAt ? `Updated ${agoText(loadedAt)}` : "Awaiting scan";

    return `
      <div class="imfr-page">
        <!-- Top bar: Clean bold Liquidity + spinning icon button on far right -->
        <div class="imfr-top">
          <span class="imfr-logo" aria-hidden="true">💧</span>
          <div>
            <strong>Liquidity</strong>
            <small>5M &amp; 15M INSTITUTIONAL SWEEPS &bull; NSE &amp; MCX</small>
          </div>
          <button id="imLiqTelegramTest" class="imfr-iconbtn" type="button" aria-label="Send Telegram Test Alert" title="Send Telegram Test Alert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
          <button id="imLiqRefresh" class="imfr-iconbtn" type="button" aria-label="Scan Liquidity" title="Scan Liquidity">
            <svg class="imfr-spin" viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>

        <!-- Filter bar: Pill tabs and direction dropdown matching Commodity Radar -->
        <div class="imfr-bar">
          <div class="imfr-tabs">
            <button type="button" class="imfr-pilltab ${activeTf === 'all' && activeMarket === 'all' ? 'is-active' : ''}" data-liq-reset="1">All (${totalCount})</button>
            <button type="button" class="imfr-pilltab ${activeTf === '5m' ? 'is-active' : ''}" data-liq-tf="5m">5m (${c5m})</button>
            <button type="button" class="imfr-pilltab ${activeTf === '15m' ? 'is-active' : ''}" data-liq-tf="15m">15m (${c15m})</button>
            <button type="button" class="imfr-pilltab ${activeMarket === 'nse' ? 'is-active' : ''}" data-liq-mkt="nse">NSE (${nseCount})</button>
            <button type="button" class="imfr-pilltab ${activeMarket === 'mcx' ? 'is-active' : ''}" data-liq-mkt="mcx">MCX (${mcxCount})</button>
          </div>
          <button id="imLiqFilter" class="imfr-filter" type="button" aria-label="Filter direction">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4-2v-4z"/></svg>
            <span>${FILTER_LABEL[dirFilter]}</span>
          </button>
        </div>

        <!-- Summary row matching Commodity Radar -->
        <div class="imfr-summary">
          <svg class="imfr-radar" viewBox="0 0 60 60" aria-hidden="true">
            <circle cx="30" cy="30" r="27"/>
            <circle cx="30" cy="30" r="18"/>
            <circle cx="30" cy="30" r="9"/>
            <path d="M30 30 L52 14"/>
          </svg>
          <div>
            <b>Liquidity Hunter</b>
            <small>${updatedText}</small>
          </div>
          <div class="imfr-ticks">
            <div><span><i class="${totalCount ? 'is-up' : ''}"></i>Setups</span> <b>${totalCount}</b></div>
            <div><span><i></i>Timeframes</span> <b>5m &amp; 15m</b></div>
          </div>
        </div>

        <!-- Setup cards results -->
        <div class="imfr-results">
          ${inner}
        </div>
      </div>
    `;
  }

  function renderView() {
    if (!lastData) {
      body.innerHTML = shell('<p class="imfr-loading">Scanning 5m &amp; 15m liquidity setups across NSE Equities &amp; MCX Commodities…</p>');
      return;
    }

    const raw = lastData.setups || [];
    const filtered = raw.filter(s => {
      if (activeTf !== "all" && String(s.timeframe).toLowerCase() !== activeTf) return false;
      if (activeMarket !== "all" && String(s.market).toLowerCase() !== activeMarket) return false;
      if (dirFilter !== "all" && String(s.direction).toLowerCase() !== dirFilter) return false;
      return true;
    });

    const inner = filtered.length
      ? filtered.map(card).join("")
      : `
        <div class="imfr-empty">
          <strong>No matching liquidity setups right now</strong>
          <p>The engine tracks 5m &amp; 15m swing highs/lows on NSE &amp; MCX and confirms sweeps with candlestick crossovers. Click the refresh icon to scan again.</p>
        </div>
      `;

    body.innerHTML = shell(inner);
  }

  body.addEventListener("click", (e) => {
    if (e.target.closest("#imLiqTelegramTest")) {
      const btn = e.target.closest("#imLiqTelegramTest");
      btn.style.opacity = "0.5";
      btn.style.pointerEvents = "none";
      (async () => {
        try {
          const token = await getOwnerToken(2000);
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          const res = await fetch(`${API}/api/owner/liquidity/telegram-test`, { headers });
          const json = await res.json();
          if (json && json.ok && json.sent) {
            alert("✅ Telegram Test Alert Sent! Check your Telegram channel/chat.");
          } else {
            alert("⚠️ Telegram Test Alert could not be sent. Please check bot token and chat ID.");
          }
        } catch (err) {
          alert("❌ Error sending Telegram test alert: " + (err.message || err));
        } finally {
          btn.style.opacity = "";
          btn.style.pointerEvents = "";
        }
      })();
      return;
    }
    if (e.target.closest("#imLiqRefresh")) {
      fetchSetups(true);
      return;
    }
    if (e.target.closest("#imLiqFilter")) {
      dirFilter = FILTERS[(FILTERS.indexOf(dirFilter) + 1) % FILTERS.length];
      renderView();
      return;
    }
    const resetBtn = e.target.closest("[data-liq-reset]");
    if (resetBtn) {
      activeTf = "all";
      activeMarket = "all";
      renderView();
      return;
    }
    const tfBtn = e.target.closest("[data-liq-tf]");
    if (tfBtn) {
      activeTf = activeTf === tfBtn.dataset.liqTf ? "all" : tfBtn.dataset.liqTf;
      renderView();
      return;
    }
    const mktBtn = e.target.closest("[data-liq-mkt]");
    if (mktBtn) {
      activeMarket = activeMarket === mktBtn.dataset.liqMkt ? "all" : mktBtn.dataset.liqMkt;
      renderView();
      return;
    }
  });

  async function fetchSetups(force = false) {
    if (isLoading) return;

    const token = await getOwnerToken();
    if (!token) {
      body.innerHTML = shell('<p class="imfr-error">Signing in… Please sign in with your owner account to view Liquidity Hunter.</p>');
      return;
    }

    isLoading = true;
    page.classList.add("is-loading");
    if (!lastData) {
      body.innerHTML = shell('<p class="imfr-loading">Scanning 5m &amp; 15m liquidity setups across NSE Equities &amp; MCX Commodities…</p>');
    }

    const minSpin = new Promise(resolve => setTimeout(resolve, 800));

    try {
      const res = await fetch(`${API}/api/owner/liquidity${force ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401 || res.status === 403) {
        body.innerHTML = shell('<p class="imfr-error">Owner authentication required. Please sign in with amitkmrai21@gmail.com.</p>');
        return;
      }
      const [data] = await Promise.all([res.json(), minSpin]);
      if (data && data.ok) {
        lastData = data;
        loadedAt = Date.now();
      }
    } catch (err) {
      console.error("Failed to fetch liquidity setups:", err);
    } finally {
      isLoading = false;
      page.classList.remove("is-loading");
      renderView();
    }
  }

  const observer = new MutationObserver(() => {
    if (page.classList.contains("active") && !lastData && !isLoading) {
      fetchSetups(false);
    }
  });
  observer.observe(page, { attributes: true, attributeFilter: ["class"] });

  if (page.classList.contains("active")) {
    fetchSetups(false);
  }

  if (!autoTimer) {
    autoTimer = setInterval(() => {
      if (page.classList.contains("active") && !isLoading) {
        fetchSetups(false);
      }
    }, 45000);
  }
})();
