// MarketDock Liquidity Hunter (5m & 15m) - Dedicated to NSE Equities & MCX Commodities
// Strictly owner-only (amitkmrai21@gmail.com)
(function () {
  const page = document.getElementById("im-liquidity");
  const navButton = document.querySelector('.nav-button[data-page="im-liquidity"]');
  const body = document.getElementById("imLiquidityBody");
  if (!page || !body) return;

  const API = window.MD_API_BASE || "https://api.marketdock.in";

  let activeMarket = "all";       // 'all' | 'nse' | 'mcx'
  let activeTimeframe = "all";    // 'all' | '5m' | '15m'
  let activeDirection = "all";    // 'all' | 'bullish' | 'bearish'
  let isLoading = false;
  let allSetups = [];
  let lastFetched = null;
  let autoTimer = null;
  let isOwnerAllowed = false;

  const ALLOWED_KEY = "marketdock_liquidity_allowed";
  const readCached = () => {
    try {
      if (localStorage.getItem(ALLOWED_KEY) === "1") return true;
      if (localStorage.getItem("marketdock_smart_mtf_allowed") === "1") return true;
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

  // Pre-unhide if cached from previous session to avoid UI flash
  if (readCached() && navButton) navButton.hidden = false;
  setTimeout(() => checkAccess(), 1200);

  // Watch auth state changes
  try {
    const auth = window.marketDockSupabase?.auth;
    if (auth?.onAuthStateChange) {
      auth.onAuthStateChange(() => {
        setTimeout(() => checkAccess(0), 400);
      });
    }
  } catch (e) {}

  function getAvatarColor(sym) {
    let hash = 0;
    for (let i = 0; i < sym.length; i++) hash = sym.charCodeAt(i) + ((hash << 5) - hash);
    const hues = [210, 160, 280, 35, 190, 340, 45];
    const h = hues[Math.abs(hash) % hues.length];
    return `hsl(${h}, 70%, 42%)`;
  }

  async function fetchSetups(force = false) {
    if (isLoading) return;

    const token = await getOwnerToken();
    if (!token) {
      body.innerHTML = `
        <div class="imliq-container" style="padding: 24px; text-align: center;">
          <p style="color: var(--im-muted); font-size: 13px;">Owner authentication required. Please sign in with your owner account.</p>
        </div>
      `;
      return;
    }

    isLoading = true;
    page.classList.add("is-loading");
    renderUI();

    try {
      const res = await fetch(`${API}/api/owner/liquidity${force ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json());
      allSetups = (res && res.setups) || [];
      lastFetched = new Date();
    } catch (err) {
      console.error("Failed to fetch liquidity setups:", err);
    } finally {
      isLoading = false;
      page.classList.remove("is-loading");
      renderUI();
    }
  }

  function renderUI() {
    const filtered = allSetups.filter(s => {
      if (activeMarket !== "all" && s.market !== activeMarket) return false;
      if (activeTimeframe !== "all" && s.timeframe !== activeTimeframe) return false;
      if (activeDirection !== "all" && s.direction !== activeDirection) return false;
      return true;
    });

    const nseCount = allSetups.filter(s => s.market === "NSE").length;
    const mcxCount = allSetups.filter(s => s.market === "MCX").length;
    const bullCount = allSetups.filter(s => s.direction === "BULLISH").length;
    const bearCount = allSetups.filter(s => s.direction === "BEARISH").length;

    body.innerHTML = `
      <div class="imliq-container">
        <!-- Header -->
        <div class="imliq-header">
          <div class="imliq-title-group">
            <span class="imliq-pill"><span class="imliq-dot"></span> LIVE ENGINE &bull; 5M &amp; 15M</span>
            <h2>Liquidity Hunter</h2>
            <div class="imliq-subtitle">Tracks institutional liquidity sweeps, fakeouts, and candle confirmations across NSE Equities &amp; MCX Commodities.</div>
          </div>
          <div class="imliq-actions">
            <button class="imliq-btn imliq-btn-primary" id="imliqRefreshBtn" ${isLoading ? "disabled" : ""}>
              ${isLoading ? "Scanning..." : "Scan Liquidity"}
            </button>
            <div class="imliq-meta">
              ${lastFetched ? `Updated: ${lastFetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : "Awaiting scan"}
            </div>
          </div>
        </div>

        <!-- Metric Bar -->
        <div class="imliq-metrics">
          <div class="imliq-metric-card">
            <div class="imliq-metric-label">Total Setups</div>
            <div class="imliq-metric-val">${allSetups.length}</div>
          </div>
          <div class="imliq-metric-card">
            <div class="imliq-metric-label">NSE Equities</div>
            <div class="imliq-metric-val" style="color: #38bdf8;">${nseCount}</div>
          </div>
          <div class="imliq-metric-card">
            <div class="imliq-metric-label">MCX Commodities</div>
            <div class="imliq-metric-val" style="color: #fbbf24;">${mcxCount}</div>
          </div>
          <div class="imliq-metric-card">
            <div class="imliq-metric-label">Bullish / Bearish</div>
            <div class="imliq-metric-val" style="font-size: 16px;">
              <span style="color: #4ade80;">${bullCount}L</span> / <span style="color: #f87171;">${bearCount}S</span>
            </div>
          </div>
        </div>

        <!-- Filter Bar -->
        <div class="imliq-filters">
          <div class="imliq-tab-group" id="imliqMarketTabs">
            <button class="imliq-tab ${activeMarket === 'all' ? 'active' : ''}" data-val="all">All Markets</button>
            <button class="imliq-tab ${activeMarket === 'nse' ? 'active' : ''}" data-val="nse">NSE Equities</button>
            <button class="imliq-tab ${activeMarket === 'mcx' ? 'active' : ''}" data-val="mcx">MCX Commodities</button>
          </div>
          <div class="imliq-tab-group" id="imliqTfTabs">
            <button class="imliq-tab ${activeTimeframe === 'all' ? 'active' : ''}" data-val="all">All TF</button>
            <button class="imliq-tab ${activeTimeframe === '5m' ? 'active' : ''}" data-val="5m">5m</button>
            <button class="imliq-tab ${activeTimeframe === '15m' ? 'active' : ''}" data-val="15m">15m</button>
          </div>
          <div class="imliq-tab-group" id="imliqDirTabs">
            <button class="imliq-tab ${activeDirection === 'all' ? 'active' : ''}" data-val="all">All Sides</button>
            <button class="imliq-tab ${activeDirection === 'bullish' ? 'active' : ''}" data-val="bullish">Long</button>
            <button class="imliq-tab ${activeDirection === 'bearish' ? 'active' : ''}" data-val="bearish">Short</button>
          </div>
        </div>

        <!-- Cards Container -->
        <div class="imliq-grid">
          ${filtered.length ? filtered.map(renderSetupCard).join("") : `
            <div class="imliq-empty" style="grid-column: 1 / -1;">
              <strong>No qualifying liquidity setups matching filters.</strong>
              <p style="margin: 6px 0 0; font-size: 11.5px;">The engine tracks 5m and 15m swing highs/lows on NSE &amp; MCX and confirms sweeps with candlestick crossovers. Click "Scan Liquidity" to re-check.</p>
            </div>
          `}
        </div>
      </div>
    `;

    attachEvents();
  }

  function renderSetupCard(s) {
    const isBull = s.direction === "BULLISH";
    const dirClass = isBull ? "bullish" : "bearish";
    const dirIcon = isBull ? "&#8599;" : "&#8600;";
    const avatarColor = getAvatarColor(s.symbol);

    return `
      <div class="imliq-card ${dirClass}">
        <div class="imliq-card-head">
          <div class="imliq-card-left">
            <div class="imliq-avatar" style="background: ${avatarColor};">${s.symbol.slice(0, 3)}</div>
            <div>
              <div class="imliq-sym-name">${s.name || s.symbol}</div>
              <div class="imliq-sym-sub">${s.symbol} &bull; ₹${Number(s.current_price).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
            </div>
          </div>
          <div class="imliq-card-badges">
            <span class="imliq-tag tf">${s.timeframe}</span>
            <span class="imliq-tag mkt">${s.market}</span>
            <span class="imliq-badge-dir ${dirClass}">
              <span>${dirIcon}</span> ${s.direction}
            </span>
          </div>
        </div>

        <div style="font-size: 11.5px; font-weight: 700; color: ${isBull ? '#4ade80' : '#f87171'}; margin-bottom: 2px;">
          ${s.pattern_name}
        </div>

        <div class="imliq-levels">
          <div class="imliq-level-box">
            <span class="imliq-lvl-label">ENTRY TRIGGER</span>
            <span class="imliq-lvl-val val-entry">₹${Number(s.entry).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
          </div>
          <div class="imliq-level-box">
            <span class="imliq-lvl-label">STOP LOSS</span>
            <span class="imliq-lvl-val val-sl">₹${Number(s.stop_loss).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
          </div>
          <div class="imliq-level-box">
            <span class="imliq-lvl-label">TARGET 1</span>
            <span class="imliq-lvl-val val-tp">₹${Number(s.target_1).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
          </div>
          <div class="imliq-level-box">
            <span class="imliq-lvl-label">TARGET 2</span>
            <span class="imliq-lvl-val val-tp">₹${Number(s.target_2).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px;">
          <span style="color: var(--im-muted); font-weight: 700;">Risk / Reward:</span>
          <strong style="color: var(--im-text); font-size: 12px;">1 : ${s.risk_reward}</strong>
        </div>

        <div class="imliq-story">
          ${s.explanation}
        </div>
      </div>
    `;
  }

  function attachEvents() {
    const refreshBtn = document.getElementById("imliqRefreshBtn");
    if (refreshBtn) refreshBtn.onclick = () => fetchSetups(true);

    document.querySelectorAll("#imliqMarketTabs .imliq-tab").forEach(tab => {
      tab.onclick = () => {
        activeMarket = tab.dataset.val;
        renderUI();
      };
    });

    document.querySelectorAll("#imliqTfTabs .imliq-tab").forEach(tab => {
      tab.onclick = () => {
        activeTimeframe = tab.dataset.val;
        renderUI();
      };
    });

    document.querySelectorAll("#imliqDirTabs .imliq-tab").forEach(tab => {
      tab.onclick = () => {
        activeDirection = tab.dataset.val;
        renderUI();
      };
    });
  }

  const observer = new MutationObserver(() => {
    if (page.classList.contains("active") && !allSetups.length && !isLoading) {
      fetchSetups();
    }
  });
  observer.observe(page, { attributes: true, attributeFilter: ["class"] });

  if (page.classList.contains("active")) {
    fetchSetups();
  }

  if (!autoTimer) {
    autoTimer = setInterval(() => {
      if (page.classList.contains("active") && !isLoading) {
        fetchSetups(false);
      }
    }, 45000);
  }
})();
