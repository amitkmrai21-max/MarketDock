let liveCandleChart = null;
let liveCandleSeries = null;
let liveCandleRawData = [];

function msUntilNextPacificMidnight() {
  const nowPacific = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const nextMidnightPacific = new Date(nowPacific);
  nextMidnightPacific.setHours(24, 0, 0, 0);
  return Math.max(60000, nextMidnightPacific.getTime() - nowPacific.getTime());
}

function showQuotaFinishedMessage(retryBtn) {
  if (!retryBtn) return;
  retryBtn.textContent = "Quota Finished";
  retryBtn.classList.add("quota-finished-message");
  retryBtn.disabled = true;
  window.setTimeout(() => {
    if (retryBtn.classList.contains("quota-finished-message")) {
      retryBtn.classList.remove("quota-finished-message");
      retryBtn.textContent = "Try Again";
      retryBtn.disabled = false;
    }
  }, msUntilNextPacificMidnight());
}

const USER_API_KEY_STORAGE = { gemini: "userGeminiApiKey", groq: "userGroqApiKey" };

function getUserApiKey(provider) {
  try {
    return localStorage.getItem(USER_API_KEY_STORAGE[provider]) || "";
  } catch (error) {
    return "";
  }
}

function setUserApiKey(provider, value) {
  try {
    if (value) localStorage.setItem(USER_API_KEY_STORAGE[provider], value);
    else localStorage.removeItem(USER_API_KEY_STORAGE[provider]);
  } catch (error) {
    console.error(error);
  }
}

const AI_GATE_BUTTON_IDS = { gemini: "geminiAiBtn", groq: "groqLiveBtn" };
const AI_GATE_PROMPT_IDS = { gemini: "geminiKeyPrompt", groq: "groqKeyPrompt" };
const AI_GATE_PROVIDER_LABEL = { gemini: "Gemini", groq: "Groq" };

function updateApiKeyGate(provider, justSaved = false) {
  const button = document.getElementById(AI_GATE_BUTTON_IDS[provider]);
  const prompt = document.getElementById(AI_GATE_PROMPT_IDS[provider]);
  if (!button || !prompt) return;

  const hasKey = !!getUserApiKey(provider);

  if (hasKey) {
    button.classList.remove("key-gate-locked");
    button.disabled = false;
    if (justSaved) {
      prompt.classList.add("congrats-message");
      prompt.textContent = "Congratulations! You can now use AI.";
      window.setTimeout(() => {
        prompt.textContent = "";
        prompt.classList.remove("congrats-message");
      }, 5000);
    } else {
      prompt.textContent = "";
      prompt.classList.remove("congrats-message");
    }
  } else {
    button.classList.add("key-gate-locked");
    button.disabled = true;
    prompt.classList.remove("congrats-message");
    prompt.innerHTML = `Put your ${AI_GATE_PROVIDER_LABEL[provider]} API key in <button type="button" class="key-prompt-link" data-open-settings>Settings</button>`;
  }
}

document.addEventListener("click", (event) => {
  if (event.target.closest && event.target.closest("[data-open-settings]")) {
    document.getElementById("settingsMenuButton")?.click();
  }
});
let liveChartTimeframe = "15m";
let liveChartRefreshTimer = null;
let liveAiPriceLines = [];
let liveAiSignalSeries = null;
let liveAiLevelSeries = [];

const CHART_DRAWINGS_STORAGE_KEY = "btcChartDrawingsV1";
const DRAWING_COLOR = "#38bdf8";
let currentDrawingColor = DRAWING_COLOR;
const FIB_LEVELS = [
  { ratio: 0, label: "0%", color: "#787b86" },
  { ratio: 0.236, label: "23.6%", color: "#f23645" },
  { ratio: 0.382, label: "38.2%", color: "#ff9800" },
  { ratio: 0.5, label: "50%", color: "#4caf50" },
  { ratio: 0.618, label: "61.8%", color: "#2196f3" },
  { ratio: 0.786, label: "78.6%", color: "#9c27b0" },
  { ratio: 1, label: "100%", color: "#787b86" }
];
const VOLUME_PROFILE_BINS = 24;
const DRAWING_CLICK_MOVE_THRESHOLD_PX = 4;
let chartDrawingMode = "cursor";
let chartDrawingPendingPoint = null;
let userChartDrawings = [];
let drawingRepositionFrame = null;
let activeDragDrawing = null;
let activeDragHandle = null;
let activeDragMoved = false;
let activeDragStart = null;
let selectedDrawingForMenu = null;

const liveChartSettings = {
  "1m": { limit: 500 },
  "5m": { limit: 500 },
  "15m": { limit: 1000 },
  "1h": { limit: 1000 },
  "4h": { limit: 1000 },
  "1d": { limit: 500 },
  "1w": { limit: 300 }
};

let btcChart;
let rrgChart;
let activeTimeframe = "1D";
let activeRrgTimeframe = "1d";
let currentBtcPriceUsd = null;
let currentBtcPriceInr = null;
let aiRefreshInProgress = false;
let technicalRefreshInProgress = false;

let latestAiPlan = null;
let latestTechnicalMarket = null;
let latestTechnicalResponse = null;

const USD_INR_RATE = 83;
const PAPER_STORAGE_KEY = "btcAiSignalPaperPortfolioV2";
const DEFAULT_PAPER_CASH = 100000;
const PAPER_MIN_TRADE_INR = 100;
const PAPER_EPSILON = 0.00000001;
const AI_NEWS_STORAGE_KEY = "btcAiSignalLatestNewsV1";
const NEWS_TRANSLATION_STORAGE_KEY = "btcAiSignalNewsTranslationsV1";
const ALERT_SETTINGS_STORAGE_KEY = "btcAiSignalAlertSettingsV1";
const ALERT_RUNTIME_STORAGE_KEY = "btcAiSignalAlertRuntimeV1";
const LAST_AI_SIGNAL_STORAGE_KEY = "btcAiSignalLastSignalV1";
const LAYOUT_STORAGE_KEY = "btcAiSignalCustomLayoutV1";
const TECHNICAL_TIMEOUT_MS = 20000;

const timeframeSettings = {
  "1W": { days: 90, interval: "1w", label: "Weekly", dateOptions: { month: "short", year: "numeric" }, maxPoints: 20 },
  "1D": { days: 30, interval: "1d", label: "Daily", dateOptions: { month: "short", day: "numeric" }, maxPoints: 31 },
  "1H": { days: 7, interval: "1h", label: "Hourly", dateOptions: { month: "short", day: "numeric", hour: "2-digit" }, maxPoints: 120 },
  "15M": { days: 1, interval: "15m", label: "15 Min", dateOptions: { hour: "2-digit", minute: "2-digit" }, maxPoints: 120 }
};

const rrgColors = {
  BTCUSDT: { border: "#facc15", background: "rgba(250, 204, 21, 0.18)" },
  ETHUSDT: { border: "#60a5fa", background: "rgba(96, 165, 250, 0.18)" },
  SOLUSDT: { border: "#a78bfa", background: "rgba(167, 139, 250, 0.18)" }
};

function getElement(id) { return document.getElementById(id); }
function setText(id, value) { const element = getElement(id); if (element) element.textContent = value ?? "--"; }
function formatDateForSignal() { return new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
function formatUpdatedAt(timestamp) { return timestamp ? new Date(timestamp * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Update time unavailable"; }
function formatUsd(value) { const number = Number(value); return Number.isFinite(number) ? `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "--"; }
function formatInr(value) { const number = Number(value); return Number.isFinite(number) ? `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "₹--"; }
function formatBtc(value) { const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(6)} BTC` : "0.000000 BTC"; }
function formatPercent(value, suffix = "%") { const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(2)}${suffix}` : "--"; }
function formatSignedScore(value) { const number = Number(value); return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${number.toFixed(2)}` : "--"; }
function toNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

function getSignalColor(signal) {
  if (signal === "BUY") return "#22c55e";
  if (signal === "SELL") return "#ef4444";
  return "#facc15";
}

function setMiniSignal(id, signal) {
  const element = getElement(id);
  if (!element) return;
  const normalized = ["BUY", "SELL", "HOLD"].includes(signal) ? signal : "HOLD";
  const color = getSignalColor(normalized);
  element.textContent = normalized;
  element.style.color = color;
  element.style.borderColor = color;
}

/* ===== Independent Engine / Gemini / Groq cards =====
   Each provider only ever writes to its own prefixed element IDs, so none
   of the three can overwrite another's card (rebuild spec Section 9). */
const PROVIDER_CARD_IDS = {
  ENGINE: { signal: "engineSignalBox", risk: "engineRiskBadge", confidence: "engineQuality", updated: "engineUpdatedAt", reason: "engineReason", entry: "engineEntry", stopLoss: "engineStopLoss", target1: "engineTarget1", target2: "engineTarget2" },
  GEMINI: { signal: "geminiSignalAction", risk: "geminiRiskBadge", confidence: "geminiConfidence", updated: "geminiUpdatedAt", reason: "geminiReason", entry: "geminiEntry", stopLoss: "geminiStopLoss", target1: "geminiTarget1", target2: "geminiTarget2" },
  GROQ: { signal: "groqSignalAction", risk: "groqRiskBadge", confidence: "groqConfidence", updated: "groqUpdatedAt", reason: "groqReason", entry: "groqEntry", stopLoss: "groqStopLoss", target1: "groqTarget1", target2: "groqTarget2" },
};

function renderProviderSignalCard(provider, opts) {
  const ids = PROVIDER_CARD_IDS[provider];
  if (!ids) return "HOLD";
  const normalized = ["BUY", "SELL", "HOLD"].includes(opts.signal) ? opts.signal : "HOLD";
  const color = getSignalColor(normalized);
  const signalElement = getElement(ids.signal);
  if (signalElement) { signalElement.textContent = normalized; signalElement.style.color = color; }
  const riskElement = getElement(ids.risk);
  if (riskElement) {
    const normalizedRisk = ["LOW", "MEDIUM", "HIGH"].includes(opts.risk) ? opts.risk : "HIGH";
    riskElement.textContent = `Risk: ${normalizedRisk}`;
    riskElement.className = `risk-badge risk-${normalizedRisk.toLowerCase()}`;
  }
  setText(ids.confidence, opts.confidenceText);
  setText(ids.updated, opts.updatedText);
  setText(ids.reason, opts.reasonText);
  setText(ids.entry, opts.entryText);
  setText(ids.stopLoss, opts.stopLossText);
  setText(ids.target1, opts.target1Text);
  setText(ids.target2, opts.target2Text);
  return normalized;
}

function updateHeroSignalBox(signal, labelText) {
  const heroBox = getElement("signalBox");
  const heroLabel = getElement("signalBoxLabel");
  const normalized = String(signal || "HOLD").toUpperCase();
  if (heroBox) { heroBox.textContent = normalized; heroBox.style.color = getSignalColor(normalized); }
  if (heroLabel) heroLabel.textContent = labelText;
}

function renderEngineCard(data = {}) {
  const normalized = renderProviderSignalCard("ENGINE", {
    signal: data.signal,
    risk: data.risk,
    confidenceText: Number.isFinite(Number(data.confidence)) ? `${Number(data.confidence)}%` : "--%",
    updatedText: `${data.setup_status || "Live technical analysis"} • updated ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`,
    reasonText: data.reason,
    entryText: data.entry_idea,
    stopLossText: data.stop_loss_idea,
    target1Text: data.target_1,
    target2Text: data.target_2,
  });
  // Quick-glance duplicate in the "Live Market" hero metric box — shows the Engine's
  // own signal, labeled plain "SIGNAL", whenever Technical refreshes. Running Gemini or
  // Groq afterward switches this same box to that AI's signal, labeled "AI Signal",
  // until Technical refreshes again.
  updateHeroSignalBox(normalized, "SIGNAL");
}

function renderGeminiCard(data = {}, fromSavedPlan = false) {
  renderProviderSignalCard("GEMINI", {
    signal: data.signal,
    risk: data.risk,
    confidenceText: `${Number(data.confidence || 0)}%`,
    updatedText: `${fromSavedPlan ? "Restored" : "Fresh"} Gemini analysis • ${formatUpdatedAt(data.updated_at)}${data.cached ? " (API cached)" : ""}`,
    reasonText: data.reason,
    entryText: data.entry_idea,
    stopLossText: data.stop_loss_idea,
    target1Text: data.target_1,
    target2Text: data.target_2,
  });
  updateHeroSignalBox(data.signal, "AI Signal");
  setText("disclaimerText", data.disclaimer);
  saveLastAiSignal(data);
}

function renderGroqCard(data = {}, fromSavedPlan = false) {
  renderProviderSignalCard("GROQ", {
    signal: data.signal,
    risk: data.risk,
    confidenceText: `${Number(data.confidence || 0)}%`,
    updatedText: `${fromSavedPlan ? "Restored" : "Fresh"} Groq analysis • ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`,
    reasonText: data.reason,
    entryText: data.entry_idea,
    stopLossText: data.stop_loss_idea,
    target1Text: data.target_1,
    target2Text: data.target_2,
  });
  updateHeroSignalBox(data.signal, "AI Signal");
  saveLastAiSignal(data);
}

/* Per-provider manual-plan persistence, so the Gemini and Groq cards each keep showing
   their OWN latest result independently (across reloads) — never each other's. */
const PROVIDER_PLAN_STORAGE_KEYS = { GEMINI: "btcAiSignalGeminiPlanV1", GROQ: "btcAiSignalGroqPlanV1" };
let latestProviderPlans = { GEMINI: null, GROQ: null };

function saveProviderPlan(provider, data) {
  const plan = { data, savedAt: Date.now() };
  latestProviderPlans[provider] = plan;
  try { localStorage.setItem(PROVIDER_PLAN_STORAGE_KEYS[provider], JSON.stringify(plan)); } catch (error) { console.error(error); }
  // Also track whichever provider ran most recently (either one), in memory only —
  // the Gemini-success chart-lock hookup reads this right after saving.
  latestAiPlan = plan;
}

function loadSavedProviderPlan(provider) {
  try {
    const saved = localStorage.getItem(PROVIDER_PLAN_STORAGE_KEYS[provider]);
    if (!saved) return null;
    const plan = JSON.parse(saved);
    if (!plan?.data || !Number.isFinite(Number(plan.savedAt))) return null;
    latestProviderPlans[provider] = plan;
    return plan;
  } catch (error) { console.error(error); return null; }
}

function renderSavedProviderPlanIfAny(provider) {
  const plan = latestProviderPlans[provider] || loadSavedProviderPlan(provider);
  if (!plan) return false;
  if (provider === "GEMINI") renderGeminiCard(plan.data, true);
  else renderGroqCard(plan.data, true);
  return true;
}

function saveLastAiSignal(aiData) {
  const snapshot = { signal: aiData?.signal || "HOLD", confidence: aiData?.confidence ?? "--", reason: aiData?.reason || "No AI explanation available.", updatedAt: aiData?.updated_at ? Number(aiData.updated_at) * 1000 : Date.now() };
  try { localStorage.setItem(LAST_AI_SIGNAL_STORAGE_KEY, JSON.stringify(snapshot)); } catch (error) { console.error(error); }
}
function getLastAiSignal() { try { const saved = localStorage.getItem(LAST_AI_SIGNAL_STORAGE_KEY); return saved ? JSON.parse(saved) : null; } catch (error) { console.error(error); return null; } }
function isBuyLike(signal = "") { return String(signal).toUpperCase().includes("BUY"); }
function isSellLike(signal = "") { return String(signal).toUpperCase().includes("SELL"); }
function formatStoredSignalTime(timestamp) { const date = new Date(Number(timestamp)); return timestamp && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--"; }

function updateSignalConfirmation(technicalData) {
  const lastAi = getLastAiSignal();
  const technicalSignal = technicalData?.signal || "HOLD";
  setText("liveTechnicalSignal", technicalSignal);
  setText("liveTechnicalReason", technicalData?.reason || "--");
  setText("liveTechnicalUpdated", `Updated: ${formatUpdatedAt(technicalData?.updated_at)}`);
  if (!lastAi) {
    setText("lastAiSignal", "No previous AI analysis"); setText("lastAiConfidence", "Confidence: --"); setText("lastAiUpdated", "Updated: --");
    setText("combinedDecision", technicalSignal); setText("combinedDecisionReason", "No manual Gemini or Groq analysis yet. Showing live technical fallback only.");
    return;
  }
  setText("lastAiSignal", lastAi.signal); setText("lastAiConfidence", `Confidence: ${lastAi.confidence}`); setText("lastAiUpdated", `Updated: ${formatStoredSignalTime(lastAi.updatedAt)}`);
  const aiBuy = isBuyLike(lastAi.signal), aiSell = isSellLike(lastAi.signal), technicalBuy = isBuyLike(technicalSignal), technicalSell = isSellLike(technicalSignal);
  let decision = "WAIT FOR CONFIRMATION";
  let reason = "The last AI view and live technical conditions are not fully aligned. Do not force an entry.";
  if ((aiBuy && technicalBuy) || (aiSell && technicalSell)) { decision = aiBuy ? "BUY SETUP CONFIRMED" : "SELL SETUP CONFIRMED"; reason = "The last successful manual AI view and current live technical signal are aligned."; }
  else if ((aiBuy && technicalSell) || (aiSell && technicalBuy)) { decision = "AI SIGNAL INVALIDATED — NO ENTRY"; reason = "Current live technical conditions oppose the last manual AI signal."; }
  else if (String(technicalSignal).toUpperCase().includes("HOLD")) { reason = "The previous AI idea is not currently confirmed by live technical data."; }
  setText("combinedDecision", decision); setText("combinedDecisionReason", reason);
}


function calculateTechnicalSignal(market15m = {}, market1h = {}) {
  const trend15m = String(market15m.trend || "").toUpperCase(), trend1h = String(market1h.trend || "").toUpperCase();
  const macd15m = String(market15m?.macd?.state || "").toUpperCase(), macd1h = String(market1h?.macd?.state || "").toUpperCase();
  const breakout = String(market15m.breakout_status || "").toUpperCase();
  const rsi15m = toNumber(market15m.rsi_14), rsi1h = toNumber(market1h.rsi_14), momentum15m = toNumber(market15m.momentum_percent), volumeRatio = toNumber(market15m?.volume?.volume_ratio);
  const bullishTrend = trend15m.includes("BULL") || trend1h.includes("BULL"), bearishTrend = trend15m.includes("BEAR") || trend1h.includes("BEAR");
  const bullishMacd = macd15m.includes("BULL") || macd1h.includes("BULL"), bearishMacd = macd15m.includes("BEAR") || macd1h.includes("BEAR");
  const bullishBreakout = breakout.includes("BREAKOUT") && !breakout.includes("BEAR"), bearishBreakdown = breakout.includes("BREAKDOWN") || breakout.includes("BEAR");
  const bullishMomentum = (rsi15m !== null && rsi15m >= 52 && rsi15m <= 72) || (rsi1h !== null && rsi1h >= 50 && rsi1h <= 72) || (momentum15m !== null && momentum15m > 0);
  const bearishMomentum = (rsi15m !== null && rsi15m <= 48 && rsi15m >= 28) || (rsi1h !== null && rsi1h <= 50 && rsi1h >= 28) || (momentum15m !== null && momentum15m < 0);
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1;
  let buyScore = 0, sellScore = 0;
  if (bullishTrend) buyScore += 2; if (bullishMacd) buyScore += 2; if (bullishMomentum) buyScore += 1; if (bullishBreakout) buyScore += 2; if (volumeConfirmed) buyScore += 1;
  if (bearishTrend) sellScore += 2; if (bearishMacd) sellScore += 2; if (bearishMomentum) sellScore += 1; if (bearishBreakdown) sellScore += 2; if (volumeConfirmed) sellScore += 1;
  if (buyScore >= 5 && buyScore > sellScore + 1) return { signal: "BUY", reason: "Technical confirmation is bullish: trend, momentum and/or breakout conditions are aligned.", score: buyScore };
  if (sellScore >= 5 && sellScore > buyScore + 1) return { signal: "SELL", reason: "Technical confirmation is bearish: trend, momentum and/or breakdown conditions are aligned.", score: sellScore };
  return { signal: "HOLD", reason: "Technical conditions are mixed or lack enough confirmation. Wait for trend, momentum and volume alignment.", score: Math.max(buyScore, sellScore) };
}
function getTechnicalConfidence(technical) { const score = Number(technical?.score || 0); return ["BUY", "SELL"].includes(technical?.signal) ? Math.min(85, 50 + score * 7) : Math.min(55, 25 + score * 6); }

async function fetchWithTimeout(url, options = {}, timeoutMs = TECHNICAL_TIMEOUT_MS) {
  const controller = new AbortController(); const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) { if (error?.name === "AbortError") throw new Error(`Technical request timed out after ${Math.round(timeoutMs / 1000)} seconds.`); throw error; }
  finally { window.clearTimeout(timeoutId); }
}

function setTechnicalRefreshState(state = "idle", message = "") {
  const retry = getElement("retryTechnicalBtn"), refresh = getElement("refreshBtn");
  if (retry) { retry.hidden = state !== "error"; retry.disabled = state === "loading"; }
  if (refresh) { refresh.disabled = state === "loading"; refresh.innerHTML = state === "loading" ? "Refreshing..." : "Refresh<span class=\"btn-subline\">Technical</span>"; }
  if (message) setText("technicalRefreshStatus", message);
}
function setDataHealthBadge(health = {}) {
  const badge = getElement("technicalDataHealth"); if (!badge) return;
  const status = ["LIVE", "CACHED", "DELAYED", "ERROR"].includes(health.status) ? health.status : "ERROR";
  const age = Number(health.cache_age_seconds); const ageText = Number.isFinite(age) ? ` • ${age.toFixed(1)}s old` : "";
  badge.textContent = `Data: ${status}${status === "LIVE" ? "" : ageText}`; badge.className = `data-health-badge health-${status.toLowerCase()}`;
}

function getDynamicGeminiAlignment(technicalData) {
  const lastAi = getLastAiSignal();
  const technicalSignal = String(
    technicalData?.signal || "HOLD"
  ).toUpperCase();

  if (!lastAi?.signal) {
    return {
      state: "WAIT",
      reason: "No recent Gemini AI plan is available. Run Gemini AI Analysis for a fresh comparison.",
      riskFlag: null
    };
  }

  const aiSignal = String(lastAi.signal || "HOLD").toUpperCase();
  const aiBuy = isBuyLike(aiSignal);
  const aiSell = isSellLike(aiSignal);
  const technicalBuy = isBuyLike(technicalSignal);
  const technicalSell = isSellLike(technicalSignal);
  const aiNoTrade = aiSignal.includes("HOLD");
  const technicalNoTrade = technicalSignal.includes("HOLD");

  if ((aiBuy && technicalBuy) || (aiSell && technicalSell)) {
    return {
      state: "PASS",
      reason: `Gemini ${aiSignal} and live technical ${technicalSignal} are aligned.`,
      riskFlag: null
    };
  }

  if ((aiBuy && technicalSell) || (aiSell && technicalBuy)) {
    return {
      state: "FAIL",
      reason: `Gemini ${aiSignal} conflicts with live technical ${technicalSignal}. Do not force an entry.`,
      riskFlag: "Gemini AI conflicts with live technical direction"
    };
  }

  if (aiNoTrade && technicalNoTrade) {
    return {
      state: "PASS",
      reason: "Gemini AI and live technical analysis both indicate caution / no trade.",
      riskFlag: null
    };
  }

  if (technicalNoTrade) {
    return {
      state: "WAIT",
      reason: `Gemini ${aiSignal} is not confirmed because live technical status is ${technicalSignal}.`,
      riskFlag: null
    };
  }

  if (aiNoTrade) {
    return {
      state: "WAIT",
      reason: `Live technical shows ${technicalSignal}, but Gemini AI remains cautious (${aiSignal}).`,
      riskFlag: null
    };
  }

  return {
    state: "WAIT",
    reason: `Gemini ${aiSignal} and live technical ${technicalSignal} need further confirmation.`,
    riskFlag: null
  };
}

function calculateDynamicSetupDecision(setup, items, flags) {
  const passed = items.filter((item) => item.state === "PASS").length;
  const waiting = items.filter((item) => item.state === "WAIT").length;
  const failed = items.filter((item) => item.state === "FAIL").length;

  const direction = String(setup?.direction || "NEUTRAL").toUpperCase();

  const hasGeminiConflict = flags.includes(
    "Gemini AI conflicts with live technical direction"
  );

  let grade = "C";
  let executionState = "WAIT FOR CONFIRMATION";
  let decisionReason =
    "The setup is mixed. Wait for stronger trend, momentum and volume confirmation.";

  if (hasGeminiConflict || failed >= 4) {
    grade = "D";
    executionState = "AVOID";

    decisionReason = hasGeminiConflict
      ? "Gemini AI and live technical direction conflict. Avoid forcing a practice entry."
      : "Too many checklist conditions are failing. Avoid forcing a practice entry.";
  } else if (passed >= 7 && failed === 0) {
    grade = "A";
    executionState = "READY";

    decisionReason =
      "Most technical conditions and Gemini alignment are supportive. Wait for the stated trigger and define invalidation.";
  } else if (passed >= 5 && failed <= 1) {
    grade = "B";
    executionState = "WAIT FOR TRIGGER";

    decisionReason =
      "The setup is developing well, but a price trigger or one more confirmation is still needed.";
  } else if (passed >= 3 && failed <= 2) {
    grade = "C";
    executionState = "WAIT FOR CONFIRMATION";

    decisionReason =
      "Some conditions are supportive, but the setup is not sufficiently aligned yet.";
  } else if (direction === "NEUTRAL" && failed >= 3) {
    grade = "D";
    executionState = "AVOID";

    decisionReason =
      "The market is mixed and several checklist conditions are failing. Wait for clearer alignment.";
  }

  return {
    passed,
    waiting,
    failed,
    total: items.length,
    grade,
    executionState,
    decisionReason
  };
}

function renderSetupQuality(data) {
  const setup = data?.setup_quality || {};
  const originalItems = Array.isArray(setup.items) ? setup.items : [];
  const items = originalItems.map((item) => ({ ...item }));
  const flags = Array.isArray(setup.risk_flags) ? [...setup.risk_flags] : [];

  const alignment = getDynamicGeminiAlignment(data);

  const alignmentItem = {
    key: "ai_alignment",
    label: "Gemini AI vs live technical alignment",
    state: alignment.state,
    reason: alignment.reason
  };

  const alignmentIndex = items.findIndex(
    (item) => item?.key === "ai_alignment"
  );

  if (alignmentIndex >= 0) {
    items[alignmentIndex] = alignmentItem;
  } else {
    items.push(alignmentItem);
  }

  if (alignment.riskFlag && !flags.includes(alignment.riskFlag)) {
    flags.push(alignment.riskFlag);
  }

  const dynamic = calculateDynamicSetupDecision(setup, items, flags);

  setText("setupGrade", dynamic.grade);
  setText(
    "setupScore",
    `${dynamic.passed} / ${dynamic.total} checks passed • ${dynamic.waiting} wait • ${dynamic.failed} fail`
  );
  setText("setupDirection", setup.direction || "--");
  setText("setupDecisionReason", dynamic.decisionReason);

  setText(
    "setupRiskFlagCount",
    flags.length
      ? `${flags.length} flag${flags.length === 1 ? "" : "s"}`
      : "No major flags"
  );

  setText(
    "setupRiskFlags",
    flags.length
      ? flags.join(" • ")
      : "No major technical risk flags detected by the current checklist."
  );

  const badge = getElement("setupExecutionState");

  if (badge) {
    badge.textContent = dynamic.executionState;
    badge.className = `setup-execution-badge setup-state-${dynamic.executionState
      .toLowerCase()
      .replace(/[^a-z]+/g, "-")}`;
  }

  const checklist = getElement("setupChecklist");

  if (!checklist) return;

  checklist.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "setup-checklist-loading";
    empty.textContent = "Setup checklist data is not available yet.";
    checklist.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const itemState = ["PASS", "WAIT", "FAIL"].includes(
      String(item?.state || "").toUpperCase()
    )
      ? String(item.state).toUpperCase()
      : "WAIT";

    const row = document.createElement("article");
    row.className = `setup-check-item setup-check-${itemState.toLowerCase()}`;

    const top = document.createElement("div");
    top.className = "setup-check-top";

    const label = document.createElement("h3");
    label.textContent = item?.label || "Checklist item";

    const stateBadge = document.createElement("span");
    stateBadge.className = "setup-check-state";
    stateBadge.textContent = itemState;

    const reason = document.createElement("p");
    reason.textContent = item?.reason || "No detail available.";

    top.append(label, stateBadge);
    row.append(top, reason);
    checklist.appendChild(row);
  });
}
function renderSwingFailureStructure(data) {
  const structure =
    data?.market_data?.timeframes?.["15m"]?.swing_failure_structure || {};

  const signal = String(structure.signal || "NO TRADE").toUpperCase();
  const direction = String(structure.direction || "NEUTRAL").toUpperCase();

  setText("swingTimeframe", structure.timeframe || "15m");
  setText("swingCurrentPrice", formatUsd(structure.current_price));
  setText("swingPriorHigh", formatUsd(structure.prior_swing_high));
  setText("swingPriorLow", formatUsd(structure.prior_swing_low));

  const failedHigh = structure.failed_high;
  const failedLow = structure.failed_low;

   setText(
    "swingFailedLevel",
    structure.break_event || "No confirmed break event yet"
  );

  setText(
    "swingProtectedLevel",
    formatUsd(structure.protected_break_level)
  );

  setText(
    "swingBreakLevel",
    structure.break_level_text || "Waiting for confirmed swing structure"
  );

  setText("swingBreakStatus", structure.break_status || "NO STRUCTURE");
  setText("swingRetestLevel", formatUsd(structure.retest_level));
  setText(
    "swingInvalidationLevel",
    formatUsd(structure.invalidation_level)
  );

  setText(
    "swingStructureReason",
    structure.reason || "Waiting for confirmed 15m swing structure."
  );

  setText(
    "swingFinalConclusion",
    structure.final_conclusion ||
      "WAIT — no final trade signal until break, retest, and confirmation."
  );

  const filterData = structure.filter_checklist || {};
  const passed = Array.isArray(filterData.passed) ? filterData.passed : [];
  const waiting = Array.isArray(filterData.waiting) ? filterData.waiting : [];
  const failed = Array.isArray(filterData.failed) ? filterData.failed : [];

  setText(
    "swingFilterSummary",
    `Quality: ${structure.quality || "LOW"} • Passed ${passed.length} • Pending ${waiting.length} • Failed ${failed.length}`
  );

  setText(
    "swingFilterDetails",
    [
      passed.length ? `Pass: ${passed.join(" | ")}` : "",
      waiting.length ? `Pending: ${waiting.join(" | ")}` : "",
      failed.length ? `Blocked: ${failed.join(" | ")}` : "",
    ].filter(Boolean).join(" • ") || "Waiting for structure filters."
  );
  
  setText(
    "swingConfirmationRule",
    structure.confirmation_rule ||
      "Wicks do not confirm a break. Waiting for completed candle-body confirmation."
  );

  const badge = getElement("swingSignalBadge");

  if (badge) {
    badge.className = "swing-signal-badge";

   if (signal === "BUY") {
      badge.classList.add("swing-bullish");
      badge.textContent = "BUY — FINAL";
    } else if (signal === "SELL") {
      badge.classList.add("swing-bearish");
      badge.textContent = "SELL — FINAL";
    } else if (direction === "BEARISH") {
      badge.classList.add("swing-bearish");
      badge.textContent = "HOLD";
    } else if (direction === "BULLISH") {
      badge.classList.add("swing-bullish");
      badge.textContent = "HOLD";
    } else {
      badge.classList.add("swing-neutral");
      badge.textContent = "HOLD";
    }
  }
}

function renderTechnicalIntelligence(data) {
  const health = data?.data_health || {}, score = data?.score_breakdown || {}, regime = data?.market_regime || {}, agreement = data?.timeframe_agreement || {}, levels = data?.key_level_distance || {};
  setDataHealthBadge(health); setText("technicalHealthMessage", health.message || "Technical data status unavailable."); setText("technicalRefreshStatus", `Updated: ${formatUpdatedAt(data?.updated_at)}${data?.cached ? " • cached response" : ""}`);
  setText("marketRegime", regime.label || "--"); setText("marketRegimeDetail", regime.detail || "--"); setText("regimeStats", `ADX ${formatPercent(regime.average_adx, "")} • ATR ${formatPercent(regime.average_atr_percent)} • BB Width ${formatPercent(regime.average_bollinger_width_percent)}`);
  const percent = Number(agreement.percent); setText("timeframeAgreement", Number.isFinite(percent) ? `${percent.toFixed(0)}%` : "--"); setText("timeframeAgreementDetail", agreement.direction || "--"); setText("timeframeVotes", `Bullish ${agreement.bullish_votes ?? 0} • Bearish ${agreement.bearish_votes ?? 0} • Hold ${agreement.hold_votes ?? 0}`);
  const bar = getElement("timeframeAgreementBar"); if (bar) bar.style.width = `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0}%`;
  setText("scoreTrend", formatSignedScore(score?.trend?.score)); setText("scoreMacd", formatSignedScore(score?.macd?.score)); setText("scoreMomentum", formatSignedScore(score?.momentum?.score)); setText("scoreBreakout", formatSignedScore(score?.breakout?.score)); setText("scoreVolume", formatSignedScore(score?.volume?.score));
  const totalScore = Number(score.total_score), alignment = Number(score.technical_alignment_percent); setText("technicalScoreTotal", Number.isFinite(totalScore) ? `${formatSignedScore(totalScore)} / 9` : "--"); setText("technicalAlignment", Number.isFinite(alignment) ? `${alignment.toFixed(0)}% alignment` : "--"); setText("technicalScoreBias", score.bias || "--");
  ["15m", "1h", "4h"].forEach((timeframe) => { const level = levels?.[timeframe] || {}; const id = timeframe === "15m" ? "15m" : timeframe; setText(`level${id}Price`, formatUsd(level.price)); setText(`level${id}Support`, formatUsd(level.support)); setText(`level${id}Resistance`, formatUsd(level.resistance)); const supportDistance = Number(level.support_distance_percent), resistanceDistance = Number(level.resistance_distance_percent); setText(`level${id}SupportDistance`, Number.isFinite(supportDistance) ? `${supportDistance.toFixed(2)}% below` : "--"); setText(`level${id}ResistanceDistance`, Number.isFinite(resistanceDistance) ? `${resistanceDistance.toFixed(2)}% above` : "--"); });
}

function updateIndicators(m15, m1h) {
  setText("trend15m", m15.trend); setText("rsi15m", m15.rsi_14); setText("macd15m", m15?.macd?.state); setText("adx15m", `${m15?.adx?.adx_14 ?? "--"} (${m15?.adx?.trend_strength ?? "--"})`); setText("momentum15m", `${m15?.momentum_percent ?? "--"}%`);
  setText("trend1h", m1h.trend); setText("rsi1h", m1h.rsi_14); setText("macd1h", m1h?.macd?.state); setText("adx1h", `${m1h?.adx?.adx_14 ?? "--"} (${m1h?.adx?.trend_strength ?? "--"})`); setText("momentum1h", `${m1h?.momentum_percent ?? "--"}%`);
  setText("volume15m", `x${m15?.volume?.volume_ratio ?? "--"}`); setText("volume1h", `x${m1h?.volume?.volume_ratio ?? "--"}`); setText("pattern15m", m15.candle_pattern); setText("pattern1h", m1h.candle_pattern); setText("breakout15m", m15.breakout_status); setText("support15m", formatUsd(m15?.support_resistance?.support_20)); setText("resistance15m", formatUsd(m15?.support_resistance?.resistance_20)); setText("support1h", formatUsd(m1h?.support_resistance?.support_20)); setText("resistance1h", formatUsd(m1h?.support_resistance?.resistance_20)); setText("structure1h", m1h.market_structure);
}

async function loadTechnicalFallback(prefix = "Live technical analysis refreshed.", forceRefresh = false) {
  if (technicalRefreshInProgress) return latestTechnicalResponse;
  technicalRefreshInProgress = true; setTechnicalRefreshState("loading", "Refreshing technical data…");
  try {
    const response = await fetchWithTimeout(forceRefresh ? "/api/technical-signal?force_refresh=true" : "/api/technical-signal", { cache: "no-store" }); const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Technical signal API could not be loaded.");
    latestTechnicalResponse = data; latestTechnicalMarket = data?.market_data?.timeframes || {};
    updateIndicators(latestTechnicalMarket["15m"] || {}, latestTechnicalMarket["1h"] || {});
    ["15m", "1h", "4h"].forEach((frame) => { const item = data?.timeframes?.[frame] || {}; const key = frame === "15m" ? "15m" : frame; setMiniSignal(`signal${key}`, item.signal); setText(`summary${key}`, item.summary); setText(`keyLevel${key}`, item.key_level); });
    setText("marketBias", data.market_bias); setText("setupStatus", data.setup_status); setText("confirmationNeeded", data.confirmation_needed); setText("target1", data.target_1); setText("target2", data.target_2);
    renderEngineCard(data);
    updateSignalConfirmation(data);
    renderTechnicalIntelligence(data);
    renderSwingFailureStructure(data);
    renderSetupQuality(data);
    setTechnicalRefreshState("idle", `Technical data updated: ${formatUpdatedAt(data.updated_at)}.`);
    return data;
  } catch (error) {
    console.error(error);
    renderTechnicalFallback(prefix);
    setDataHealthBadge({ status: "ERROR" });
    setText("technicalHealthMessage", error.message || "Technical data could not be refreshed.");
    renderSetupQuality(null);
    setTechnicalRefreshState("error", `Technical refresh failed: ${error.message || "Please retry."}`);
    return null;
  } finally { technicalRefreshInProgress = false; const refresh = getElement("refreshBtn"); if (refresh) { refresh.disabled = false; refresh.innerHTML = "Refresh<span class=\"btn-subline\">Technical</span>"; } }
}

function renderTechnicalFallback(prefix = "Live technical signal API is temporarily unavailable.") {
  const m15 = latestTechnicalMarket?.["15m"] || {}, m1h = latestTechnicalMarket?.["1h"] || {};
  const technical = calculateTechnicalSignal(m15, m1h);
  const normalizedSignal = ["BUY", "SELL"].includes(technical.signal) ? technical.signal : "HOLD";
  renderEngineCard({
    signal: normalizedSignal,
    risk: normalizedSignal === "HOLD" ? "HIGH" : "MEDIUM",
    confidence: getTechnicalConfidence(technical),
    setup_status: "Offline estimate — live technical API unreachable",
    reason: `${prefix} ${technical.reason}`,
    entry_idea: "No candidate entry while running on the offline estimate.",
    stop_loss_idea: "No candidate stop-loss while running on the offline estimate.",
    target_1: "--",
    target_2: "--",
    updated_at: Math.floor(Date.now() / 1000),
  });
  updateSignalConfirmation(technical);
}

function getDefaultPaperPortfolio() { return { cashInr: DEFAULT_PAPER_CASH, btcHolding: 0, totalCostInr: 0, shortBtcHolding: 0, shortProceedsInr: 0, history: [] }; }
function normalisePaperPortfolio(p) { return { cashInr: Math.max(0, Number(p.cashInr) || 0), btcHolding: Math.max(0, Number(p.btcHolding) || 0), totalCostInr: Math.max(0, Number(p.totalCostInr) || 0), shortBtcHolding: Math.max(0, Number(p.shortBtcHolding) || 0), shortProceedsInr: Math.max(0, Number(p.shortProceedsInr) || 0), history: Array.isArray(p.history) ? p.history.slice(0, 50) : [] }; }
function loadPaperPortfolio() { try { const saved = localStorage.getItem(PAPER_STORAGE_KEY); if (saved) return normalisePaperPortfolio(JSON.parse(saved)); const legacy = localStorage.getItem("btcAiSignalPaperPortfolioV1"); if (!legacy) return getDefaultPaperPortfolio(); const p = JSON.parse(legacy); return normalisePaperPortfolio({ ...p, shortBtcHolding: 0, shortProceedsInr: 0 }); } catch { return getDefaultPaperPortfolio(); } }
function savePaperPortfolio(p) { localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(normalisePaperPortfolio(p))); }
function addPaperTrade(p, type, amountInr, btcAmount) { p.history.unshift({ type, amountInr, btcAmount, priceInr: currentBtcPriceInr, timestamp: Date.now() }); p.history = p.history.slice(0, 50); }
function renderPaperHistory(history) { const box = getElement("paperTradeHistory"); if (!box) return; if (!history.length) { box.textContent = "No virtual trades yet."; return; } box.innerHTML = ""; history.forEach((trade) => { const item = document.createElement("div"); const date = new Date(trade.timestamp).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); item.className = `history-item ${trade.type.includes("SELL") || trade.type.includes("SHORT") ? "history-sell" : "history-buy"}`; item.textContent = `${trade.type} • ${formatInr(trade.amountInr)} • ${formatBtc(trade.btcAmount)} • ${date}`; box.appendChild(item); }); }
function renderPaperTrading() { const p = loadPaperPortfolio(), mark = Number(currentBtcPriceInr) || 0, value = p.cashInr + p.btcHolding * mark - p.shortBtcHolding * mark, pnl = value - DEFAULT_PAPER_CASH, pct = (pnl / DEFAULT_PAPER_CASH) * 100; const longAvg = p.btcHolding > PAPER_EPSILON ? p.totalCostInr / p.btcHolding : 0, shortAvg = p.shortBtcHolding > PAPER_EPSILON ? p.shortProceedsInr / p.shortBtcHolding : 0; const position = p.btcHolding > PAPER_EPSILON ? "LONG BTC" : p.shortBtcHolding > PAPER_EPSILON ? "SHORT BTC" : "No open position"; setText("paperCash", formatInr(p.cashInr)); setText("paperBtcHolding", formatBtc(p.btcHolding)); setText("paperShortBtcHolding", formatBtc(p.shortBtcHolding)); setText("paperPositionType", position); setText("paperAvgPrice", p.btcHolding > PAPER_EPSILON ? formatInr(longAvg) : "No long position"); setText("paperShortAvgPrice", p.shortBtcHolding > PAPER_EPSILON ? formatInr(shortAvg) : "No short position"); setText("paperPortfolioValue", formatInr(value)); const pos = getElement("paperPositionType"), pnlElement = getElement("paperPnl"); if (pos) pos.style.color = position === "LONG BTC" ? "#22c55e" : position === "SHORT BTC" ? "#ef4444" : "#cbd5e1"; if (pnlElement) { const prefix = pnl >= 0 ? "+" : ""; pnlElement.textContent = `${prefix}${formatInr(pnl)} (${prefix}${pct.toFixed(2)}%)`; pnlElement.style.color = pnl >= 0 ? "#22c55e" : "#ef4444"; } renderPaperHistory(p.history); }

function getDefaultAlertSettings() {
  return {
    priceAbove: null,
    priceBelow: null,
    signalChangeEnabled: true,
    riskChangeEnabled: true,
    setupGradeChangeEnabled: true
  };
}

function getAlertSettings() {
  try {
    const raw = localStorage.getItem(ALERT_SETTINGS_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    const defaults = getDefaultAlertSettings();

    return {
      ...defaults,
      ...saved,
      priceAbove:
        Number(saved?.priceAbove) > 0 ? Number(saved.priceAbove) : null,
      priceBelow:
        Number(saved?.priceBelow) > 0 ? Number(saved.priceBelow) : null,
      signalChangeEnabled: saved?.signalChangeEnabled !== false,
      riskChangeEnabled: saved?.riskChangeEnabled !== false,
      setupGradeChangeEnabled: saved?.setupGradeChangeEnabled !== false
    };
  } catch (error) {
    console.error(error);
    return getDefaultAlertSettings();
  }
}

function saveAlertSettings(settings) {
  try {
    localStorage.setItem(
      ALERT_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings)
    );
  } catch (error) {
    console.error(error);
  }
}

function getDefaultAlertRuntime() {
  return {
    lastPrice: null,
    aboveTriggeredFor: null,
    belowTriggeredFor: null,
    previousTechnicalSignal: null,
    previousRisk: null,
    previousSetupGrade: null,
    lastAlertMessage: "",
    lastAlertAt: null
  };
}

function getAlertRuntime() {
  try {
    const raw = localStorage.getItem(ALERT_RUNTIME_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...getDefaultAlertRuntime(), ...saved };
  } catch (error) {
    console.error(error);
    return getDefaultAlertRuntime();
  }
}

function saveAlertRuntime(runtime) {
  try {
    localStorage.setItem(
      ALERT_RUNTIME_STORAGE_KEY,
      JSON.stringify(runtime)
    );
  } catch (error) {
    console.error(error);
  }
}

function getNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function updateNotificationUi(message = "") {
  const badge = getElement("notificationPermissionBadge");
  const status = getElement("notificationStatus");
  const enableButton = getElement("enableNotificationsBtn");
  const testButton = getElement("testNotificationBtn");
  const permission = getNotificationPermission();

  const labels = {
    granted: "Notifications: Enabled",
    denied: "Notifications: Blocked",
    default: "Notifications: Permission needed",
    unsupported: "Notifications: Unsupported"
  };

  if (badge) {
    badge.textContent = labels[permission] || labels.default;
    badge.className = `notification-permission-badge notification-${permission}`;
  }

  if (enableButton) {
    enableButton.hidden = permission === "granted" || permission === "unsupported";
    enableButton.disabled = permission === "denied";
  }

  if (testButton) {
    testButton.disabled = permission !== "granted";
  }

  if (status) {
    if (message) {
      status.textContent = message;
    } else if (permission === "granted") {
      status.textContent =
        "Browser alerts are enabled for this dashboard while it remains open.";
    } else if (permission === "denied") {
      status.textContent =
        "Notifications are blocked in browser settings. Allow notifications for this site, then reload.";
    } else if (permission === "unsupported") {
      status.textContent =
        "This browser does not support desktop/browser notifications.";
    } else {
      status.textContent =
        "Enable browser alerts to receive price and technical-change notifications.";
    }
  }
}

function sendBrowserAlert(title, body, options = {}) {
  const runtime = getAlertRuntime();
  const message = `${title}: ${body}`;

  runtime.lastAlertMessage = message;
  runtime.lastAlertAt = Date.now();
  saveAlertRuntime(runtime);

  setText(
    "lastAlertStatus",
    `${message} • ${new Date(runtime.lastAlertAt).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    })}`
  );

  if (getNotificationPermission() !== "granted") {
    updateNotificationUi(
      "Alert condition detected, but browser notifications are not enabled."
    );
    return false;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon: "/frontend/image-1.png",
      tag: options.tag || "btc-ai-signal-alert",
      renotify: true
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    return true;
  } catch (error) {
    console.error(error);
    updateNotificationUi("Browser could not display the notification.");
    return false;
  }
}

async function requestBrowserNotifications() {
  if (!("Notification" in window)) {
    updateNotificationUi(
      "This browser does not support desktop/browser notifications."
    );
    return;
  }

  if (Notification.permission === "denied") {
    updateNotificationUi(
      "Notifications are blocked. Open browser site settings, allow notifications, then reload."
    );
    return;
  }

  try {
    const permission = await Notification.requestPermission();

    updateNotificationUi(
      permission === "granted"
        ? "Browser alerts enabled. Use Test Alert to verify."
        : "Permission was not granted. Alerts will remain on-screen only."
    );
  } catch (error) {
    console.error(error);
    updateNotificationUi("Could not request notification permission.");
  }
}

function formatAlertTarget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? formatUsd(number) : "Not set";
}

function renderAlertSettings() {
  const settings = getAlertSettings();
  const runtime = getAlertRuntime();

  const aboveInput = getElement("priceAboveInput");
  const belowInput = getElement("priceBelowInput");
  const signalToggle = getElement("signalChangeAlertToggle");
  const riskToggle = getElement("riskChangeAlertToggle");
  const setupToggle = getElement("setupGradeAlertToggle");

  if (aboveInput) aboveInput.value = settings.priceAbove || "";
  if (belowInput) belowInput.value = settings.priceBelow || "";
  if (signalToggle) signalToggle.checked = settings.signalChangeEnabled;
  if (riskToggle) riskToggle.checked = settings.riskChangeEnabled;
  if (setupToggle) setupToggle.checked = settings.setupGradeChangeEnabled;

  setText(
    "priceAboveStatus",
    settings.priceAbove
      ? `Active: alert at or above ${formatAlertTarget(settings.priceAbove)}.`
      : "No above-price alert is active."
  );

  setText(
    "priceBelowStatus",
    settings.priceBelow
      ? `Active: alert at or below ${formatAlertTarget(settings.priceBelow)}.`
      : "No below-price alert is active."
  );

  setText(
    "lastAlertStatus",
    runtime.lastAlertMessage
      ? `${runtime.lastAlertMessage} • ${new Date(
          runtime.lastAlertAt
        ).toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        })}`
      : "No alert triggered yet"
  );

  updateNotificationUi();
}

function savePriceAlert(type) {
  const inputId = type === "above" ? "priceAboveInput" : "priceBelowInput";
  const input = getElement(inputId);
  const value = Number(input?.value);
  const settings = getAlertSettings();
  const runtime = getAlertRuntime();

  if (!Number.isFinite(value) || value <= 0) {
    settings[type === "above" ? "priceAbove" : "priceBelow"] = null;

    if (type === "above") runtime.aboveTriggeredFor = null;
    else runtime.belowTriggeredFor = null;

    saveAlertSettings(settings);
    saveAlertRuntime(runtime);
    renderAlertSettings();

    setText(
      type === "above" ? "priceAboveStatus" : "priceBelowStatus",
      `Alert cleared. Enter a valid target to save a new ${
        type === "above" ? "above-price" : "below-price"
      } alert.`
    );
    return;
  }

  const key = type === "above" ? "priceAbove" : "priceBelow";
  settings[key] = value;

  if (type === "above") runtime.aboveTriggeredFor = null;
  else runtime.belowTriggeredFor = null;

  saveAlertSettings(settings);
  saveAlertRuntime(runtime);
  renderAlertSettings();

  setText(
    type === "above" ? "priceAboveStatus" : "priceBelowStatus",
    `Saved: alert at or ${type === "above" ? "above" : "below"} ${formatUsd(
      value
    )}.`
  );
}

function updateAlertToggle(settingKey, checked) {
  const settings = getAlertSettings();
  settings[settingKey] = Boolean(checked);
  saveAlertSettings(settings);
  renderAlertSettings();
}

function checkPriceAlerts(price) {
  const currentPrice = Number(price);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

  const settings = getAlertSettings();
  const runtime = getAlertRuntime();
  const previousPrice = Number(runtime.lastPrice);

  setText("alertCurrentBtcPrice", formatUsd(currentPrice));

  if (
    settings.priceAbove &&
    currentPrice >= settings.priceAbove &&
    runtime.aboveTriggeredFor !== settings.priceAbove &&
    (!Number.isFinite(previousPrice) || previousPrice < settings.priceAbove)
  ) {
    runtime.aboveTriggeredFor = settings.priceAbove;
    runtime.lastPrice = currentPrice;
    saveAlertRuntime(runtime);

    sendBrowserAlert(
      "BTC Price Alert",
      `BTC reached ${formatUsd(currentPrice)}, at or above your target of ${formatUsd(
        settings.priceAbove
      )}.`,
      { tag: `btc-above-${settings.priceAbove}` }
    );
  }

  if (
    settings.priceBelow &&
    currentPrice <= settings.priceBelow &&
    runtime.belowTriggeredFor !== settings.priceBelow &&
    (!Number.isFinite(previousPrice) || previousPrice > settings.priceBelow)
  ) {
    runtime.belowTriggeredFor = settings.priceBelow;
    runtime.lastPrice = currentPrice;
    saveAlertRuntime(runtime);

    sendBrowserAlert(
      "BTC Price Alert",
      `BTC reached ${formatUsd(currentPrice)}, at or below your target of ${formatUsd(
        settings.priceBelow
      )}.`,
      { tag: `btc-below-${settings.priceBelow}` }
    );
  }

  if (
    settings.priceAbove &&
    currentPrice < settings.priceAbove &&
    runtime.aboveTriggeredFor === settings.priceAbove
  ) {
    runtime.aboveTriggeredFor = null;
  }

  if (
    settings.priceBelow &&
    currentPrice > settings.priceBelow &&
    runtime.belowTriggeredFor === settings.priceBelow
  ) {
    runtime.belowTriggeredFor = null;
  }

  runtime.lastPrice = currentPrice;
  saveAlertRuntime(runtime);
}

function getSetupGradeForAlerts() {
  const grade = String(
    getElement("setupGrade")?.textContent || ""
  ).toUpperCase();

  return ["A", "B", "C", "D"].includes(grade) ? grade : null;
}

function checkTechnicalAlerts(data) {
  if (!data) return;

  const settings = getAlertSettings();
  const runtime = getAlertRuntime();
  const signal = String(data?.signal || "").toUpperCase() || null;
  const risk = String(data?.risk || "").toUpperCase() || null;
  const grade = getSetupGradeForAlerts();

  setText(
    "alertTechnicalWatchStatus",
    `${signal || "Unknown"} • Risk ${risk || "--"} • Grade ${grade || "--"}`
  );

  if (
    settings.signalChangeEnabled &&
    runtime.previousTechnicalSignal &&
    signal &&
    runtime.previousTechnicalSignal !== signal
  ) {
    sendBrowserAlert(
      "BTC Technical Signal Changed",
      `${runtime.previousTechnicalSignal} changed to ${signal}. Review live technical conditions before taking any action.`,
      { tag: "btc-signal-change" }
    );
  }

  if (
    settings.riskChangeEnabled &&
    runtime.previousRisk &&
    risk &&
    runtime.previousRisk !== risk
  ) {
    sendBrowserAlert(
      "BTC Risk Level Changed",
      `Risk changed from ${runtime.previousRisk} to ${risk}.`,
      { tag: "btc-risk-change" }
    );
  }

  if (
    settings.setupGradeChangeEnabled &&
    runtime.previousSetupGrade &&
    grade &&
    runtime.previousSetupGrade !== grade
  ) {
    sendBrowserAlert(
      "BTC Setup Grade Changed",
      `Setup grade changed from ${runtime.previousSetupGrade} to ${grade}.`,
      { tag: "btc-grade-change" }
    );
  }

  runtime.previousTechnicalSignal = signal;
  runtime.previousRisk = risk;
  runtime.previousSetupGrade = grade;
  saveAlertRuntime(runtime);
}

function setupAlerts() {
  const enableButton = getElement("enableNotificationsBtn");
  const testButton = getElement("testNotificationBtn");
  const saveAboveButton = getElement("savePriceAboveBtn");
  const saveBelowButton = getElement("savePriceBelowBtn");
  const signalToggle = getElement("signalChangeAlertToggle");
  const riskToggle = getElement("riskChangeAlertToggle");
  const setupToggle = getElement("setupGradeAlertToggle");

  if (enableButton) {
    enableButton.addEventListener("click", requestBrowserNotifications);
  }

  if (testButton) {
    testButton.addEventListener("click", () => {
      sendBrowserAlert(
        "BTC AI Signal Test Alert",
        "Browser alerts are working. This is a test notification.",
        { tag: "btc-ai-signal-test" }
      );
    });
  }

  if (saveAboveButton) {
    saveAboveButton.addEventListener("click", () => savePriceAlert("above"));
  }

  if (saveBelowButton) {
    saveBelowButton.addEventListener("click", () => savePriceAlert("below"));
  }

  if (signalToggle) {
    signalToggle.addEventListener("change", () =>
      updateAlertToggle("signalChangeEnabled", signalToggle.checked)
    );
  }

  if (riskToggle) {
    riskToggle.addEventListener("change", () =>
      updateAlertToggle("riskChangeEnabled", riskToggle.checked)
    );
  }

  if (setupToggle) {
    setupToggle.addEventListener("change", () =>
      updateAlertToggle("setupGradeChangeEnabled", setupToggle.checked)
    );
  }

  renderAlertSettings();
}
function updatePrice(data) { const btc = data?.bitcoin, price = Number(btc?.usd), change = Number(btc?.usd_24h_change || 0); if (!Number.isFinite(price)) throw new Error("Live BTC price was not received."); currentBtcPriceUsd = price; currentBtcPriceInr = price * USD_INR_RATE; setText("btcPrice", formatUsd(price)); const changeBox = getElement("btcChange"); if (changeBox) { changeBox.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`; changeBox.style.color = change >= 0 ? "#22c55e" : "#ef4444"; } setText("marketUpdatedAt", `Live price updated: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`);  renderPaperTrading(); checkPriceAlerts(price); }
  

function getNewsImpactClass(impact) {
  const normalized = String(impact || "NEUTRAL").toUpperCase();

  if (normalized === "BULLISH") return "news-impact-bullish";
  if (normalized === "BEARISH") return "news-impact-bearish";

  return "news-impact-neutral";
}

function saveAiNews(aiData) {
  const snapshot = {
    news: Array.isArray(aiData?.news) ? aiData.news : [],
    overview: aiData?.news_overview || "",
    marketBias: aiData?.news_market_bias || "NEUTRAL",
    updatedAt: aiData?.news_updated_at
      ? Number(aiData.news_updated_at) * 1000
      : Date.now()
  };

  try {
    localStorage.setItem(AI_NEWS_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error(error);
  }
}

function getSavedAiNews() {
  try {
    const raw = localStorage.getItem(AI_NEWS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function getNewsTranslationCache() {
  try {
    const raw = localStorage.getItem(NEWS_TRANSLATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error(error);
    return {};
  }
}

function saveNewsTranslationCache(cache) {
  try {
    localStorage.setItem(
      NEWS_TRANSLATION_STORAGE_KEY,
      JSON.stringify(cache)
    );
  } catch (error) {
    console.error(error);
  }
}

function getNewsTranslationKey(item = {}) {
  return [
    String(item?.source || ""),
    String(item?.url || ""),
    String(item?.headline || "")
  ].join("|");
}

function getCachedNewsTranslation(item) {
  const key = getNewsTranslationKey(item);
  return getNewsTranslationCache()[key] || null;
}

function saveCachedNewsTranslation(item, translation) {
  const key = getNewsTranslationKey(item);
  const cache = getNewsTranslationCache();

  cache[key] = {
    headline_hi: String(translation?.headline_hi || "").trim(),
    summary_hi: String(translation?.summary_hi || "").trim(),
    savedAt: Date.now()
  };

  const entries = Object.entries(cache)
    .sort(([, a], [, b]) => Number(b?.savedAt || 0) - Number(a?.savedAt || 0))
    .slice(0, 100);

  saveNewsTranslationCache(Object.fromEntries(entries));
}

function renderGeminiNews(aiData = null) {
  const newsData = aiData
    ? {
        news: Array.isArray(aiData.news) ? aiData.news : [],
        overview: aiData.news_overview || "",
        marketBias: aiData.news_market_bias || "NEUTRAL",
        updatedAt: aiData.news_updated_at
          ? Number(aiData.news_updated_at) * 1000
          : Date.now()
      }
    : getSavedAiNews();

  const container = getElement("geminiNewsList");
  const overview = getElement("geminiNewsOverview");
  const bias = getElement("geminiNewsBias");
  const updated = getElement("geminiNewsUpdated");

  if (!container || !overview || !bias || !updated) return;

  const items = Array.isArray(newsData?.news) ? newsData.news : [];
  const marketBias = String(newsData?.marketBias || "NEUTRAL").toUpperCase();
  const updatedAt = Number(newsData?.updatedAt);

  overview.textContent =
    newsData?.overview ||
    "News will update only when you run Refresh News with Groq.";

  bias.textContent = `News bias: ${marketBias}`;
  bias.className = `news-bias-badge ${getNewsImpactClass(marketBias)}`;

  updated.textContent = Number.isFinite(updatedAt)
    ? `Last news update: ${new Date(updatedAt).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      })} • Updated only with manual Groq News refresh`
    : "News updates only when you run Refresh News with Groq.";

  container.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "gemini-news-empty";
    empty.textContent =
      "No saved Gemini news context yet. Run Gemini AI Analysis to fetch current BTC/crypto news.";
    container.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "gemini-news-item";

    const top = document.createElement("div");
    top.className = "gemini-news-item-top";

    const source = document.createElement("span");
    source.className = "gemini-news-source";
    source.textContent = item?.source || "Source unavailable";

    const impact = document.createElement("span");
    const impactValue = String(item?.market_impact || "NEUTRAL").toUpperCase();
    impact.className = `news-impact-badge ${getNewsImpactClass(impactValue)}`;
    impact.textContent = impactValue;

    top.append(source, impact);

    const headline = document.createElement("h3");
    headline.textContent = item?.headline || "Crypto market update";

    const meta = document.createElement("p");
    meta.className = "gemini-news-meta";
    meta.textContent = item?.published_time || "Time unavailable";

    const summary = document.createElement("p");
    summary.className = "gemini-news-summary";
    summary.textContent = item?.summary || "No summary available.";

    const relevance = document.createElement("p");
    relevance.className = "gemini-news-relevance";
    relevance.textContent = `Market context: ${
      item?.market_relevance || "Interpretation unavailable."
    }`;

    const translationBox = document.createElement("div");
    translationBox.className = "gemini-news-translation";
    translationBox.hidden = true;

    const translationTitle = document.createElement("h4");
    translationTitle.textContent = "हिंदी अनुवाद";

    const translationHeadline = document.createElement("p");
    translationHeadline.className = "gemini-news-hi-headline";

    const translationSummary = document.createElement("p");
    translationSummary.className = "gemini-news-hi-summary";

    translationBox.append(
      translationTitle,
      translationHeadline,
      translationSummary
    );

    const actions = document.createElement("div");
    actions.className = "gemini-news-actions";

    const translateButton = document.createElement("button");
    translateButton.type = "button";
    translateButton.className = "translate-news-btn";
    translateButton.textContent = "हिंदी में पढ़ें";

    const translationStatus = document.createElement("span");
    translationStatus.className = "translation-status";
    translationStatus.setAttribute("aria-live", "polite");

    const cachedTranslation = getCachedNewsTranslation(item);

    function showTranslation(translation) {
      translationHeadline.textContent =
        translation?.headline_hi || item?.headline || "";
      translationSummary.textContent =
        translation?.summary_hi || item?.summary || "";
      translationBox.hidden = false;
      translateButton.textContent = "हिंदी अनुवाद छुपाएं";
      translationStatus.textContent = "अनुवाद तैयार है";
    }

    function hideTranslation() {
      translationBox.hidden = true;
      translateButton.textContent = "हिंदी में पढ़ें";
      translationStatus.textContent = "";
    }

    if (cachedTranslation?.headline_hi || cachedTranslation?.summary_hi) {
      showTranslation(cachedTranslation);
    }

    translateButton.addEventListener("click", async () => {
      if (!translationBox.hidden) {
        hideTranslation();
        return;
      }

      const alreadyCached = getCachedNewsTranslation(item);

      if (alreadyCached?.headline_hi || alreadyCached?.summary_hi) {
        showTranslation(alreadyCached);
        return;
      }

      translateButton.disabled = true;
      translateButton.textContent = "अनुवाद हो रहा है...";
      translationStatus.textContent = "Groq translation चल रहा है...";

      try {
        const response = await fetch("/api/news/translate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            headline: item?.headline || "",
            summary: item?.summary || "",
            source: item?.source || ""
          })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data.detail || "Hindi translation could not be completed."
          );
        }

        saveCachedNewsTranslation(item, data);
        showTranslation(data);
      } catch (error) {
        console.error(error);
        translationStatus.textContent =
          error.message ||
          "Translation unavailable. Please try again later.";
        translateButton.textContent = "हिंदी में पढ़ें";
      } finally {
        translateButton.disabled = false;
      }
    });

    actions.append(translateButton, translationStatus);

    card.append(
      top,
      headline,
      meta,
      summary,
      relevance,
      translationBox,
      actions
    );

    const url = String(item?.url || "").trim();

    if (/^https?:\/\//i.test(url)) {
      const link = document.createElement("a");
      link.className = "gemini-news-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Read original article ↗";
      card.appendChild(link);
    }

    container.appendChild(card);
  });
}


async function loadPrice(force = false) { const response = await fetch(force ? "/api/btc/price?force_refresh=true" : "/api/btc/price", { cache: "no-store" }); if (!response.ok) throw new Error("Price API could not be loaded."); updatePrice(await response.json()); }
async function loadChart() { const selected = timeframeSettings[activeTimeframe], response = await fetch(`/api/btc/chart?days=${selected.days}&interval=${selected.interval}`, { cache: "no-store" }); if (!response.ok) throw new Error("Chart API could not be loaded."); const chart = await response.json(), prices = Array.isArray(chart.prices) ? chart.prices : []; if (!prices.length) throw new Error("No chart data was received."); const step = Math.max(1, Math.ceil(prices.length / selected.maxPoints)), points = prices.filter((_, index) => index % step === 0 || index === prices.length - 1); renderChart(points.map((p) => new Date(p[0]).toLocaleString("en-IN", selected.dateOptions)), points.map((p) => p[1]), selected.label); }
async function loadAiAnalysis() {
  if (aiRefreshInProgress) return;

  aiRefreshInProgress = true;
  setText(
    "geminiUpdatedAt",
    "Running Gemini AI analysis and checking fresh news..."
  );

  try {
    const response = await fetch("/api/ai-signal/run", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: getUserApiKey("gemini") })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.detail ||
          data.message ||
          `AI signal request failed (${response.status}).`
      );
    }

    saveProviderPlan("GEMINI", data);
    saveAiNews(data);

    renderGeminiCard(data);
    renderGeminiNews(data);
    const geminiRetryOk = getElement("geminiRetryBtn");
    geminiRetryOk?.setAttribute("hidden", "");
    if (geminiRetryOk?.classList.contains("quota-finished-message")) {
      geminiRetryOk.classList.remove("quota-finished-message");
      geminiRetryOk.textContent = "Try Again";
      geminiRetryOk.disabled = false;
    }
    return true;
  } catch (error) {
    console.error(error);

    const savedNews = getSavedAiNews();
    renderGeminiNews(savedNews);
    const geminiRetry = getElement("geminiRetryBtn");
    geminiRetry?.removeAttribute("hidden");

    if (/quota/i.test(error.message || "")) {
      showQuotaFinishedMessage(geminiRetry);
    }

    if (renderSavedProviderPlanIfAny("GEMINI")) {
      setText(
        "geminiUpdatedAt",
        "Gemini refresh failed; showing the last successful Gemini plan."
      );
      return false;
    }

    setText("geminiSignalAction", "Unavailable");
    setText("geminiReason", error.message || "Gemini AI could not respond. Please try again.");
    setText("geminiUpdatedAt", "Gemini refresh failed. Please try again.");
    return false;
  } finally {
    aiRefreshInProgress = false;
  }
}
async function refreshFastData() { try { await Promise.all([loadPrice(true), loadChart()]); } catch (error) { console.error(error); setText("marketUpdatedAt", "Live price/chart could not be updated. Please try again."); } }
async function refreshTechnicalAnalysis(prefix = "Live technical analysis refreshed.") { return loadTechnicalFallback(prefix, true); }
async function refreshAllData() { if (technicalRefreshInProgress) return; try { await Promise.all([refreshFastData(), refreshTechnicalAnalysis("Live technical analysis refreshed.")]); } catch (error) { console.error("Technical refresh error:", error); } loadRrg().catch((error) => console.error("RRG refresh error:", error)); }

function renderChart(labels, data, label) { const canvas = getElement("btcChart"); if (!canvas) return; if (btcChart) btcChart.destroy(); btcChart = new Chart(canvas.getContext("2d"), { type: "line", data: { labels, datasets: [{ label: `BTC/USD • ${label}`, data, borderColor: "#22c55e", backgroundColor: "rgba(34, 197, 94, 0.15)", borderWidth: 2, fill: true, tension: 0.28, pointRadius: 0, pointHoverRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: true, interaction: { intersect: false, mode: "index" }, plugins: { legend: { labels: { color: "#ffffff" } }, tooltip: { callbacks: { label(context) { return `BTC: ${formatUsd(context.raw)}`; } } }, zoom: { limits: { x: { min: "original", max: "original", minRange: 2 } }, pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true, speed: 0.25 }, pinch: { enabled: true }, drag: { enabled: true, threshold: 2, backgroundColor: "rgba(59, 130, 246, 0.18)", borderColor: "#60a5fa", borderWidth: 1 }, mode: "x" } } }, scales: { x: { ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#1e293b" } }, y: { ticks: { color: "#cbd5e1", callback(value) { return formatUsd(value); } }, grid: { color: "#1e293b" } } } } }); }
function getRrgQuadrant(x, y) { return x >= 100 && y >= 100 ? "Leading" : x >= 100 ? "Weakening" : y < 100 ? "Lagging" : "Improving"; }
function createRrgQuadrantsPlugin() { return { id: "rrgQuadrants", beforeDatasetsDraw(chart) { const { ctx, chartArea, scales } = chart; if (!chartArea || !scales.x || !scales.y) return; const { left, right, top, bottom } = chartArea, cx = scales.x.getPixelForValue(100), cy = scales.y.getPixelForValue(100); if (!Number.isFinite(cx) || !Number.isFinite(cy)) return; ctx.save(); [["rgba(59, 130, 246, 0.13)", left, top, cx-left, cy-top], ["rgba(34, 197, 94, 0.13)", cx, top, right-cx, cy-top], ["rgba(239, 68, 68, 0.13)", left, cy, cx-left, bottom-cy], ["rgba(250, 204, 21, 0.13)", cx, cy, right-cx, bottom-cy]].forEach(([c,x,y,w,h]) => { ctx.fillStyle=c; ctx.fillRect(x,y,w,h); }); ctx.strokeStyle="rgba(255,255,255,.96)"; ctx.lineWidth=2.5; ctx.beginPath(); ctx.moveTo(cx,top); ctx.lineTo(cx,bottom); ctx.stroke(); ctx.beginPath(); ctx.moveTo(left,cy); ctx.lineTo(right,cy); ctx.stroke(); ctx.font="700 13px Arial"; ctx.fillStyle="#fff"; ctx.textBaseline="top"; ctx.textAlign="left"; ctx.fillText("IMPROVING",left+14,top+14); ctx.textAlign="right"; ctx.fillText("LEADING",right-14,top+14); ctx.textBaseline="bottom"; ctx.textAlign="left"; ctx.fillText("LAGGING",left+14,bottom-14); ctx.textAlign="right"; ctx.fillText("WEAKENING",right-14,bottom-14); ctx.restore(); } }; }
function createRrgDirectionArrowsPlugin() { return { id: "rrgDirectionArrows", afterDatasetsDraw(chart) { const { ctx } = chart; chart.data.datasets.forEach((dataset, index) => { const meta = chart.getDatasetMeta(index), element = meta?.data?.[meta.data.length - 1], raw = dataset.data[dataset.data.length - 1]; if (!element || !raw) return; const map = { "North-East": "↗", "South-East": "↘", "North-West": "↖", "South-West": "↙", Flat: "→" }; ctx.save(); ctx.fillStyle = dataset.borderColor || "#fff"; ctx.font = "bold 20px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(map[raw.direction || "Flat"] || "→", element.x + 9, element.y); ctx.restore(); }); } }; }
async function loadRrg() { const status = getElement("rrgStatus"); if (status) status.textContent = `Loading ${activeRrgTimeframe} RRG-style data...`; try { const response = await fetch(`/api/rrg?interval=${activeRrgTimeframe}`, { cache: "no-store" }); if (!response.ok) throw new Error("RRG API could not be loaded."); const data = await response.json(); renderRrg(data); if (status) status.textContent = `${activeRrgTimeframe.toUpperCase()} RRG updated: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`; } catch (error) { console.error(error); if (status) status.textContent = "RRG-style chart could not be loaded. Please refresh again."; } }
function renderRrg(data) { const canvas = getElement("rrgChart"); if (!canvas || !Array.isArray(data?.trails)) return; if (rrgChart) rrgChart.destroy(); const all = data.trails.flatMap((t) => Array.isArray(t.points) ? t.points : []), xs = all.map((p) => Number(p.x)).filter(Number.isFinite), ys = all.map((p) => Number(p.y)).filter(Number.isFinite), xmin = Math.min(100,...xs), xmax = Math.max(100,...xs), ymin = Math.min(100,...ys), ymax = Math.max(100,...ys), xp = Math.max(.8,(xmax-xmin)*.22), yp = Math.max(.8,(ymax-ymin)*.22); const datasets = data.trails.map((t) => { const color = rrgColors[t.symbol] || {border:"#fff",background:"rgba(255,255,255,.15)"}, points = Array.isArray(t.points)?t.points:[], last=points.length-1; return { label:t.symbol.replace("USDT",""), data:points.map((p,i)=>({x:Number(p.x),y:Number(p.y),timestamp:p.timestamp,isLatest:i===last,direction:t.direction||"Flat"})), borderColor:color.border, backgroundColor:color.background,borderWidth:2,pointBorderColor:color.border,pointBackgroundColor(c){return c.raw?.isLatest?color.border:"rgba(15,23,42,.95)";},pointRadius(c){return c.raw?.isLatest?5:2;},pointHoverRadius:7,showLine:true,tension:0}; }); rrgChart = new Chart(canvas.getContext("2d"), { type:"scatter",data:{datasets},plugins:[createRrgQuadrantsPlugin(),createRrgDirectionArrowsPlugin()],options:{responsive:true,maintainAspectRatio:true,aspectRatio:1.15,interaction:{intersect:false,mode:"nearest"},plugins:{legend:{labels:{color:"#fff",usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{title(c){const raw=c[0]?.raw;return raw?.timestamp?new Date(raw.timestamp).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"RRG-style point";},label(c){const x=Number(c.raw?.x||0),y=Number(c.raw?.y||0),d=c.raw?.direction||"Flat";return [`${c.dataset.label}: ${getRrgQuadrant(x,y)}`,`Direction: ${d}`,`RS Ratio: ${x.toFixed(2)}`,`RS Momentum: ${y.toFixed(2)}`];}}},zoom:{limits:{x:{min:"original",max:"original",minRange:.5},y:{min:"original",max:"original",minRange:.5}},pan:{enabled:true,mode:"xy",threshold:2},zoom:{wheel:{enabled:true,speed:.18},pinch:{enabled:true},drag:{enabled:true,threshold:2,backgroundColor:"rgba(59,130,246,.16)",borderColor:"#60a5fa",borderWidth:1},mode:"xy"}}},scales:{x:{type:"linear",min:xmin-xp,max:xmax+xp,title:{display:true,text:"Relative Strength Ratio",color:"#cbd5e1"},ticks:{color:"#cbd5e1",maxTicksLimit:7},grid:{color:"#334155"}},y:{type:"linear",min:ymin-yp,max:ymax+yp,title:{display:true,text:"Relative Strength Momentum",color:"#cbd5e1"},ticks:{color:"#cbd5e1",maxTicksLimit:7},grid:{color:"#334155"}}}} }); }

function getPaperTradeAmount() { const input=getElement("paperAmountInput"), amountInr=Number(input?.value); if (!currentBtcPriceInr) { setText("paperTradeStatus","Waiting for live BTC price. Please wait a few seconds."); return null; } if (!Number.isFinite(amountInr)||amountInr<PAPER_MIN_TRADE_INR) { setText("paperTradeStatus","Please enter a valid virtual amount of at least ₹100."); return null; } return {input,amountInr}; }
function executePaperBuy() { const trade=getPaperTradeAmount(); if(!trade)return; const {input,amountInr}=trade,p=loadPaperPortfolio(),btc=amountInr/currentBtcPriceInr; if(p.shortBtcHolding>PAPER_EPSILON){const value=p.shortBtcHolding*currentBtcPriceInr;if(amountInr>value+.01){setText("paperTradeStatus","Cover amount is larger than the current open short position.");return;}if(amountInr>p.cashInr+.01){setText("paperTradeStatus","Not enough virtual cash to cover this short position.");return;}const cover=Math.min(btc,p.shortBtcHolding),cost=cover*currentBtcPriceInr,avg=p.shortProceedsInr/p.shortBtcHolding;p.cashInr-=cost;p.shortBtcHolding-=cover;p.shortProceedsInr-=cover*avg;if(p.shortBtcHolding<PAPER_EPSILON){p.shortBtcHolding=0;p.shortProceedsInr=0;}addPaperTrade(p,"BUY TO COVER",cost,cover);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual BUY TO COVER complete: ${formatBtc(cover)} at ${formatInr(currentBtcPriceInr)} per BTC.`);renderPaperTrading();return;}if(amountInr>p.cashInr+.01){setText("paperTradeStatus","Not enough virtual cash for this long trade.");return;}p.cashInr-=amountInr;p.btcHolding+=btc;p.totalCostInr+=amountInr;addPaperTrade(p,"BUY LONG",amountInr,btc);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual BUY LONG complete: ${formatBtc(btc)} at ${formatInr(currentBtcPriceInr)} per BTC.`);renderPaperTrading(); }
function executePaperSell() { const trade=getPaperTradeAmount(); if(!trade)return; const {input,amountInr}=trade,p=loadPaperPortfolio(),btc=amountInr/currentBtcPriceInr; if(p.btcHolding>PAPER_EPSILON){const value=p.btcHolding*currentBtcPriceInr;if(amountInr>value+.01){setText("paperTradeStatus","Sell amount is larger than the current BTC long holding.");return;}const sold=Math.min(btc,p.btcHolding),sale=sold*currentBtcPriceInr,avg=p.totalCostInr/p.btcHolding;p.cashInr+=sale;p.btcHolding-=sold;p.totalCostInr-=sold*avg;if(p.btcHolding<PAPER_EPSILON){p.btcHolding=0;p.totalCostInr=0;}addPaperTrade(p,"SELL LONG",sale,sold);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual SELL LONG complete: ${formatBtc(sold)} at ${formatInr(currentBtcPriceInr)} per BTC.`);renderPaperTrading();return;}if(amountInr>p.cashInr+.01){setText("paperTradeStatus","Not enough virtual cash/margin to open this 1x short trade.");return;}p.cashInr+=amountInr;p.shortBtcHolding+=btc;p.shortProceedsInr+=amountInr;addPaperTrade(p,"SELL SHORT",amountInr,btc);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual SELL SHORT complete: ${formatBtc(btc)} at ${formatInr(currentBtcPriceInr)} per BTC. Use Buy / Cover Short to close it.`);renderPaperTrading(); }
function resetPaperTrading(){if(!window.confirm("Reset virtual paper portfolio to ₹100,000 and remove all virtual trades?"))return;savePaperPortfolio(getDefaultPaperPortfolio());setText("paperTradeStatus","Virtual portfolio reset to ₹100,000.");renderPaperTrading();}

function setupPaperTrading(){const buy=getElement("paperBuyBtn"),sell=getElement("paperSellBtn"),reset=getElement("resetPaperBtn");if(buy)buy.addEventListener("click",executePaperBuy);if(sell)sell.addEventListener("click",executePaperSell);if(reset)reset.addEventListener("click",resetPaperTrading);renderPaperTrading();}
function setupTimeframeButtons(){document.querySelectorAll(".timeframe-btn").forEach((button)=>button.addEventListener("click",async()=>{const frame=button.dataset.timeframe;if(!timeframeSettings[frame])return;activeTimeframe=frame;document.querySelectorAll(".timeframe-btn").forEach((item)=>item.classList.remove("active"));button.classList.add("active");try{await loadChart();}catch(error){console.error(error);setText("marketUpdatedAt","Selected chart timeframe could not be loaded.");}}));}
function setupZoomButtons(){const zin=getElement("zoomInBtn"),zout=getElement("zoomOutBtn"),reset=getElement("resetZoomBtn");if(zin)zin.addEventListener("click",()=>btcChart?.zoom({x:1.35}));if(zout)zout.addEventListener("click",()=>btcChart?.zoom({x:.74}));if(reset)reset.addEventListener("click",()=>btcChart?.resetZoom());}
function setupRrgButtons(){const reset=getElement("rrgResetBtn");document.querySelectorAll(".rrg-timeframe-btn").forEach((button)=>button.addEventListener("click",async()=>{const frame=button.dataset.rrgTimeframe;if(!["1h","1d"].includes(frame))return;activeRrgTimeframe=frame;document.querySelectorAll(".rrg-timeframe-btn").forEach((item)=>item.classList.remove("active"));button.classList.add("active");await loadRrg();}));if(reset)reset.addEventListener("click",()=>rrgChart?.resetZoom());}
function setUploadedChartText(id,value){const element=getElement(id);if(element)element.textContent=value||"--";}
function setupChartAnalyser(){const input=getElement("chartImageInput"),preview=getElement("chartImagePreview"),button=getElement("analyseChartBtn"),status=getElement("chartAnalyseStatus"),box=getElement("chartAnalysisResult");if(!input||!preview||!button||!status||!box)return;input.addEventListener("change",()=>{const file=input.files[0];box.hidden=true;if(!file){preview.hidden=true;preview.removeAttribute("src");status.textContent="Upload PNG, JPG, or WEBP chart image. Maximum 8 MB.";return;}if(!["image/png","image/jpeg","image/webp"].includes(file.type)||file.size>8*1024*1024){input.value="";preview.hidden=true;preview.removeAttribute("src");status.textContent="Select PNG, JPG, or WEBP only; maximum size is 8 MB.";return;}preview.src=URL.createObjectURL(file);preview.hidden=false;status.textContent=`Selected: ${file.name}. Click Analyse with Gemini AI.`;});button.addEventListener("click",async()=>{const file=input.files[0];if(!file){status.textContent="Please upload a chart image first.";return;}const form=new FormData();form.append("file",file);button.disabled=true;button.textContent="Analysing Chart...";status.textContent="Gemini is reading the uploaded chart screenshot...";box.hidden=true;try{const response=await fetch("/api/chart-analyser",{method:"POST",body:form}),data=await response.json();if(!response.ok)throw new Error(data.detail||"Chart analysis failed.");const signal=["BUY","SELL","HOLD"].includes(data.signal)?data.signal:"HOLD",element=getElement("uploadedChartSignal"),color=getSignalColor(signal);if(element){element.textContent=signal;element.style.color=color;element.style.borderColor=color;}setUploadedChartText("uploadedChartConfidence",`Confidence: ${Number(data.confidence||0)}%`);setUploadedChartText("uploadedChartRisk",data.risk);setUploadedChartText("uploadedChartTrend",data.trend);setUploadedChartText("uploadedChartPattern",data.pattern);setUploadedChartText("uploadedChartSupport",data.support);setUploadedChartText("uploadedChartResistance",data.resistance);setUploadedChartText("uploadedChartReason",data.reason);setUploadedChartText("uploadedChartEntry",data.entry_idea);setUploadedChartText("uploadedChartInvalidation",data.invalidation_idea);setUploadedChartText("uploadedChartWarning",data.warning);box.hidden=false;status.textContent="Chart analysis complete. Educational use only.";}catch(error){console.error(error);status.textContent=`Chart analysis error: ${error.message}`;}finally{button.disabled=false;button.textContent="Analyse with Gemini AI";}});}
function setupGeminiAiButton(){const button=getElement("geminiAiBtn");if(!button)return;button.addEventListener("click",async()=>{if(aiRefreshInProgress)return;button.disabled=true;button.textContent="Running Gemini AI...";try{await loadAiAnalysis();}finally{button.disabled=false;button.innerHTML="Run Gemini<span class=\"btn-subtext\">(Dashboard / Live Chart)</span>";}});getElement("geminiRetryBtn")?.addEventListener("click",()=>button.click());}
function setupTechnicalRetryButton(){const button=getElement("retryTechnicalBtn");if(button)button.addEventListener("click",async()=>{button.disabled=true;await refreshTechnicalAnalysis("Retrying live technical analysis.");button.disabled=false;});}

function setupLayoutEditor(){const
  container=getElement("customizableSections"),edit=getElement("editLayoutBtn"),save=getElement("saveLayoutBtn"),reset=getElement("resetLayoutBtn");if(!container||!edit||!save||!reset)return;let editMode=false,dragged=null;const cards=()=>[...container.querySelectorAll(":scope > .layout-editable")];const height=(card,h)=>{card.classList.remove("layout-height-compact","layout-height-normal","layout-height-tall");card.classList.add(`layout-height-${h}`);};const toolbar=(card)=>{if(card.querySelector(".layout-editor-toolbar"))return;const bar=document.createElement("div");bar.className="layout-editor-toolbar";bar.innerHTML='<button class="layout-editor-btn layout-drag-handle" type="button">Move</button><button class="layout-editor-btn" type="button" data-height="compact">Compact</button><button class="layout-editor-btn" type="button" data-height="normal">Normal</button><button class="layout-editor-btn" type="button" data-height="tall">Tall</button>';card.prepend(bar);bar.querySelectorAll("[data-height]").forEach((b)=>b.addEventListener("click",(e)=>{e.preventDefault();e.stopPropagation();height(card,b.dataset.height);}));};const drag=(card)=>{if(card.dataset.layoutDragReady)return;card.dataset.layoutDragReady="true";card.addEventListener("dragstart",(e)=>{if(!editMode){e.preventDefault();return;}dragged=card;card.classList.add("is-dragging");e.dataTransfer.effectAllowed="move";});card.addEventListener("dragend",()=>{card.classList.remove("is-dragging");cards().forEach((c)=>c.classList.remove("drag-over"));dragged=null;});card.addEventListener("dragover",(e)=>{if(!editMode||!dragged||dragged===card)return;e.preventDefault();card.classList.add("drag-over");});card.addEventListener("dragleave",()=>card.classList.remove("drag-over"));card.addEventListener("drop",(e)=>{if(!editMode||!dragged||dragged===card)return;e.preventDefault();const box=card.getBoundingClientRect();container.insertBefore(dragged,e.clientY>box.top+box.height/2?card.nextSibling:card);card.classList.remove("drag-over");});};const mode=(on)=>{editMode=on;container.classList.toggle("layout-edit-mode",on);cards().forEach((card)=>{toolbar(card);drag(card);card.draggable=on;if(!on)card.classList.remove("is-dragging","drag-over");});edit.hidden=on;save.hidden=!on;reset.hidden=!on;};const restore=()=>{try{const stored=JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)||"[]");if(!Array.isArray(stored))return;stored.forEach((item)=>{const card=container.querySelector(`:scope > .layout-editable[data-layout-id="${item.id}"]`);if(card){container.appendChild(card);height(card,["compact","normal","tall"].includes(item.height)?item.height:"normal");}});}catch(error){console.warn("Saved dashboard layout could not be restored.",error);}};edit.addEventListener("click",()=>mode(true));save.addEventListener("click",()=>{localStorage.setItem(LAYOUT_STORAGE_KEY,JSON.stringify(cards().map((card)=>({id:card.dataset.layoutId,height:["compact","normal","tall"].find((h)=>card.classList.contains(`layout-height-${h}`))||"normal"}))));mode(false);});reset.addEventListener("click",()=>{localStorage.removeItem(LAYOUT_STORAGE_KEY);window.location.reload();});restore();}

renderGeminiNews();
const refreshButton=getElement("refreshBtn");if(refreshButton)refreshButton.addEventListener("click",refreshAllData);setupGeminiAiButton();updateApiKeyGate("gemini");updateApiKeyGate("groq");
setupTechnicalRetryButton();
setupAlerts();
setText("signal-date",formatDateForSignal());
setupPaperTrading();
setupTimeframeButtons();
setupZoomButtons();
setupRrgButtons();
setupChartAnalyser();
setupLayoutEditor();
setupLiveCandlestickChart();

renderSavedProviderPlanIfAny("GEMINI");
renderSavedProviderPlanIfAny("GROQ");

refreshAllData();

setInterval(loadPrice, 30000);
setInterval(loadChart, 60000);

setInterval(() => {
  if (typeof window.isAiPlanLocked === "function" && window.isAiPlanLocked()) return;
  refreshTechnicalAnalysis("Automatic technical refresh.");
}, 60000);

setInterval(loadRrg, 300000);
/* ===== Dashboard tabs and settings ===== */
(() => {
  const STORAGE_KEY = "btcAiSignalDashboardPreferences";

  function initDashboard() {
    const tabs = [...document.querySelectorAll(".app-tab[data-tab]")];
    const panels = [...document.querySelectorAll(".tab-panel[data-panel]")];

    const menuButton = document.querySelector("#settingsMenuButton");
    const drawer = document.querySelector("#settingsDrawer");
    const closeButton = document.querySelector("#settingsCloseButton");

    const nameInput = document.querySelector("#userNameInput");
    const saveNameButton = document.querySelector("#saveUserNameBtn");
    const resetSettingsButton = document.querySelector("#resetSettingsBtn");

    const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
    const accentButtons = [...document.querySelectorAll("[data-accent-choice]")];
    const textSizeButtons = [...document.querySelectorAll("[data-text-size-choice]")];

    let settings = {};

    try {
      settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (error) {
      settings = {};
    }

    function getCurrentSettings() {
      return {
        name: nameInput?.value.trim() || "",
        theme: document.body.dataset.theme || "dark",
        accent: document.body.dataset.accent || "blue",
        textSize: document.body.dataset.textSize || "normal",
        activeTab: document.querySelector(".app-tab.active")?.dataset.tab || "dashboard"
      };
    }

    function saveSettings() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(getCurrentSettings()));
      } catch (error) {
        // Browser storage unavailable: current session will still work.
      }
    }

    function updateChoiceState(buttons, selectedValue, dataKey) {
      buttons.forEach((button) => {
        const active = button.dataset[dataKey] === selectedValue;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    }

    function applySettings(nextSettings = {}) {
      const theme = nextSettings.theme || "dark";
      const accent = nextSettings.accent || "blue";
      const textSize = nextSettings.textSize || "normal";
      const name = nextSettings.name || "";

      document.body.dataset.theme = theme;
      document.body.dataset.accent = accent;
      document.body.dataset.textSize = textSize;

      if (nameInput) {
        nameInput.value = name;
      }

      updateChoiceState(themeButtons, theme, "themeChoice");
      updateChoiceState(accentButtons, accent, "accentChoice");
      updateChoiceState(textSizeButtons, textSize, "textSizeChoice");
    }

    function showTab(tabName, shouldSave = true) {
      const validTab = panels.some((panel) => panel.dataset.panel === tabName);
      const targetTab = validTab ? tabName : "dashboard";

      tabs.forEach((tab) => {
        const active = tab.dataset.tab === targetTab;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });

      panels.forEach((panel) => {
        const active = panel.dataset.panel === targetTab;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
      });

      if (shouldSave) {
        saveSettings();
      }
    }

    function openSettings() {
      drawer?.classList.add("open");
      menuButton?.setAttribute("aria-expanded", "true");
    }

    function closeSettings() {
      drawer?.classList.remove("open");
      menuButton?.setAttribute("aria-expanded", "false");
    }

    applySettings(settings);
    showTab(settings.activeTab || "dashboard", false);

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        showTab(tab.dataset.tab);
      });
    });

    menuButton?.addEventListener("click", openSettings);
    closeButton?.addEventListener("click", closeSettings);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSettings();
      }
    });

    saveNameButton?.addEventListener("click", () => {
      applySettings({
        ...getCurrentSettings(),
        name: nameInput?.value.trim() || ""
      });
      saveSettings();
    });

    const geminiKeyInput = document.querySelector("#userGeminiKeyInput");
    const saveGeminiKeyButton = document.querySelector("#saveGeminiKeyBtn");
    const geminiKeyStatus = document.querySelector("#geminiKeyStatus");
    const groqKeyInput = document.querySelector("#userGroqKeyInput");
    const saveGroqKeyButton = document.querySelector("#saveGroqKeyBtn");
    const groqKeyStatus = document.querySelector("#groqKeyStatus");

    if (geminiKeyInput) geminiKeyInput.value = getUserApiKey("gemini");
    if (groqKeyInput) groqKeyInput.value = getUserApiKey("groq");
    if (geminiKeyStatus) geminiKeyStatus.textContent = getUserApiKey("gemini") ? "Using your own Gemini key." : "Using the site's shared Gemini key.";
    if (groqKeyStatus) groqKeyStatus.textContent = getUserApiKey("groq") ? "Using your own Groq key." : "Using the site's shared Groq key.";

    saveGeminiKeyButton?.addEventListener("click", () => {
      const value = geminiKeyInput?.value.trim() || "";
      setUserApiKey("gemini", value);
      if (geminiKeyStatus) geminiKeyStatus.textContent = value ? "Saved — using your own Gemini key." : "Cleared — using the site's shared Gemini key.";
      updateApiKeyGate("gemini", true);
    });

    saveGroqKeyButton?.addEventListener("click", () => {
      const value = groqKeyInput?.value.trim() || "";
      setUserApiKey("groq", value);
      if (groqKeyStatus) groqKeyStatus.textContent = value ? "Saved — using your own Groq key." : "Cleared — using the site's shared Groq key.";
      updateApiKeyGate("groq", true);
    });

    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveNameButton?.click();
      }
    });

    themeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applySettings({
          ...getCurrentSettings(),
          theme: button.dataset.themeChoice || "dark"
        });
        saveSettings();
      });
    });

    accentButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applySettings({
          ...getCurrentSettings(),
          accent: button.dataset.accentChoice || "blue"
        });
        saveSettings();
      });
    });

    textSizeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applySettings({
          ...getCurrentSettings(),
          textSize: button.dataset.textSizeChoice || "normal"
        });
        saveSettings();
      });
    });

    resetSettingsButton?.addEventListener("click", () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        // Continue resetting in the active browser session.
      }

      applySettings({
        name: "",
        theme: "dark",
        accent: "blue",
        textSize: "normal"
      });

      showTab("dashboard", false);
      closeSettings();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDashboard);
  } else {
    initDashboard();
  }
})();
function formatLiveCandlePrice(value) {
  const number = Number(value);
  return Number.isFinite(number)
    ? `$${number.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      })}`
    : "--";
}

function setLiveChartStatus(message, type = "connecting") {
  const badge = document.getElementById("liveChartConnection");
  const status = document.getElementById("liveChartStatus");

  if (badge) {
    badge.className = `live-chart-connection live-${type}`;
    badge.textContent =
      type === "live"
        ? `Live • BTCUSDT ${liveChartTimeframe}`
        : type === "error"
          ? "Connection error"
          : "Connecting…";
  }

  if (status) {
    status.textContent = message;
  }
}

/* ===== Chart drawing tools (cursor, horizontal line, vertical line, trend line, rectangle) =====
   Horizontal lines use candleSeries.createPriceLine() (a native full-width axis reference,
   which is exactly right for a horizontal line). Trend lines use a 2-point LineSeries (a
   native chart primitive, same pattern as the AI overlay lines). Vertical lines and
   rectangles don't map onto a (time, value) series, so they're drawn as SVG shapes in an
   overlay layer on top of the chart and repositioned every animation frame (only while at
   least one such shape exists) by converting their stored time/price back to pixels via
   the chart's own timeToCoordinate/priceToCoordinate — this keeps them lined up correctly
   through panning, zooming, and resizing. */

function getDrawingOverlaySvg() {
  return document.getElementById("liveChartDrawingOverlay");
}

function setDrawingToolHint(text) {
  const hint = document.getElementById("drawingToolHint");
  if (hint) hint.textContent = text || "";
}

function setChartDrawingMode(mode) {
  chartDrawingMode = mode;
  chartDrawingPendingPoint = null;
  hideDrawingContextMenu();

  document.querySelectorAll(".drawing-tool-btn[data-draw-tool]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.drawTool === mode);
  });

  const hints = {
    cursor: "",
    horizontal: "Click the chart to place a horizontal line.",
    vertical: "Click the chart to place a vertical line.",
    trend: "Click the start point, then the end point.",
    rectangle: "Click one corner, then the opposite corner.",
    measure: "Click the start point, then the end point to measure price, %, bars and time.",
    fibonacci: "Click the swing high, then the swing low (or reverse) to draw retracement levels.",
    position: "Click the entry price, then the stop-loss price (target auto-calculates at 2:1 reward:risk).",
    "volume-profile": "Click the start of the range, then the end, to show traded volume by price."
  };

  setDrawingToolHint(hints[mode] || "");
}

function saveUserDrawings() {
  try {
    const serializable = userChartDrawings.map(({ id, type, color, price, time, t1, p1, t2, p2 }) => ({ id, type, color, price, time, t1, p1, t2, p2 }));
    localStorage.setItem(CHART_DRAWINGS_STORAGE_KEY, JSON.stringify(serializable));
  } catch (error) {
    console.error(error);
  }
}

function scheduleDrawingReposition() {
  if (drawingRepositionFrame) return;
  drawingRepositionFrame = window.requestAnimationFrame(drawingRepositionLoop);
}

function drawingRepositionLoop() {
  repositionDrawingOverlays();
  const hasOverlayDrawings = userChartDrawings.some((drawing) => drawing.type === "vertical" || drawing.type === "rectangle" || drawing.type === "trend" || drawing.type === "measure" || drawing.type === "fibonacci" || drawing.type === "position" || drawing.type === "volume-profile");
  drawingRepositionFrame = hasOverlayDrawings ? window.requestAnimationFrame(drawingRepositionLoop) : null;
}

function repositionDrawingOverlays() {
  if (!liveCandleChart || !liveCandleSeries) return;
  const container = document.getElementById("liveCandlestickChart");
  const height = container ? container.clientHeight : 520;

  userChartDrawings.forEach((drawing) => {
    if (drawing.type === "vertical" && drawing.el) {
      const x = liveCandleChart.timeScale().timeToCoordinate(drawing.time);
      if (x === null) {
        drawing.el.setAttribute("opacity", "0");
        return;
      }
      drawing.el.setAttribute("opacity", "1");
      drawing.el.setAttribute("x1", x);
      drawing.el.setAttribute("x2", x);
      drawing.el.setAttribute("y1", 0);
      drawing.el.setAttribute("y2", height);
    } else if (drawing.type === "rectangle" && drawing.el) {
      const x1 = liveCandleChart.timeScale().timeToCoordinate(drawing.t1);
      const x2 = liveCandleChart.timeScale().timeToCoordinate(drawing.t2);
      const y1 = liveCandleSeries.priceToCoordinate(drawing.p1);
      const y2 = liveCandleSeries.priceToCoordinate(drawing.p2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) {
        drawing.el.setAttribute("opacity", "0");
        return;
      }
      drawing.el.setAttribute("opacity", "1");
      drawing.el.setAttribute("x", Math.min(x1, x2));
      drawing.el.setAttribute("y", Math.min(y1, y2));
      drawing.el.setAttribute("width", Math.max(1, Math.abs(x2 - x1)));
      drawing.el.setAttribute("height", Math.max(1, Math.abs(y2 - y1)));
      positionHandlePair(drawing, x1, y1, x2, y2);
    } else if (drawing.type === "trend" && drawing.handleEls) {
      const x1 = liveCandleChart.timeScale().timeToCoordinate(drawing.t1);
      const x2 = liveCandleChart.timeScale().timeToCoordinate(drawing.t2);
      const y1 = liveCandleSeries.priceToCoordinate(drawing.p1);
      const y2 = liveCandleSeries.priceToCoordinate(drawing.p2);
      positionHandlePair(drawing, x1, y1, x2, y2);
    } else if (drawing.type === "measure" && drawing.el) {
      const x1 = liveCandleChart.timeScale().timeToCoordinate(drawing.t1);
      const x2 = liveCandleChart.timeScale().timeToCoordinate(drawing.t2);
      const y1 = liveCandleSeries.priceToCoordinate(drawing.p1);
      const y2 = liveCandleSeries.priceToCoordinate(drawing.p2);
      if (x1 === null || x2 === null || y1 === null || y2 === null) {
        drawing.el.setAttribute("opacity", "0");
        if (drawing.textEl) drawing.textEl.setAttribute("opacity", "0");
        return;
      }
      drawing.el.setAttribute("opacity", "1");
      drawing.el.setAttribute("x", Math.min(x1, x2));
      drawing.el.setAttribute("y", Math.min(y1, y2));
      drawing.el.setAttribute("width", Math.max(1, Math.abs(x2 - x1)));
      drawing.el.setAttribute("height", Math.max(1, Math.abs(y2 - y1)));
      positionHandlePair(drawing, x1, y1, x2, y2);

      if (drawing.textEl) {
        drawing.textEl.setAttribute("opacity", "1");
        drawing.textEl.setAttribute("x", Math.min(x1, x2) + 6);
        drawing.textEl.setAttribute("y", Math.min(y1, y2) - 8 < 12 ? Math.min(y1, y2) + 16 : Math.min(y1, y2) - 8);
        renderMeasureLabel(drawing.textEl, drawing);
      }
    } else if (drawing.type === "fibonacci" && Array.isArray(drawing.levelEls)) {
      const timeScale = liveCandleChart.timeScale();
      const x1 = timeScale.timeToCoordinate(drawing.t1);
      const x2 = timeScale.timeToCoordinate(drawing.t2);
      if (x1 === null || x2 === null) {
        drawing.levelEls.forEach(({ line, text }) => {
          line.setAttribute("opacity", "0");
          text.setAttribute("opacity", "0");
        });
        positionHandlePair(drawing, null, null, null, null);
        return;
      }
      const leftX = Math.min(x1, x2);
      const rightX = Math.max(x1, x2);
      drawing.levelEls.forEach(({ line, text, level }) => {
        const levelPrice = drawing.p1 + (drawing.p2 - drawing.p1) * level.ratio;
        const y = liveCandleSeries.priceToCoordinate(levelPrice);
        if (y === null) {
          line.setAttribute("opacity", "0");
          text.setAttribute("opacity", "0");
          return;
        }
        line.setAttribute("opacity", "1");
        line.setAttribute("x1", leftX);
        line.setAttribute("x2", rightX);
        line.setAttribute("y1", y);
        line.setAttribute("y2", y);
        text.setAttribute("opacity", "1");
        text.setAttribute("x", rightX + 6);
        text.setAttribute("y", y + 4);
        text.textContent = `${level.label}  $${levelPrice.toFixed(2)}`;
      });
      const py1 = liveCandleSeries.priceToCoordinate(drawing.p1);
      const py2 = liveCandleSeries.priceToCoordinate(drawing.p2);
      positionHandlePair(drawing, x1, py1, x2, py2);
    } else if (drawing.type === "position" && drawing.riskRectEl) {
      const timeScale = liveCandleChart.timeScale();
      const x1 = timeScale.timeToCoordinate(drawing.t1);
      const x2 = timeScale.timeToCoordinate(drawing.t2);
      const entryY = liveCandleSeries.priceToCoordinate(drawing.p1);
      const stopY = liveCandleSeries.priceToCoordinate(drawing.p2);
      if (x1 === null || x2 === null || entryY === null || stopY === null) {
        drawing.riskRectEl.setAttribute("opacity", "0");
        drawing.rewardRectEl.setAttribute("opacity", "0");
        drawing.entryLineEl.setAttribute("opacity", "0");
        drawing.labelEl.setAttribute("opacity", "0");
        positionHandlePair(drawing, null, null, null, null);
        return;
      }
      const risk = drawing.p1 - drawing.p2;
      const targetPrice = drawing.p1 + risk * 2;
      const targetY = liveCandleSeries.priceToCoordinate(targetPrice);
      const leftX = Math.min(x1, x2);
      const rightX = Math.max(x1, x2);
      const width = Math.max(1, rightX - leftX);

      drawing.riskRectEl.setAttribute("opacity", "1");
      drawing.riskRectEl.setAttribute("x", leftX);
      drawing.riskRectEl.setAttribute("y", Math.min(entryY, stopY));
      drawing.riskRectEl.setAttribute("width", width);
      drawing.riskRectEl.setAttribute("height", Math.max(1, Math.abs(stopY - entryY)));

      if (targetY !== null) {
        drawing.rewardRectEl.setAttribute("opacity", "1");
        drawing.rewardRectEl.setAttribute("x", leftX);
        drawing.rewardRectEl.setAttribute("y", Math.min(entryY, targetY));
        drawing.rewardRectEl.setAttribute("width", width);
        drawing.rewardRectEl.setAttribute("height", Math.max(1, Math.abs(targetY - entryY)));
      } else {
        drawing.rewardRectEl.setAttribute("opacity", "0");
      }

      drawing.entryLineEl.setAttribute("opacity", "1");
      drawing.entryLineEl.setAttribute("x1", leftX);
      drawing.entryLineEl.setAttribute("x2", rightX);
      drawing.entryLineEl.setAttribute("y1", entryY);
      drawing.entryLineEl.setAttribute("y2", entryY);

      const direction = risk > 0 ? "LONG" : "SHORT";
      drawing.labelEl.setAttribute("opacity", "1");
      drawing.labelEl.setAttribute("x", leftX + 6);
      drawing.labelEl.setAttribute("y", Math.min(entryY, stopY, targetY ?? entryY) - 8);
      drawing.labelEl.textContent = `${direction}  Entry $${drawing.p1.toFixed(2)}  •  Stop $${drawing.p2.toFixed(2)}  •  Target $${targetPrice.toFixed(2)}  •  R:R 1:2.00`;

      positionHandlePair(drawing, x1, entryY, x2, stopY);
    } else if (drawing.type === "volume-profile" && Array.isArray(drawing.barEls)) {
      const timeScale = liveCandleChart.timeScale();
      const rangeStart = Math.min(drawing.t1, drawing.t2);
      const rangeEnd = Math.max(drawing.t1, drawing.t2);
      const x1 = timeScale.timeToCoordinate(drawing.t1);
      const x2 = timeScale.timeToCoordinate(drawing.t2);
      const hide = () => {
        drawing.barEls.forEach((bar) => bar.setAttribute("opacity", "0"));
        drawing.boundsEl.setAttribute("opacity", "0");
        drawing.labelEl.setAttribute("opacity", "0");
        positionHandlePair(drawing, null, null, null, null);
      };
      if (x1 === null || x2 === null) {
        hide();
        return;
      }
      const candlesInRange = liveCandleRawData.filter((candle) => candle.time >= rangeStart && candle.time <= rangeEnd);
      if (!candlesInRange.length) {
        hide();
        return;
      }
      const highestPrice = Math.max(...candlesInRange.map((candle) => candle.high));
      const lowestPrice = Math.min(...candlesInRange.map((candle) => candle.low));
      if (!(highestPrice > lowestPrice)) {
        hide();
        return;
      }
      const binSize = (highestPrice - lowestPrice) / VOLUME_PROFILE_BINS;
      const bins = new Array(VOLUME_PROFILE_BINS).fill(0);
      candlesInRange.forEach((candle) => {
        const binIndex = Math.min(VOLUME_PROFILE_BINS - 1, Math.max(0, Math.floor((candle.close - lowestPrice) / binSize)));
        bins[binIndex] += candle.volume;
      });
      const maxVolume = Math.max(...bins, 0.0000001);
      const pocIndex = bins.indexOf(maxVolume);
      const leftX = Math.min(x1, x2);
      const rightX = Math.max(x1, x2);
      const maxBarWidth = 90;

      drawing.boundsEl.setAttribute("opacity", "1");
      drawing.boundsEl.setAttribute("x", leftX);
      drawing.boundsEl.setAttribute("width", Math.max(1, rightX - leftX));
      const topY = liveCandleSeries.priceToCoordinate(highestPrice);
      const bottomY = liveCandleSeries.priceToCoordinate(lowestPrice);
      if (topY === null || bottomY === null) {
        hide();
        return;
      }
      drawing.boundsEl.setAttribute("y", topY);
      drawing.boundsEl.setAttribute("height", Math.max(1, bottomY - topY));

      drawing.barEls.forEach((bar, index) => {
        const binLowPrice = lowestPrice + index * binSize;
        const binHighPrice = binLowPrice + binSize;
        const binTopY = liveCandleSeries.priceToCoordinate(binHighPrice);
        const binBottomY = liveCandleSeries.priceToCoordinate(binLowPrice);
        if (binTopY === null || binBottomY === null) {
          bar.setAttribute("opacity", "0");
          return;
        }
        const barWidth = Math.max(1, (bins[index] / maxVolume) * maxBarWidth);
        bar.setAttribute("opacity", "1");
        bar.setAttribute("fill", index === pocIndex ? "#fbbf2499" : `${drawing.color}66`);
        bar.setAttribute("x", rightX);
        bar.setAttribute("y", Math.min(binTopY, binBottomY) + 1);
        bar.setAttribute("width", barWidth);
        bar.setAttribute("height", Math.max(1, Math.abs(binBottomY - binTopY) - 2));
      });

      drawing.labelEl.setAttribute("opacity", "1");
      drawing.labelEl.setAttribute("x", leftX + 4);
      drawing.labelEl.setAttribute("y", topY - 8 < 12 ? topY + 14 : topY - 8);
      drawing.labelEl.textContent = `Volume Profile  •  POC $${(lowestPrice + pocIndex * binSize + binSize / 2).toFixed(2)}`;

      positionHandlePair(drawing, x1, topY, x2, bottomY);
    }
  });
}

function getDrawingIntervalSeconds() {
  const intervals = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };
  return intervals[liveChartTimeframe] || 900;
}

function formatMeasureDuration(totalSeconds) {
  const seconds = Math.abs(Math.round(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function renderMeasureLabel(textEl, drawing) {
  const priceDiff = drawing.p2 - drawing.p1;
  const percent = drawing.p1 !== 0 ? (priceDiff / Math.abs(drawing.p1)) * 100 : 0;
  const bars = Math.round(Math.abs(drawing.t2 - drawing.t1) / getDrawingIntervalSeconds());
  const duration = formatMeasureDuration(drawing.t2 - drawing.t1);
  const sign = priceDiff >= 0 ? "+" : "";
  textEl.textContent = `${sign}$${priceDiff.toFixed(2)} (${sign}${percent.toFixed(2)}%)  •  ${bars} bars  •  ${duration}`;
}

function positionHandlePair(drawing, x1, y1, x2, y2) {
  const [handle1, handle2] = drawing.handleEls || [];
  if (!handle1 || !handle2) return;
  if (x1 === null || y1 === null) {
    handle1.setAttribute("opacity", "0");
  } else {
    handle1.setAttribute("opacity", "1");
    handle1.setAttribute("cx", x1);
    handle1.setAttribute("cy", y1);
  }
  if (x2 === null || y2 === null) {
    handle2.setAttribute("opacity", "0");
  } else {
    handle2.setAttribute("opacity", "1");
    handle2.setAttribute("cx", x2);
    handle2.setAttribute("cy", y2);
  }
}

function createDrawingHandlePair(color) {
  const svg = getDrawingOverlaySvg();
  if (!svg) return null;
  const makeHandle = () => {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("r", "5");
    circle.setAttribute("fill", "#07111f");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "2");
    circle.setAttribute("class", "drawing-handle");
    svg.appendChild(circle);
    return circle;
  };
  return [makeHandle(), makeHandle()];
}

function addDrawing(type, points, color = DRAWING_COLOR, persist = true) {
  if (!liveCandleChart || !liveCandleSeries || !window.LightweightCharts) return null;

  const id = `d${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
  const drawing = { id, type, color, ...points };

  if (type === "horizontal") {
    const numericPrice = Number(points.price);
    if (!Number.isFinite(numericPrice) || numericPrice <= 0) return null;
    drawing.ref = liveCandleSeries.createPriceLine({
      price: numericPrice,
      color,
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Solid,
      axisLabelVisible: true,
      title: "H-Line"
    });
  } else if (type === "trend") {
    if (points.t1 === points.t2) return null;
    const series = liveCandleChart.addLineSeries({
      color,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    });
    const orderedPoints = points.t1 <= points.t2
      ? [{ time: points.t1, value: points.p1 }, { time: points.t2, value: points.p2 }]
      : [{ time: points.t2, value: points.p2 }, { time: points.t1, value: points.p1 }];
    series.setData(orderedPoints);
    drawing.ref = series;
    drawing.handleEls = createDrawingHandlePair(color);
  } else if (type === "vertical") {
    const svg = getDrawingOverlaySvg();
    if (!svg) return null;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", "1.5");
    el.setAttribute("stroke-dasharray", "4,3");
    svg.appendChild(el);
    drawing.el = el;
  } else if (type === "rectangle") {
    const svg = getDrawingOverlaySvg();
    if (!svg) return null;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("fill", `${color}26`);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", "1.5");
    svg.appendChild(el);
    drawing.el = el;
    drawing.handleEls = createDrawingHandlePair(color);
  } else if (type === "measure") {
    if (points.t1 === points.t2) return null;
    const svg = getDrawingOverlaySvg();
    if (!svg) return null;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("fill", `${color}26`);
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", "1.5");
    el.setAttribute("stroke-dasharray", "5,3");
    svg.appendChild(el);
    drawing.el = el;
    const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    textEl.setAttribute("fill", "#f8fafc");
    textEl.setAttribute("font-size", "12");
    textEl.setAttribute("font-weight", "700");
    textEl.setAttribute("class", "drawing-measure-label");
    svg.appendChild(textEl);
    drawing.textEl = textEl;
    drawing.handleEls = createDrawingHandlePair(color);
  } else if (type === "fibonacci") {
    if (points.t1 === points.t2 || points.p1 === points.p2) return null;
    const svg = getDrawingOverlaySvg();
    if (!svg) return null;
    drawing.levelEls = FIB_LEVELS.map((level) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("stroke", level.color);
      line.setAttribute("stroke-width", level.ratio === 0.5 || level.ratio === 0.618 ? "2" : "1.5");
      svg.appendChild(line);
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("fill", level.color);
      text.setAttribute("font-size", "11");
      text.setAttribute("font-weight", "700");
      text.setAttribute("class", "drawing-measure-label");
      svg.appendChild(text);
      return { line, text, level };
    });
    drawing.handleEls = createDrawingHandlePair(color);
  } else if (type === "position") {
    if (points.t1 === points.t2 || points.p1 === points.p2) return null;
    const svg = getDrawingOverlaySvg();
    if (!svg) return null;
    const riskRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    riskRect.setAttribute("fill", "#ef444433");
    riskRect.setAttribute("stroke", "#ef4444");
    riskRect.setAttribute("stroke-width", "1");
    svg.appendChild(riskRect);
    drawing.riskRectEl = riskRect;

    const rewardRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rewardRect.setAttribute("fill", "#22c55e33");
    rewardRect.setAttribute("stroke", "#22c55e");
    rewardRect.setAttribute("stroke-width", "1");
    svg.appendChild(rewardRect);
    drawing.rewardRectEl = rewardRect;

    const entryLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    entryLine.setAttribute("stroke", "#f8fafc");
    entryLine.setAttribute("stroke-width", "1.5");
    svg.appendChild(entryLine);
    drawing.entryLineEl = entryLine;

    const labelEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    labelEl.setAttribute("fill", "#f8fafc");
    labelEl.setAttribute("font-size", "11");
    labelEl.setAttribute("font-weight", "700");
    labelEl.setAttribute("class", "drawing-measure-label");
    svg.appendChild(labelEl);
    drawing.labelEl = labelEl;

    drawing.handleEls = createDrawingHandlePair(color);
  } else if (type === "volume-profile") {
    if (points.t1 === points.t2) return null;
    const svg = getDrawingOverlaySvg();
    if (!svg) return null;
    const boundsEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    boundsEl.setAttribute("fill", "none");
    boundsEl.setAttribute("stroke", color);
    boundsEl.setAttribute("stroke-width", "1");
    boundsEl.setAttribute("stroke-dasharray", "3,3");
    svg.appendChild(boundsEl);
    drawing.boundsEl = boundsEl;

    drawing.barEls = [];
    for (let i = 0; i < VOLUME_PROFILE_BINS; i += 1) {
      const bar = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bar.setAttribute("fill", `${color}99`);
      svg.appendChild(bar);
      drawing.barEls.push(bar);
    }

    const labelEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    labelEl.setAttribute("fill", "#f8fafc");
    labelEl.setAttribute("font-size", "11");
    labelEl.setAttribute("font-weight", "700");
    labelEl.setAttribute("class", "drawing-measure-label");
    svg.appendChild(labelEl);
    drawing.labelEl = labelEl;

    drawing.handleEls = createDrawingHandlePair(color);
  } else {
    return null;
  }

  userChartDrawings.push(drawing);
  if (persist) saveUserDrawings();
  scheduleDrawingReposition();
  return drawing;
}

function removeDrawingElements(drawing) {
  if (drawing.ref) {
    try {
      if (drawing.type === "horizontal") liveCandleSeries?.removePriceLine(drawing.ref);
      else liveCandleChart?.removeSeries(drawing.ref);
    } catch (error) {
      console.warn("Could not remove drawing.", error);
    }
  }
  if (drawing.el) drawing.el.remove();
  if (drawing.textEl) drawing.textEl.remove();
  if (drawing.riskRectEl) drawing.riskRectEl.remove();
  if (drawing.rewardRectEl) drawing.rewardRectEl.remove();
  if (drawing.entryLineEl) drawing.entryLineEl.remove();
  if (drawing.labelEl) drawing.labelEl.remove();
  if (drawing.boundsEl) drawing.boundsEl.remove();
  if (Array.isArray(drawing.barEls)) drawing.barEls.forEach((bar) => bar.remove());
  if (Array.isArray(drawing.levelEls)) drawing.levelEls.forEach(({ line, text }) => { line.remove(); text.remove(); });
  if (Array.isArray(drawing.handleEls)) drawing.handleEls.forEach((handle) => handle.remove());
}

function applyDrawingColor(drawing, newColor) {
  drawing.color = newColor;
  if (drawing.type === "horizontal" && drawing.ref) {
    drawing.ref.applyOptions({ color: newColor });
  } else if (drawing.type === "vertical" && drawing.el) {
    drawing.el.setAttribute("stroke", newColor);
  } else if (drawing.type === "trend" && drawing.ref) {
    drawing.ref.applyOptions({ color: newColor });
  } else if ((drawing.type === "rectangle" || drawing.type === "measure") && drawing.el) {
    drawing.el.setAttribute("fill", `${newColor}26`);
    drawing.el.setAttribute("stroke", newColor);
  } else if (drawing.type === "volume-profile" && drawing.boundsEl) {
    drawing.boundsEl.setAttribute("stroke", newColor);
  }
  // Fibonacci levels and Long/Short Position risk/reward zones keep their fixed,
  // meaningful colors — only their endpoint handles follow the picked color.
  if (Array.isArray(drawing.handleEls)) {
    drawing.handleEls.forEach((handle) => handle.setAttribute("stroke", newColor));
  }
  saveUserDrawings();
}

function hideDrawingContextMenu() {
  const menu = document.getElementById("drawingContextMenu");
  if (menu) menu.hidden = true;
  selectedDrawingForMenu = null;
}

function showDrawingContextMenu(drawing, clientX, clientY) {
  const menu = document.getElementById("drawingContextMenu");
  const container = document.getElementById("liveCandlestickChart");
  if (!menu || !container) return;

  selectedDrawingForMenu = drawing;

  const rect = container.getBoundingClientRect();
  const left = Math.max(4, Math.min(clientX - rect.left + 12, rect.width - 90));
  const top = Math.max(4, Math.min(clientY - rect.top - 16, rect.height - 40));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.hidden = false;

  const colorInput = document.getElementById("drawingContextColor");
  if (colorInput) colorInput.value = drawing.color || DRAWING_COLOR;
}

function deleteDrawing(drawing) {
  const index = userChartDrawings.indexOf(drawing);
  if (index === -1) return;
  removeDrawingElements(drawing);
  userChartDrawings.splice(index, 1);
  saveUserDrawings();
}

function clearAllUserDrawings() {
  userChartDrawings.forEach(removeDrawingElements);
  userChartDrawings = [];
  saveUserDrawings();
}

function loadSavedDrawings() {
  try {
    const saved = localStorage.getItem(CHART_DRAWINGS_STORAGE_KEY);
    if (!saved) return;
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return;
    parsed.forEach((item) => {
      if (!item || !item.type) return;
      addDrawing(item.type, {
        price: item.price, time: item.time,
        t1: item.t1, p1: item.p1, t2: item.t2, p2: item.p2
      }, item.color || DRAWING_COLOR, false);
    });
  } catch (error) {
    console.error(error);
  }
}

function handleChartDrawingClick(param) {
  if (chartDrawingMode === "cursor") return;
  if (!param || !param.time || !param.point || !liveCandleSeries) return;

  const price = liveCandleSeries.coordinateToPrice(param.point.y);
  if (!Number.isFinite(price)) return;
  const time = param.time;

  if (chartDrawingMode === "horizontal") {
    addDrawing("horizontal", { price }, currentDrawingColor);
    setChartDrawingMode("cursor");
    return;
  }

  if (chartDrawingMode === "vertical") {
    addDrawing("vertical", { time }, currentDrawingColor);
    setChartDrawingMode("cursor");
    return;
  }

  if (chartDrawingMode === "trend" || chartDrawingMode === "rectangle" || chartDrawingMode === "measure" || chartDrawingMode === "fibonacci" || chartDrawingMode === "position" || chartDrawingMode === "volume-profile") {
    if (!chartDrawingPendingPoint) {
      chartDrawingPendingPoint = { time, price };
      setDrawingToolHint("Now click the second point.");
      return;
    }
    const first = chartDrawingPendingPoint;
    addDrawing(chartDrawingMode, { t1: first.time, p1: first.price, t2: time, p2: price }, currentDrawingColor);
    setChartDrawingMode("cursor");
  }
}

function setupChartDrawingTools() {
  document.querySelectorAll(".drawing-tool-btn[data-draw-tool]").forEach((btn) => {
    btn.addEventListener("click", () => setChartDrawingMode(btn.dataset.drawTool));
  });

  document.getElementById("clearDrawingsBtn")?.addEventListener("click", () => {
    if (userChartDrawings.length && window.confirm("Clear all drawings from the chart?")) {
      clearAllUserDrawings();
      hideDrawingContextMenu();
    }
  });

  const colorPicker = document.getElementById("drawingColorPicker");
  if (colorPicker) {
    colorPicker.value = currentDrawingColor;
    colorPicker.addEventListener("input", () => {
      currentDrawingColor = colorPicker.value;
    });
  }

  document.getElementById("drawingContextColor")?.addEventListener("input", (event) => {
    if (selectedDrawingForMenu) applyDrawingColor(selectedDrawingForMenu, event.target.value);
  });

  document.getElementById("drawingContextDelete")?.addEventListener("click", () => {
    if (selectedDrawingForMenu) deleteDrawing(selectedDrawingForMenu);
    hideDrawingContextMenu();
  });

  setChartDrawingMode("cursor");
}

/* ===== Drag-to-move for existing drawings =====
   Whole-shape dragging only (the line/rectangle keeps its shape and shifts as one
   piece) — not per-endpoint resizing. Hit-testing works in pixel space: horizontal/
   vertical lines check distance to the line's single axis, trend lines check
   point-to-segment distance, rectangles check "point is inside the box". While a
   drawing is being dragged, the chart's own pan/zoom is temporarily disabled so a
   drag never turns into a chart pan by accident. */

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function getContainerPoint(event) {
  const container = document.getElementById("liveCandlestickChart");
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  const source = event.touches && event.touches[0] ? event.touches[0] : event;
  return { x: source.clientX - rect.left, y: source.clientY - rect.top };
}

/* Returns { drawing, handle } where handle is "point1"/"point2" (grabbed an
   endpoint — resize just that point) or "move" (grabbed the body — shift the
   whole shape). Endpoints are checked first so precise corner-grabs always win
   over a whole-shape grab in the same area. */
function findDrawingHandleAtPoint(x, y) {
  if (!liveCandleChart || !liveCandleSeries) return null;
  const timeScale = liveCandleChart.timeScale();
  const LINE_HIT_PX = 8;
  const ENDPOINT_HIT_PX = 10;

  for (let i = userChartDrawings.length - 1; i >= 0; i -= 1) {
    const drawing = userChartDrawings[i];

    if (drawing.type === "horizontal") {
      const lineY = liveCandleSeries.priceToCoordinate(drawing.price);
      if (lineY !== null && Math.abs(lineY - y) <= LINE_HIT_PX) return { drawing, handle: "move" };
    } else if (drawing.type === "vertical") {
      const lineX = timeScale.timeToCoordinate(drawing.time);
      if (lineX !== null && Math.abs(lineX - x) <= LINE_HIT_PX) return { drawing, handle: "move" };
    } else if (drawing.type === "trend" || drawing.type === "rectangle" || drawing.type === "measure" || drawing.type === "fibonacci" || drawing.type === "position" || drawing.type === "volume-profile") {
      const x1 = timeScale.timeToCoordinate(drawing.t1);
      const y1 = liveCandleSeries.priceToCoordinate(drawing.p1);
      const x2 = timeScale.timeToCoordinate(drawing.t2);
      const y2 = liveCandleSeries.priceToCoordinate(drawing.p2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) continue;

      if (Math.hypot(x - x1, y - y1) <= ENDPOINT_HIT_PX) return { drawing, handle: "point1" };
      if (Math.hypot(x - x2, y - y2) <= ENDPOINT_HIT_PX) return { drawing, handle: "point2" };

      if (drawing.type === "trend") {
        if (distanceToSegment(x, y, x1, y1, x2, y2) <= LINE_HIT_PX) return { drawing, handle: "move" };
      } else {
        const withinX = x >= Math.min(x1, x2) && x <= Math.max(x1, x2);
        const withinY = y >= Math.min(y1, y2) && y <= Math.max(y1, y2);
        if (withinX && withinY) return { drawing, handle: "move" };
      }
    }
  }
  return null;
}

function handleDrawingMouseDown(event) {
  if (event.target.closest && event.target.closest("#drawingContextMenu")) return;
  if (chartDrawingMode !== "cursor") return;
  const point = getContainerPoint(event);
  if (!point) return;
  hideDrawingContextMenu();
  const hit = findDrawingHandleAtPoint(point.x, point.y);
  if (!hit) return;

  event.preventDefault();
  activeDragDrawing = hit.drawing;
  activeDragHandle = hit.handle;
  activeDragMoved = false;
  activeDragStart = { x: point.x, y: point.y, original: { ...hit.drawing } };
  liveCandleChart?.applyOptions({ handleScroll: false, handleScale: false });

  const container = document.getElementById("liveCandlestickChart");
  if (container) container.style.cursor = hit.handle === "move" ? "grabbing" : "crosshair";
}

function applyTrendOrRectanglePoints(drawing) {
  if (drawing.type === "trend" && drawing.ref) {
    const ordered = drawing.t1 <= drawing.t2
      ? [{ time: drawing.t1, value: drawing.p1 }, { time: drawing.t2, value: drawing.p2 }]
      : [{ time: drawing.t2, value: drawing.p2 }, { time: drawing.t1, value: drawing.p1 }];
    drawing.ref.setData(ordered);
  }
  // Rectangles re-read t1/p1/t2/p2 every animation frame via repositionDrawingOverlays,
  // so updating the stored values is all that's needed for them to follow the drag.
}

function handleDrawingMouseMove(event) {
  if (!activeDragDrawing || !liveCandleChart || !liveCandleSeries) return;
  const point = getContainerPoint(event);
  if (!point) return;

  if (!activeDragMoved) {
    const movedDistance = Math.hypot(point.x - activeDragStart.x, point.y - activeDragStart.y);
    if (movedDistance < DRAWING_CLICK_MOVE_THRESHOLD_PX) return;
    activeDragMoved = true;
  }

  const timeScale = liveCandleChart.timeScale();
  const drawing = activeDragDrawing;
  const original = activeDragStart.original;

  if (drawing.type === "horizontal") {
    const newPrice = liveCandleSeries.coordinateToPrice(point.y);
    if (Number.isFinite(newPrice)) {
      drawing.price = newPrice;
      drawing.ref?.applyOptions({ price: newPrice });
    }
    return;
  }

  if (drawing.type === "vertical") {
    const newTime = timeScale.coordinateToTime(point.x);
    if (newTime !== null) drawing.time = newTime;
    return;
  }

  if (activeDragHandle === "point1" || activeDragHandle === "point2") {
    // Resize: move only the grabbed endpoint, leave the other one fixed.
    const newTime = timeScale.coordinateToTime(point.x);
    const newPrice = liveCandleSeries.coordinateToPrice(point.y);
    if (newTime === null || !Number.isFinite(newPrice)) return;
    const otherTime = activeDragHandle === "point1" ? drawing.t2 : drawing.t1;
    if (newTime === otherTime) return;

    if (activeDragHandle === "point1") {
      drawing.t1 = newTime;
      drawing.p1 = newPrice;
    } else {
      drawing.t2 = newTime;
      drawing.p2 = newPrice;
    }
    applyTrendOrRectanglePoints(drawing);
    return;
  }

  // Move: shift both stored points by the same pixel delta, so the shape keeps
  // its size while moving.
  const origX1 = timeScale.timeToCoordinate(original.t1);
  const origY1 = liveCandleSeries.priceToCoordinate(original.p1);
  const origX2 = timeScale.timeToCoordinate(original.t2);
  const origY2 = liveCandleSeries.priceToCoordinate(original.p2);
  if (origX1 === null || origY1 === null || origX2 === null || origY2 === null) return;

  const dX = point.x - activeDragStart.x;
  const dY = point.y - activeDragStart.y;
  const newT1 = timeScale.coordinateToTime(origX1 + dX);
  const newP1 = liveCandleSeries.coordinateToPrice(origY1 + dY);
  const newT2 = timeScale.coordinateToTime(origX2 + dX);
  const newP2 = liveCandleSeries.coordinateToPrice(origY2 + dY);
  if (newT1 === null || newT2 === null || !Number.isFinite(newP1) || !Number.isFinite(newP2) || newT1 === newT2) return;

  drawing.t1 = newT1;
  drawing.p1 = newP1;
  drawing.t2 = newT2;
  drawing.p2 = newP2;
  applyTrendOrRectanglePoints(drawing);
}

function handleDrawingMouseUp(event) {
  if (!activeDragDrawing) return;
  const drawing = activeDragDrawing;
  const moved = activeDragMoved;

  activeDragDrawing = null;
  activeDragHandle = null;
  activeDragMoved = false;
  activeDragStart = null;
  liveCandleChart?.applyOptions({ handleScroll: true, handleScale: true });

  const container = document.getElementById("liveCandlestickChart");
  if (container) container.style.cursor = "";

  if (!moved) {
    const source = event && event.changedTouches && event.changedTouches[0] ? event.changedTouches[0] : event;
    const clientX = source ? source.clientX : 0;
    const clientY = source ? source.clientY : 0;
    showDrawingContextMenu(drawing, clientX, clientY);
    return;
  }

  saveUserDrawings();
}

function setupDrawingDrag() {
  const container = document.getElementById("liveCandlestickChart");
  if (!container) return;
  container.addEventListener("mousedown", handleDrawingMouseDown);
  container.addEventListener("touchstart", handleDrawingMouseDown, { passive: false });
  window.addEventListener("mousemove", handleDrawingMouseMove);
  window.addEventListener("touchmove", handleDrawingMouseMove, { passive: false });
  window.addEventListener("mouseup", handleDrawingMouseUp);
  window.addEventListener("touchend", handleDrawingMouseUp);
}

function createLiveCandlestickChart() {
  const container = document.getElementById("liveCandlestickChart");

  if (!container) return false;

  if (!window.LightweightCharts) {
    setLiveChartStatus(
      "Candlestick chart library could not be loaded. Please refresh the page.",
      "error"
    );
    return false;
  }

  if (liveCandleChart) return true;

  liveCandleChart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 520,
    layout: {
      background: { color: "#07111f" },
      textColor: "#cbd5e1"
    },
    grid: {
      vertLines: { color: "rgba(30, 41, 59, 0.72)" },
      horzLines: { color: "rgba(30, 41, 59, 0.72)" }
    },
    rightPriceScale: {
      borderColor: "rgba(56, 189, 248, 0.34)"
    },
    timeScale: {
      borderColor: "rgba(56, 189, 248, 0.34)",
      timeVisible: true,
      secondsVisible: false
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    }
  });

 liveCandleSeries = liveCandleChart.addCandlestickSeries({
  upColor: "#22c55e",
  downColor: "#ef4444",
  borderUpColor: "#22c55e",
  borderDownColor: "#ef4444",
  wickUpColor: "#86efac",
  wickDownColor: "#fca5a5"
});

  liveCandleChart.subscribeClick(handleChartDrawingClick);
  setupDrawingDrag();

  new ResizeObserver(() => {
    if (!liveCandleChart || !container.clientWidth) return;

    liveCandleChart.applyOptions({
      width: container.clientWidth,
      height: window.innerWidth <= 720 ? 480 : 520
    });

    scheduleDrawingReposition();
  }).observe(container);

  return true;
}

async function loadLiveCandlestickChart() {
  if (!createLiveCandlestickChart()) return;

  const setting = liveChartSettings[liveChartTimeframe] || { limit: 200 };

  setLiveChartStatus("Loading latest Binance candles…", "connecting");

  try {
    const response = await fetch(
      `/api/btc/candles?interval=${liveChartTimeframe}&limit=${setting.limit}`,
      { cache: "no-store" }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.detail || "Could not load candlestick data.");
    }

    const candles = Array.isArray(data.candles) ? data.candles : [];

    if (!candles.length) {
      throw new Error("No candlestick data was returned.");
    }

    liveCandleSeries.setData(
      candles.map((candle) => ({
        time: Number(candle.time),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close)
      }))
    );

    liveCandleRawData = candles.map((candle) => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume) || 0
    }));

    const latest = candles[candles.length - 1];

    const timeframeBox = document.getElementById("liveChartTimeframe");
    const priceBox = document.getElementById("liveChartPrice");
    const candleBox = document.getElementById("liveChartCandle");

    if (timeframeBox) timeframeBox.textContent = liveChartTimeframe;
    if (priceBox) priceBox.textContent = formatLiveCandlePrice(latest.close);

    if (candleBox) {
      candleBox.textContent =
        `Live • O ${formatLiveCandlePrice(latest.open)} • ` +
        `H ${formatLiveCandlePrice(latest.high)} • ` +
        `L ${formatLiveCandlePrice(latest.low)}`;
    }

    liveCandleChart.timeScale().fitContent();

    setLiveChartStatus(
      `Updated from Binance at ${new Date().toLocaleTimeString("en-IN")}.`,
      "live"
    );
  } catch (error) {
    console.error("Live candlestick chart error:", error);
    setLiveChartStatus(
      `Candlestick chart could not refresh: ${error.message}`,
      "error"
    );
  }
}

function setupLiveCandlestickChart() {
  const container = document.getElementById("liveCandlestickChart");

  if (!container) return;

  document.querySelectorAll(".live-chart-timeframe-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const nextTimeframe = button.dataset.liveTimeframe;

      if (!liveChartSettings[nextTimeframe]) return;

      liveChartTimeframe = nextTimeframe;

      document
        .querySelectorAll(".live-chart-timeframe-btn")
        .forEach((item) => item.classList.remove("active"));

      button.classList.add("active");

      await loadLiveCandlestickChart();
    });
  });

  document
    .getElementById("liveChartRefreshBtn")
    ?.addEventListener("click", loadLiveCandlestickChart);

  document
    .getElementById("liveChartResetBtn")
    ?.addEventListener("click", () => {
      liveCandleChart?.timeScale().fitContent();
    });

  loadLiveCandlestickChart();
  setupChartDrawingTools();
  loadSavedDrawings();

  if (liveChartRefreshTimer) {
    window.clearInterval(liveChartRefreshTimer);
  }

  liveChartRefreshTimer = window.setInterval(() => {
    if (!document.hidden) {
      loadLiveCandlestickChart();
    }
  }, 15000);

  if (!setupLiveCandlestickChart.visibilityBound) {
    setupLiveCandlestickChart.visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        loadLiveCandlestickChart();
      }
    });
  }
}
function clearLiveChartAiOverlay() {
  if (liveCandleSeries && Array.isArray(liveAiPriceLines)) {
    liveAiPriceLines.forEach((priceLine) => {
      try {
        liveCandleSeries.removePriceLine(priceLine);
      } catch (error) {
        console.warn("Could not remove old AI price line.", error);
      }
    });
  }

  liveAiPriceLines = [];

  if (liveAiSignalSeries && liveCandleChart) {
    try {
      liveCandleChart.removeSeries(liveAiSignalSeries);
    } catch (error) {
      console.warn("Could not remove old AI signal marker.", error);
    }
  }

  liveAiSignalSeries = null;

  if (liveCandleChart && Array.isArray(liveAiLevelSeries)) {
    liveAiLevelSeries.forEach((series) => {
      try {
        liveCandleChart.removeSeries(series);
      } catch (error) {
        console.warn("Could not remove old AI level segment.", error);
      }
    });
  }

  liveAiLevelSeries = [];
}
/* ===== Groq live-chart and news integration ===== */
(() => {
  let groqNewsRequestInProgress = false;

  async function runGroqNews() {
    if (groqNewsRequestInProgress) return;

    const button = document.getElementById("groqNewsBtn");
    groqNewsRequestInProgress = true;

    if (button) {
      button.disabled = true;
      button.textContent = "Refreshing Groq News...";
    }

    if (typeof setText === "function") {
      setText(
        "geminiNewsUpdated",
        "Groq is loading RSS news, sentiment, and Hindi explanation..."
      );
    }

    try {
      const response = await fetch("/api/groq-news", {
        method: "POST",
        cache: "no-store"
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.detail || `Groq news request failed (${response.status}).`
        );
      }

      if (typeof saveAiNews === "function") {
        saveAiNews(data);
      }

      if (typeof renderGeminiNews === "function") {
        renderGeminiNews(data);
      }
    } catch (error) {
      console.error("Groq news error:", error);

      if (typeof setText === "function") {
        setText(
          "geminiNewsUpdated",
          `Groq news unavailable: ${
            error?.message || "Please try again later."
          }`
        );
      }
    } finally {
      groqNewsRequestInProgress = false;

      if (button) {
        button.disabled = false;
        button.textContent = "Refresh News with Groq";
      }
    }
  }

  function connectGroqButtons() {
    document
      .getElementById("groqNewsBtn")
      ?.addEventListener("click", runGroqNews);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connectGroqButtons);
  } else {
    connectGroqButtons();
  }
})();
/* ===== AI chart status label + 5-minute refresh protection ===== */
(() => {
  const AI_LOCK_MS = 5 * 60 * 1000;
  const AI_LOCK_KEY = "btcAiSignalPlanLockV1";

  let statusSeries = [];
  let activePlanLock = null;

  function getChart() {
    return liveCandleChart || null;
  }

  function getCandleSeries() {
    return liveCandleSeries || null;
  }

  function getTimeframe() {
    return liveChartTimeframe || "15m";
  }

  function getIntervalSeconds() {
    const intervals = {
      "1m": 60,
      "5m": 300,
      "15m": 900,
      "1h": 3600,
      "4h": 14400,
      "1d": 86400,
      "1w": 604800
    };

    return intervals[getTimeframe()] || 900;
  }

  function getCurrentChartTime() {
    const interval = getIntervalSeconds();
    return Math.floor(Math.floor(Date.now() / 1000) / interval) * interval;
  }

  function clearStatusSeries() {
    const chart = getChart();

    if (!chart) {
      statusSeries = [];
      return;
    }

    statusSeries.forEach((series) => {
      try {
        chart.removeSeries(series);
      } catch (error) {
        console.warn("Could not remove chart status overlay.", error);
      }
    });

    statusSeries = [];
  }

  function setHoldBadge(text) {
    const badge = document.getElementById("liveChartHoldBadge");
    if (!badge) return;
    if (!text) {
      badge.hidden = true;
      return;
    }
    badge.textContent = text;
    badge.hidden = false;
  }

  function clearAllAiChartMarks() {
    if (typeof clearLiveChartAiOverlay === "function") {
      clearLiveChartAiOverlay();
    }

    clearStatusSeries();
    setHoldBadge(null);
  }

  function addForwardStatusLine(price, label, color) {
    const chart = getChart();
    const candleSeries = getCandleSeries();
    const numericPrice = Number(price);

    if (
      !chart ||
      !candleSeries ||
      !Number.isFinite(numericPrice) ||
      numericPrice <= 0 ||
      !window.LightweightCharts
    ) {
      return;
    }

    const startTime = getCurrentChartTime();
    const futureTime = startTime + getIntervalSeconds() * 12;

    const series = chart.addLineSeries({
      color,
      lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      title: label
    });

    series.setData([
      { time: startTime, value: numericPrice },
      { time: futureTime, value: numericPrice }
    ]);

    statusSeries.push(series);

    chart.timeScale().applyOptions({
      rightOffset: 12
    });
  }

  function validPosition(data) {
    const signal = String(data?.signal || "").toUpperCase();
    const entry = Number(data?.entry_price);
    const stop = Number(data?.stop_loss_price);
    const target1 = Number(data?.target_1_price);
    const target2 = Number(data?.target_2_price);

    if (
      ![entry, stop, target1, target2].every(
        (value) => Number.isFinite(value) && value > 0
      )
    ) {
      return false;
    }

    if (signal.includes("BUY")) {
      return stop < entry && entry < target1 && target1 < target2;
    }

    if (signal.includes("SELL")) {
      return target2 < target1 && target1 < entry && entry < stop;
    }

    return false;
  }

  function getCurrentPrice(data) {
    return (
      Number(data?.current_price) ||
      Number(data?.market_data?.current_price_usdt) ||
      Number(currentBtcPriceUsd) ||
      0
    );
  }

  function renderAiChartStatus(data, provider) {
    clearAllAiChartMarks();

    const signal = String(data?.signal || "HOLD").toUpperCase();
    const name = String(provider || "AI").toUpperCase();
    const isValid = validPosition(data);

    if (!isValid) {
      setHoldBadge(`${name} HOLD`);
      return;
    }

    const currentPrice = getCurrentPrice(data);

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return;
    }

    const direction = signal.includes("SELL") ? "SELL" : "BUY";
    const entryColor = direction === "BUY" ? "#22c55e" : "#ef4444";

    addForwardStatusLine(
      Number(data.entry_price),
      `${name} • ${direction} — SETUP ACTIVE | ENTRY`,
      entryColor
    );

    addForwardStatusLine(
      Number(data.stop_loss_price),
      `${name} • STOP LOSS`,
      "#ef4444"
    );

    addForwardStatusLine(
      Number(data.target_1_price),
      `${name} • TARGET 1`,
      "#facc15"
    );

    addForwardStatusLine(
      Number(data.target_2_price),
      `${name} • TARGET 2`,
      "#a78bfa"
    );
  }

  function savePlanLock(data, provider) {
    activePlanLock = {
      data,
      provider: String(provider || "AI").toUpperCase(),
      startedAt: Date.now()
    };

    try {
      localStorage.setItem(AI_LOCK_KEY, JSON.stringify(activePlanLock));
    } catch (error) {
      console.error("Could not save AI plan lock.", error);
    }

    refreshLockUi();
  }

  function getPlanLock() {
    if (activePlanLock) {
      return activePlanLock;
    }

    try {
      const raw = localStorage.getItem(AI_LOCK_KEY);
      activePlanLock = raw ? JSON.parse(raw) : null;
      return activePlanLock;
    } catch (error) {
      return null;
    }
  }

  function lockRemainingSeconds() {
    const lock = getPlanLock();

    if (!lock?.startedAt) return 0;

    const remaining = AI_LOCK_MS - (Date.now() - Number(lock.startedAt));

    if (remaining <= 0) {
      activePlanLock = null;

      try {
        localStorage.removeItem(AI_LOCK_KEY);
      } catch (error) {
        console.error(error);
      }

      return 0;
    }

    return Math.ceil(remaining / 1000);
  }

  function lockLabel() {
    const seconds = lockRemainingSeconds();

    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
      seconds % 60
    ).padStart(2, "0")}`;
  }

  function planLocked() {
    return lockRemainingSeconds() > 0;
  }

  window.isAiPlanLocked = planLocked;

  function refreshLockUi() {
    const refreshButton = document.getElementById("refreshBtn");
    const lock = getPlanLock();

    if (!planLocked()) {
      if (refreshButton?.dataset.aiPlanLocked === "true") {
        refreshButton.disabled = false;
        refreshButton.innerHTML = "Refresh<span class=\"btn-subline\">Technical</span>";
        delete refreshButton.dataset.aiPlanLocked;
      }
      return;
    }

    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.dataset.aiPlanLocked = "true";
      refreshButton.textContent = `AI Active ${lockLabel()}`;
    }

    if (typeof setText === "function") {
      setText(
        "technicalRefreshStatus",
        `${lock?.provider || "AI"} analysis active • technical refresh paused for ${lockLabel()}.`
      );
    }
  }

  const originalLoadAiAnalysis =
    typeof loadAiAnalysis === "function" ? loadAiAnalysis : null;

  if (originalLoadAiAnalysis) {
    window.loadAiAnalysis = async function () {
      const succeeded = await originalLoadAiAnalysis();

      if (succeeded && latestAiPlan?.data) {
        savePlanLock(latestAiPlan.data, "GEMINI");
        renderAiChartStatus(latestAiPlan.data, "GEMINI");
      }

      return succeeded;
    };
  }

  function connectGroqOverride() {
    const button = document.getElementById("groqLiveBtn");

    if (!button || button.dataset.chartStatusBound === "true") {
      return;
    }

    button.dataset.chartStatusBound = "true";
    document.getElementById("groqRetryBtn")?.addEventListener("click", () => button.click());

    button.addEventListener(
      "click",
      async (event) => {
        event.stopImmediatePropagation();

        if (planLocked()) {
          refreshLockUi();
          return;
        }

        button.disabled = true;
        button.textContent = "Running Groq Live Analysis...";

        try {
          const response = await fetch("/api/groq-live-analysis", {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ api_key: getUserApiKey("groq") })
          });

          const data = await response.json().catch(() => ({}));

          if (!response.ok) {
            throw new Error(
              data.detail ||
                `Groq live-chart request failed (${response.status}).`
            );
          }

          renderGroqCard(data);
          saveProviderPlan("GROQ", data);

          savePlanLock(data, "GROQ");
          renderAiChartStatus(data, "GROQ");
          const groqRetryOk = getElement("groqRetryBtn");
          groqRetryOk?.setAttribute("hidden", "");
          if (groqRetryOk?.classList.contains("quota-finished-message")) {
            groqRetryOk.classList.remove("quota-finished-message");
            groqRetryOk.textContent = "Try Again";
            groqRetryOk.disabled = false;
          }
        } catch (error) {
          console.error("Groq live chart error:", error);

          if (typeof clearLiveChartAiOverlay === "function") {
            clearLiveChartAiOverlay();
          }

          const groqRetry = getElement("groqRetryBtn");
          groqRetry?.removeAttribute("hidden");

          setText("groqSignalAction", "Unavailable");
          setText(
            "groqReason",
            error.message || "Groq live-chart analysis could not respond. Please try again later."
          );
          setText(
            "groqUpdatedAt",
            `Groq analysis unavailable: ${
              error.message || "Please try again later."
            }`
          );

          if (/quota/i.test(error.message || "")) {
            showQuotaFinishedMessage(groqRetry);
          }
        } finally {
          button.disabled = false;
          button.innerHTML = "Run Groq<span class=\"btn-subtext\">(Dashboard / Live Chart)</span>";
        }
      },
      true
    );
  }

  window.setInterval(() => {
    if (planLocked()) {
      refreshLockUi();
      return;
    }

    const refreshButton = document.getElementById("refreshBtn");

    if (refreshButton?.dataset.aiPlanLocked === "true") {
      refreshLockUi();

      if (typeof loadTechnicalFallback === "function") {
        loadTechnicalFallback(
          "AI plan expired. Live technical analysis resumed."
        );
      }
    }
  }, 1000);

  function restoreChartState() {
    const lock = getPlanLock();

    if (!planLocked() || !lock?.data) {
      return;
    }

    refreshLockUi();
    renderAiChartStatus(lock.data, lock.provider);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      connectGroqOverride();
      window.setTimeout(restoreChartState, 1500);
    });
  } else {
    connectGroqOverride();
    window.setTimeout(restoreChartState, 1500);
  }
})();

(function setupModeToggle() {
  const btcRoot = document.getElementById("btcModeRoot");
  const indianRoot = document.getElementById("indianModeRoot");
  const slider = document.getElementById("modeSliderToggle");
  const brandTitle = document.getElementById("brandTitle");
  const brandSubtitle = document.getElementById("brandSubtitle");
  if (!btcRoot || !indianRoot || !slider) return;

  function setMode(mode) {
    const isIndian = mode === "indian";
    btcRoot.hidden = isIndian;
    indianRoot.hidden = !isIndian;
    slider.dataset.mode = mode;
    if (brandTitle) brandTitle.textContent = isIndian ? "Indian Market AI" : "BTC AI Signal";
    if (brandSubtitle) {
      brandSubtitle.textContent = isIndian
        ? "NIFTY 50 and Bank Nifty research dashboard with paper-trading workflow"
        : "Live market analysis, virtual paper trading and Gemini/Groq AI signals";
    }
    try { localStorage.setItem("btcAiSignalActiveMode", mode); } catch (error) { /* ignore */ }
    if (window.IndianMarketMode) {
      if (isIndian) window.IndianMarketMode.start();
      else window.IndianMarketMode.stop();
    }
  }

  slider.addEventListener("click", () => {
    setMode(slider.dataset.mode === "indian" ? "btc" : "indian");
  });

  let savedMode = "btc";
  try { savedMode = localStorage.getItem("btcAiSignalActiveMode") || "btc"; } catch (error) { /* ignore */ }
  setMode(savedMode);
})();

/* ===== Indian Market mode (namespaced, isolated from BTC site logic) ===== */
(function IndianMarketModule() {
  const pageInfo = {
    "im-dashboard": {
      title: "Indian Market Overview",
      subtitle: "NIFTY 50 and Bank Nifty research dashboard with paper-trading workflow."
    },
    "im-nifty": {
      title: "NIFTY 50 Research",
      subtitle: "Technical research, market structure, and paper-trading preparation."
    },
    "im-banknifty": {
      title: "Bank Nifty Research",
      subtitle: "Volatility-aware research and disciplined paper-trading preparation."
    },
    "im-watchlist": {
      title: "Watchlist",
      subtitle: "Live last-traded price for popular NSE stocks."
    },
    "im-live-chart": {
      title: "Live Market Chart",
      subtitle: "Custom chart workspace for NIFTY 50 and Bank Nifty."
    },
    "im-rrg": {
      title: "Stock Rotation (RRG)",
      subtitle: "Relative strength and momentum rotation versus NIFTY 50."
    },
    "im-paper-trading": {
      title: "Paper Trading Journal",
      subtitle: "Record research setups only. No real-money order execution."
    }
  };

  const root = document.querySelector(".indian-market-mode");
  if (!root) return;

  const navButtons = root.querySelectorAll(".nav-button");
  const pages = root.querySelectorAll(".page");
  const pageTitle = document.getElementById("im-page-title");
  const pageSubtitle = document.getElementById("im-page-subtitle");

  function showPage(pageId) {
    navButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.page === pageId);
    });

    pages.forEach((page) => {
      page.classList.toggle("active", page.id === pageId);
    });

    const info = pageInfo[pageId];

    if (info && pageTitle && pageSubtitle) {
      pageTitle.textContent = info.title;
      pageSubtitle.textContent = info.subtitle;
    }

    if (pageId === "im-live-chart") {
      if (typeof createImLiveChart === "function") createImLiveChart();
      window.setTimeout(() => {
        if (imLiveChart) imLiveChart.applyOptions({ width: document.getElementById("im-lightweight-chart")?.clientWidth || 0 });
        if (typeof refreshLiveChartCandles === "function") refreshLiveChartCandles();
      }, 50);
    }

    if (pageId === "im-watchlist") {
      if (typeof startWatchlistPolling === "function") startWatchlistPolling();
    } else if (typeof stopWatchlistPolling === "function") {
      stopWatchlistPolling();
    }

    if (pageId === "im-dashboard" && typeof fetchAllTopMovers === "function") {
      fetchAllTopMovers();
    }

    if (pageId === "im-rrg" && typeof fetchImRrg === "function") {
      loadImRrgSymbolPanel().then(fetchImRrg);
    }
  }

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      showPage(button.dataset.page);
    });
  });

  const storageKey = "indianMarketPaperTrades";
  const form = document.getElementById("im-paper-trade-form");
  const tradeTableBody = document.getElementById("im-trade-table-body");
  const emptyTrades = document.getElementById("im-empty-trades");
  const tradeCount = document.getElementById("im-trade-count");
  const journalCount = document.getElementById("im-journal-count");

  function loadTrades() {
    try {
      return JSON.parse(localStorage.getItem(storageKey)) || [];
    } catch {
      return [];
    }
  }

  function saveTrades(trades) {
    localStorage.setItem(storageKey, JSON.stringify(trades));
  }

  function escapeText(value) {
    const div = document.createElement("div");
    div.textContent = value;
    return div.innerHTML;
  }

  function renderTrades() {
    const trades = loadTrades();

    if (tradeTableBody) {
      tradeTableBody.innerHTML = trades
        .map((trade, index) => {
          const directionClass = trade.direction === "Buy" ? "positive" : "negative";

          return `
            <tr>
              <td>${escapeText(trade.index)}</td>
              <td class="${directionClass}">${escapeText(trade.direction)}</td>
              <td>${Number(trade.entry).toFixed(2)}</td>
              <td>${Number(trade.stop).toFixed(2)}</td>
              <td>${Number(trade.target).toFixed(2)}</td>
              <td>
                <button
                  class="delete-trade-button"
                  type="button"
                  data-delete-index="${index}"
                >
                  Delete
                </button>
              </td>
            </tr>
          `;
        })
        .join("");
    }

    if (emptyTrades) emptyTrades.style.display = trades.length ? "none" : "block";
    if (tradeCount) tradeCount.textContent = String(trades.length);
    if (journalCount) {
      journalCount.textContent = `${trades.length} ${
        trades.length === 1 ? "trade" : "trades"
      }`;
    }
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const entry = Number(document.getElementById("im-trade-entry").value);
      const stop = Number(document.getElementById("im-trade-stop").value);
      const target = Number(document.getElementById("im-trade-target").value);

      if (![entry, stop, target].every((value) => Number.isFinite(value) && value > 0)) {
        alert("Please enter valid positive prices.");
        return;
      }

      const trades = loadTrades();

      trades.unshift({
        index: document.getElementById("im-trade-index").value,
        direction: document.getElementById("im-trade-direction").value,
        entry,
        stop,
        target
      });

      saveTrades(trades);
      form.reset();
      renderTrades();
    });
  }

  if (tradeTableBody) {
    tradeTableBody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-delete-index]");

      if (!button) {
        return;
      }

      const trades = loadTrades();
      trades.splice(Number(button.dataset.deleteIndex), 1);
      saveTrades(trades);
      renderTrades();
    });
  }

  renderTrades();

  const API_BASE_URL = "https://indian-market-ai-api.onrender.com";

  function formatNumber(value) {
    if (value === null || value === undefined) {
      return "--";
    }

    return Number(value).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = String(value);
    return div.innerHTML;
  }

  function decisionClass(label) {
    if (label.includes("BUY")) {
      return "decision-buy";
    }

    if (label.includes("SELL")) {
      return "decision-sell";
    }

    return "decision-wait";
  }

  function renderTechnicalMetrics(marketKey, data) {
    const grid = document.getElementById(`im-${marketKey}-technical-grid`);

    if (!grid) {
      return;
    }

    const bb = data.indicators.bollinger_bands || {};
    const st = data.indicators.supertrend || {};
    const adx = data.indicators.adx || {};
    const stoch = data.indicators.stochastic || {};
    const pivots = data.indicators.pivot_points || {};

    const metrics = [
      ["Price", formatNumber(data.price)],
      ["Change", `${data.change_percent >= 0 ? "+" : ""}${data.change_percent}%`],
      ["Open", formatNumber(data.open)],
      ["High", formatNumber(data.high)],
      ["Low", formatNumber(data.low)],
      ["RSI 14", data.indicators.rsi_14],
      ["EMA 9 / 21", `${formatNumber(data.indicators.ema_9)} / ${formatNumber(data.indicators.ema_21)}`],
      ["VWAP", formatNumber(data.indicators.vwap)],
      ["Volume Ratio", `${data.indicators.volume_ratio}x`],
      ["ATR 14", formatNumber(data.indicators.atr_14)],
      ["Bollinger Bands", `${formatNumber(bb.lower)} / ${formatNumber(bb.middle)} / ${formatNumber(bb.upper)}`],
      ["Supertrend", `${formatNumber(st.value)} (${st.trend || "--"})`],
      ["ADX / +DI / -DI", `${adx.adx ?? "--"} / ${adx.plus_di ?? "--"} / ${adx.minus_di ?? "--"}`],
      ["Stochastic %K/%D", `${stoch.k ?? "--"} / ${stoch.d ?? "--"}`],
      ["Pivot (R1/S1)", `${formatNumber(pivots.pivot)} (${formatNumber(pivots.r1)} / ${formatNumber(pivots.s1)})`]
    ];

    grid.innerHTML = metrics
      .map(
        ([label, value]) => `
          <div class="technical-item">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `
      )
      .join("");
  }

  function renderConfirmations(marketKey, data) {
    const list = document.getElementById(`im-${marketKey}-confirmation-list`);
    const count = document.getElementById(`im-${marketKey}-confirmation-count`);

    if (!list || !count) {
      return;
    }

    count.textContent = `${data.decision.bullish_count} bullish / ${data.decision.bearish_count} bearish`;

    list.innerHTML = data.confirmations
      .map(
        (item) => `
          <div class="confirmation-row">
            <div>
              <div class="confirmation-name">${escapeHtml(item.name)}</div>
              <div class="confirmation-reason">${escapeHtml(item.reason)}</div>
            </div>
            <span class="confirmation-state state-${escapeHtml(item.state)}">
              ${escapeHtml(item.state)}
            </span>
          </div>
        `
      )
      .join("");
  }

  function renderTradePlan(marketKey, data) {
    const plan = document.getElementById(`im-${marketKey}-trade-plan`);

    if (!plan) {
      return;
    }

    const entry = data.trade_plan.entry_zone;
    const entryText =
      entry.from === null || entry.to === null
        ? "No entry"
        : `${formatNumber(entry.from)} - ${formatNumber(entry.to)}`;

    const rows = [
      ["Decision", data.decision.label],
      ["Entry zone", entryText],
      ["Entry condition", entry.condition],
      ["Stop-loss", formatNumber(data.trade_plan.stop_loss)],
      ["Target 1", formatNumber(data.trade_plan.target_1)],
      ["Target 2", formatNumber(data.trade_plan.target_2)],
      ["Support", formatNumber(data.levels.support)],
      ["Resistance", formatNumber(data.levels.resistance)],
      ["Exit rule", data.trade_plan.exit_rule]
    ];

    plan.innerHTML = rows
      .map(
        ([label, value]) => `
          <div class="trade-plan-row">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `
      )
      .join("");
  }

  function renderMarketEngine(marketKey, data) {
    const label = document.getElementById(`im-${marketKey}-decision-label`);
    const reason = document.getElementById(`im-${marketKey}-decision-reason`);
    const status = document.getElementById(`im-${marketKey}-api-status`);

    if (label) {
      label.textContent = data.decision.label;
      label.className = `decision-label ${decisionClass(data.decision.label)}`;
    }

    if (reason) {
      reason.textContent = `${data.decision.reason} Score: ${data.decision.weighted_score}/${data.decision.max_score}.`;
    }

    if (status) {
      const time = new Date(data.updated_at).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });

      status.textContent = `Technical API connected - Last refresh: ${time}`;
    }

    const statusBadge = document.getElementById("im-market-status");
    const statusText = document.getElementById("im-market-status-text");
    if (statusBadge && statusText) {
      const isLive = data.data_source === "upstox_live";
      statusText.textContent = isLive ? "Live market data" : "Demo data mode";
      statusBadge.classList.toggle("market-status-live", isLive);
      statusBadge.classList.toggle("market-status-demo", !isLive);
    }

    const isLiveData = data.data_source === "upstox_live";
    const changeArrow = data.change_percent >= 0 ? "\u25B2" : "\u25BC";
    const changeClass = data.change_percent >= 0 ? "positive" : "negative";
    const changeText = `${changeArrow} ${data.change_percent >= 0 ? "+" : ""}${data.change_percent}% ${isLiveData ? "" : "\u00B7 Demo"}`.trim();

    const tickerPrice = document.getElementById(`im-ticker-${marketKey}-price`);
    const tickerChange = document.getElementById(`im-ticker-${marketKey}-change`);
    if (tickerPrice) tickerPrice.textContent = formatNumber(data.price);
    if (tickerChange) {
      tickerChange.textContent = `${changeArrow} ${data.change_percent >= 0 ? "+" : ""}${data.change_percent}%`;
      tickerChange.className = `im-ticker-change ${changeClass}`;
    }
    const tickerDot = document.getElementById("im-ticker-dot");
    const tickerStatusText = document.getElementById("im-ticker-status-text");
    if (tickerDot && tickerStatusText) {
      const sessionStatus = data.session_status;
      const isSessionLive = isLiveData && sessionStatus === "live";
      tickerDot.classList.toggle("im-ticker-live", isSessionLive);
      if (!isLiveData) {
        tickerStatusText.textContent = "Demo";
      } else if (sessionStatus === "live") {
        tickerStatusText.textContent = "Live";
      } else {
        tickerStatusText.textContent = "Closed";
      }
    }

    const dashPrice = document.getElementById(`im-dash-${marketKey}-price`);
    const dashChange = document.getElementById(`im-dash-${marketKey}-change`);
    if (dashPrice) dashPrice.textContent = formatNumber(data.price);
    if (dashChange) {
      dashChange.textContent = changeText;
      dashChange.className = `stat-change ${changeClass}`;
    }

    const heroPrice = document.getElementById(`im-${marketKey}-hero-price`);
    const heroChange = document.getElementById(`im-${marketKey}-hero-change`);
    const heroEyebrow = document.getElementById(`im-${marketKey}-eyebrow`);
    if (heroPrice) heroPrice.textContent = formatNumber(data.price);
    if (heroChange) {
      heroChange.textContent = `${changeArrow} ${data.change_percent >= 0 ? "+" : ""}${data.change_percent}%`;
      heroChange.className = changeClass;
    }
    if (heroEyebrow) heroEyebrow.textContent = `NSE Index \u00B7 ${isLiveData ? "Live data" : "Demo values"}`;

    renderTechnicalMetrics(marketKey, data);
    renderConfirmations(marketKey, data);
    renderTradePlan(marketKey, data);
  }

  function renderApiError(marketKey) {
    const label = document.getElementById(`im-${marketKey}-decision-label`);
    const reason = document.getElementById(`im-${marketKey}-decision-reason`);
    const status = document.getElementById(`im-${marketKey}-api-status`);

    if (label) {
      label.textContent = "TECHNICAL DATA UNAVAILABLE";
      label.className = "decision-label decision-wait";
    }

    if (reason) {
      reason.textContent = "The research API could not be reached. The backend may be starting or temporarily unavailable.";
    }

    if (status) {
      status.textContent = "Refresh will retry automatically in 60 seconds.";
    }
  }

  async function loadMarketEngine(marketKey) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/market/${marketKey}`);

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const payload = await response.json();

      if (!payload.ok || !payload.data) {
        throw new Error("Invalid API response");
      }

      renderMarketEngine(marketKey, payload.data);
    } catch (error) {
      console.error(`Could not load ${marketKey} technical engine`, error);
      renderApiError(marketKey);
    }
  }

  function refreshTechnicalEngine() {
    loadMarketEngine("nifty");
    loadMarketEngine("banknifty");
  }

  let technicalEngineTimer = null;

  function startTechnicalEnginePolling() {
    if (technicalEngineTimer) return;
    refreshTechnicalEngine();
    technicalEngineTimer = window.setInterval(refreshTechnicalEngine, 60000);
  }

  function stopTechnicalEnginePolling() {
    if (technicalEngineTimer) {
      window.clearInterval(technicalEngineTimer);
      technicalEngineTimer = null;
    }
  }

  function renderWatchlist(rows) {
    const body = document.getElementById("im-watchlist-body");
    const status = document.getElementById("im-watchlist-status");
    if (!body) return;

    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = `<tr><td colspan="2">No watchlist data available right now.</td></tr>`;
      if (status) status.textContent = "Unavailable";
      return;
    }

    body.innerHTML = rows
      .map(
        (row) => `
          <tr>
            <td>${escapeHtml(row.symbol)}</td>
            <td>${formatNumber(row.last_price)}</td>
          </tr>
        `
      )
      .join("");

    if (status) status.textContent = "Live";
  }

  async function fetchWatchlist() {
    const status = document.getElementById("im-watchlist-status");
    try {
      const response = await fetch(`${API_BASE_URL}/api/watchlist`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Watchlist request failed.");
      }
      renderWatchlist(result.data);
    } catch (error) {
      console.error("Watchlist fetch failed:", error);
      if (status) status.textContent = "Unavailable";
    }
  }

  function renderTopMover(indexKey, mover) {
    const nameEl = document.getElementById(`im-${indexKey}-mover-symbol`);
    const priceEl = document.getElementById(`im-${indexKey}-mover-price`);
    const changeEl = document.getElementById(`im-${indexKey}-mover-change`);
    if (!nameEl || !priceEl || !changeEl) return;

    if (!mover) {
      nameEl.textContent = "Unavailable";
      priceEl.textContent = "--";
      changeEl.textContent = "--";
      return;
    }

    const changePercent = mover.change_percent;
    const isPositive = changePercent >= 0;
    const arrow = isPositive ? "\u25B2" : "\u25BC";

    nameEl.textContent = mover.symbol;
    priceEl.textContent = formatNumber(mover.last_price);
    changeEl.textContent = `${arrow} ${isPositive ? "+" : ""}${changePercent}%`;
    changeEl.className = `im-mover-change ${isPositive ? "positive" : "negative"}`;
  }

  async function fetchTopMover(indexKey) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/top-mover/${indexKey}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Top mover request failed.");
      }
      renderTopMover(indexKey, result.data.mover);
    } catch (error) {
      console.error(`Top mover fetch failed for ${indexKey}:`, error);
      renderTopMover(indexKey, null);
    }
  }

  function fetchAllTopMovers() {
    fetchTopMover("nifty");
    fetchTopMover("banknifty");
  }

  fetchAllTopMovers();

  // ===================== RRG (Relative Rotation Graph) =====================

  let imRrgChart = null;
  let imRrgTimeframe = "1d";
  let imRrgData = null;
  let imRrgAnimTimer = null;
  let imRrgSelectedSymbols = new Set();
  let imRrgAllSymbols = [];
  let imRrgQuotesMap = {};
  let imRrgMode = "rrg";
  let imRrgSingleChart = null;
  let imRrgSingleSeries = null;
  let imRrgSelectedSingleSymbol = null;

  const imRrgColors = {
    "NIFTY 50": { border: "#e2e8f0", background: "rgba(226,232,240,.18)" }
  };

  function getImRrgColor(symbol) {
    if (imRrgColors[symbol]) return imRrgColors[symbol];
    let hash = 0;
    for (let i = 0; i < symbol.length; i += 1) {
      hash = (hash * 31 + symbol.charCodeAt(i)) % 360;
    }
    const hue = hash;
    const color = { border: `hsl(${hue}, 75%, 62%)`, background: `hsla(${hue}, 75%, 62%, 0.18)` };
    imRrgColors[symbol] = color;
    return color;
  }

  function imRrgQuadrantsPlugin() {
    return {
      id: "imRrgQuadrants",
      beforeDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || !scales.x || !scales.y) return;
        const { left, right, top, bottom } = chartArea;
        const cx = scales.x.getPixelForValue(100);
        const cy = scales.y.getPixelForValue(100);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
        ctx.save();
        [
          ["rgba(59,130,246,.13)", left, top, cx - left, cy - top],
          ["rgba(34,197,94,.13)", cx, top, right - cx, cy - top],
          ["rgba(239,68,68,.13)", left, cy, cx - left, bottom - cy],
          ["rgba(250,204,21,.13)", cx, cy, right - cx, bottom - cy]
        ].forEach(([color, x, y, w, h]) => {
          ctx.fillStyle = color;
          ctx.fillRect(x, y, w, h);
        });
        ctx.strokeStyle = "rgba(255,255,255,.25)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, top);
        ctx.lineTo(cx, bottom);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(left, cy);
        ctx.lineTo(right, cy);
        ctx.stroke();
        ctx.font = "700 12px Arial";
        ctx.fillStyle = "rgba(255,255,255,.85)";
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        ctx.fillText("IMPROVING", left + 12, top + 12);
        ctx.textAlign = "right";
        ctx.fillText("LEADING", right - 12, top + 12);
        ctx.textBaseline = "bottom";
        ctx.textAlign = "left";
        ctx.fillText("LAGGING", left + 12, bottom - 12);
        ctx.textAlign = "right";
        ctx.fillText("WEAKENING", right - 12, bottom - 12);
        ctx.restore();
      }
    };
  }

  function imRrgArrowsPlugin() {
    return {
      id: "imRrgArrows",
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        chart.data.datasets.forEach((dataset, index) => {
          const meta = chart.getDatasetMeta(index);
          const element = meta?.data?.[meta.data.length - 1];
          const raw = dataset.data[dataset.data.length - 1];
          if (!element || !raw) return;
          const map = { "North-East": "\u2197", "South-East": "\u2198", "North-West": "\u2196", "South-West": "\u2199", Flat: "\u2192" };
          ctx.save();
          ctx.fillStyle = dataset.borderColor || "#fff";
          ctx.font = "bold 16px Arial";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(map[raw.direction || "Flat"] || "\u2192", element.x + 8, element.y);
          ctx.restore();
        });
      }
    };
  }

  function renderImRrgSymbolList(data) {
    const container = document.getElementById("im-rrg-symbol-list");
    if (!container || !Array.isArray(data?.trails)) return;

    container.innerHTML = data.trails
      .map((t) => {
        const color = getImRrgColor(t.symbol);
        const last = (t.points || [])[t.points.length - 1];
        const rsRatio = last ? Number(last.x).toFixed(2) : "--";
        return `
          <div class="im-rrg-symbol-item">
            <span class="im-rrg-symbol-swatch" style="background:${color.border}"></span>
            <span class="im-rrg-symbol-name">${escapeHtml(t.symbol)}</span>
            <span class="im-rrg-symbol-ratio">${rsRatio}</span>
          </div>
        `;
      })
      .join("");
  }

  function renderImRrg(data, windowStart) {
    const canvas = document.getElementById("im-rrg-chart");
    if (!canvas || !Array.isArray(data?.trails)) return;
    if (imRrgChart) imRrgChart.destroy();
    renderImRrgSymbolList(data);

    const windowSize = data.display_window || 8;

    const all = data.trails.flatMap((t) => (Array.isArray(t.points) ? t.points : []));
    const xs = all.map((p) => Number(p.x)).filter(Number.isFinite);
    const ys = all.map((p) => Number(p.y)).filter(Number.isFinite);
    const xmin = Math.min(100, ...xs);
    const xmax = Math.max(100, ...xs);
    const ymin = Math.min(100, ...ys);
    const ymax = Math.max(100, ...ys);
    const xp = Math.max(0.8, (xmax - xmin) * 0.22);
    const yp = Math.max(0.8, (ymax - ymin) * 0.22);

    const datasets = data.trails.map((t) => {
      const color = getImRrgColor(t.symbol);
      const points = Array.isArray(t.points) ? t.points : [];
      const start = windowStart === undefined ? Math.max(0, points.length - windowSize) : windowStart;
      const visible = points.slice(start, start + windowSize);
      const last = visible.length - 1;
      return {
        label: t.symbol,
        data: visible.map((p, i) => ({ x: Number(p.x), y: Number(p.y), timestamp: p.timestamp, isLatest: i === last, direction: t.direction || "Flat" })),
        borderColor: color.border,
        backgroundColor: color.background,
        borderWidth: 2,
        pointBorderColor: color.border,
        pointBackgroundColor(c) { return c.raw?.isLatest ? color.border : "rgba(15,23,42,.95)"; },
        pointRadius(c) { return c.raw?.isLatest ? 5 : 2; },
        pointHoverRadius: 7,
        showLine: true,
        tension: 0.35
      };
    });

    imRrgChart = new Chart(canvas.getContext("2d"), {
      type: "scatter",
      data: { datasets },
      plugins: [imRrgQuadrantsPlugin(), imRrgArrowsPlugin()],
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1.8,
        interaction: { intersect: false, mode: "nearest" },
        animation: { duration: 450, easing: "easeInOutQuad" },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title(c) {
                const raw = c[0]?.raw;
                return raw?.timestamp ? new Date(raw.timestamp).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "RRG point";
              },
              label(c) {
                const x = Number(c.raw?.x || 0);
                const y = Number(c.raw?.y || 0);
                return [`${c.dataset.label}`, `RS Ratio: ${x.toFixed(2)}`, `RS Momentum: ${y.toFixed(2)}`];
              }
            }
          },
          zoom: {
            limits: { x: { min: "original", max: "original", minRange: 0.5 }, y: { min: "original", max: "original", minRange: 0.5 } },
            pan: { enabled: true, mode: "xy", threshold: 2 },
            zoom: {
              wheel: { enabled: true, speed: 0.18 },
              pinch: { enabled: true },
              drag: { enabled: true, threshold: 2, backgroundColor: "rgba(59,130,246,.16)", borderColor: "#60a5fa", borderWidth: 1 },
              mode: "xy"
            }
          }
        },
        scales: {
          x: { type: "linear", min: xmin - xp, max: xmax + xp, title: { display: true, text: "Relative Strength Ratio", color: "#94a3b8" }, ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.15)" } },
          y: { type: "linear", min: ymin - yp, max: ymax + yp, title: { display: true, text: "Relative Strength Momentum", color: "#94a3b8" }, ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.15)" } }
        }
      }
    });
  }

  async function fetchImRrg() {
    const status = document.getElementById("im-rrg-status");
    if (status) status.textContent = `Loading ${imRrgTimeframe.toUpperCase()} RRG data…`;
    try {
      const symbolsParam = `&symbols=${encodeURIComponent(Array.from(imRrgSelectedSymbols).join(","))}`;
      const response = await fetch(`${API_BASE_URL}/api/rrg?interval=${imRrgTimeframe}${symbolsParam}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "RRG request failed.");
      }
      imRrgData = result.data;
      renderImRrg(imRrgData);
      if (status) status.textContent = `${imRrgTimeframe.toUpperCase()} RRG updated \u00B7 NIFTY 50 benchmark`;
    } catch (error) {
      console.error("RRG fetch failed:", error);
      if (status) status.textContent = "RRG data unavailable right now.";
    }
  }

  function renderOneRrgSymbolList(containerId, filterText) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const filter = (filterText || "").trim().toLowerCase();
    const list = filter
      ? imRrgAllSymbols.filter((s) => s.toLowerCase().includes(filter))
      : imRrgAllSymbols;

    if (!list.length) {
      container.innerHTML = `<div class="im-rrg-symbols-loading">No matching indices.</div>`;
      return;
    }

    container.innerHTML = list
      .map((symbol) => {
        const quote = imRrgQuotesMap[symbol];
        const price = quote ? formatNumber(quote.last_price) : "--";
        const change = quote && quote.change_percent !== null && quote.change_percent !== undefined
          ? `${quote.change_percent >= 0 ? "+" : ""}${quote.change_percent}%`
          : "--";
        const changeClass = quote && quote.change_percent >= 0 ? "positive" : "negative";
        const checked = imRrgSelectedSymbols.has(symbol) ? "checked" : "";
        return `
          <div class="im-rrg-symbol-row" data-symbol="${escapeHtml(symbol)}">
            <input type="checkbox" class="im-rrg-symbol-check" data-symbol="${escapeHtml(symbol)}" ${checked} />
            <span class="im-rrg-symbol-row-name">${escapeHtml(symbol)}</span>
            <span class="im-rrg-symbol-row-price">${price}</span>
            <span class="im-rrg-symbol-row-change ${changeClass}">${change}</span>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".im-rrg-symbol-check").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const symbol = checkbox.dataset.symbol;
        if (checkbox.checked) imRrgSelectedSymbols.add(symbol);
        else imRrgSelectedSymbols.delete(symbol);
        // Keep both lists (left panel + below-chart panel) in sync with
        // whichever one the user just clicked in.
        renderRrgSymbolPanel(document.getElementById("im-rrg-search")?.value);
        window.clearTimeout(imRrgSelectionDebounce);
        imRrgSelectionDebounce = window.setTimeout(fetchImRrg, 500);
      });
    });

    container.querySelectorAll(".im-rrg-symbol-row-name").forEach((nameEl) => {
      nameEl.addEventListener("click", () => {
        const symbol = nameEl.closest(".im-rrg-symbol-row").dataset.symbol;
        drillDownRrgIndex(symbol);
      });
    });
  }

  let imRrgDrilldownIndex = null;
  let imRrgDrilldownConstituents = null;

  async function drillDownRrgIndex(indexName) {
    const belowContainer = document.getElementById("im-rrg-below-symbols-list");
    if (belowContainer) belowContainer.innerHTML = `<div class="im-rrg-symbols-loading">Loading ${escapeHtml(indexName)} stocks…</div>`;
    imRrgDrilldownIndex = indexName;

    if (imRrgMode === "chart") loadImRrgSingleChart(indexName);

    try {
      const response = await fetch(`${API_BASE_URL}/api/index-constituents?index=${encodeURIComponent(indexName)}`);
      const result = await response.json();
      if (!response.ok || !result.ok || !result.available) {
        imRrgDrilldownConstituents = null;
        if (belowContainer) {
          belowContainer.innerHTML = `
            <div class="im-rrg-drilldown-header">
              <button class="im-rrg-back-btn" id="im-rrg-back-btn">&#8592; Back to indices</button>
              <span>${escapeHtml(indexName)}</span>
            </div>
            <div class="im-rrg-symbols-loading">Stock list not available for this index yet.</div>
          `;
          document.getElementById("im-rrg-back-btn")?.addEventListener("click", exitRrgDrilldown);
        }
        return;
      }
      imRrgDrilldownConstituents = result.constituents;
      renderRrgDrilldownList(indexName, result.constituents);
    } catch (error) {
      console.error("Drill-down failed:", error);
      if (belowContainer) belowContainer.innerHTML = `<div class="im-rrg-symbols-loading">Could not load stocks for ${escapeHtml(indexName)}.</div>`;
    }
  }

  function exitRrgDrilldown() {
    imRrgDrilldownIndex = null;
    imRrgDrilldownConstituents = null;
    renderBelowSelectedList();
    syncRrgSelectAllCheckboxes();
  }

  function renderRrgDrilldownList(indexName, constituents) {
    const container = document.getElementById("im-rrg-below-symbols-list");
    if (!container) return;

    const rows = constituents
      .map((c) => {
        const checked = imRrgSelectedSymbols.has(c.symbol) ? "checked" : "";
        return `
          <div class="im-rrg-symbol-row" data-symbol="${escapeHtml(c.symbol)}">
            <input type="checkbox" class="im-rrg-symbol-check" data-symbol="${escapeHtml(c.symbol)}" ${checked} />
            <span class="im-rrg-symbol-row-name" title="${escapeHtml(c.name)}">${escapeHtml(c.symbol)}</span>
            <span class="im-rrg-symbol-row-price" id="im-rrg-price-${escapeHtml(c.symbol)}">…</span>
            <span class="im-rrg-symbol-row-change" id="im-rrg-change-${escapeHtml(c.symbol)}">…</span>
          </div>
        `;
      })
      .join("");

    container.innerHTML = `
      <div class="im-rrg-drilldown-header">
        <button class="im-rrg-back-btn" id="im-rrg-back-btn">&#8592; Back to indices</button>
        <span>${escapeHtml(indexName)} (${constituents.length})</span>
      </div>
      ${rows}
    `;

    document.getElementById("im-rrg-back-btn")?.addEventListener("click", exitRrgDrilldown);

    container.querySelectorAll(".im-rrg-symbol-check").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const symbol = checkbox.dataset.symbol;
        if (checkbox.checked) imRrgSelectedSymbols.add(symbol);
        else imRrgSelectedSymbols.delete(symbol);
        window.clearTimeout(imRrgSelectionDebounce);
        imRrgSelectionDebounce = window.setTimeout(fetchImRrg, 500);
      });
    });

    container.querySelectorAll(".im-rrg-symbol-row-name").forEach((nameEl) => {
      nameEl.addEventListener("click", () => {
        const symbol = nameEl.closest(".im-rrg-symbol-row").dataset.symbol;
        if (imRrgMode === "chart") loadImRrgSingleChart(symbol);
      });
    });

    loadDrilldownQuotes(constituents.map((c) => c.symbol));
  }

  async function loadDrilldownQuotes(symbols) {
    if (!symbols.length) return;

    const CHUNK_SIZE = 15;
    const chunks = [];
    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
      chunks.push(symbols.slice(i, i + CHUNK_SIZE));
    }

    function markUnavailable(chunkSymbols) {
      chunkSymbols.forEach((symbol) => {
        const priceEl = document.getElementById(`im-rrg-price-${symbol}`);
        const changeEl = document.getElementById(`im-rrg-change-${symbol}`);
        if (priceEl && priceEl.textContent === "\u2026") priceEl.textContent = "--";
        if (changeEl && changeEl.textContent === "\u2026") changeEl.textContent = "--";
      });
    }

    await Promise.all(
      chunks.map(async (chunkSymbols) => {
        try {
          const response = await fetch(`${API_BASE_URL}/api/watchlist?symbols=${encodeURIComponent(chunkSymbols.join(","))}`);
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || "Quotes request failed.");

          const returned = new Set();
          (result.data || []).forEach((q) => {
            returned.add(q.symbol);
            const priceEl = document.getElementById(`im-rrg-price-${q.symbol}`);
            const changeEl = document.getElementById(`im-rrg-change-${q.symbol}`);
            if (priceEl) priceEl.textContent = formatNumber(q.last_price);
            if (changeEl && q.change_percent !== null && q.change_percent !== undefined) {
              changeEl.textContent = `${q.change_percent >= 0 ? "+" : ""}${q.change_percent}%`;
              changeEl.className = `im-rrg-symbol-row-change ${q.change_percent >= 0 ? "positive" : "negative"}`;
            }
          });
          // Any symbol in this chunk that Upstox couldn't resolve/quote —
          // show "--" rather than leaving "…" stuck forever.
          markUnavailable(chunkSymbols.filter((s) => !returned.has(s)));
        } catch (error) {
          console.error("Drilldown quotes chunk failed:", error);
          markUnavailable(chunkSymbols);
        }
      })
    );
  }

  function renderBelowSelectedList() {
    const container = document.getElementById("im-rrg-below-symbols-list");
    if (!container) return;

    if (!imRrgSelectedSymbols.size) {
      container.innerHTML = `<div class="im-rrg-symbols-loading">Nothing selected yet — tick indices on the left to plot them here.</div>`;
      return;
    }

    // Keep selected items in the same order as the master list, for a
    // stable, predictable display.
    const orderedSelected = imRrgAllSymbols.filter((s) => imRrgSelectedSymbols.has(s));

    container.innerHTML = orderedSelected
      .map((symbol) => {
        const quote = imRrgQuotesMap[symbol];
        const price = quote ? formatNumber(quote.last_price) : "--";
        const change = quote && quote.change_percent !== null && quote.change_percent !== undefined
          ? `${quote.change_percent >= 0 ? "+" : ""}${quote.change_percent}%`
          : "--";
        const changeClass = quote && quote.change_percent >= 0 ? "positive" : "negative";
        return `
          <div class="im-rrg-symbol-row" data-symbol="${escapeHtml(symbol)}">
            <input type="checkbox" class="im-rrg-symbol-check" data-symbol="${escapeHtml(symbol)}" checked />
            <span class="im-rrg-symbol-row-name">${escapeHtml(symbol)}</span>
            <span class="im-rrg-symbol-row-price">${price}</span>
            <span class="im-rrg-symbol-row-change ${changeClass}">${change}</span>
          </div>
        `;
      })
      .join("");

    container.querySelectorAll(".im-rrg-symbol-check").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        // Unticking here always means "remove from selection" (this list
        // only ever shows selected items).
        imRrgSelectedSymbols.delete(checkbox.dataset.symbol);
        renderRrgSymbolPanel(imRrgSearchInput?.value);
        window.clearTimeout(imRrgSelectionDebounce);
        imRrgSelectionDebounce = window.setTimeout(fetchImRrg, 500);
      });
    });

    container.querySelectorAll(".im-rrg-symbol-row-name").forEach((nameEl) => {
      nameEl.addEventListener("click", () => {
        const symbol = nameEl.closest(".im-rrg-symbol-row").dataset.symbol;
        drillDownRrgIndex(symbol);
      });
    });
  }

  function renderRrgSymbolPanel(filterText) {
    renderOneRrgSymbolList("im-rrg-symbols-list", filterText);
    if (!imRrgDrilldownIndex) renderBelowSelectedList();
    if (typeof syncRrgSelectAllCheckboxes === "function") syncRrgSelectAllCheckboxes();
  }

  let imRrgSelectionDebounce = null;

  let imRrgPanelEverLoaded = false;

  async function loadImRrgSymbolPanel() {
    try {
      const [symbolsRes, quotesRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/rrg/symbols`).then((r) => r.json()),
        fetch(`${API_BASE_URL}/api/rrg/quotes`).then((r) => r.json())
      ]);
      if (symbolsRes.ok) {
        imRrgAllSymbols = symbolsRes.symbols || [];
        if (!imRrgPanelEverLoaded) {
          imRrgSelectedSymbols = new Set(symbolsRes.default_selected || []);
          imRrgPanelEverLoaded = true;
        }
      }
      if (quotesRes.ok) {
        imRrgQuotesMap = {};
        (quotesRes.data || []).forEach((q) => { imRrgQuotesMap[q.symbol] = q; });
      }
      renderRrgSymbolPanel(document.getElementById("im-rrg-search")?.value);
    } catch (error) {
      console.error("RRG symbol panel load failed:", error);
      const container = document.getElementById("im-rrg-symbols-list");
      if (container) container.innerHTML = `<div class="im-rrg-symbols-loading">Could not load index list.</div>`;
    }
  }

  const imRrgSearchInput = document.getElementById("im-rrg-search");
  if (imRrgSearchInput) {
    imRrgSearchInput.addEventListener("input", () => renderRrgSymbolPanel(imRrgSearchInput.value));
  }

  function syncRrgSelectAllCheckboxes() {
    const allSelected = imRrgAllSymbols.length > 0 && imRrgSelectedSymbols.size === imRrgAllSymbols.length;
    ["im-rrg-select-all-left", "im-rrg-select-all-below"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.checked = allSelected;
    });
  }

  function handleRrgSelectAllToggle(checkbox) {
    if (checkbox.checked) {
      imRrgSelectedSymbols = new Set(imRrgAllSymbols);
    } else {
      imRrgSelectedSymbols = new Set();
    }
    renderRrgSymbolPanel(imRrgSearchInput?.value);
    window.clearTimeout(imRrgSelectionDebounce);
    imRrgSelectionDebounce = window.setTimeout(fetchImRrg, 500);
  }

  ["im-rrg-select-all-left", "im-rrg-select-all-below"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => handleRrgSelectAllToggle(el));
  });

  document.querySelectorAll('input[name="im-rrg-mode"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      imRrgMode = radio.value;
      const rrgView = document.getElementById("im-rrg-rrg-view");
      const singleView = document.getElementById("im-rrg-single-view");
      const quadrantLegend = document.getElementById("im-rrg-quadrant-legend");
      const runBtn = document.getElementById("im-rrg-run-btn");
      const zoomBtns = [
        document.getElementById("im-rrg-zoom-in-btn"),
        document.getElementById("im-rrg-zoom-out-btn"),
        document.getElementById("im-rrg-zoom-reset-btn")
      ];
      const isRrg = imRrgMode === "rrg";
      if (rrgView) rrgView.hidden = !isRrg;
      if (singleView) singleView.hidden = isRrg;
      if (quadrantLegend) quadrantLegend.hidden = !isRrg;
      if (runBtn) runBtn.hidden = !isRrg;
      zoomBtns.forEach((b) => { if (b) b.hidden = !isRrg; });
    });
  });

  function createImRrgSingleChart() {
    const container = document.getElementById("im-rrg-single-chart");
    if (!container || imRrgSingleChart || !window.LightweightCharts) return;
    imRrgSingleChart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 420,
      layout: { background: { color: "#081728" }, textColor: "#93a9c3" },
      grid: { vertLines: { color: "rgba(29, 54, 85, 0.6)" }, horzLines: { color: "rgba(29, 54, 85, 0.6)" } },
      rightPriceScale: { borderColor: "rgba(69, 182, 255, 0.3)" },
      timeScale: { borderColor: "rgba(69, 182, 255, 0.3)", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    });
    imRrgSingleSeries = imRrgSingleChart.addCandlestickSeries({
      upColor: "#36cf83", downColor: "#ff6f7d",
      borderUpColor: "#36cf83", borderDownColor: "#ff6f7d",
      wickUpColor: "#7be3ad", wickDownColor: "#ffa3ab"
    });
    new ResizeObserver(() => {
      if (imRrgSingleChart && container.clientWidth) imRrgSingleChart.applyOptions({ width: container.clientWidth });
    }).observe(container);
  }

  async function loadImRrgSingleChart(symbol) {
    imRrgSelectedSingleSymbol = symbol;
    createImRrgSingleChart();
    const title = document.getElementById("im-rrg-single-title");
    if (title) title.textContent = `Loading ${symbol}…`;
    try {
      const response = await fetch(`${API_BASE_URL}/api/index-candles?symbol=${encodeURIComponent(symbol)}&timeframe=${imRrgTimeframe === "1h" ? "1h" : "1d"}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Chart request failed.");
      const points = (result.candles || [])
        .map((c) => ({ time: Math.floor(new Date(c.time).getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close }))
        .filter((p) => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
      if (imRrgSingleSeries) imRrgSingleSeries.setData(points);
      if (title) title.textContent = symbol;
    } catch (error) {
      console.error("Single index chart failed:", error);
      if (title) title.textContent = `Could not load chart for ${symbol}.`;
    }
  }

  function updateImRrgFrame(data, windowStart) {
    if (!imRrgChart) return;
    const windowSize = data.display_window || 8;
    imRrgChart.data.datasets.forEach((dataset, index) => {
      const trail = data.trails[index];
      if (!trail) return;
      const points = Array.isArray(trail.points) ? trail.points : [];
      const visible = points.slice(windowStart, windowStart + windowSize);
      const last = visible.length - 1;
      dataset.data = visible.map((p, i) => ({
        x: Number(p.x),
        y: Number(p.y),
        timestamp: p.timestamp,
        isLatest: i === last,
        direction: trail.direction || "Flat"
      }));
    });
    imRrgChart.update();
  }

  function runImRrgAnimation() {
    if (!imRrgData || imRrgAnimTimer) return;
    const windowSize = imRrgData.display_window || 8;
    const maxLen = Math.max(1, ...imRrgData.trails.map((t) => (t.points || []).length));
    const lastWindowStart = Math.max(0, maxLen - windowSize);
    const runBtn = document.getElementById("im-rrg-run-btn");
    if (runBtn) runBtn.disabled = true;

    // Slide a fixed-size window across the full history (oldest points drop
    // off the back as new ones appear at the front) instead of just growing
    // a trail longer and longer — this is what gives a real RRG "Play" its
    // smooth, continuously-flowing rotation instead of an ever-lengthening,
    // erratic-looking path.
    let windowStart = 0;
    renderImRrg(imRrgData, windowStart);

    imRrgAnimTimer = window.setInterval(() => {
      windowStart += 1;
      if (windowStart > lastWindowStart) {
        window.clearInterval(imRrgAnimTimer);
        imRrgAnimTimer = null;
        if (runBtn) runBtn.disabled = false;
        return;
      }
      updateImRrgFrame(imRrgData, windowStart);
    }, 500);
  }

  document.querySelectorAll(".im-rrg-timeframe-btn").forEach((button) => {
    button.addEventListener("click", () => {
      imRrgTimeframe = button.dataset.rrgTimeframe;
      document.querySelectorAll(".im-rrg-timeframe-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      fetchImRrg();
    });
  });

  const imRrgRunBtn = document.getElementById("im-rrg-run-btn");
  if (imRrgRunBtn) imRrgRunBtn.addEventListener("click", runImRrgAnimation);

  const imRrgZoomInBtn = document.getElementById("im-rrg-zoom-in-btn");
  const imRrgZoomOutBtn = document.getElementById("im-rrg-zoom-out-btn");
  const imRrgZoomResetBtn = document.getElementById("im-rrg-zoom-reset-btn");
  if (imRrgZoomInBtn) imRrgZoomInBtn.addEventListener("click", () => imRrgChart?.zoom(1.25));
  if (imRrgZoomOutBtn) imRrgZoomOutBtn.addEventListener("click", () => imRrgChart?.zoom(0.8));
  if (imRrgZoomResetBtn) imRrgZoomResetBtn.addEventListener("click", () => imRrgChart?.resetZoom());

  let watchlistTimer = null;

  function startWatchlistPolling() {
    if (watchlistTimer) return;
    fetchWatchlist();
    watchlistTimer = window.setInterval(fetchWatchlist, 20000);
  }

  function stopWatchlistPolling() {
    if (watchlistTimer) {
      window.clearInterval(watchlistTimer);
      watchlistTimer = null;
    }
  }

  let selectedChartMarket = "nifty";
  let imLiveChart = null;
  let imLiveSeries = null;
  let selectedChartTimeframe = "5m";

  function getDemoMarketProfile(marketKey) {
    if (marketKey === "banknifty") {
      return {
        name: "Bank Nifty",
        price: 55112.4,
        support: 54920,
        resistance: 55250,
        decision: "BUY SETUP",
        entry: "55,112.40 - 55,149.60",
        stop: "54,833.20",
        target1: "55,391.60",
        target2: "55,670.80",
        exit: "Exit if stop-loss is hit, price loses VWAP and EMA 21, or an opposite confirmed signal appears."
      };
    }

    return {
      name: "NIFTY 50",
      price: 24680.55,
      support: 24580,
      resistance: 24760,
      decision: "BUY SETUP",
      entry: "24,680.55 - 24,698.25",
      stop: "24,538.70",
      target1: "24,822.40",
      target2: "24,964.25",
      exit: "Exit if stop-loss is hit, price loses VWAP and EMA 21, or an opposite confirmed signal appears."
    };
  }

  function createDemoCandles(marketKey, timeframe) {
    const candleCount = timeframe === "1d" ? 24 : 34;
    const seedBase = marketKey === "banknifty" ? 13 : 7;
    const timeMultiplier = {
      "5m": 1,
      "15m": 1.4,
      "1h": 1.9,
      "1d": 2.5
    }[timeframe] || 1;

    const candles = [];

    for (let index = 0; index < candleCount; index += 1) {
      const wave = Math.sin((index + seedBase) * 1.73) * 22;
      const trend = index * 2.1 * timeMultiplier;
      const noise = Math.cos((index + seedBase) * 2.31) * 17;
      const move = wave + trend + noise;
      const bodyHeight = Math.max(24, Math.min(105, Math.abs(move) + 26));
      const bullish = move >= 0;
      const wickTop = -Math.max(10, Math.min(48, 12 + Math.abs(noise)));
      const wickBottom = -Math.max(10, Math.min(48, 13 + Math.abs(wave) * 0.45));

      candles.push({
        bullish,
        height: bodyHeight,
        wickTop,
        wickBottom
      });
    }

    return candles;
  }

  const LIVE_CANDLE_API_BASE = "https://indian-market-ai-api.onrender.com";
  let chartRefreshTimer = null;
  let latestLiveCandleData = null;

  function formatChartTime(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return "Unknown time";
    }

    return date.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true
    });
  }

  function createImLiveChart() {
    const container = document.getElementById("im-lightweight-chart");
    if (!container || imLiveChart || !window.LightweightCharts) return;

    imLiveChart = LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 460,
      layout: {
        background: { color: "#081728" },
        textColor: "#93a9c3"
      },
      grid: {
        vertLines: { color: "rgba(29, 54, 85, 0.6)" },
        horzLines: { color: "rgba(29, 54, 85, 0.6)" }
      },
      rightPriceScale: {
        borderColor: "rgba(69, 182, 255, 0.3)"
      },
      timeScale: {
        borderColor: "rgba(69, 182, 255, 0.3)",
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal
      }
    });

    imLiveSeries = imLiveChart.addCandlestickSeries({
      upColor: "#36cf83",
      downColor: "#ff6f7d",
      borderUpColor: "#36cf83",
      borderDownColor: "#ff6f7d",
      wickUpColor: "#7be3ad",
      wickDownColor: "#ffa3ab"
    });

    new ResizeObserver(() => {
      if (!imLiveChart || !container.clientWidth) return;
      imLiveChart.applyOptions({ width: container.clientWidth });
      scheduleImDrawingReposition();
    }).observe(container);

    setupImDrawingTools();
    loadSavedImDrawings();
  }

  // ===================== Indian Market drawing tools =====================
  // Core subset (Cursor, Horizontal Line, Trend Line, Fibonacci Retracement,
  // Clear) using the same patterns as the BTC live chart: horizontal lines
  // use the native createPriceLine, trend lines use a native 2-point
  // LineSeries, and fibonacci levels are drawn as SVG lines repositioned via
  // timeToCoordinate/priceToCoordinate on every pan/zoom/resize.

  const IM_DRAWING_STORAGE_KEY = "imChartDrawingsV1";
  let imDrawingMode = "cursor";
  let imDrawingColor = "#38bdf8";
  let imUserDrawings = [];
  let imDrawingPendingPoint = null;
  let imDrawingRepositionFrame = null;

  function getImDrawingOverlaySvg() {
    return document.getElementById("im-drawing-overlay");
  }

  function setImDrawingToolHint(text) {
    const hint = document.getElementById("im-drawing-tool-hint");
    if (hint) hint.textContent = text || "";
  }

  function setImDrawingMode(mode) {
    imDrawingMode = mode;
    imDrawingPendingPoint = null;
    document.querySelectorAll(".im-drawing-tool-btn[data-im-draw-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.imDrawTool === mode);
    });
    const hints = {
      cursor: "",
      horizontal: "Click the chart to place a horizontal line.",
      trend: "Click the start point, then the end point.",
      fibonacci: "Click the swing high, then the swing low (or reverse) to draw retracement levels."
    };
    setImDrawingToolHint(hints[mode] || "");
  }

  function saveImDrawings() {
    try {
      const serializable = imUserDrawings.map(({ id, type, color, price, t1, p1, t2, p2 }) => ({ id, type, color, price, t1, p1, t2, p2 }));
      localStorage.setItem(IM_DRAWING_STORAGE_KEY, JSON.stringify(serializable));
    } catch (error) {
      console.error(error);
    }
  }

  function scheduleImDrawingReposition() {
    if (imDrawingRepositionFrame) return;
    imDrawingRepositionFrame = window.requestAnimationFrame(imDrawingRepositionLoop);
  }

  function imDrawingRepositionLoop() {
    repositionImDrawingOverlays();
    const hasOverlayDrawings = imUserDrawings.some((d) => d.type === "trend" || d.type === "fibonacci");
    imDrawingRepositionFrame = hasOverlayDrawings ? window.requestAnimationFrame(imDrawingRepositionLoop) : null;
  }

  function repositionImDrawingOverlays() {
    if (!imLiveChart || !imLiveSeries) return;
    imUserDrawings.forEach((drawing) => {
      if (drawing.type === "fibonacci") {
        const x1 = imLiveChart.timeScale().timeToCoordinate(drawing.t1);
        const x2 = imLiveChart.timeScale().timeToCoordinate(drawing.t2);
        if (x1 === null || x2 === null) return;
        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const high = Math.max(drawing.p1, drawing.p2);
        const low = Math.min(drawing.p1, drawing.p2);
        drawing.levelEls.forEach(({ line, text, level }) => {
          const price = high - (high - low) * level.ratio;
          const y = imLiveSeries.priceToCoordinate(price);
          if (y === null) return;
          line.setAttribute("x1", left);
          line.setAttribute("x2", right);
          line.setAttribute("y1", y);
          line.setAttribute("y2", y);
          text.setAttribute("x", right + 4);
          text.setAttribute("y", y + 4);
          text.textContent = `${level.label} — ${formatNumber(price)}`;
        });
      }
    });
  }

  function imAddDrawing(type, points, color, persist = true) {
    if (!imLiveChart || !imLiveSeries || !window.LightweightCharts) return null;
    const id = `im${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
    const drawing = { id, type, color, ...points };

    if (type === "horizontal") {
      const numericPrice = Number(points.price);
      if (!Number.isFinite(numericPrice) || numericPrice <= 0) return null;
      drawing.ref = imLiveSeries.createPriceLine({
        price: numericPrice,
        color,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid,
        axisLabelVisible: true,
        title: "H-Line"
      });
    } else if (type === "trend") {
      if (points.t1 === points.t2) return null;
      const series = imLiveChart.addLineSeries({
        color,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false
      });
      const ordered = points.t1 <= points.t2
        ? [{ time: points.t1, value: points.p1 }, { time: points.t2, value: points.p2 }]
        : [{ time: points.t2, value: points.p2 }, { time: points.t1, value: points.p1 }];
      series.setData(ordered);
      drawing.ref = series;
    } else if (type === "fibonacci") {
      if (points.t1 === points.t2 || points.p1 === points.p2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      drawing.levelEls = FIB_LEVELS.map((level) => {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("stroke", level.color);
        line.setAttribute("stroke-width", level.ratio === 0.5 || level.ratio === 0.618 ? "2" : "1.5");
        svg.appendChild(line);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("fill", level.color);
        text.setAttribute("font-size", "11");
        text.setAttribute("font-weight", "700");
        svg.appendChild(text);
        return { line, text, level };
      });
    }

    imUserDrawings.push(drawing);
    if (persist) saveImDrawings();
    scheduleImDrawingReposition();
    return drawing;
  }

  function clearAllImDrawings() {
    imUserDrawings.forEach((drawing) => {
      if (drawing.type === "horizontal" && drawing.ref) imLiveSeries.removePriceLine(drawing.ref);
      else if (drawing.type === "trend" && drawing.ref) imLiveChart.removeSeries(drawing.ref);
      else if (drawing.type === "fibonacci" && drawing.levelEls) {
        drawing.levelEls.forEach(({ line, text }) => { line.remove(); text.remove(); });
      }
    });
    imUserDrawings = [];
    saveImDrawings();
  }

  function loadSavedImDrawings() {
    try {
      const raw = localStorage.getItem(IM_DRAWING_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      saved.forEach((d) => imAddDrawing(d.type, d, d.color, false));
    } catch (error) {
      console.error(error);
    }
  }

  function handleImChartClick(param) {
    if (imDrawingMode === "cursor" || !param.point || !param.time || !imLiveSeries) return;
    const price = imLiveSeries.coordinateToPrice(param.point.y);
    if (price === null) return;

    if (imDrawingMode === "horizontal") {
      imAddDrawing("horizontal", { price }, imDrawingColor);
      setImDrawingMode("cursor");
      return;
    }

    if (!imDrawingPendingPoint) {
      imDrawingPendingPoint = { time: param.time, price };
      setImDrawingToolHint("Click the second point to finish.");
      return;
    }

    const points = { t1: imDrawingPendingPoint.time, p1: imDrawingPendingPoint.price, t2: param.time, p2: price };
    imAddDrawing(imDrawingMode, points, imDrawingColor);
    imDrawingPendingPoint = null;
    setImDrawingMode("cursor");
  }

  function setupImDrawingTools() {
    if (!imLiveChart) return;
    imLiveChart.subscribeClick(handleImChartClick);

    document.querySelectorAll(".im-drawing-tool-btn[data-im-draw-tool]").forEach((btn) => {
      btn.addEventListener("click", () => setImDrawingMode(btn.dataset.imDrawTool));
    });

    const colorPicker = document.getElementById("im-drawing-color-picker");
    if (colorPicker) {
      colorPicker.addEventListener("input", () => { imDrawingColor = colorPicker.value; });
    }

    const clearBtn = document.getElementById("im-clear-drawings-btn");
    if (clearBtn) clearBtn.addEventListener("click", clearAllImDrawings);
  }

  function renderLiveChartCandles(candles) {
    if (!imLiveSeries || !Array.isArray(candles) || !candles.length) {
      return;
    }

    const chartPoints = candles
      .map((candle) => ({
        time: Math.floor(new Date(candle.time).getTime() / 1000),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close)
      }))
      .filter((point) => Number.isFinite(point.time))
      .sort((a, b) => a.time - b.time);

    imLiveSeries.setData(chartPoints);
  }

  async function refreshLiveChartCandles() {
    const requestedMarket = selectedChartMarket;
    const requestedTimeframe = selectedChartTimeframe;
    const status = document.getElementById("im-chart-data-status");
    const subtitle = document.getElementById("im-chart-market-subtitle");

    if (status) {
      status.textContent = "Loading Upstox candles...";
    }

    try {
      const response = await fetch(
        `${LIVE_CANDLE_API_BASE}/api/live/candles/${requestedMarket}?timeframe=${requestedTimeframe}`
      );

      const result = await response.json();

      if (!response.ok || !result.ok || !Array.isArray(result.candles)) {
        throw new Error(result.error || "Live candle data is unavailable.");
      }

      if (
        requestedMarket !== selectedChartMarket ||
        requestedTimeframe !== selectedChartTimeframe
      ) {
        return;
      }

      latestLiveCandleData = result;
      renderLiveChartCandles(result.candles);
      const chartDecision = document.getElementById("im-chart-decision");

      if (chartDecision) {
        chartDecision.textContent = "LIVE OHLC";
      }

      const latest = result.latest || result.candles[result.candles.length - 1];
      const price = document.getElementById("im-chart-last-price");

      if (price && latest) {
        price.textContent = formatNumber(latest.close);
      }

      if (status) {
        status.textContent = "Upstox candle feed";
      }

      if (subtitle && latest) {
        subtitle.textContent = `Upstox market-data candles - Last candle: ${formatChartTime(
          latest.time
        )} - Refreshes every 60 seconds during market hours.`;
      }
    } catch (error) {
      console.error("Upstox live candle refresh failed:", error);

      if (status) {
        status.textContent = `Live error: ${error.message}`;
      }

      if (subtitle) {
        subtitle.textContent =
          "Live candle request failed. Open browser Console for the full error.";
      }
    }
  }

  function startLiveChartPolling() {
    if (chartRefreshTimer) {
      window.clearInterval(chartRefreshTimer);
    }

    refreshLiveChartCandles();

    chartRefreshTimer = window.setInterval(() => {
      refreshLiveChartCandles();
    }, 60000);
  }

  function stopLiveChartPolling() {
    if (chartRefreshTimer) {
      window.clearInterval(chartRefreshTimer);
      chartRefreshTimer = null;
    }
  }

  function renderChartCandles(marketKey, timeframe) {
    const candleContainer = document.getElementById("im-chart-candles");

    if (!candleContainer) {
      return;
    }

    const candles = createDemoCandles(marketKey, timeframe);

    candleContainer.innerHTML = candles
      .map(
        (candle) => `
          <span
            class="candle ${candle.bullish ? "candle-bullish" : "candle-bearish"}"
            style="
              height: ${candle.height}px;
              --wick-top: ${candle.wickTop}px;
              --wick-bottom: ${candle.wickBottom}px;
            "
          ></span>
        `
      )
      .join("");
  }

  function setChartLevelLabels(profile) {
    const top = document.getElementById("im-chart-scale-top");
    const mid = document.getElementById("im-chart-scale-mid");
    const bottom = document.getElementById("im-chart-scale-bottom");
    const resistanceLine = document.getElementById("im-chart-resistance-line");
    const entryLine = document.getElementById("im-chart-entry-line");
    const stopLine = document.getElementById("im-chart-stop-line");

    if (top) top.textContent = formatNumber(profile.resistance + 40);
    if (mid) mid.textContent = formatNumber(profile.price);
    if (bottom) bottom.textContent = formatNumber(profile.support - 60);

    if (resistanceLine) {
      resistanceLine.querySelector("span").textContent = `Resistance ${formatNumber(profile.resistance)}`;
    }

    if (entryLine) {
      entryLine.querySelector("span").textContent = `Entry ${profile.entry}`;
    }

    if (stopLine) {
      stopLine.querySelector("span").textContent = `Stop ${profile.stop}`;
    }
  }

  const MARKET_API_BASE = "https://indian-market-ai-api.onrender.com";

  function formatPriceRange(from, to) {
    if (from === null || from === undefined || to === null || to === undefined) {
      return "Wait for confirmation";
    }

    return `${formatNumber(from)} - ${formatNumber(to)}`;
  }

  function formatPlanValue(value) {
    if (value === null || value === undefined) {
      return "Not active";
    }

    return formatNumber(value);
  }

  function updateChartWithBackendData(data) {
    const profile = getDemoMarketProfile(selectedChartMarket);
    const decisionLabel = data.decision?.label || "WAIT";
    const tradePlan = data.trade_plan || {};
    const levels = data.levels || {};

    profile.price = data.price ?? profile.price;
    profile.support = levels.support ?? profile.support;
    profile.resistance = levels.resistance ?? profile.resistance;
    profile.decision = decisionLabel;
    profile.entry = formatPriceRange(
      tradePlan.entry_zone?.from,
      tradePlan.entry_zone?.to
    );
    profile.stop = formatPlanValue(tradePlan.stop_loss);
    profile.target1 = formatPlanValue(tradePlan.target_1);
    profile.target2 = formatPlanValue(tradePlan.target_2);
    profile.exit = tradePlan.exit_rule || profile.exit;

    const title = document.getElementById("im-chart-market-title");
    const subtitle = document.getElementById("im-chart-market-subtitle");
    const status = document.getElementById("im-chart-data-status");
    const price = document.getElementById("im-chart-last-price");
    const decision = document.getElementById("im-chart-decision");
    const entry = document.getElementById("im-chart-entry-value");
    const stop = document.getElementById("im-chart-stop-value");
    const target1 = document.getElementById("im-chart-target-1-value");
    const target2 = document.getElementById("im-chart-target-2-value");
    const exit = document.getElementById("im-chart-exit-value");
    const buyMarker = document.getElementById("im-chart-buy-marker");
    const sellMarker = document.getElementById("im-chart-sell-marker");

    if (!title) {
      return;
    }

    title.textContent = `${data.market || profile.name} - ${selectedChartTimeframe}`;

    if (!latestLiveCandleData) {
      subtitle.textContent =
        "Backend confirmation-engine data. Demo market values remain active until Upstox live data is connected.";
      status.textContent = "Backend demo feed";
      price.textContent = formatNumber(profile.price);
      decision.textContent = profile.decision;
      decision.className = `chart-decision ${decisionClass(profile.decision)}`;
    }

    if (entry) entry.textContent = profile.entry;
    if (stop) stop.textContent = profile.stop;
    if (target1) target1.textContent = profile.target1;
    if (target2) target2.textContent = profile.target2;
    if (exit) exit.textContent = profile.exit;

    if (buyMarker) buyMarker.style.display = profile.decision.includes("BUY") ? "block" : "none";
    if (sellMarker) sellMarker.style.display = profile.decision.includes("SELL") ? "block" : "none";

    setChartLevelLabels(profile);

    if (!latestLiveCandleData) {
      renderChartCandles(selectedChartMarket, selectedChartTimeframe);
    }
  }

  async function refreshChartFromBackend() {
    const requestMarket = selectedChartMarket;

    try {
      const response = await fetch(
        `${MARKET_API_BASE}/api/market/${requestMarket}`
      );

      const result = await response.json();

      if (!response.ok || !result.ok || !result.data) {
        throw new Error(result.error || "Backend market data is unavailable.");
      }

      if (requestMarket !== selectedChartMarket) {
        return;
      }

      updateChartWithBackendData(result.data);
    } catch (error) {
      const status = document.getElementById("im-chart-data-status");

      if (status) {
        status.textContent = "Demo fallback";
      }

      console.error("Chart backend sync failed:", error);
    }
  }

  function updateChartPage() {
    const profile = getDemoMarketProfile(selectedChartMarket);
    const title = document.getElementById("im-chart-market-title");
    const subtitle = document.getElementById("im-chart-market-subtitle");
    const status = document.getElementById("im-chart-data-status");
    const price = document.getElementById("im-chart-last-price");
    const decision = document.getElementById("im-chart-decision");
    const entry = document.getElementById("im-chart-entry-value");
    const stop = document.getElementById("im-chart-stop-value");
    const target1 = document.getElementById("im-chart-target-1-value");
    const target2 = document.getElementById("im-chart-target-2-value");
    const exit = document.getElementById("im-chart-exit-value");
    const buyMarker = document.getElementById("im-chart-buy-marker");
    const sellMarker = document.getElementById("im-chart-sell-marker");

    if (
      !title || !subtitle || !status || !price || !decision ||
      !entry || !stop || !target1 || !target2 || !exit || !buyMarker || !sellMarker
    ) {
      return;
    }

    title.textContent = `${profile.name} - ${selectedChartTimeframe}`;
    subtitle.textContent = "Demo chart only. Upstox live candle feed will replace this after API setup.";
    status.textContent = "Demo feed";
    price.textContent = formatNumber(profile.price);
    decision.textContent = profile.decision;
    decision.className = `chart-decision ${decisionClass(profile.decision)}`;

    entry.textContent = profile.entry;
    stop.textContent = profile.stop;
    target1.textContent = profile.target1;
    target2.textContent = profile.target2;
    exit.textContent = profile.exit;

    buyMarker.style.display = profile.decision.includes("BUY") ? "block" : "none";
    sellMarker.style.display = profile.decision.includes("SELL") ? "block" : "none";

    setChartLevelLabels(profile);

    if (!latestLiveCandleData) {
      renderChartCandles(selectedChartMarket, selectedChartTimeframe);
    }

    refreshChartFromBackend();
    startLiveChartPolling();
  }

  root.querySelectorAll("[data-chart-market]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedChartMarket = button.dataset.chartMarket;

      root.querySelectorAll("[data-chart-market]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      latestLiveCandleData = null;
      updateChartPage();
    });
  });

  root.querySelectorAll("[data-chart-timeframe]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedChartTimeframe = button.dataset.chartTimeframe;

      root.querySelectorAll("[data-chart-timeframe]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      latestLiveCandleData = null;
      updateChartPage();
    });
  });

  function renderGeminiReview(container, reviewText) {
    const lines = String(reviewText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    container.replaceChildren();

    lines.forEach((line) => {
      const headingMatch = line.match(/^#{1,6}\s*(.+)$/);
      const numberedHeadingMatch = line.match(/^(\d+)\.\s+(.+)$/);
      const bulletMatch = line.match(/^[-*]\s+(.+)$/);

      const cleanText = (value) =>
        value
          .replace(/\*\*(.*?)\*\*/g, "$1")
          .replace(/__(.*?)__/g, "$1")
          .replace(/`(.*?)`/g, "$1")
          .trim();

      let element;

      if (headingMatch) {
        element = document.createElement("strong");
        element.className = "gemini-review-heading";
        element.textContent = cleanText(headingMatch[1]);
      } else if (numberedHeadingMatch) {
        element = document.createElement("strong");
        element.className = "gemini-review-heading";
        element.textContent = `${numberedHeadingMatch[1]}. ${cleanText(
          numberedHeadingMatch[2]
        )}`;
      } else if (bulletMatch) {
        element = document.createElement("div");
        element.className = "gemini-review-bullet";
        element.textContent = `- ${cleanText(bulletMatch[1])}`;
      } else {
        element = document.createElement("p");
        element.className = "gemini-review-paragraph";
        element.textContent = cleanText(line);
      }

      container.appendChild(element);
    });
  }

  const chartAiButton = document.getElementById("im-chart-ai-button");

  if (chartAiButton) {
    chartAiButton.addEventListener("click", async () => {
      const title = document.getElementById("im-chart-ai-title");
      const text = document.getElementById("im-chart-ai-text");

      chartAiButton.disabled = true;
      chartAiButton.textContent = "Generating Gemini review...";
      if (title) title.textContent = "Gemini review in progress";
      if (text) {
        text.textContent =
          "Sending the selected index, timeframe, and technical research snapshot securely to the backend...";
      }

      try {
        const response = await fetch(
          "https://indian-market-ai-api.onrender.com/api/gemini/review",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              market: selectedChartMarket,
              timeframe: selectedChartTimeframe
            })
          }
        );

        const result = await response.json();

        if (!response.ok || !result.ok) {
          throw new Error(result.error || "Gemini review request failed.");
        }

        if (title) title.textContent = `Gemini review - ${result.market} - ${result.timeframe}`;
        if (text) renderGeminiReview(text, result.review);

        const validUntil = new Date(
          new Date(result.generated_at).getTime() + result.valid_for_seconds * 1000
        );

        chartAiButton.textContent = `Review ready - valid until ${validUntil.toLocaleTimeString(
          [],
          {
            hour: "2-digit",
            minute: "2-digit"
          }
        )}`;
      } catch (error) {
        if (title) title.textContent = "Gemini review unavailable";
        if (text) {
          text.textContent =
            error.message ||
            "Could not generate the Gemini review. Please wait a moment and try again.";
        }
        chartAiButton.textContent = "Retry Gemini AI Review";
      } finally {
        chartAiButton.disabled = false;
      }
    });
  }

  updateChartPage();

  // Expose start/stop hooks so the top-level mode toggle can pause background
  // polling when this mode isn't visible, and resume it when switched back to.
  window.IndianMarketMode = {
    start() {
      startTechnicalEnginePolling();
      if (!chartRefreshTimer) startLiveChartPolling();
    },
    stop() {
      stopTechnicalEnginePolling();
      stopLiveChartPolling();
      stopWatchlistPolling();
    }
  };

  // This module loads after the mode-toggle skeleton has already applied the
  // saved mode to the DOM, so check directly whether Indian mode is the
  // currently visible one and start polling immediately if so.
  const indianRootEl = document.getElementById("indianModeRoot");
  if (indianRootEl && !indianRootEl.hidden) {
    window.IndianMarketMode.start();
  }
})();
