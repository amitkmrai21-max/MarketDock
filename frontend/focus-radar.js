// Focus Radar (owner only)
(function marketDockFocusRadar() {
  const page = document.getElementById("im-focus-radar");
  const navButton = document.querySelector('.nav-button[data-page="im-focus-radar"]');
  const body = document.getElementById("imFrBody");
  if (!page || !navButton || !body) return;
  const API = window.MD_API_BASE || "https://api.marketdock.in";

  let activeTab = "breakouts"; // 'breakouts' | 'swings'
  let lastData = null;
  let isLoading = false;

  async function getOwnerToken() {
    try {
      const { data: session } = await window.marketDockSupabase.auth.getSession();
      return session?.session?.access_token || null;
    } catch (e) {
      return null;
    }
  }

  // Render Skeleton / Loading state
  function renderLoading() {
    body.innerHTML = `
      <div class="fr-container">
        <div class="fr-header">
          <div class="fr-badge-row">
            <span class="fr-owner-pill">🎯 PRO DOCK • OWNER RADAR</span>
          </div>
          <h2 class="fr-title">Focus Radar PRO</h2>
          <p class="fr-subtitle">Scanning liquid NSE market leaders for institutional Breakouts and VWAP / 20 EMA Pullback setups.</p>
        </div>
        <div class="fr-loading-card">
          <div class="fr-spinner"></div>
          <div class="fr-loading-text">Scanning liquid NSE markets...</div>
          <div class="fr-loading-sub">Computing VWAP, 20 EMA, ATR &amp; Volume ratios across 20 liquid leaders.</div>
        </div>
      </div>
    `;
  }

  // Render Full View
  function renderView(data) {
    if (!data) return;
    const breakouts = data.breakouts || [];
    const swings = data.swings || [];
    const isLive = data.market_status === "live";

    const currentList = activeTab === "breakouts" ? breakouts : swings;

    body.innerHTML = `
      <div class="fr-container">
        <div class="fr-header">
          <div class="fr-badge-row">
            <span class="fr-owner-pill">🎯 PRO DOCK • OWNER RADAR</span>
            <span class="fr-market-pill ${isLive ? "is-live" : "is-closed"}">
              ${isLive ? "● NSE Market Live" : "🌙 Market Closed (Last Session Data)"}
            </span>
          </div>
          <div class="fr-title-row">
            <div>
              <h2 class="fr-title">Focus Radar PRO</h2>
              <p class="fr-subtitle">High-probability Breakouts and Institutional VWAP / 20 EMA Pullback setups for liquid NSE Equities.</p>
            </div>
            <button type="button" class="fr-refresh-btn" id="frRefreshBtn" ${isLoading ? "disabled" : ""}>
              <span class="fr-refresh-icon ${isLoading ? "is-spinning" : ""}">↻</span>
              <span>Refresh Scan</span>
            </button>
          </div>

          <div class="fr-tabs">
            <button type="button" class="fr-tab ${activeTab === "breakouts" ? "is-active" : ""}" data-tab="breakouts">
              <span>⚡ Breakouts &amp; Breakdowns</span>
              <span class="fr-tab-count">${breakouts.length}</span>
            </button>
            <button type="button" class="fr-tab ${activeTab === "swings" ? "is-active" : ""}" data-tab="swings">
              <span>🌊 Swing Pullbacks (VWAP &amp; 20 EMA)</span>
              <span class="fr-tab-count">${swings.length}</span>
            </button>
          </div>
        </div>

        <div class="fr-content">
          ${currentList.length === 0 ? renderEmptyState() : renderCards(currentList)}
        </div>

        <div class="fr-disclaimer">
          ⚠️ <strong>Research &amp; Paper Trading Guidance Only:</strong> Setups are algorithmically identified based on institutional volume, VWAP retests, and EMA alignment. Always confirm with price action and maintain strict stop-loss discipline.
        </div>
      </div>
    `;

    // Bind tab clicks
    body.querySelectorAll(".fr-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        renderView(lastData);
      });
    });

    // Bind refresh click
    const refreshBtn = document.getElementById("frRefreshBtn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => fetchRadarData(true));
    }
  }

  function renderEmptyState() {
    const isBreakout = activeTab === "breakouts";
    return `
      <div class="fr-empty-card">
        <div class="fr-empty-icon">${isBreakout ? "⚡" : "🌊"}</div>
        <h3 class="fr-empty-title">No Qualifying ${isBreakout ? "Breakout" : "Swing Pullback"} Setups Right Now</h3>
        <p class="fr-empty-sub">
          ${isBreakout
            ? "The scanner requires strong volume expansion (1.15x+) and clean breakout beyond session range above VWAP. Currently, liquid stocks are consolidating."
            : "The pullback scanner looks for stocks holding precise support at VWAP or 20 EMA with trend alignment. Currently, no qualifying retest is in the entry zone."}
        </p>
        <p class="fr-empty-hint">Check the other tab or tap Refresh to re-scan.</p>
      </div>
    `;
  }

  function renderCards(list) {
    return `<div class="fr-cards-grid">
      ${list.map(renderCard).join("")}
    </div>`;
  }

  function renderCard(s) {
    const isBull = s.type === "BULLISH";
    const changeSign = s.change_pct >= 0 ? "+" : "";
    const changeClass = s.change_pct >= 0 ? "is-up" : "is-down";
    const volHigh = (s.volume_ratio || 1) >= 1.2;

    return `
      <div class="fr-card ${isBull ? "is-bullish" : "is-bearish"}">
        <div class="fr-card-head">
          <div class="fr-card-symbol-wrap">
            <span class="fr-card-symbol">${s.symbol}</span>
            <span class="fr-card-name">${s.name} ${s.sector ? "• " + s.sector : ""}</span>
          </div>
          <div class="fr-card-badges">
            <span class="fr-dir-pill ${isBull ? "is-bull" : "is-bear"}">
              ${isBull ? "▲ BULLISH BUY" : "▼ BEARISH SHORT"}
            </span>
            <span class="fr-trigger-pill">${s.trigger}</span>
          </div>
        </div>

        <div class="fr-price-row">
          <div class="fr-ltp-wrap">
            <span class="fr-ltp">₹${Number(s.price).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span class="fr-change ${changeClass}">${changeSign}${s.change_pct}%</span>
          </div>
          <div class="fr-tech-pills">
            <span class="fr-tech-pill ${volHigh ? "is-highlight" : ""}">Vol: ${s.volume_ratio}x avg</span>
            <span class="fr-tech-pill">VWAP: ₹${Number(s.vwap).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
            <span class="fr-tech-pill">20 EMA: ₹${Number(s.ema_20).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</span>
            <span class="fr-tech-pill">RSI: ${s.rsi}</span>
          </div>
        </div>

        <div class="fr-plan-grid">
          <div class="fr-plan-box is-entry">
            <div class="fr-box-label">ENTRY LEVEL</div>
            <div class="fr-box-val">₹${Number(s.entry).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
            <div class="fr-box-sub">Ideal entry price</div>
          </div>
          <div class="fr-plan-box is-sl">
            <div class="fr-box-label">STOP-LOSS</div>
            <div class="fr-box-val">₹${Number(s.stop_loss).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
            <div class="fr-box-sub">${s.risk_pct}% Risk</div>
          </div>
          <div class="fr-plan-box is-tgt">
            <div class="fr-box-label">TARGET 1</div>
            <div class="fr-box-val">₹${Number(s.target_1).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
            <div class="fr-box-sub">1:1.5 Risk-Reward</div>
          </div>
          <div class="fr-plan-box is-tgt2">
            <div class="fr-box-label">TARGET 2</div>
            <div class="fr-box-val">₹${Number(s.target_2).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</div>
            <div class="fr-box-sub">1:2.5 Risk-Reward</div>
          </div>
        </div>

        <div class="fr-card-reason">
          <span class="fr-reason-icon">💡</span>
          <span class="fr-reason-text">${s.reason}</span>
        </div>
      </div>
    `;
  }

  async function fetchRadarData(force = false) {
    if (isLoading) return;
    isLoading = true;
    if (!lastData) renderLoading();
    else {
      const btn = document.getElementById("frRefreshBtn");
      if (btn) btn.querySelector(".fr-refresh-icon")?.classList.add("is-spinning");
    }

    try {
      const token = await getOwnerToken();
      if (!token) {
        body.innerHTML = `<div class="fr-error-card">Please sign in with your owner account to access Focus Radar.</div>`;
        return;
      }

      const res = await fetch(`${API}/api/owner/focus-radar${force ? "?refresh=1" : ""}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401 || res.status === 403) {
        body.innerHTML = `<div class="fr-error-card">Focus Radar is locked. It is available only for the owner account.</div>`;
        return;
      }

      if (!res.ok) {
        throw new Error("Scan request failed");
      }

      const data = await res.json();
      if (data.ok) {
        lastData = data;
        renderView(data);
      } else {
        body.innerHTML = `<div class="fr-error-card">${data.error || "Could not complete scan right now."}</div>`;
      }
    } catch (err) {
      if (!lastData) {
        body.innerHTML = `
          <div class="fr-error-card">
            <p>Could not connect to Focus Radar scanner.</p>
            <button type="button" class="fr-retry-btn" id="frRetryBtn">Retry</button>
          </div>
        `;
        document.getElementById("frRetryBtn")?.addEventListener("click", () => fetchRadarData(true));
      }
    } finally {
      isLoading = false;
      const btn = document.getElementById("frRefreshBtn");
      if (btn) btn.querySelector(".fr-refresh-icon")?.classList.remove("is-spinning");
    }
  }

  // Hook into page activation
  navButton.addEventListener("click", () => {
    if (!lastData) fetchRadarData();
  });

  // If page is already active on load
  if (page.classList.contains("active")) {
    fetchRadarData();
  }

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
      if (auth?.onAuthStateChange) { auth.onAuthStateChange(() => setTimeout(() => checkAccess(), 400)); authWatched = true; }
    } catch (e) { /* ignore */ }
  }
  watchAuth();
  setTimeout(watchAuth, 2000);
})();
