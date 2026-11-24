// MarketDock Liquidity Hunter (5m & 15m) - Dedicated to NSE Equities & MCX Commodities
(function () {
  const page = document.getElementById("im-liquidity");
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

  function getAvatarColor(sym) {
    let hash = 0;
    for (let i = 0; i < sym.length; i++) hash = sym.charCodeAt(i) + ((hash << 5) - hash);
    const hues = [210, 160, 280, 35, 190, 340, 45];
    const h = hues[Math.abs(hash) % hues.length];
    return `hsl(${h}, 70%, 42%)`;
  }

  async function fetchSetups(force = false) {
    if (isLoading) return;
    isLoading = true;
    page.classList.add("is-loading");
    renderUI();

    try {
      const res = await fetch(`${API}/api/owner/liquidity${force ? "?refresh=1" : ""}`).then(r => r.json());
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

    const total5m = allSetups.filter(s => s.timeframe === "5m").length;
    const total15m = allSetups.filter(s => s.timeframe === "15m").length;
    const totalBull = allSetups.filter(s => s.direction === "bullish").length;
    const totalBear = allSetups.filter(s => s.direction === "bearish").length;

    const timeStr = lastFetched ? lastFetched.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : "Scanning...";

    body.innerHTML = `
      <div class="imliq-page">
        <!-- Top Title Bar -->
        <div class="imliq-top">
          <div class="imliq-title-box">
            <div class="imliq-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path>
              </svg>
            </div>
            <div>
              <strong>Liquidity Hunter (5m &amp; 15m)</strong>
              <small>NSE Equities &amp; MCX Commodities • Updated: ${timeStr}</small>
            </div>
          </div>

          <div class="imliq-actions">
            <button class="imliq-refresh-btn" id="imliqRefreshBtn" type="button" ${isLoading ? "disabled" : ""}>
              <svg class="imliq-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke-width="2" stroke-dasharray="32" stroke-dashoffset="12"></circle>
              </svg>
              <span>${isLoading ? "Scanning..." : "Scan Liquidity"}</span>
            </button>
          </div>
        </div>

        <!-- Metric Cards Strip -->
        <div class="imliq-metrics">
          <div class="imliq-metric-card">
            <span class="imliq-metric-label">Active Setups</span>
            <span class="imliq-metric-val">${allSetups.length}</span>
          </div>
          <div class="imliq-metric-card">
            <span class="imliq-metric-label">5-Minute (5m)</span>
            <span class="imliq-metric-val" style="color: #38bdf8;">${total5m}</span>
          </div>
          <div class="imliq-metric-card">
            <span class="imliq-metric-label">15-Minute (15m)</span>
            <span class="imliq-metric-val" style="color: #c084fc;">${total15m}</span>
          </div>
          <div class="imliq-metric-card">
            <span class="imliq-metric-label">Bullish / Bearish</span>
            <span class="imliq-metric-val"><span style="color: var(--im-green);">${totalBull}</span> / <span style="color: var(--im-red);">${totalBear}</span></span>
          </div>
        </div>

        <!-- Filter Bar -->
        <div class="imliq-bar">
          <!-- Market Tabs: NSE & MCX Only -->
          <div class="imliq-tabs" id="imliqMarketTabs">
            <button class="imliq-tab ${activeMarket === "all" ? "is-active" : ""}" data-val="all">All Markets</button>
            <button class="imliq-tab ${activeMarket === "nse" ? "is-active" : ""}" data-val="nse">NSE Equities</button>
            <button class="imliq-tab ${activeMarket === "mcx" ? "is-active" : ""}" data-val="mcx">MCX Commodities</button>
          </div>

          <!-- Timeframe & Direction -->
          <div class="imliq-tabs" id="imliqTfTabs">
            <button class="imliq-tab ${activeTimeframe === "all" ? "is-active" : ""}" data-val="all">All (5m &amp; 15m)</button>
            <button class="imliq-tab ${activeTimeframe === "5m" ? "is-active" : ""}" data-val="5m">⚡ 5m Active</button>
            <button class="imliq-tab ${activeTimeframe === "15m" ? "is-active" : ""}" data-val="15m">⚡ 15m Active</button>
          </div>

          <div class="imliq-tabs" id="imliqDirTabs">
            <button class="imliq-tab ${activeDirection === "all" ? "is-active" : ""}" data-val="all">All Directions</button>
            <button class="imliq-tab ${activeDirection === "bullish" ? "is-active" : ""}" data-val="bullish">🟢 Bullish Long</button>
            <button class="imliq-tab ${activeDirection === "bearish" ? "is-active" : ""}" data-val="bearish">🔴 Bearish Short</button>
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
    const isBear = s.direction === "bearish";
    const tfClass = s.timeframe === "15m" ? "is-15m" : "";

    return `
      <div class="imliq-card ${isBear ? "is-bear" : ""}">
        <div class="imliq-card-head">
          <div class="imliq-id-row">
            <div class="imliq-avatar" style="background: ${getAvatarColor(s.symbol)};">
              ${s.symbol.slice(0, 3)}
            </div>
            <div>
              <div class="imliq-symbol">${s.symbol}</div>
              <span class="imliq-market-tag">${s.market.toUpperCase()}</span>
            </div>
          </div>

          <div class="imliq-badges">
            <span class="imliq-tf-badge ${tfClass}">⚡ ${s.timeframe}</span>
            <span class="imliq-dir-badge">${isBear ? "BEARISH SHORT" : "BULLISH LONG"}</span>
          </div>
        </div>

        <div>
          <div class="imliq-setup-title">${s.setup_name}</div>
          <div class="imliq-trigger-event" style="margin-top: 4px;">
            ${s.trigger_event}
          </div>
        </div>

        <div class="imliq-levels-grid">
          <div class="imliq-level-col is-entry">
            <small>Entry Price</small>
            <b>₹${s.entry_price}</b>
          </div>
          <div class="imliq-level-col is-sl">
            <small>Stop Loss</small>
            <b>₹${s.stop_loss}</b>
          </div>
          <div class="imliq-level-col is-tp">
            <small>Target (TP)</small>
            <b>₹${s.target_price}</b>
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
