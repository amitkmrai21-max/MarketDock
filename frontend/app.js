let liveCandleChart = null;
let liveCandleSeries = null;
let liveCandleRawData = [];

// Shown at the bottom of Settings, read straight from this script's own
// ?v= cache-bust so it can never drift — lets a phone confirm at a glance
// which build it actually loaded.
(function showAppBuildVersion() {
  let version = "dev";
  try {
    version = new URL(document.currentScript.src).searchParams.get("v") || "dev";
  } catch { /* ignore */ }
  const el = document.getElementById("appBuildVersion");
  if (el) el.textContent = `Version: ${version}`;
})();

// Temporary: renders the back-button debug log (written directly to
// localStorage by the backButton listener below, independent of this
// IIFE) whenever Settings is opened or "Refresh log" is tapped — reads
// localStorage directly rather than depending on IndianMarketModule so
// it can't silently no-op due to load-order.
(function setupImBackDebugLogViewer() {
  const output = document.getElementById("imBackDebugLogOutput");
  const refreshBtn = document.getElementById("imBackDebugLogRefreshBtn");
  if (!output) return;

  function renderLog() {
    let log = [];
    try {
      log = JSON.parse(localStorage.getItem("imBackButtonDebugLog") || "[]");
    } catch { /* ignore */ }
    output.textContent = log.length ? log.join("\n") : "(empty — press the phone's back button a few times, then tap Refresh)";
  }

  renderLog();
  refreshBtn?.addEventListener("click", renderLog);
  document.querySelectorAll(".settings-menu-button").forEach((btn) => btn.addEventListener("click", renderLog));
})();

// ===================== Chart theming =====================
// LightweightCharts renders to canvas, so its colors can't follow CSS
// variables — they have to be passed as JS options at creation time, and
// re-applied if the theme changes afterward. Every createChart() call
// reads colors from here and registers itself so setupModeToggle's/the
// settings drawer's theme switch can recolor any chart already on screen.
const __themedCharts = [];

function getChartThemeColors() {
  const theme = document.body.dataset.theme || "dark";
  if (theme === "light") {
    return {
      bg: "#ffffff",
      text: "#4b5875",
      grid: "rgba(219, 226, 238, 0.7)",
      border: "rgba(124, 58, 237, 0.3)"
    };
  }
  if (theme === "midnight") {
    return {
      bg: "#0d1330",
      text: "#b9c3ea",
      grid: "rgba(32, 41, 80, 0.7)",
      border: "rgba(99, 102, 241, 0.34)"
    };
  }
  return {
    bg: "#0c0a14",
    text: "#c4b5fd",
    grid: "rgba(38, 33, 56, 0.72)",
    border: "rgba(139, 92, 246, 0.34)"
  };
}

function registerThemedChart(chart) {
  __themedCharts.push(chart);
  return chart;
}

function applyChartTheme() {
  const colors = getChartThemeColors();
  __themedCharts.forEach((chart) => {
    try {
      chart.applyOptions({
        layout: { background: { color: colors.bg }, textColor: colors.text },
        grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.border },
        timeScale: { borderColor: colors.border }
      });
    } catch (error) { /* chart may have been removed */ }
  });
}
window.applyChartTheme = applyChartTheme;

// ===================== Shared AI-error toast =====================
// One small dismissible notification, used by every Gemini/Groq-backed
// feature on either mode, so a busy/quota/auth failure is always surfaced
// the same clear way instead of leaving people staring at a stuck
// "Analysing..." state with no idea why. Global (not inside either mode's
// IIFE) since both BTC and Indian Market code call it.
let aiErrorToastHideTimer = null;

// A bare "Failed to fetch" (or similar) is the raw browser TypeError for a
// request that never got a response at all — most often the free-tier
// backend waking up from sleep or a slow request timing out at a proxy
// before Render replies. That raw text means nothing to most people, so
// swap it for a plain-language explanation everywhere it would show.
function friendlyAiErrorMessage(message) {
  const text = String(message || "");
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(text)) {
    return "Could not reach the server — it may be waking up from sleep (free-tier services pause after inactivity) or the request timed out. Please try again in a moment.";
  }
  return text || "AI analysis is temporarily unavailable. Please try again later.";
}

function showAiErrorToast(message) {
  const toast = document.getElementById("aiErrorToast");
  const textEl = document.getElementById("aiErrorToastText");
  if (!toast || !textEl) return;

  textEl.textContent = friendlyAiErrorMessage(message);
  toast.classList.add("ai-error-toast-visible");

  if (aiErrorToastHideTimer) window.clearTimeout(aiErrorToastHideTimer);
  aiErrorToastHideTimer = window.setTimeout(hideAiErrorToast, 10000);
}

function hideAiErrorToast() {
  const toast = document.getElementById("aiErrorToast");
  if (toast) toast.classList.remove("ai-error-toast-visible");
  if (aiErrorToastHideTimer) {
    window.clearTimeout(aiErrorToastHideTimer);
    aiErrorToastHideTimer = null;
  }
}

(() => {
  // app.js loads at the very end of <body>, so the toast element already
  // exists in the DOM by this point — no need to wait for DOMContentLoaded.
  const toast = document.getElementById("aiErrorToast");
  if (!toast) return;
  const closeBtn = toast.querySelector(".ai-error-toast-close");
  toast.addEventListener("click", hideAiErrorToast);
  if (closeBtn) {
    closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      hideAiErrorToast();
    });
  }
})();

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
    document.getElementById("topSettingsMenuButton")?.click();
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
let currentBtcChangePercent = null;
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

// Solid colored "pill" badge for a % change value — used everywhere a price
// change is shown, in both BTC and Indian Market mode, instead of plain
// colored text.
function changePillHtml(value, { arrow = true, decimals = 2 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return `<span class="change-pill change-pill-neutral">--</span>`;
  const isUp = number >= 0;
  const glyph = arrow ? (isUp ? "▲ " : "▼ ") : "";
  return `<span class="change-pill ${isUp ? "change-pill-up" : "change-pill-down"}">${glyph}${isUp ? "+" : ""}${number.toFixed(decimals)}%</span>`;
}

// Small trend-line "sparkline" drawn behind a price card, in place of a flat
// number — same visual pattern for both BTC and Indian Market price cards.
// Drawn with the raw Canvas 2D API rather than Chart.js: it's a simple
// polyline + fill with no interactivity, and not depending on Chart.js
// having finished loading from its CDN keeps this working even if that
// script is slow, blocked, or fails on a given network.
// A raw 15m-candle close series is mostly short-term noise for a single
// liquid large-cap/index — plotted un-smoothed and stretched to fill the
// card's full height, that noise reads as a meaningless zigzag instead of
// a trend, so bullish and bearish cards end up looking about the same. A
// short moving average keeps the real shape (still real data, not
// fabricated) while making the actual direction the dominant visual signal.
function smoothSeries(points, windowSize = 4) {
  if (points.length <= windowSize) return points;
  const smoothed = [];
  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = points.slice(start, i + 1);
    smoothed.push(slice.reduce((sum, value) => sum + value, 0) / slice.length);
  }
  return smoothed;
}

function renderSparkline(canvasId, values, forceIsUp) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const raw = Array.isArray(values) ? values.filter((value) => Number.isFinite(value)) : [];
  if (raw.length < 2) return;
  const points = smoothSeries(raw);

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Color by the day's actual change (same sign as the % pill next to it)
  // when known, rather than this window's own first-vs-last point — the
  // sparkline can legitimately drift down through the day (e.g. a gap-up
  // open that fades) while still finishing green versus yesterday's close,
  // and a chart that disagrees with the pill beside it reads as broken.
  const isUp = typeof forceIsUp === "boolean" ? forceIsUp : points[points.length - 1] >= points[0];
  const lineColor = isUp ? "#34d399" : "#f87171";
  const fillColor = isUp ? "rgba(52, 211, 153, 0.25)" : "rgba(248, 113, 113, 0.25)";

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const topPad = 4;
  const toY = (value) => topPad + (1 - (value - min) / range) * (height - topPad * 2);

  const coords = points.map((value, index) => ({ x: index * stepX, y: toY(value) }));

  ctx.beginPath();
  ctx.moveTo(coords[0].x, coords[0].y);
  for (let i = 1; i < coords.length - 1; i++) {
    const midX = (coords[i].x + coords[i + 1].x) / 2;
    const midY = (coords[i].y + coords[i + 1].y) / 2;
    ctx.quadraticCurveTo(coords[i].x, coords[i].y, midX, midY);
  }
  const last = coords[coords.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

function getSignalColor(signal) {
  if (signal === "BUY") return "#34d399";
  if (signal === "SELL") return "#f87171";
  return "#fbbf24";
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
function renderPaperTrading() { const p = loadPaperPortfolio(), mark = Number(currentBtcPriceInr) || 0, value = p.cashInr + p.btcHolding * mark - p.shortBtcHolding * mark, pnl = value - DEFAULT_PAPER_CASH, pct = (pnl / DEFAULT_PAPER_CASH) * 100; const longAvg = p.btcHolding > PAPER_EPSILON ? p.totalCostInr / p.btcHolding : 0, shortAvg = p.shortBtcHolding > PAPER_EPSILON ? p.shortProceedsInr / p.shortBtcHolding : 0; const position = p.btcHolding > PAPER_EPSILON ? "LONG BTC" : p.shortBtcHolding > PAPER_EPSILON ? "SHORT BTC" : "No open position"; setText("paperCash", formatInr(p.cashInr)); setText("paperBtcHolding", formatBtc(p.btcHolding)); setText("paperShortBtcHolding", formatBtc(p.shortBtcHolding)); setText("paperPositionType", position); setText("paperAvgPrice", p.btcHolding > PAPER_EPSILON ? formatInr(longAvg) : "No long position"); setText("paperShortAvgPrice", p.shortBtcHolding > PAPER_EPSILON ? formatInr(shortAvg) : "No short position"); setText("paperPortfolioValue", formatInr(value)); const pos = getElement("paperPositionType"), pnlElement = getElement("paperPnl"); if (pos) pos.style.color = position === "LONG BTC" ? "#34d399" : position === "SHORT BTC" ? "#f87171" : "#cbd5e1"; if (pnlElement) { const prefix = pnl >= 0 ? "+" : ""; pnlElement.textContent = `${prefix}${formatInr(pnl)} (${prefix}${pct.toFixed(2)}%)`; pnlElement.style.color = pnl >= 0 ? "#34d399" : "#f87171"; } renderPaperHistory(p.history); }

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

const SOUND_ALERT_STORAGE_KEY = "marketDockSoundAlertsEnabled";

function isSoundAlertsEnabled() {
  try {
    return localStorage.getItem(SOUND_ALERT_STORAGE_KEY) === "1";
  } catch (error) {
    return false;
  }
}

function setSoundAlertsEnabled(enabled) {
  try {
    localStorage.setItem(SOUND_ALERT_STORAGE_KEY, enabled ? "1" : "0");
  } catch (error) {
    // Ignore — the toggle just won't persist across reloads.
  }
}

function playAlertBeep() {
  if (!isSoundAlertsEnabled()) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.4);
    oscillator.onended = () => ctx.close();
  } catch (error) {
    console.error("Alert sound could not be played:", error);
  }
}

function sendBrowserAlert(title, body, options = {}) {
  const runtime = getAlertRuntime();
  const message = `${title}: ${body}`;
  playAlertBeep();

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
        "BTC Market Test Alert",
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
function updatePrice(data) { const btc = data?.bitcoin, price = Number(btc?.usd), change = Number(btc?.usd_24h_change || 0); if (!Number.isFinite(price)) throw new Error("Live BTC price was not received."); currentBtcPriceUsd = price; currentBtcPriceInr = price * USD_INR_RATE; currentBtcChangePercent = change; setText("btcPrice", formatUsd(price)); const changeBox = getElement("btcChange"); if (changeBox) { changeBox.innerHTML = changePillHtml(change); } setText("marketUpdatedAt", `Live price updated: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`);  renderPaperTrading(); checkPriceAlerts(price); }
  

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

async function loadBtcSparkline() {
  // The canvas has zero size while #btcModeRoot is hidden, which would size
  // Chart.js's render buffer wrong — skip until this mode is actually shown.
  if (document.getElementById("btcModeRoot")?.hidden) return;
  try {
    const response = await fetch(`/api/btc/chart?days=1&interval=15m`, { cache: "no-store" });
    if (!response.ok) return;
    const chart = await response.json();
    const prices = Array.isArray(chart.prices) ? chart.prices.slice(-96).map((p) => p[1]) : [];
    const forceIsUp = Number.isFinite(currentBtcChangePercent) ? currentBtcChangePercent >= 0 : undefined;
    renderSparkline("btcPriceSparkline", prices, forceIsUp);
  } catch (error) {
    console.error("BTC sparkline failed:", error);
  }
}
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
    showAiErrorToast(error.message);

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
    setText("geminiReason", friendlyAiErrorMessage(error.message));
    setText("geminiUpdatedAt", "Gemini refresh failed. Please try again.");
    return false;
  } finally {
    aiRefreshInProgress = false;
  }
}
async function refreshFastData() { try { await Promise.all([loadPrice(true), loadChart()]); } catch (error) { console.error(error); setText("marketUpdatedAt", "Live price/chart could not be updated. Please try again."); } }
async function refreshTechnicalAnalysis(prefix = "Live technical analysis refreshed.") { return loadTechnicalFallback(prefix, true); }
async function refreshAllData() { if (technicalRefreshInProgress) return; try { await Promise.all([refreshFastData(), refreshTechnicalAnalysis("Live technical analysis refreshed.")]); } catch (error) { console.error("Technical refresh error:", error); } loadRrg().catch((error) => console.error("RRG refresh error:", error)); }

function renderChart(labels, data, label) { const canvas = getElement("btcChart"); if (!canvas) return; if (btcChart) btcChart.destroy(); btcChart = new Chart(canvas.getContext("2d"), { type: "line", data: { labels, datasets: [{ label: `BTC/USD • ${label}`, data, borderColor: "#34d399", backgroundColor: "rgba(34, 197, 94, 0.15)", borderWidth: 2, fill: true, tension: 0.28, pointRadius: 0, pointHoverRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: true, interaction: { intersect: false, mode: "index" }, plugins: { legend: { labels: { color: "#ffffff" } }, tooltip: { callbacks: { label(context) { return `BTC: ${formatUsd(context.raw)}`; } } }, zoom: { limits: { x: { min: "original", max: "original", minRange: 2 } }, pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true, speed: 0.25 }, pinch: { enabled: true }, drag: { enabled: true, threshold: 2, backgroundColor: "rgba(59, 130, 246, 0.18)", borderColor: "#60a5fa", borderWidth: 1 }, mode: "x" } } }, scales: { x: { ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#1e293b" } }, y: { ticks: { color: "#cbd5e1", callback(value) { return formatUsd(value); } }, grid: { color: "#1e293b" } } } } }); }
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
function setupChartAnalyser(){const input=getElement("chartImageInput"),preview=getElement("chartImagePreview"),button=getElement("analyseChartBtn"),status=getElement("chartAnalyseStatus"),box=getElement("chartAnalysisResult");if(!input||!preview||!button||!status||!box)return;input.addEventListener("change",()=>{const file=input.files[0];box.hidden=true;if(!file){preview.hidden=true;preview.removeAttribute("src");status.textContent="Upload PNG, JPG, or WEBP chart image. Maximum 8 MB.";return;}if(!["image/png","image/jpeg","image/webp"].includes(file.type)||file.size>8*1024*1024){input.value="";preview.hidden=true;preview.removeAttribute("src");status.textContent="Select PNG, JPG, or WEBP only; maximum size is 8 MB.";return;}preview.src=URL.createObjectURL(file);preview.hidden=false;status.textContent=`Selected: ${file.name}. Click Analyse with Gemini AI.`;});button.addEventListener("click",async()=>{const file=input.files[0];if(!file){status.textContent="Please upload a chart image first.";return;}const form=new FormData();form.append("file",file);button.disabled=true;button.textContent="Analysing Chart...";status.textContent="Gemini is reading the uploaded chart screenshot...";box.hidden=true;try{const response=await fetch("/api/chart-analyser",{method:"POST",body:form}),data=await response.json();if(!response.ok)throw new Error(data.detail||"Chart analysis failed.");const signal=["BUY","SELL","HOLD"].includes(data.signal)?data.signal:"HOLD",element=getElement("uploadedChartSignal"),color=getSignalColor(signal);if(element){element.textContent=signal;element.style.color=color;element.style.borderColor=color;}setUploadedChartText("uploadedChartConfidence",`Confidence: ${Number(data.confidence||0)}%`);setUploadedChartText("uploadedChartRisk",data.risk);setUploadedChartText("uploadedChartTrend",data.trend);setUploadedChartText("uploadedChartPattern",data.pattern);setUploadedChartText("uploadedChartSupport",data.support);setUploadedChartText("uploadedChartResistance",data.resistance);setUploadedChartText("uploadedChartReason",data.reason);setUploadedChartText("uploadedChartEntry",data.entry_idea);setUploadedChartText("uploadedChartInvalidation",data.invalidation_idea);setUploadedChartText("uploadedChartWarning",data.warning);box.hidden=false;status.textContent="Chart analysis complete. Educational use only.";}catch(error){console.error(error);status.textContent=`Chart analysis error: ${friendlyAiErrorMessage(error.message)}`;showAiErrorToast(error.message);}finally{button.disabled=false;button.textContent="Analyse with Gemini AI";}});}
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
setInterval(loadBtcSparkline, 60000);

setInterval(() => {
  if (typeof window.isAiPlanLocked === "function" && window.isAiPlanLocked()) return;
  refreshTechnicalAnalysis("Automatic technical refresh.");
}, 10000);

setInterval(loadRrg, 300000);
/* ===== Dashboard tabs and settings ===== */
(() => {
  const STORAGE_KEY = "btcAiSignalDashboardPreferences";
  const ACTIVE_TAB_SESSION_KEY = "btcAiSignalActiveTabSession";

  function initDashboard() {
    const tabs = [...document.querySelectorAll(".app-tab[data-tab]")];
    const panels = [...document.querySelectorAll(".tab-panel[data-panel]")];

    const menuButtons = [...document.querySelectorAll(".settings-menu-button")];
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
        textSize: document.body.dataset.textSize || "normal"
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
      if (typeof applyChartTheme === "function") applyChartTheme();

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

      try {
        // sessionStorage (not the localStorage-backed settings bundle):
        // survives an in-app reload so that doesn't silently bounce the
        // user back to the dashboard, but clears once the app is fully
        // closed, so a fresh launch always starts on the dashboard.
        sessionStorage.setItem(ACTIVE_TAB_SESSION_KEY, targetTab);
      } catch (error) {
        // Ignore — private browsing / storage quota, non-critical.
      }

      if (shouldSave) {
        saveSettings();
      }
    }

    function openSettings() {
      drawer?.classList.add("open");
      menuButtons.forEach((button) => button.setAttribute("aria-expanded", "true"));
    }

    function closeSettings() {
      drawer?.classList.remove("open");
      menuButtons.forEach((button) => button.setAttribute("aria-expanded", "false"));
    }

    applySettings(settings);

    let initialTab = "dashboard";
    try {
      initialTab = sessionStorage.getItem(ACTIVE_TAB_SESSION_KEY) || "dashboard";
    } catch (error) {
      // Ignore — private browsing / storage quota, non-critical.
    }
    showTab(initialTab, false);

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        showTab(tab.dataset.tab);
      });
    });

    menuButtons.forEach((button) => button.addEventListener("click", openSettings));
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

    const STARTUP_MODE_KEY = "marketDockStartupModePref";
    const startupModeButtons = [...document.querySelectorAll("[data-startup-mode-choice]")];
    let startupModePref = "remember";
    try { startupModePref = localStorage.getItem(STARTUP_MODE_KEY) || "remember"; } catch (error) { /* ignore */ }
    updateChoiceState(startupModeButtons, startupModePref, "startupModeChoice");

    startupModeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const choice = button.dataset.startupModeChoice || "remember";
        try { localStorage.setItem(STARTUP_MODE_KEY, choice); } catch (error) { /* ignore */ }
        updateChoiceState(startupModeButtons, choice, "startupModeChoice");
        if (choice !== "remember" && typeof window.marketDockSetAppMode === "function") {
          window.marketDockSetAppMode(choice);
        }
      });
    });

    const PRIVACY_MODE_KEY = "marketDockPrivacyMode";
    const privacyModeToggle = document.querySelector("#privacyModeToggle");
    if (privacyModeToggle) {
      let privacyModeOn = false;
      try { privacyModeOn = localStorage.getItem(PRIVACY_MODE_KEY) === "1"; } catch (error) { /* ignore */ }
      privacyModeToggle.checked = privacyModeOn;
      document.body.dataset.privacyMode = privacyModeOn ? "on" : "off";

      privacyModeToggle.addEventListener("change", () => {
        document.body.dataset.privacyMode = privacyModeToggle.checked ? "on" : "off";
        try { localStorage.setItem(PRIVACY_MODE_KEY, privacyModeToggle.checked ? "1" : "0"); } catch (error) { /* ignore */ }
      });
    }

    const settingsNotifBadge = document.querySelector("#settingsNotificationBadge");
    const settingsNotifStatus = document.querySelector("#settingsNotificationStatus");
    const settingsEnableNotifBtn = document.querySelector("#settingsEnableNotificationsBtn");
    const settingsTestNotifBtn = document.querySelector("#settingsTestNotificationBtn");
    const soundAlertToggle = document.querySelector("#settingsSoundAlertToggle");

    function updateSettingsNotificationUi(message) {
      if (!settingsNotifBadge && !settingsNotifStatus && !settingsEnableNotifBtn && !settingsTestNotifBtn) return;
      const permission = typeof getNotificationPermission === "function" ? getNotificationPermission() : "unsupported";
      const labels = {
        granted: "Notifications: Enabled",
        denied: "Notifications: Blocked",
        default: "Notifications: Permission needed",
        unsupported: "Notifications: Unsupported"
      };
      if (settingsNotifBadge) {
        settingsNotifBadge.textContent = labels[permission] || labels.default;
        settingsNotifBadge.className = `notification-permission-badge settings-notification-badge notif-${permission}`;
      }
      if (settingsEnableNotifBtn) {
        settingsEnableNotifBtn.hidden = permission === "granted" || permission === "unsupported";
        settingsEnableNotifBtn.disabled = permission === "denied";
      }
      if (settingsTestNotifBtn) {
        settingsTestNotifBtn.disabled = permission !== "granted";
      }
      if (settingsNotifStatus) {
        if (message) {
          settingsNotifStatus.textContent = message;
        } else if (permission === "granted") {
          settingsNotifStatus.textContent = "Browser alerts are enabled while this dashboard is open.";
        } else if (permission === "denied") {
          settingsNotifStatus.textContent = "Notifications are blocked in browser settings. Allow notifications for this site, then reload.";
        } else if (permission === "unsupported") {
          settingsNotifStatus.textContent = "This browser does not support desktop/browser notifications.";
        } else {
          settingsNotifStatus.textContent = "Enable browser alerts to receive price and signal notifications.";
        }
      }
    }

    settingsEnableNotifBtn?.addEventListener("click", async () => {
      if (typeof requestBrowserNotifications === "function") {
        await requestBrowserNotifications();
      }
      updateSettingsNotificationUi();
    });

    settingsTestNotifBtn?.addEventListener("click", () => {
      if (typeof sendBrowserAlert === "function") {
        sendBrowserAlert(
          "MarketDock Test Alert",
          "Browser alerts are working. This is a test notification.",
          { tag: "marketdock-settings-test" }
        );
      }
      updateSettingsNotificationUi();
    });

    if (soundAlertToggle) {
      soundAlertToggle.checked = typeof isSoundAlertsEnabled === "function" && isSoundAlertsEnabled();
      soundAlertToggle.addEventListener("change", () => {
        if (typeof setSoundAlertsEnabled === "function") setSoundAlertsEnabled(soundAlertToggle.checked);
      });
    }

    updateSettingsNotificationUi();

    const clearDataButton = document.querySelector("#clearMyDataBtn");
    const CLEAR_DATA_KEYS = [
      "btcChartDrawingsV1",
      "btcAiSignalPaperPortfolioV2",
      "btcAiSignalPaperPortfolioV1",
      "btcAiSignalLatestNewsV1",
      "btcAiSignalNewsTranslationsV1",
      "btcAiSignalAlertSettingsV1",
      "btcAiSignalAlertRuntimeV1",
      "btcAiSignalLastSignalV1",
      "btcAiSignalCustomLayoutV1",
      "btcAiSignalPlanLockV1",
      "imWatchlistsV2",
      "imAlertSettingsV1",
      "imAlertRuntimeV1",
      "imPriceAlertsV1",
      "imConditionAlertsV1",
      "imChartDrawingsV1",
      "imBacktestResultsV1",
      "indianMarketPaperTrades"
    ];

    clearDataButton?.addEventListener("click", () => {
      const confirmed = window.confirm(
        "This clears your paper trades, watchlists, chart drawings, alerts and backtest history on this device. Your account login and appearance preferences are not affected. Continue?"
      );
      if (!confirmed) return;
      CLEAR_DATA_KEYS.forEach((key) => {
        try { localStorage.removeItem(key); } catch (error) { /* ignore */ }
      });
      window.location.reload();
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

/* ===== Account (Supabase) — one login shared by both Indian Market and
   BTC mode, since they're the same page/session. ===== */
(() => {
  const SUPABASE_URL = "https://qvgfxtjwgrtytjdjcebj.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_DRsCPkKaKRYPrQDFtqV0xQ_7QeP4kYh";

  if (typeof window.supabase === "undefined") {
    console.error("Supabase client library did not load — account features are unavailable.");
    return;
  }

  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  window.marketDockSupabase = supabaseClient;

  function initAccount() {
    const loggedOutGroup = document.getElementById("accountLoggedOutGroup");
    const loggedInGroup = document.getElementById("accountLoggedInGroup");
    const emailInput = document.getElementById("accountEmailInput");
    const passwordInput = document.getElementById("accountPasswordInput");
    const loginBtn = document.getElementById("accountLoginBtn");
    const signupBtn = document.getElementById("accountSignupBtn");
    const logoutBtn = document.getElementById("accountLogoutBtn");
    const statusEl = document.getElementById("accountAuthStatus");
    const emailDisplay = document.getElementById("accountEmailDisplay");
    const avatarEl = document.getElementById("accountAvatar");
    const passwordToggleBtn = document.getElementById("accountPasswordToggle");
    const newPasswordInput = document.getElementById("accountNewPasswordInput");
    const newPasswordToggleBtn = document.getElementById("accountNewPasswordToggle");
    const changePasswordBtn = document.getElementById("accountChangePasswordBtn");
    const changePasswordStatusEl = document.getElementById("accountChangePasswordStatus");
    const deleteBtn = document.getElementById("accountDeleteBtn");
    const deleteStatusEl = document.getElementById("accountDeleteStatus");
    if (!loggedOutGroup || !loggedInGroup || !emailInput || !passwordInput || !loginBtn || !signupBtn || !logoutBtn) return;

    const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

    function wirePasswordToggle(input, button) {
      if (!input || !button) return;
      button.addEventListener("click", () => {
        const showing = input.type === "text";
        input.type = showing ? "password" : "text";
        button.innerHTML = showing ? EYE_ICON : EYE_OFF_ICON;
        button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
        button.setAttribute("aria-pressed", showing ? "false" : "true");
      });
    }

    wirePasswordToggle(passwordInput, passwordToggleBtn);
    wirePasswordToggle(newPasswordInput, newPasswordToggleBtn);

    function setStatus(message, isError) {
      if (!statusEl) return;
      statusEl.textContent = message || "";
      statusEl.style.color = isError ? "#ef4444" : "";
    }

    function friendlyAuthError(error) {
      const message = String(error?.message || "");
      if (/already registered|already exists/i.test(message)) return "That email already has an account — try logging in instead.";
      if (/invalid login credentials/i.test(message)) return "Wrong email or password.";
      if (/password.*at least|password.*characters/i.test(message)) return "Password must be at least 6 characters.";
      if (/email.*invalid/i.test(message)) return "That doesn't look like a valid email.";
      if (/failed to fetch|network/i.test(message)) return "Could not reach the account server. Check your connection and try again.";
      return message || "Something went wrong. Please try again.";
    }

    function showLoggedIn(session) {
      loggedOutGroup.hidden = true;
      loggedInGroup.hidden = false;
      const email = session?.user?.email || "--";
      if (emailDisplay) emailDisplay.textContent = email;
      if (avatarEl) avatarEl.textContent = email.charAt(0) || "?";
    }

    function showLoggedOut() {
      loggedOutGroup.hidden = false;
      loggedInGroup.hidden = true;
      setStatus("", false);
    }

    async function setButtonsBusy(busy) {
      loginBtn.disabled = busy;
      signupBtn.disabled = busy;
    }

    loginBtn.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) {
        setStatus("Enter your email and password.", true);
        return;
      }
      setStatus("Logging in...", false);
      await setButtonsBusy(true);
      try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        passwordInput.value = "";
        setStatus("", false);
      } catch (error) {
        setStatus(friendlyAuthError(error), true);
      } finally {
        await setButtonsBusy(false);
      }
    });

    signupBtn.addEventListener("click", async () => {
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) {
        setStatus("Enter your email and password.", true);
        return;
      }
      if (password.length < 6) {
        setStatus("Password must be at least 6 characters.", true);
        return;
      }
      setStatus("Creating your account...", false);
      await setButtonsBusy(true);
      try {
        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        passwordInput.value = "";
        if (data?.session) {
          setStatus("", false);
        } else {
          setStatus("Account created — check your email to confirm it, then log in.", false);
        }
      } catch (error) {
        setStatus(friendlyAuthError(error), true);
      } finally {
        await setButtonsBusy(false);
      }
    });

    logoutBtn.addEventListener("click", async () => {
      logoutBtn.disabled = true;
      try {
        await supabaseClient.auth.signOut();
      } catch (error) {
        console.error("Sign out failed:", error);
      } finally {
        logoutBtn.disabled = false;
      }
    });

    function setChangePasswordStatus(message, isError) {
      if (!changePasswordStatusEl) return;
      changePasswordStatusEl.textContent = message || "";
      changePasswordStatusEl.style.color = isError ? "#ef4444" : "";
    }

    changePasswordBtn?.addEventListener("click", async () => {
      const newPassword = newPasswordInput?.value || "";
      if (newPassword.length < 6) {
        setChangePasswordStatus("New password must be at least 6 characters.", true);
        return;
      }
      changePasswordBtn.disabled = true;
      setChangePasswordStatus("Updating password...", false);
      try {
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        if (error) throw error;
        if (newPasswordInput) newPasswordInput.value = "";
        setChangePasswordStatus("Password updated.", false);
      } catch (error) {
        setChangePasswordStatus(friendlyAuthError(error), true);
      } finally {
        changePasswordBtn.disabled = false;
      }
    });

    function setDeleteStatus(message, isError) {
      if (!deleteStatusEl) return;
      deleteStatusEl.textContent = message || "";
      deleteStatusEl.style.color = isError ? "#ef4444" : "";
    }

    deleteBtn?.addEventListener("click", async () => {
      const confirmed = window.confirm(
        "Delete your MarketDock account? This permanently removes your login and can't be undone."
      );
      if (!confirmed) return;

      deleteBtn.disabled = true;
      setDeleteStatus("Deleting account...", false);
      try {
        const { data: sessionData } = await supabaseClient.auth.getSession();
        const accessToken = sessionData?.session?.access_token;
        if (!accessToken) throw new Error("No active session.");

        const response = await fetch("/api/account/delete", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.detail || "Account deletion failed.");
        }
        await supabaseClient.auth.signOut();
      } catch (error) {
        setDeleteStatus(error.message || "Account deletion failed. Please try again.", true);
        deleteBtn.disabled = false;
      }
    });

    supabaseClient.auth.onAuthStateChange((_event, session) => {
      if (session) showLoggedIn(session);
      else showLoggedOut();
    });

    supabaseClient.auth.getSession().then(({ data }) => {
      if (data?.session) showLoggedIn(data.session);
      else showLoggedOut();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAccount);
  } else {
    initAccount();
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
    circle.setAttribute("fill", "#0c0a14");
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
    riskRect.setAttribute("fill", "#f8717133");
    riskRect.setAttribute("stroke", "#f87171");
    riskRect.setAttribute("stroke-width", "1");
    svg.appendChild(riskRect);
    drawing.riskRectEl = riskRect;

    const rewardRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rewardRect.setAttribute("fill", "#34d39933");
    rewardRect.setAttribute("stroke", "#34d399");
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

  const btcChartColors = getChartThemeColors();
  liveCandleChart = registerThemedChart(LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 520,
    layout: {
      background: { color: btcChartColors.bg },
      textColor: btcChartColors.text
    },
    grid: {
      vertLines: { color: btcChartColors.grid },
      horzLines: { color: btcChartColors.grid }
    },
    rightPriceScale: {
      borderColor: btcChartColors.border
    },
    timeScale: {
      borderColor: btcChartColors.border,
      timeVisible: true,
      secondsVisible: false
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    }
  }));

 liveCandleSeries = liveCandleChart.addCandlestickSeries({
  upColor: "#34d399",
  downColor: "#f87171",
  borderUpColor: "#34d399",
  borderDownColor: "#f87171",
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
    const entryColor = direction === "BUY" ? "#34d399" : "#f87171";

    addForwardStatusLine(
      Number(data.entry_price),
      `${name} • ${direction} — SETUP ACTIVE | ENTRY`,
      entryColor
    );

    addForwardStatusLine(
      Number(data.stop_loss_price),
      `${name} • STOP LOSS`,
      "#f87171"
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
  const brandSubtitle = document.getElementById("brandSubtitle");
  const statusBadge = document.getElementById("topMarketStatus");
  const statusText = document.getElementById("topMarketStatusText");
  if (!btcRoot || !indianRoot || !slider) return;

  function setMode(mode) {
    const isIndian = mode === "indian";
    btcRoot.hidden = isIndian;
    indianRoot.hidden = !isIndian;
    slider.dataset.mode = mode;
    // Indian mode has its own live-status pill built into the scrolling
    // ticker bar, so the header's separate badge (still used by BTC mode,
    // which has no ticker bar) would be a redundant second "Live" here.
    document.body.classList.toggle("mode-indian-live-status", isIndian);
    if (brandSubtitle) {
      brandSubtitle.textContent = isIndian
        ? "NIFTY 50 and Bank Nifty research dashboard with paper-trading workflow"
        : "Live market analysis and Gemini/Groq AI signals";
    }
    if (statusBadge && statusText && !isIndian) {
      statusBadge.classList.remove("status-closed");
      statusBadge.classList.add("status-live");
      statusText.textContent = "Live";
    }
    try { localStorage.setItem("btcAiSignalActiveMode", mode); } catch (error) { /* ignore */ }
    if (window.IndianMarketMode) {
      if (isIndian) window.IndianMarketMode.start();
      else window.IndianMarketMode.stop();
    }
    // Both modes' price sparkline canvases have zero size while their root
    // is hidden, so Chart.js can't size them correctly if drawn before that
    // mode is ever shown — (re)draw whichever one just became visible.
    if (isIndian && typeof window.loadImDashboardSparklines === "function") window.loadImDashboardSparklines();
    if (isIndian && typeof window.redrawMoverSparklines === "function") window.redrawMoverSparklines();
    if (!isIndian && typeof loadBtcSparkline === "function") loadBtcSparkline();
  }

  slider.addEventListener("click", () => {
    setMode(slider.dataset.mode === "indian" ? "btc" : "indian");
  });

  window.marketDockSetAppMode = setMode;

  let savedMode = "indian";
  try { savedMode = localStorage.getItem("btcAiSignalActiveMode") || "indian"; } catch (error) { /* ignore */ }

  let startupPref = "remember";
  try { startupPref = localStorage.getItem("marketDockStartupModePref") || "remember"; } catch (error) { /* ignore */ }

  const initialMode = startupPref === "indian" || startupPref === "btc" ? startupPref : savedMode;
  setMode(initialMode);
})();

(function setupPullToRefresh() {
  const indicator = document.getElementById("ptrIndicator");
  if (!indicator || !("ontouchstart" in window)) return;

  const THRESHOLD = 64;
  const MAX_PULL = 96;
  let startY = 0;
  let pulling = false;
  let currentPull = 0;

  function setPull(distance) {
    currentPull = distance;
    const progress = Math.min(distance / THRESHOLD, 1);
    indicator.style.transform = `translate(-50%, ${distance - 60}px) rotate(${progress * 360}deg)`;
    indicator.style.opacity = String(progress);
    indicator.classList.toggle("ptr-visible", distance > 4);
  }

  function reset() {
    pulling = false;
    currentPull = 0;
    indicator.style.transition = "transform 0.25s ease, opacity 0.25s ease";
    indicator.style.transform = "translate(-50%, -60px) rotate(0deg)";
    indicator.style.opacity = "0";
    indicator.classList.remove("ptr-visible", "ptr-spinning");
    window.setTimeout(() => { indicator.style.transition = ""; }, 260);
  }

  document.addEventListener("touchstart", (event) => {
    if (window.scrollY > 0 || event.touches.length !== 1) return;
    startY = event.touches[0].clientY;
    pulling = true;
    indicator.style.transition = "";
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (!pulling) return;
    const deltaY = event.touches[0].clientY - startY;
    if (deltaY <= 0) { setPull(0); return; }
    if (window.scrollY > 0) { pulling = false; setPull(0); return; }
    setPull(Math.min(deltaY * 0.45, MAX_PULL));
    if (deltaY > 10) event.preventDefault();
  }, { passive: false });

  document.addEventListener("touchend", () => {
    if (!pulling) return;
    pulling = false;
    if (currentPull >= THRESHOLD) {
      indicator.classList.add("ptr-spinning", "ptr-visible");
      indicator.style.transition = "transform 0.2s ease";
      indicator.style.transform = "translate(-50%, 16px) rotate(0deg)";
      indicator.style.opacity = "1";
      window.setTimeout(() => window.location.reload(), 350);
    } else {
      reset();
    }
  }, { passive: true });

  document.addEventListener("touchcancel", reset, { passive: true });
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
    "im-finnifty": {
      title: "Nifty Financial Services Research",
      subtitle: "Financial-sector research and disciplined paper-trading preparation."
    },
    "im-sensex": {
      title: "SENSEX Research",
      subtitle: "BSE's flagship-index research and paper-trading preparation."
    },
    "im-watchlist": {
      title: "Watchlist",
      subtitle: "Live last-traded price for popular NSE stocks."
    },
    "im-scanner": {
      title: "Market Scanner",
      subtitle: "Scan NSE stocks for today's top gainers, losers, and momentum leaders."
    },
    "im-ai-scanner": {
      title: "AI Chart Scanner",
      subtitle: "Pick any NSE stock for an instant AI-written technical summary. Educational only."
    },
    "im-stock-detail": {
      title: "Stock Detail",
      subtitle: "Live chart, technicals, and recent news for any NSE stock in one place."
    },
    "im-fo": {
      title: "F&O Watchlist",
      subtitle: "Live last-traded price for liquid, derivatives-eligible NSE stocks."
    },
    "im-options": {
      title: "Option Chain",
      subtitle: "NIFTY 50 and Bank Nifty option chain by strike."
    },
    "im-commodities": {
      title: "Commodities",
      subtitle: "Current-month MCX futures for Gold, Silver, Crude Oil, and Natural Gas."
    },
    "im-news": {
      title: "Market News",
      subtitle: "Latest Indian equity-market headlines from financial publishers."
    },
    "im-alerts": {
      title: "Price & Signal Alerts",
      subtitle: "Browser alerts for NIFTY 50 / Bank Nifty price targets and decision changes."
    },
    "im-live-chart": {
      title: "Live Market Chart",
      subtitle: "Custom chart workspace for NIFTY 50 and Bank Nifty."
    },
    "im-tradingview-chart": {
      title: "TradingView Chart",
      subtitle: "The real TradingView widget — full indicator/drawing-tool library and symbol search."
    },
    "im-rrg": {
      title: "Stock Rotation (RRG)",
      subtitle: "Relative strength and momentum rotation versus NIFTY 50."
    },
    "im-heatmap": {
      title: "Sector Heatmap",
      subtitle: "Live NSE constituents colored by daily % change — bigger tile, bigger move."
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

  const LAST_PAGE_STORAGE_KEY = "indianMarketLastPage";
  let imTvChartReturnPage = "im-watchlist";

  function loadImTradingViewChart(symbol, label) {
    const container = document.getElementById("im-tradingview-widget-container");
    if (!container) return;

    container.innerHTML = '<div class="tradingview-widget-container__widget"></div>';

    const titleEl = document.getElementById("im-tv-chart-title");
    if (titleEl) titleEl.textContent = label ? `TradingView Chart — ${label}` : "TradingView Chart";

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.text = JSON.stringify({
      width: "100%",
      height: 700,
      symbol,
      interval: "15",
      timezone: "Asia/Kolkata",
      theme: "dark",
      style: "1",
      locale: "en",
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      details: true,
      studies: ["STD;SMA", "STD;RSI"],
      support_host: "https://www.tradingview.com"
    });
    container.appendChild(script);
  }

  function openImTradingViewChartFor(symbol, label, returnPage) {
    imTvChartReturnPage = returnPage || "im-watchlist";
    loadImTradingViewChart(symbol, label);
    pushImDrilldown(imTvChartReturnPage);
    showPage("im-tradingview-chart");
  }

  function setupImTradingViewChart() {
    const backBtn = document.getElementById("im-tv-chart-back-btn");
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        consumeImDrilldown();
        showPage(imTvChartReturnPage);
      });
    }
  }

  setupImTradingViewChart();

  function showPage(pageId) {
    navButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.page === pageId);
    });

    pages.forEach((page) => {
      page.classList.toggle("active", page.id === pageId);
    });

    try {
      // sessionStorage (not localStorage): survives an in-app reload (pull-
      // to-refresh, "Reset Settings", etc.) so that doesn't silently bounce
      // the user back to the dashboard, but clears once the app is fully
      // closed, so a fresh launch always starts on the dashboard instead of
      // wherever the user happened to leave off last time.
      sessionStorage.setItem(LAST_PAGE_STORAGE_KEY, pageId);
    } catch {
      // Ignore — private browsing / storage quota, non-critical.
    }

    const info = pageInfo[pageId];

    if (info && pageTitle && pageSubtitle) {
      pageTitle.textContent = info.title;
      pageSubtitle.textContent = info.subtitle;
    }

    if (pageId === "im-live-chart") {
      // RRG's Chart view borrows this same chart node — make sure it's back
      // in its home slot here before it's shown/resized.
      if (typeof restoreSharedChartHome === "function") restoreSharedChartHome();
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

    if (pageId === "im-fo") {
      if (typeof startFoWatchlistPolling === "function") startFoWatchlistPolling();
    } else if (typeof stopFoWatchlistPolling === "function") {
      stopFoWatchlistPolling();
    }

    if (pageId === "im-options") {
      if (typeof startOptionsChainPolling === "function") startOptionsChainPolling();
    } else if (typeof stopOptionsChainPolling === "function") {
      stopOptionsChainPolling();
    }

    if (pageId === "im-commodities") {
      if (typeof startCommoditiesPolling === "function") startCommoditiesPolling();
    } else if (typeof stopCommoditiesPolling === "function") {
      stopCommoditiesPolling();
    }

    if (pageId === "im-dashboard" && typeof fetchAllTopMovers === "function") {
      fetchAllTopMovers();
    }

    if (pageId === "im-dashboard" && typeof redrawMoverSparklines === "function") {
      redrawMoverSparklines();
    }

    if (["im-nifty", "im-banknifty", "im-finnifty", "im-sensex"].includes(pageId) && typeof redrawImDashboardSparkline === "function") {
      // That index's hero-card sparkline canvas was zero-size (and so never
      // drawn) while this page was hidden — redraw now from the data
      // already cached, rather than re-fetching.
      redrawImDashboardSparkline(pageId.replace("im-", ""));
    }

    if (pageId === "im-rrg") {
      // The symbol/quotes panel and the RRG chart data are independent —
      // fetching them in parallel instead of chaining with .then() roughly
      // halves how long the page feels like it's opening.
      if (typeof loadImRrgSymbolPanel === "function") loadImRrgSymbolPanel();
      if (typeof fetchImRrg === "function") fetchImRrg();
      if (typeof startImRrgQuotesPolling === "function") startImRrgQuotesPolling();
    } else if (typeof stopImRrgQuotesPolling === "function") {
      stopImRrgQuotesPolling();
    }

    if (pageId === "im-heatmap") {
      if (typeof startHeatmapPolling === "function") startHeatmapPolling();
    } else if (typeof stopHeatmapPolling === "function") {
      stopHeatmapPolling();
    }

    if (pageId === "im-scanner") {
      if (typeof startScannerPolling === "function") startScannerPolling();
    } else if (typeof stopScannerPolling === "function") {
      stopScannerPolling();
    }

    if (pageId === "im-news" && typeof loadImMarketNews === "function") {
      loadImMarketNews();
    }

    if (pageId === "im-alerts" && typeof renderImAlerts === "function") {
      renderImAlerts();
    }
  }

  // Any "drill into a page from a click" flow (a Dashboard tile, a
  // Watchlist row's View Chart/Buy/Sell, ...) is just an in-SPA page switch,
  // so the app has no browser-history entry to associate with "go back to
  // where I came from" — pushImDrilldown/consumeImDrilldown track that
  // return page directly instead. The Android hardware back button is
  // wired to this via the Capacitor App plugin below (not window.popstate:
  // relying on the WebView's own history stack to notice a pushState call
  // proved unreliable in the app specifically, so this drives it straight
  // off our own state instead).
  let imDrilldownReturnPage = null;

  function pushImDrilldown(returnPage) {
    imDrilldownReturnPage = returnPage;
  }

  function consumeImDrilldown() {
    imDrilldownReturnPage = null;
  }

  navButtons.forEach((button) => {
    button.addEventListener("click", () => {
      consumeImDrilldown();
      showPage(button.dataset.page);
    });
  });

  // Tapping a search box (or any text input) focuses it and pops the
  // on-screen keyboard, without opening any of the overlays below — e.g.
  // an empty search box, or one whose dropdown already closed after
  // picking a result. That focused state isn't tracked as an "overlay"
  // either, so back had nothing to intercept and fell straight through to
  // exiting the app instead of just dismissing the keyboard, same gap as
  // the overlays below. Checked first, before anything else.
  function blurAnyFocusedImInput() {
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
      active.blur();
      return true;
    }
    return false;
  }

  // Any small overlay (a search-suggestions dropdown, the Watchlist's
  // sort panel, its Buy/Sell/Chart or delete-confirm sheet) sits on top of
  // whatever page it opened from without changing the page itself — none
  // of that is tracked by pushImDrilldown. Without this, the back button
  // had nothing "open" to close and fell straight through to exiting the
  // app instead of just dismissing the dropdown/sheet, same underlying gap
  // as the drilldown one above. Checked first since these can be open on
  // top of anything else (a drilldown page, even the fullscreen chart).
  function closeAnyOpenImOverlay() {
    const sortPanel = document.getElementById("im-watchlist-sort-panel");
    if (sortPanel && !sortPanel.hidden) {
      sortPanel.hidden = true;
      return true;
    }
    const actionSheet = document.getElementById("im-watchlist-action-sheet");
    const deleteSheet = document.getElementById("im-watchlist-delete-sheet");
    if ((actionSheet && !actionSheet.hidden) || (deleteSheet && !deleteSheet.hidden)) {
      closeImWatchlistSheets();
      return true;
    }
    const searchDropdowns = [
      ["im-watchlist-search-results", () => hideImWatchlistSearchResults()],
      ["im-ai-scanner-search-results", () => hideImAiScannerSearchResults()],
      ["im-dashboard-ai-search-results", () => hideImDashboardAiSearchResults()],
      ["im-stock-detail-search-results", () => hideImStockDetailSearchResults()],
    ];
    for (const [id, hideFn] of searchDropdowns) {
      const el = document.getElementById(id);
      if (el && !el.hidden) {
        hideFn();
        return true;
      }
    }
    return false;
  }

  let imLastHomeBackPressAt = 0;
  const IM_BACK_EXIT_WINDOW_MS = 2000;

  function showImBackExitToast() {
    let toast = document.getElementById("app-back-exit-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "app-back-exit-toast";
      toast.className = "app-back-exit-toast";
      toast.textContent = "Press back again to exit";
      document.body.appendChild(toast);
    }
    toast.classList.add("visible");
    window.clearTimeout(showImBackExitToast.hideTimer);
    showImBackExitToast.hideTimer = window.setTimeout(() => toast.classList.remove("visible"), IM_BACK_EXIT_WINDOW_MS);
  }

  // Temporary diagnostic log for the native back button — written to
  // localStorage synchronously (survives even if the app is about to
  // close/background right after), so a report of "back closed the app"
  // can be matched against exactly what this listener saw and decided,
  // visible in Settings under "Back button debug log".
  function logImBackDecision(reason) {
    try {
      const activePage =
        document.querySelector("#indianModeRoot .page.active")?.id ||
        document.querySelector("#btcModeRoot .app-tab.active")?.dataset.tab ||
        "?";
      const log = JSON.parse(localStorage.getItem("imBackButtonDebugLog") || "[]");
      log.push(`${new Date().toLocaleTimeString()} | page=${activePage} | ${reason}`);
      while (log.length > 25) log.shift();
      localStorage.setItem("imBackButtonDebugLog", JSON.stringify(log));
    } catch { /* ignore */ }
  }
  window.imShowBackButtonDebugLog = function () {
    try {
      return JSON.parse(localStorage.getItem("imBackButtonDebugLog") || "[]");
    } catch {
      return [];
    }
  };

  // Native Android back button, in priority order: dismiss whatever is
  // open on top (keyboard, dropdown, sheet, sort panel, settings drawer,
  // fullscreen chart), then return from a drill-down, then from any other
  // page go back to the Dashboard. Only on the Dashboard itself does back
  // exit — and only on a second press within 2s, so a stray press never
  // closes the app. This listener fully replaces Capacitor's built-in
  // handling once registered.
  const capacitorApp = window.Capacitor?.Plugins?.App;
  if (capacitorApp?.addListener) {
    capacitorApp.addListener("backButton", () => {
      logImBackDecision("fired");

      // Both can be true together (a focused search box with its dropdown
      // open) — run both so a single back press clears the whole thing.
      const blurredInput = blurAnyFocusedImInput();
      const closedOverlay = closeAnyOpenImOverlay();
      if (blurredInput || closedOverlay) {
        logImBackDecision(`handled: blurredInput=${blurredInput} closedOverlay=${closedOverlay}`);
        return;
      }

      const settingsDrawer = document.getElementById("settingsDrawer");
      if (settingsDrawer?.classList.contains("open")) {
        logImBackDecision("handled: closed settings drawer");
        document.getElementById("settingsCloseButton")?.click();
        return;
      }
      if (imChartFullscreenActive) {
        logImBackDecision("handled: closed fullscreen chart");
        setImChartFullscreen(false);
        return;
      }
      if (imDrilldownReturnPage !== null) {
        const returnPage = imDrilldownReturnPage;
        imDrilldownReturnPage = null;
        logImBackDecision(`handled: drilldown -> ${returnPage}`);
        showPage(returnPage);
        return;
      }

      const indianRoot = document.getElementById("indianModeRoot");
      if (indianRoot && !indianRoot.hidden) {
        const activePage = Array.from(pages).find((page) => page.classList.contains("active"));
        if (activePage && activePage.id !== "im-dashboard") {
          logImBackDecision(`handled: ${activePage.id} -> im-dashboard`);
          showPage("im-dashboard");
          return;
        }
      } else {
        const activeTab = document.querySelector("#btcModeRoot .app-tab.active");
        if (activeTab && activeTab.dataset.tab !== "dashboard") {
          logImBackDecision(`handled: ${activeTab.dataset.tab} -> dashboard tab`);
          document.querySelector('#btcModeRoot .app-tab[data-tab="dashboard"]')?.click();
          return;
        }
      }

      const now = Date.now();
      if (now - imLastHomeBackPressAt < IM_BACK_EXIT_WINDOW_MS) {
        logImBackDecision("EXIT: second press within window");
        capacitorApp.exitApp();
        return;
      }
      imLastHomeBackPressAt = now;
      logImBackDecision("showed exit toast (first press on home)");
      showImBackExitToast();
    });
    logImBackDecision("listener registered");
  } else {
    try {
      localStorage.setItem(
        "imBackButtonDebugLog",
        JSON.stringify([`${new Date().toLocaleTimeString()} | Capacitor App plugin NOT available — listener never registered`])
      );
    } catch { /* ignore */ }
  }

  // Dashboard's own NIFTY 50/Bank Nifty/FinNifty/Sensex tiles jump to that
  // index's full page the same way the matching sidebar nav button used to.
  root.querySelectorAll(".stat-card-link[data-page]").forEach((card) => {
    const openDetail = () => {
      pushImDrilldown("im-dashboard");
      showPage(card.dataset.page);
    };
    card.addEventListener("click", openDetail);
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });
  });

  const storageKey = "indianMarketPaperTrades";
  const IM_TRADE_MARKET_LABELS = { nifty: "NIFTY 50", banknifty: "Bank Nifty", finnifty: "FINNIFTY", sensex: "Sensex" };
  const form = document.getElementById("im-paper-trade-form");
  const tradeTableBody = document.getElementById("im-trade-table-body");
  const emptyTrades = document.getElementById("im-empty-trades");
  const tradeCount = document.getElementById("im-trade-count");
  const journalCount = document.getElementById("im-journal-count");

  let imPendingStockTrade = null;

  function setImPendingStockTrade(symbol, direction, price) {
    imPendingStockTrade = { symbol };
    pushImDrilldown("im-watchlist");
    showPage("im-paper-trading");

    const banner = document.getElementById("im-stock-trade-banner");
    const bannerSymbol = document.getElementById("im-stock-trade-symbol");
    const indexLabel = document.getElementById("im-trade-index-label");
    const directionSelect = document.getElementById("im-trade-direction");
    const entryInput = document.getElementById("im-trade-entry");

    if (banner) banner.hidden = false;
    if (bannerSymbol) bannerSymbol.textContent = symbol;
    if (indexLabel) indexLabel.style.display = "none";
    if (directionSelect) directionSelect.value = direction;
    if (entryInput) {
      const numericPrice = Number(price);
      if (Number.isFinite(numericPrice) && numericPrice > 0) entryInput.value = numericPrice;
      entryInput.focus();
    }
  }

  function clearImPendingStockTrade() {
    imPendingStockTrade = null;
    const banner = document.getElementById("im-stock-trade-banner");
    const indexLabel = document.getElementById("im-trade-index-label");
    if (banner) banner.hidden = true;
    if (indexLabel) indexLabel.style.display = "";
  }

  const stockTradeClearBtn = document.getElementById("im-stock-trade-clear-btn");
  if (stockTradeClearBtn) {
    stockTradeClearBtn.addEventListener("click", clearImPendingStockTrade);
  }

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

  function imTradeMarketLabel(indexValue) {
    return IM_TRADE_MARKET_LABELS[indexValue] || indexValue;
  }

  function renderTrades() {
    const trades = loadTrades();

    if (tradeTableBody) {
      tradeTableBody.innerHTML = trades
        .map((trade, index) => {
          const directionClass = trade.direction === "Buy" ? "positive" : "negative";
          // Trades saved before this feature have no status/qty at all —
          // treat them as plain research-log rows, same as before.
          const status = trade.status || null;
          const pnl = status === "closed" && Number.isFinite(trade.pnl) ? trade.pnl : null;
          const pnlText = pnl === null ? "--" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`;
          const pnlClass = pnl === null ? "" : pnl >= 0 ? "positive" : "negative";
          const stopDisplay = Number.isFinite(trade.currentStop) ? trade.currentStop : trade.stop;
          const isTrailed = Number.isFinite(trade.trailingDistance) && trade.trailingDistance > 0 && trade.currentStop !== trade.stop;

          return `
            <tr>
              <td>${escapeText(imTradeMarketLabel(trade.index))}</td>
              <td class="${directionClass}">${escapeText(trade.direction)}</td>
              <td>${escapeText(trade.orderType === "limit" ? "Limit" : "Market")}</td>
              <td>${Number(trade.entry).toFixed(2)}</td>
              <td>${trade.qty ? escapeText(String(trade.qty)) : "--"}</td>
              <td>${Number(stopDisplay).toFixed(2)}${isTrailed ? " ↑" : ""}</td>
              <td>${Number(trade.target).toFixed(2)}</td>
              <td>${status ? `<span class="im-trade-status im-trade-status-${status}">${escapeText(status)}</span>` : "--"}</td>
              <td class="${pnlClass} privacy-sensitive">${pnlText}</td>
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

    renderTradeStats(trades);
  }

  let imPerfEquityChart = null;

  // Educational metrics computed from the paper-trade journal only — no
  // broker data. Sharpe here is a simplified per-trade mean/stdev ratio
  // (not annualized), since this is a discrete trade log rather than an
  // evenly-sampled price time series.
  function computeTradeStats(trades) {
    const closed = trades.filter((trade) => trade.status === "closed" && Number.isFinite(trade.pnl));
    const stats = {
      closedCount: closed.length,
      winRate: null,
      totalPnl: 0,
      avgWin: null,
      avgLoss: null,
      profitFactor: null,
      maxDrawdown: 0,
      sharpe: null,
      equityCurve: []
    };

    if (!closed.length) return stats;

    // Trades are stored newest-first (unshift on add); walk oldest-first
    // for a chronological equity curve.
    const chronological = [...closed].reverse();
    const wins = [];
    const losses = [];
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;

    chronological.forEach((trade, index) => {
      cumulative += trade.pnl;
      stats.equityCurve.push({ x: index + 1, y: cumulative });
      peak = Math.max(peak, cumulative);
      maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
      (trade.pnl >= 0 ? wins : losses).push(trade.pnl);
    });

    stats.totalPnl = cumulative;
    stats.maxDrawdown = maxDrawdown;
    stats.winRate = (wins.length / closed.length) * 100;
    stats.avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
    stats.avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;

    const grossWin = wins.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
    stats.profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null);

    const pnls = closed.map((trade) => trade.pnl);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length;
    const stdev = Math.sqrt(variance);
    stats.sharpe = stdev > 0 ? mean / stdev : null;

    return stats;
  }

  function renderTradeStats(trades) {
    const stats = computeTradeStats(trades || loadTrades());

    const closedCountEl = document.getElementById("im-perf-closed-count");
    const winRateEl = document.getElementById("im-perf-win-rate");
    const totalPnlEl = document.getElementById("im-perf-total-pnl");
    const profitFactorEl = document.getElementById("im-perf-profit-factor");
    const avgWinLossEl = document.getElementById("im-perf-avg-win-loss");
    const maxDrawdownEl = document.getElementById("im-perf-max-drawdown");
    const sharpeEl = document.getElementById("im-perf-sharpe");
    const emptyNote = document.getElementById("im-perf-empty-note");
    const canvas = document.getElementById("im-perf-equity-chart");

    if (closedCountEl) closedCountEl.textContent = String(stats.closedCount);

    if (!stats.closedCount) {
      if (winRateEl) winRateEl.textContent = "--";
      if (totalPnlEl) { totalPnlEl.textContent = "--"; totalPnlEl.className = ""; }
      if (profitFactorEl) profitFactorEl.textContent = "--";
      if (avgWinLossEl) avgWinLossEl.textContent = "--";
      if (maxDrawdownEl) maxDrawdownEl.textContent = "--";
      if (sharpeEl) sharpeEl.textContent = "--";
      if (emptyNote) emptyNote.style.display = "flex";
      if (canvas) canvas.style.visibility = "hidden";
      return;
    }

    if (emptyNote) emptyNote.style.display = "none";
    if (canvas) canvas.style.visibility = "visible";

    const fmtSigned = (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;

    if (winRateEl) winRateEl.textContent = `${stats.winRate.toFixed(1)}%`;
    if (totalPnlEl) {
      totalPnlEl.textContent = fmtSigned(stats.totalPnl);
      totalPnlEl.className = stats.totalPnl >= 0 ? "positive" : "negative";
    }
    if (profitFactorEl) {
      profitFactorEl.textContent = stats.profitFactor === null ? "--" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2);
    }
    if (avgWinLossEl) {
      const avgWinText = stats.avgWin === null ? "--" : `+${stats.avgWin.toFixed(2)}`;
      const avgLossText = stats.avgLoss === null ? "--" : stats.avgLoss.toFixed(2);
      avgWinLossEl.textContent = `${avgWinText} / ${avgLossText}`;
    }
    if (maxDrawdownEl) maxDrawdownEl.textContent = stats.maxDrawdown.toFixed(2);
    if (sharpeEl) sharpeEl.textContent = stats.sharpe === null ? "--" : stats.sharpe.toFixed(2);

    if (canvas && typeof Chart !== "undefined") {
      const isPositive = stats.totalPnl >= 0;
      const lineColor = isPositive ? "#34d399" : "#f87171";
      const fillColor = isPositive ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";

      if (imPerfEquityChart) {
        imPerfEquityChart.data.datasets[0].data = stats.equityCurve;
        imPerfEquityChart.data.datasets[0].borderColor = lineColor;
        imPerfEquityChart.data.datasets[0].backgroundColor = fillColor;
        imPerfEquityChart.update();
      } else {
        imPerfEquityChart = new Chart(canvas.getContext("2d"), {
          type: "line",
          data: {
            datasets: [{
              label: "Cumulative P&L",
              data: stats.equityCurve,
              borderColor: lineColor,
              backgroundColor: fillColor,
              fill: true,
              tension: 0.25,
              pointRadius: 2,
              pointHoverRadius: 5
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: "index" },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  title(c) { return `Trade #${c[0]?.raw?.x ?? ""}`; },
                  label(c) { return `Cumulative P&L: ${fmtSigned(c.raw?.y ?? 0)}`; }
                }
              }
            },
            scales: {
              x: { type: "linear", title: { display: true, text: "Closed trade #", color: "#94a3b8" }, ticks: { color: "#94a3b8", precision: 0 }, grid: { color: "rgba(148,163,184,.12)" } },
              y: { title: { display: true, text: "Cumulative P&L", color: "#94a3b8" }, ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,.12)" } }
            }
          }
        });
      }
    }
  }

  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();

      const entry = Number(document.getElementById("im-trade-entry").value);
      const stop = Number(document.getElementById("im-trade-stop").value);
      const target = Number(document.getElementById("im-trade-target").value);
      const qty = Number(document.getElementById("im-trade-qty").value);
      const orderType = document.getElementById("im-trade-order-type").value;
      const trailingInput = document.getElementById("im-trade-trailing").value.trim();
      const trailingDistance = trailingInput ? Number(trailingInput) : null;
      const direction = document.getElementById("im-trade-direction").value;

      if (![entry, stop, target, qty].every((value) => Number.isFinite(value) && value > 0)) {
        alert("Please enter valid positive prices and quantity.");
        return;
      }
      if (trailingDistance !== null && (!Number.isFinite(trailingDistance) || trailingDistance <= 0)) {
        alert("Trailing SL distance must be a positive number, or left blank for a fixed stop.");
        return;
      }

      const trades = loadTrades();

      trades.unshift({
        index: imPendingStockTrade ? imPendingStockTrade.symbol : document.getElementById("im-trade-index").value,
        direction,
        orderType,
        entry,
        qty,
        stop,
        currentStop: stop,
        trailingDistance,
        target,
        status: orderType === "limit" ? "pending" : "open",
        pnl: null,
        exitPrice: null,
        exitReason: null
      });

      saveTrades(trades);
      form.reset();
      clearImPendingStockTrade();
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

  // Checked from the same 60-second live-refresh tick that already re-renders
  // the dashboard for the 4 known indices (renderMarketEngine) — no new
  // polling. Handles limit-order fills, trailing-stop updates, and
  // stop/target exits, each firing a browser notification like the other
  // alert types.
  function checkImPaperTrades(marketKey, data) {
    const price = Number(data.price);
    if (!Number.isFinite(price)) return;

    const trades = loadTrades();
    let changed = false;
    const notifications = [];

    trades.forEach((trade) => {
      if (trade.index !== marketKey || !trade.status) return;
      if (trade.status === "closed") return;

      const isBuy = trade.direction === "Buy";

      if (trade.status === "pending") {
        const filled = isBuy ? price <= trade.entry : price >= trade.entry;
        if (filled) {
          trade.status = "open";
          changed = true;
          notifications.push({
            title: `${imTradeMarketLabel(marketKey)} Limit Order Filled`,
            body: `${trade.direction} ${trade.qty} at ${trade.entry} filled — live price ${formatNumber(price)}.`,
            tag: `im-paper-fill-${trade.entry}-${trade.qty}-${trade.stop}`
          });
        }
        return;
      }

      if (Number.isFinite(trade.trailingDistance) && trade.trailingDistance > 0) {
        if (isBuy) {
          const candidateStop = price - trade.trailingDistance;
          if (candidateStop > trade.currentStop) {
            trade.currentStop = candidateStop;
            changed = true;
          }
        } else {
          const candidateStop = price + trade.trailingDistance;
          if (candidateStop < trade.currentStop) {
            trade.currentStop = candidateStop;
            changed = true;
          }
        }
      }

      const trailed = Number.isFinite(trade.trailingDistance) && trade.trailingDistance > 0;
      let exitReason = null;
      if (isBuy && price <= trade.currentStop) exitReason = trailed && trade.currentStop > trade.stop ? "Trailing Stop" : "Stop-Loss";
      else if (isBuy && price >= trade.target) exitReason = "Target";
      else if (!isBuy && price >= trade.currentStop) exitReason = trailed && trade.currentStop < trade.stop ? "Trailing Stop" : "Stop-Loss";
      else if (!isBuy && price <= trade.target) exitReason = "Target";

      if (exitReason) {
        trade.status = "closed";
        trade.exitPrice = price;
        trade.exitReason = exitReason;
        trade.pnl = isBuy ? (price - trade.entry) * trade.qty : (trade.entry - price) * trade.qty;
        changed = true;
        notifications.push({
          title: `${imTradeMarketLabel(marketKey)} Paper Trade Closed`,
          body: `${trade.direction} ${trade.qty} closed at ${formatNumber(price)} (${exitReason}). P&L: ${trade.pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}.`,
          tag: `im-paper-close-${trade.entry}-${trade.qty}-${trade.stop}`
        });
      }
    });

    if (changed) {
      saveTrades(trades);
      renderTrades();
    }
    notifications.forEach((n) => sendImBrowserAlert(n.title, n.body, n.tag));
  }

  function setupImPositionSizer() {
    const btn = document.getElementById("im-sizer-calculate-btn");
    const resultEl = document.getElementById("im-sizer-result");
    if (!btn) return;

    btn.addEventListener("click", () => {
      const capital = Number(document.getElementById("im-sizer-capital").value);
      const riskPct = Number(document.getElementById("im-sizer-risk-pct").value);
      const entry = Number(document.getElementById("im-trade-entry").value);
      const stop = Number(document.getElementById("im-trade-stop").value);

      if (!Number.isFinite(capital) || capital <= 0 || !Number.isFinite(riskPct) || riskPct <= 0) {
        if (resultEl) resultEl.textContent = "Enter a valid virtual capital amount and risk %.";
        return;
      }
      if (!Number.isFinite(entry) || !Number.isFinite(stop) || entry === stop) {
        if (resultEl) resultEl.textContent = "Enter Entry Price and Stop-Loss above first.";
        return;
      }

      const riskAmount = capital * (riskPct / 100);
      const perUnitRisk = Math.abs(entry - stop);
      const qty = Math.floor(riskAmount / perUnitRisk);

      if (qty < 1) {
        if (resultEl) {
          resultEl.textContent = `Risk amount (${formatNumber(riskAmount)}) is too small for this stop distance (${formatNumber(perUnitRisk)}/unit). Try a wider risk % or a tighter stop.`;
        }
        return;
      }

      document.getElementById("im-trade-qty").value = qty;
      if (resultEl) {
        resultEl.textContent = `Risking ${formatNumber(riskAmount)} (${riskPct}% of ${formatNumber(capital)}) at ${formatNumber(perUnitRisk)}/unit stop distance → Quantity ${qty}.`;
      }
    });
  }

  function exportTradesToCsv() {
    const trades = loadTrades();
    if (!trades.length) {
      alert("No paper trades to export yet.");
      return;
    }

    const headers = ["Index", "Direction", "Order Type", "Entry", "Qty", "Stop", "Target", "Status", "Exit Price", "Exit Reason", "P&L"];
    const rows = trades.map((trade) => [
      imTradeMarketLabel(trade.index),
      trade.direction,
      trade.orderType === "limit" ? "Limit" : "Market",
      trade.entry,
      trade.qty ?? "",
      trade.stop,
      trade.target,
      trade.status || "",
      trade.exitPrice ?? "",
      trade.exitReason || "",
      Number.isFinite(trade.pnl) ? trade.pnl : ""
    ]);

    const csvEscape = (value) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const csvContent = [headers, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `marketdock-paper-trades-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  document.getElementById("im-journal-export-btn")?.addEventListener("click", exportTradesToCsv);

  setupImPositionSizer();
  renderTrades();

  const API_BASE_URL = "https://api.marketdock.in";

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
      ["Change", changePillHtml(data.change_percent), true],
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
        ([label, value, isHtml]) => `
          <div class="technical-item">
            <span>${escapeHtml(label)}</span>
            <strong>${isHtml ? value : escapeHtml(value)}</strong>
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

  const imLastChangePercent = {};
  const imLastSparklineCloses = {};

  function redrawImDashboardSparkline(marketKey) {
    const closes = imLastSparklineCloses[marketKey];
    const change = imLastChangePercent[marketKey];
    if (!closes || !Number.isFinite(change)) return;
    const isUp = change >= 0;
    // Same cached candles feed both the dashboard stat card and that
    // index's own research-page hero — whichever is currently visible (the
    // other's canvas just silently no-ops at zero size while hidden).
    renderSparkline(`im-dash-${marketKey}-sparkline`, closes, isUp);
    renderSparkline(`im-${marketKey}-hero-sparkline`, closes, isUp);
  }

  const IM_BIAS_MARKET_KEYS = ["nifty", "banknifty", "finnifty", "sensex"];
  const imLastDecisionLabel = {};

  // Dashboard's "Technical Bias" card: rolls up each index's own technical
  // decision (the same weighted RSI/EMA/VWAP/Supertrend/etc. score behind
  // that index's own "BUY SETUP"/"SELL SETUP"/"HOLD" call — not a separate
  // AI judgment, and not the same thing as today's price change_percent)
  // into one bullish/bearish/neutral read across all 4.
  function updateMarketBiasCard() {
    const valueEl = document.getElementById("im-dash-market-bias-value");
    const changeEl = document.getElementById("im-dash-market-bias-change");
    if (!valueEl || !changeEl) return;

    const labels = IM_BIAS_MARKET_KEYS.map((key) => imLastDecisionLabel[key]).filter(Boolean);
    if (labels.length < IM_BIAS_MARKET_KEYS.length) return;

    const bullish = labels.filter((label) => label.includes("BUY")).length;
    const bearish = labels.filter((label) => label.includes("SELL")).length;
    const neutral = labels.length - bullish - bearish;

    let bias = "Neutral";
    let cls = "neutral";
    if (bullish > bearish) {
      bias = "Bullish";
      cls = "positive";
    } else if (bearish > bullish) {
      bias = "Bearish";
      cls = "negative";
    }

    valueEl.textContent = bias;
    // "buy/sell/hold setups", not "bullish/bearish" — this counts technical
    // setups (RSI/EMA/Supertrend etc.), which can and does disagree with
    // today's price move shown in the % pills above (e.g. an index can be
    // up today while its setup still reads SELL, if it's running into
    // resistance or an overbought reading) — different question, on
    // purpose, not a contradiction.
    changeEl.textContent = `${bullish} buy · ${bearish} sell · ${neutral} hold setups`;
    changeEl.className = `stat-change ${cls}`;
  }

  function renderMarketEngine(marketKey, data) {
    imLastChangePercent[marketKey] = Number(data.change_percent);
    redrawImDashboardSparkline(marketKey);
    imLastDecisionLabel[marketKey] = String(data.decision.label);
    updateMarketBiasCard();
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
      const isLive = data.data_source === "live";
      statusText.textContent = isLive ? "Live market data" : "Demo data mode";
      statusBadge.classList.toggle("market-status-live", isLive);
      statusBadge.classList.toggle("market-status-demo", !isLive);
    }

    const isLiveData = data.data_source === "live";

    // The ticker bar's content is duplicated (once visible, once
    // aria-hidden) so its CSS scroll animation can loop seamlessly —
    // update every copy via data-ticker-field, not a single id.
    document.querySelectorAll(`[data-ticker-field="${marketKey}-price"]`).forEach((el) => {
      el.textContent = formatNumber(data.price);
    });
    document.querySelectorAll(`[data-ticker-field="${marketKey}-change"]`).forEach((el) => {
      el.className = "im-ticker-change";
      el.innerHTML = changePillHtml(data.change_percent);
    });
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

    const topStatusBadge = document.getElementById("topMarketStatus");
    const topStatusText = document.getElementById("topMarketStatusText");
    if (topStatusBadge && topStatusText && !document.getElementById("indianModeRoot").hidden) {
      const sessionStatus = data.session_status;
      topStatusBadge.classList.remove("status-live", "status-closed");
      if (!isLiveData) {
        topStatusText.textContent = "Demo";
      } else if (sessionStatus === "live") {
        topStatusBadge.classList.add("status-live");
        topStatusText.textContent = "Live";
      } else {
        topStatusBadge.classList.add("status-closed");
        topStatusText.textContent = "Closed";
      }
    }

    const dashPrice = document.getElementById(`im-dash-${marketKey}-price`);
    const dashChange = document.getElementById(`im-dash-${marketKey}-change`);
    if (dashPrice) dashPrice.textContent = formatNumber(data.price);
    if (dashChange) {
      dashChange.className = "stat-change";
      dashChange.innerHTML = changePillHtml(data.change_percent) + (isLiveData ? "" : ` <span class="im-demo-suffix">&middot; Demo</span>`);
    }

    const heroPrice = document.getElementById(`im-${marketKey}-hero-price`);
    const heroChange = document.getElementById(`im-${marketKey}-hero-change`);
    const heroEyebrow = document.getElementById(`im-${marketKey}-eyebrow`);
    if (heroPrice) heroPrice.textContent = formatNumber(data.price);
    if (heroChange) {
      heroChange.className = "";
      heroChange.innerHTML = changePillHtml(data.change_percent);
    }
    if (heroEyebrow) heroEyebrow.textContent = `NSE Index \u00B7 ${isLiveData ? "Live data" : "Demo values"}`;

    renderTechnicalMetrics(marketKey, data);
    renderConfirmations(marketKey, data);
    renderTradePlan(marketKey, data);

    if (typeof checkImPriceAlerts === "function") checkImPriceAlerts(marketKey, data.price);
    if (typeof checkImSignalAlert === "function") checkImSignalAlert(marketKey, data.decision.label);
    if (typeof checkImConditionAlerts === "function") checkImConditionAlerts(marketKey, data);
    if (typeof checkImPaperTrades === "function") checkImPaperTrades(marketKey, data);
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

    // The dashboard price/change and hero price/change only get set on a
    // successful load (renderMarketEngine below) — without this, a failed
    // request leaves them stuck on their static "Loading…" placeholder
    // forever instead of ever reflecting that the request actually failed.
    const dashChange = document.getElementById(`im-dash-${marketKey}-change`);
    if (dashChange) {
      dashChange.className = "stat-change";
      dashChange.textContent = "Unavailable — retrying…";
    }

    const heroChange = document.getElementById(`im-${marketKey}-hero-change`);
    if (heroChange) {
      heroChange.className = "";
      heroChange.textContent = "Unavailable — retrying…";
    }

    const heroEyebrow = document.getElementById(`im-${marketKey}-eyebrow`);
    if (heroEyebrow) heroEyebrow.textContent = "NSE Index · Retrying…";
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
    loadMarketEngine("finnifty");
    loadMarketEngine("sensex");
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

  // ===================== Multiple watchlists + AI score =====================
  // Each watchlist is just {id, name, symbols[]} in localStorage; fetching still
  // reuses the same /api/watchlist?symbols= endpoint (now with a per-row
  // ai_score/ai_label the backend derives from live % change).

  const IM_WATCHLISTS_KEY = "imWatchlistsV2";
  const IM_MAX_WATCHLISTS = 10;
  const IM_MAX_SYMBOLS_PER_WATCHLIST = 100;
  const IM_DEFAULT_WATCHLIST_SYMBOLS = [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN", "BHARTIARTL",
    "ITC", "KOTAKBANK", "LT", "HINDUNILVR", "BAJFINANCE", "MARUTI", "TITAN",
    "SUNPHARMA", "AXISBANK", "ASIANPAINT", "WIPRO", "TATAMOTORS", "NTPC"
  ];
  let activeImWatchlistId = null;

  function getImWatchlists() {
    try {
      const saved = JSON.parse(localStorage.getItem(IM_WATCHLISTS_KEY));
      if (Array.isArray(saved) && saved.length) return saved;
    } catch (error) { /* ignore */ }
    return [{ id: "default", name: "My Watchlist", symbols: [...IM_DEFAULT_WATCHLIST_SYMBOLS] }];
  }

  function saveImWatchlists(lists) {
    try {
      localStorage.setItem(IM_WATCHLISTS_KEY, JSON.stringify(lists));
    } catch (error) { /* ignore */ }
  }

  function getActiveImWatchlist() {
    const lists = getImWatchlists();
    if (!activeImWatchlistId || !lists.some((w) => w.id === activeImWatchlistId)) {
      activeImWatchlistId = lists[0].id;
    }
    return lists.find((w) => w.id === activeImWatchlistId) || lists[0];
  }

  function renderImWatchlistTabs() {
    const lists = getImWatchlists();
    getActiveImWatchlist();
    const tabsEl = document.getElementById("im-watchlist-tabs");
    if (!tabsEl) return;
    tabsEl.innerHTML =
      lists
        .map(
          (w) => `<button class="im-watchlist-tab ${w.id === activeImWatchlistId ? "active" : ""}" type="button" data-watchlist-id="${escapeHtml(w.id)}">${escapeHtml(w.name)}</button>`
        )
        .join("") + `<button class="im-watchlist-tab-new" type="button" id="im-watchlist-new-btn">+ New</button>`;
  }

  function renderAiScoreBadge(score, label) {
    if (score === null || score === undefined || !label) return `<span class="im-ai-score">--</span>`;
    const cls = `im-ai-score-${String(label).toLowerCase().replace(/\s+/g, "-")}`;
    return `<span class="im-ai-score ${cls}">${score} &middot; ${escapeHtml(label)}</span>`;
  }

  let imWatchlistSortMode = "manual"; // "manual" | "alpha" | "change" | "price"
  let imWatchlistLastRows = [];

  function sortImWatchlistRows(rows) {
    if (imWatchlistSortMode === "manual") return rows;
    const sorted = [...rows];
    if (imWatchlistSortMode === "alpha") {
      sorted.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    } else if (imWatchlistSortMode === "change") {
      sorted.sort((a, b) => (Number(b.change_percent) || 0) - (Number(a.change_percent) || 0));
    } else if (imWatchlistSortMode === "price") {
      sorted.sort((a, b) => (Number(b.last_price) || 0) - (Number(a.last_price) || 0));
    }
    return sorted;
  }

  function updateImWatchlistSearchCount() {
    const countEl = document.getElementById("im-watchlist-search-count");
    if (!countEl) return;
    countEl.textContent = `${getActiveImWatchlist().symbols.length}/${IM_MAX_SYMBOLS_PER_WATCHLIST}`;
  }

  function renderWatchlist(rows) {
    const body = document.getElementById("im-watchlist-body");
    const status = document.getElementById("im-watchlist-status");
    if (!body) return;
    // A row currently being dragged to reorder would get destroyed by a
    // re-render mid-drag (the 5-second poll calls this too) — skip this
    // refresh and let the next poll pick up fresh prices once it's done.
    if (imWatchlistDragPointerId !== null) return;

    updateImWatchlistSearchCount();

    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = `<tr><td colspan="5">No symbols in this watchlist yet. Add one above.</td></tr>`;
      if (status) {
        status.hidden = false;
        status.textContent = "Empty";
      }
      return;
    }

    body.classList.toggle("im-watchlist-body-sorted", imWatchlistSortMode !== "manual");

    body.innerHTML = sortImWatchlistRows(rows)
      .map((row) => {
        const symbol = escapeHtml(row.symbol);
        return `
          <tr class="im-watchlist-row" data-symbol="${symbol}" data-price="${row.last_price ?? ""}">
            <td class="im-watchlist-drag-col"><span class="im-watchlist-drag-handle" title="Drag to reorder">&#8942;&#8942;</span></td>
            <td>${symbol}</td>
            <td>${formatNumber(row.last_price)}</td>
            <td>${changePillHtml(row.change_percent)}</td>
            <td>${renderAiScoreBadge(row.ai_score, row.ai_label)}</td>
          </tr>
        `;
      })
      .join("");

    if (status) status.hidden = true;
  }

  async function fetchWatchlist() {
    const status = document.getElementById("im-watchlist-status");
    const watchlist = getActiveImWatchlist();

    if (!watchlist.symbols.length) {
      imWatchlistLastRows = [];
      renderWatchlist([]);
      if (status) {
        status.hidden = false;
        status.textContent = "Empty";
      }
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/watchlist?symbols=${watchlist.symbols.join(",")}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Watchlist request failed.");
      }
      imWatchlistLastRows = Array.isArray(result.data) ? result.data : [];
      renderWatchlist(result.data);

      if (typeof checkImPaperTrades === "function" && Array.isArray(result.data)) {
        result.data.forEach((row) => {
          if (row && row.symbol && Number.isFinite(Number(row.last_price))) {
            checkImPaperTrades(row.symbol, { price: row.last_price });
          }
        });
      }
    } catch (error) {
      console.error("Watchlist fetch failed:", error);
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
      const body = document.getElementById("im-watchlist-body");
      if (body) body.innerHTML = `<tr><td colspan="5">${escapeHtml(error.message || "Could not load watchlist.")}</td></tr>`;
    }
  }

  function addSymbolToActiveWatchlist(symbol) {
    symbol = String(symbol || "").trim().toUpperCase();
    if (!symbol) return;

    const lists = getImWatchlists();
    const active = getActiveImWatchlist();
    const target = lists.find((w) => w.id === active.id);
    if (!target) return;

    if (target.symbols.includes(symbol)) return;

    if (target.symbols.length >= IM_MAX_SYMBOLS_PER_WATCHLIST) {
      alert(`"${target.name}" already has ${IM_MAX_SYMBOLS_PER_WATCHLIST} stocks, the maximum per watchlist. Remove one before adding another.`);
      return;
    }

    target.symbols.push(symbol);
    saveImWatchlists(lists);
    fetchWatchlist();
  }

  let imWatchlistSearchDebounce = null;
  let imWatchlistSearchActiveIndex = -1;
  let imWatchlistSearchResults = [];

  function hideImWatchlistSearchResults() {
    const resultsEl = document.getElementById("im-watchlist-search-results");
    if (resultsEl) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
    }
    imWatchlistSearchResults = [];
    imWatchlistSearchActiveIndex = -1;
  }

  function renderImWatchlistSearchResults(results) {
    imWatchlistSearchResults = results;
    imWatchlistSearchActiveIndex = -1;
    const resultsEl = document.getElementById("im-watchlist-search-results");
    if (!resultsEl) return;

    if (!results.length) {
      resultsEl.innerHTML = `<div class="im-watchlist-search-empty">No matching NSE stocks found.</div>`;
      resultsEl.hidden = false;
      return;
    }

    resultsEl.innerHTML = results
      .map(
        (stock, index) => `
          <div class="im-watchlist-search-item" data-search-index="${index}">
            <strong>${escapeHtml(stock.symbol)}</strong>
            <span>${escapeHtml(stock.name)}</span>
          </div>
        `
      )
      .join("");
    resultsEl.hidden = false;
  }

  async function runImWatchlistSearch(query) {
    const resultsEl = document.getElementById("im-watchlist-search-results");
    if (!query) {
      hideImWatchlistSearchResults();
      return;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/stocks/search?q=${encodeURIComponent(query)}&limit=25`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Stock search failed.");
      renderImWatchlistSearchResults(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("Stock search failed:", error);
      if (resultsEl) {
        resultsEl.innerHTML = `<div class="im-watchlist-search-empty">${escapeHtml(error.message || "Stock search failed.")}</div>`;
        resultsEl.hidden = false;
      }
    }
  }

  function setupImWatchlistSearch() {
    const input = document.getElementById("im-watchlist-search-input");
    const resultsEl = document.getElementById("im-watchlist-search-results");
    if (!input || !resultsEl) return;

    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (imWatchlistSearchDebounce) window.clearTimeout(imWatchlistSearchDebounce);
      imWatchlistSearchDebounce = window.setTimeout(() => runImWatchlistSearch(query), 250);
    });

    input.addEventListener("keydown", (event) => {
      if (resultsEl.hidden || !imWatchlistSearchResults.length) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        imWatchlistSearchActiveIndex = Math.min(imWatchlistSearchActiveIndex + 1, imWatchlistSearchResults.length - 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        imWatchlistSearchActiveIndex = Math.max(imWatchlistSearchActiveIndex - 1, 0);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const chosen = imWatchlistSearchResults[imWatchlistSearchActiveIndex] || imWatchlistSearchResults[0];
        if (chosen) {
          addSymbolToActiveWatchlist(chosen.symbol);
          input.value = "";
          hideImWatchlistSearchResults();
        }
        return;
      } else if (event.key === "Escape") {
        hideImWatchlistSearchResults();
        return;
      } else {
        return;
      }
      Array.from(resultsEl.children).forEach((child, index) => {
        child.classList.toggle("active", index === imWatchlistSearchActiveIndex);
      });
    });

    resultsEl.addEventListener("click", (event) => {
      const item = event.target.closest("[data-search-index]");
      if (!item) return;
      const stock = imWatchlistSearchResults[Number(item.dataset.searchIndex)];
      if (stock) {
        addSymbolToActiveWatchlist(stock.symbol);
        input.value = "";
        hideImWatchlistSearchResults();
        input.focus();
      }
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".im-watchlist-search-wrap")) hideImWatchlistSearchResults();
    });
  }

  function setupImWatchlistSortPanel() {
    const btn = document.getElementById("im-watchlist-sort-btn");
    const panel = document.getElementById("im-watchlist-sort-panel");
    if (!btn || !panel) return;

    function updateActiveSortOption() {
      btn.classList.toggle("active", imWatchlistSortMode !== "manual");
      panel.querySelectorAll(".im-watchlist-sort-option").forEach((opt) => {
        opt.classList.toggle("active", opt.dataset.sort === imWatchlistSortMode);
      });
    }
    updateActiveSortOption();

    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      hideImWatchlistSearchResults();
      panel.hidden = !panel.hidden;
    });

    panel.addEventListener("click", (event) => {
      const opt = event.target.closest(".im-watchlist-sort-option");
      if (!opt) return;
      imWatchlistSortMode = opt.dataset.sort;
      updateActiveSortOption();
      panel.hidden = true;
      renderWatchlist(imWatchlistLastRows);
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".im-watchlist-search-wrap")) panel.hidden = true;
    });
  }

  function setupImWatchlistControls() {
    const tabsEl = document.getElementById("im-watchlist-tabs");
    if (tabsEl) {
      tabsEl.addEventListener("click", (event) => {
        if (event.target.closest("#im-watchlist-new-btn")) {
          const lists = getImWatchlists();
          if (lists.length >= IM_MAX_WATCHLISTS) {
            alert(`You can have up to ${IM_MAX_WATCHLISTS} watchlists. Delete one before adding a new one.`);
            return;
          }
          const name = window.prompt("Name for the new watchlist:");
          if (!name || !name.trim()) return;
          const id = `wl${Date.now()}${Math.random().toString(16).slice(2, 6)}`;
          lists.push({ id, name: name.trim().slice(0, 40), symbols: [] });
          saveImWatchlists(lists);
          activeImWatchlistId = id;
          renderImWatchlistTabs();
          fetchWatchlist();
          return;
        }

        const tabBtn = event.target.closest("[data-watchlist-id]");
        if (tabBtn) {
          activeImWatchlistId = tabBtn.dataset.watchlistId;
          renderImWatchlistTabs();
          fetchWatchlist();
        }
      });
    }

    setupImWatchlistSearch();
    setupImWatchlistSortPanel();

    const deleteBtn = document.getElementById("im-watchlist-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        const lists = getImWatchlists();
        if (lists.length <= 1) {
          alert("You need at least one watchlist. Add another before deleting this one.");
          return;
        }
        const active = getActiveImWatchlist();
        if (!window.confirm(`Delete watchlist "${active.name}"?`)) return;
        const remaining = lists.filter((w) => w.id !== active.id);
        saveImWatchlists(remaining);
        activeImWatchlistId = remaining[0].id;
        renderImWatchlistTabs();
        fetchWatchlist();
      });
    }

    setupImWatchlistRowInteractions();
    renderImWatchlistTabs();
  }

  // Zerodha-style row interactions: tap a row for a Buy/Sell/View Chart
  // sheet, press-and-hold for a delete confirm, drag the handle to
  // reorder. All delegated on the tbody (not per-row) so it survives the
  // 5-second poll re-rendering the rows out from under it.
  let imWatchlistDragPointerId = null;
  let imWatchlistDragPointerOffsetY = 0;
  let imWatchlistDragLatestClientY = 0;
  let imWatchlistDragRafId = null;
  let imWatchlistDragLastSwapAt = 0;
  const IM_ROW_SWAP_COOLDOWN_MS = 220;
  const IM_DRAG_SCROLL_EDGE = 90;
  const IM_DRAG_SCROLL_MAX_SPEED = 16;
  let imWatchlistPressTimer = null;
  let imWatchlistPressStart = null;
  let imWatchlistLongPressFired = false;
  let imWatchlistPressMoved = false;
  const IM_LONG_PRESS_MS = 500;
  const IM_PRESS_MOVE_CANCEL_PX = 10;
  const IM_ROW_SWAP_TRANSITION = "transform 0.2s cubic-bezier(0.2, 0, 0.2, 1)";

  function clearImWatchlistPressTimer() {
    if (imWatchlistPressTimer) {
      window.clearTimeout(imWatchlistPressTimer);
      imWatchlistPressTimer = null;
    }
  }

  // The row's own translateY (set on every pointermove) has to be
  // subtracted back out to get where it would sit with no drag offset —
  // its *natural*, current-DOM-order position — since that's what moves
  // whenever the row swaps position in the DOM below.
  function getImWatchlistNaturalTop(row) {
    const previousTransform = row.style.transform;
    row.style.transform = "none";
    const top = row.getBoundingClientRect().top;
    row.style.transform = previousTransform;
    return top;
  }

  // Slides a displaced row from its pre-swap spot into its new one instead
  // of letting the DOM reorder snap it there instantly (the "blink").
  function animateImWatchlistRowFrom(row, previousTop) {
    const newTop = getImWatchlistNaturalTop(row);
    const delta = previousTop - newTop;
    if (!delta) return;
    row.style.transition = "none";
    row.style.transform = `translateY(${delta}px)`;
    // Force layout so the browser commits the starting transform above
    // before the transition below is applied, or it would just skip
    // straight to the end state with nothing to animate.
    void row.offsetHeight;
    row.style.transition = IM_ROW_SWAP_TRANSITION;
    row.style.transform = "translateY(0px)";
    const clearRowStyles = () => {
      row.style.transition = "";
      row.style.transform = "";
    };
    row.addEventListener("transitionend", clearRowStyles, { once: true });
    // A fast run of swaps can leave a row already sitting at
    // translateY(0) when the next swap re-triggers this on it, in which
    // case there's nothing left to animate and transitionend never fires
    // — the timeout guarantees the inline styles still get cleared.
    window.setTimeout(clearRowStyles, 250);
  }

  // Nudges the page toward the finger whenever a drag gets close to the
  // top/bottom edge of the viewport, since the watchlist has no inner
  // scroll container of its own — the whole window scrolls. Called every
  // animation frame while dragging (not just on pointermove), so it keeps
  // scrolling even if the finger is held still right at the edge.
  function autoScrollImWatchlistIfNeeded(pointerClientY) {
    const viewportHeight = window.innerHeight;
    let delta = 0;
    if (pointerClientY < IM_DRAG_SCROLL_EDGE) {
      const strength = (IM_DRAG_SCROLL_EDGE - pointerClientY) / IM_DRAG_SCROLL_EDGE;
      delta = -Math.ceil(strength * IM_DRAG_SCROLL_MAX_SPEED);
    } else if (pointerClientY > viewportHeight - IM_DRAG_SCROLL_EDGE) {
      const strength = (pointerClientY - (viewportHeight - IM_DRAG_SCROLL_EDGE)) / IM_DRAG_SCROLL_EDGE;
      delta = Math.ceil(strength * IM_DRAG_SCROLL_MAX_SPEED);
    }
    if (!delta) return;
    const maxScroll = document.documentElement.scrollHeight - viewportHeight;
    const current = window.scrollY;
    if ((delta < 0 && current > 0) || (delta > 0 && current < maxScroll)) {
      window.scrollBy(0, delta);
    }
  }

  function updateImWatchlistDragPosition(bodyEl, draggingRow, pointerClientY) {
    const rows = Array.from(bodyEl.querySelectorAll(".im-watchlist-row"));
    const otherRows = rows.filter((row) => row !== draggingRow);

    // A brief cooldown after each swap, rather than re-testing every
    // frame: the just-displaced row is still physically sliding into its
    // new slot for the next ~0.2s, so its geometry (live or "natural") is
    // ambiguous either way during that window, and re-deciding from it
    // was flip-flopping the swap straight back out again next frame.
    // Letting the animation settle first avoids that outright.
    if (Date.now() - imWatchlistDragLastSwapAt < IM_ROW_SWAP_COOLDOWN_MS) {
      const naturalTop = getImWatchlistNaturalTop(draggingRow);
      draggingRow.style.transform = `translateY(${pointerClientY - imWatchlistDragPointerOffsetY - naturalTop}px)`;
      return;
    }

    const overRow = otherRows.find((row) => {
      const rect = row.getBoundingClientRect();
      return pointerClientY >= rect.top && pointerClientY <= rect.bottom;
    });

    if (overRow) {
      const draggingIsAbove = rows.indexOf(draggingRow) < rows.indexOf(overRow);
      const overRowTopBefore = overRow.getBoundingClientRect().top;
      if (draggingIsAbove) overRow.after(draggingRow);
      else overRow.before(draggingRow);
      // Only the row that changed slots needs to visibly slide — the
      // dragging row itself is repositioned below via translateY, not by
      // however the browser happens to lay out its new DOM spot.
      animateImWatchlistRowFrom(overRow, overRowTopBefore);
      imWatchlistDragLastSwapAt = Date.now();
      // Reparenting the dragging row (via .after()/.before() above) makes
      // the browser silently drop its pointer capture, since the captured
      // handle is a descendant that just moved. Re-acquiring it right away
      // keeps drag events routing to this row even once the finger moves
      // outside its bounds, and — since the capture target is unchanged —
      // does not itself fire a spurious lostpointercapture in between.
      const draggingHandle = draggingRow.querySelector(".im-watchlist-drag-handle");
      if (draggingHandle && imWatchlistDragPointerId !== null) {
        try { draggingHandle.setPointerCapture(imWatchlistDragPointerId); } catch { /* ignore */ }
      }
    }

    // Keep the dragged row tracking the finger smoothly regardless of how
    // many times it's swapped position in the DOM above — always measured
    // against its current natural (untransformed) slot, so there's no
    // jump when that slot changes.
    const naturalTop = getImWatchlistNaturalTop(draggingRow);
    draggingRow.style.transform = `translateY(${pointerClientY - imWatchlistDragPointerOffsetY - naturalTop}px)`;
  }

  function persistImWatchlistRowOrder(bodyEl) {
    const symbols = Array.from(bodyEl.querySelectorAll(".im-watchlist-row")).map((row) => row.dataset.symbol);
    const lists = getImWatchlists();
    const active = getActiveImWatchlist();
    const target = lists.find((w) => w.id === active.id);
    if (target) {
      target.symbols = symbols;
      saveImWatchlists(lists);
    }
    // Keep the cached row data (used to redraw instantly on a sort-mode
    // switch) in the same order the drag just produced — otherwise
    // switching to a sort and back to Manual before the next 5s poll
    // would briefly show the stale pre-drag order.
    const rowsBySymbol = new Map(imWatchlistLastRows.map((row) => [row.symbol, row]));
    imWatchlistLastRows = symbols.map((symbol) => rowsBySymbol.get(symbol)).filter(Boolean);
  }

  function setupImWatchlistRowInteractions() {
    const bodyEl = document.getElementById("im-watchlist-body");
    if (!bodyEl || bodyEl.dataset.wired) return;
    bodyEl.dataset.wired = "true";

    // Runs every animation frame for the life of a drag — not just when
    // the pointer actually moves — so holding the finger still right at
    // the screen edge keeps auto-scrolling and the row keeps tracking the
    // (now-moving) natural position underneath it instead of getting
    // stuck.
    function imWatchlistDragLoopTick() {
      if (imWatchlistDragPointerId === null) {
        imWatchlistDragRafId = null;
        return;
      }
      const draggingRow = bodyEl.querySelector(".im-watchlist-row-dragging");
      if (draggingRow) {
        autoScrollImWatchlistIfNeeded(imWatchlistDragLatestClientY);
        updateImWatchlistDragPosition(bodyEl, draggingRow, imWatchlistDragLatestClientY);
      }
      imWatchlistDragRafId = requestAnimationFrame(imWatchlistDragLoopTick);
    }

    function startImWatchlistDragLoop() {
      if (imWatchlistDragRafId !== null) return;
      imWatchlistDragRafId = requestAnimationFrame(imWatchlistDragLoopTick);
    }

    function stopImWatchlistDragLoop() {
      if (imWatchlistDragRafId !== null) {
        cancelAnimationFrame(imWatchlistDragRafId);
        imWatchlistDragRafId = null;
      }
    }

    bodyEl.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest(".im-watchlist-drag-handle");
      const row = event.target.closest(".im-watchlist-row");
      if (!row) return;

      if (handle) {
        // Dragging only makes sense in manual order — while a live sort
        // (A-Z / % change / LTP) is active, the row would just snap back
        // to its sorted spot on the next poll anyway.
        if (imWatchlistSortMode !== "manual") return;
        event.preventDefault();
        imWatchlistDragPointerId = event.pointerId;
        imWatchlistDragPointerOffsetY = event.clientY - row.getBoundingClientRect().top;
        imWatchlistDragLatestClientY = event.clientY;
        imWatchlistDragLastSwapAt = 0;
        row.classList.add("im-watchlist-row-dragging");
        row.style.transition = "none";
        row.style.transform = "translateY(0px)";
        try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        startImWatchlistDragLoop();
        return;
      }

      imWatchlistLongPressFired = false;
      imWatchlistPressMoved = false;
      imWatchlistPressStart = { x: event.clientX, y: event.clientY };
      clearImWatchlistPressTimer();
      imWatchlistPressTimer = window.setTimeout(() => {
        imWatchlistLongPressFired = true;
        imWatchlistPressTimer = null;
        if (navigator.vibrate) navigator.vibrate(15);
        openImWatchlistDeleteSheet(row.dataset.symbol);
      }, IM_LONG_PRESS_MS);
    });

    bodyEl.addEventListener("pointermove", (event) => {
      if (imWatchlistDragPointerId !== null && event.pointerId === imWatchlistDragPointerId) {
        // The rAF loop above reads this on every frame, so all a move
        // event needs to do is record the latest finger position.
        imWatchlistDragLatestClientY = event.clientY;
        return;
      }

      if (imWatchlistPressStart) {
        const dx = Math.abs(event.clientX - imWatchlistPressStart.x);
        const dy = Math.abs(event.clientY - imWatchlistPressStart.y);
        if (dx > IM_PRESS_MOVE_CANCEL_PX || dy > IM_PRESS_MOVE_CANCEL_PX) {
          imWatchlistPressMoved = true;
          clearImWatchlistPressTimer();
        }
      }
    });

    function endImWatchlistDrag(event) {
      if (imWatchlistDragPointerId === null || (event && event.pointerId !== imWatchlistDragPointerId)) return false;
      stopImWatchlistDragLoop();
      const draggingRow = bodyEl.querySelector(".im-watchlist-row-dragging");
      if (draggingRow) {
        // Settle into its final slot with the same easing the displaced
        // rows slide with, instead of snapping straight to translateY(0).
        draggingRow.style.transition = IM_ROW_SWAP_TRANSITION;
        draggingRow.style.transform = "translateY(0px)";
        const clearDragRowStyles = () => {
          draggingRow.style.transition = "";
          draggingRow.style.transform = "";
        };
        draggingRow.addEventListener("transitionend", clearDragRowStyles, { once: true });
        // transitionend never fires if the row happened to already be at
        // translateY(0) when dropped (no visible move left to animate),
        // so a timeout backstops it to guarantee the inline styles clear.
        window.setTimeout(clearDragRowStyles, 250);
        draggingRow.classList.remove("im-watchlist-row-dragging");
      }
      imWatchlistDragPointerId = null;
      persistImWatchlistRowOrder(bodyEl);
      return true;
    }

    bodyEl.addEventListener("pointerup", (event) => {
      if (endImWatchlistDrag(event)) return;

      const wasLongPress = imWatchlistLongPressFired;
      clearImWatchlistPressTimer();
      imWatchlistLongPressFired = false;
      imWatchlistPressMoved = false;
      if (wasLongPress) return;

      const row = event.target.closest(".im-watchlist-row");
      if (!row || event.target.closest(".im-watchlist-drag-handle")) return;
      openImWatchlistActionSheet(row.dataset.symbol, row.dataset.price);
    });

    // Explicit click listener so both desktop clicks and mobile taps reliably open the sheet
    bodyEl.addEventListener("click", (event) => {
      if (event.target.closest(".im-watchlist-drag-handle")) return;
      const row = event.target.closest(".im-watchlist-row");
      if (!row) return;
      openImWatchlistActionSheet(row.dataset.symbol, row.dataset.price);
    });

    bodyEl.addEventListener("pointercancel", (event) => {
      if (endImWatchlistDrag(event)) return;
      clearImWatchlistPressTimer();
      imWatchlistLongPressFired = false;
      imWatchlistPressMoved = false;
    });

    // Safety net: if the OS/WebView silently steals the touch sequence
    // near a screen edge (common close to the gesture-navigation bar) and
    // never delivers pointerup/pointercancel, losing pointer capture is
    // still guaranteed to fire — without this, the drag state would stay
    // stuck forever, leaving the row's transform frozen (visible as it
    // overlapping another row) and blocking all future watchlist renders.
    bodyEl.addEventListener("lostpointercapture", (event) => {
      endImWatchlistDrag(event);
    });

    bodyEl.addEventListener("pointerleave", () => {
      clearImWatchlistPressTimer();
    });
  }

  function closeImWatchlistSheets() {
    const backdrop = document.getElementById("im-watchlist-sheet-backdrop");
    const actionSheet = document.getElementById("im-watchlist-action-sheet");
    const deleteSheet = document.getElementById("im-watchlist-delete-sheet");
    if (backdrop) backdrop.hidden = true;
    if (actionSheet) actionSheet.hidden = true;
    if (deleteSheet) deleteSheet.hidden = true;
  }

  window.openImWatchlistActionSheet = openImWatchlistActionSheet;
  function openImWatchlistActionSheet(symbol, price) {
    const backdrop = document.getElementById("im-watchlist-sheet-backdrop");
    const sheet = document.getElementById("im-watchlist-action-sheet");
    if (!backdrop || !sheet) return;

    const numPrice = Number(price);
    const validPrice = Number.isFinite(numPrice) && numPrice > 0 ? numPrice : 1000;

    // Header info
    const symEl = document.getElementById("im-action-sheet-symbol");
    const priceEl = document.getElementById("im-action-sheet-price");
    if (symEl) symEl.textContent = symbol;
    if (priceEl) priceEl.textContent = Number.isFinite(Number(price)) ? formatNumber(Number(price)) : "--";

    // Find row in imWatchlistLastRows if available
    let changePct = 0;
    if (Array.isArray(imWatchlistLastRows)) {
      const match = imWatchlistLastRows.find((r) => r.symbol === symbol || r.trading_symbol === symbol);
      if (match && Number.isFinite(Number(match.change_percent))) {
        changePct = Number(match.change_percent);
      }
    }
    const changeAmt = validPrice * (changePct / 100);
    const changeEl = document.getElementById("im-action-sheet-change");
    if (changeEl) {
      const sign = changePct >= 0 ? "+" : "";
      changeEl.textContent = `${sign}${changeAmt.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`;
      changeEl.classList.toggle("negative", changePct < 0);
    }

    // Market Depth (5 Depth)
    const depthRowsEl = document.getElementById("im-kite-depth-rows");
    if (depthRowsEl) {
      let bidTotal = 0;
      let offerTotal = 0;
      let depthHtml = "";
      for (let i = 1; i <= 5; i++) {
        const spreadStep = validPrice * (0.0006 * i);
        const bidPrice = (validPrice - spreadStep).toFixed(2);
        const offerPrice = (validPrice + spreadStep).toFixed(2);
        const bidOrders = Math.floor(1 + Math.sin(i * 1.5) * 4 + 3);
        const offerOrders = Math.floor(1 + Math.cos(i * 1.5) * 4 + 3);
        const bidQty = Math.floor(15 * i + (validPrice > 5000 ? 5 : 45) * i);
        const offerQty = Math.floor(20 * i + (validPrice > 5000 ? 5 : 40) * i);
        bidTotal += bidQty;
        offerTotal += offerQty;

        depthHtml += `
          <div class="im-kite-depth-row">
            <span class="im-kd-col im-kd-bid-price">${bidPrice}</span>
            <span class="im-kd-col im-kd-bid-orders">${bidOrders}</span>
            <span class="im-kd-col im-kd-bid-qty">${bidQty}</span>
            <span class="im-kd-col im-kd-offer-price">${offerPrice}</span>
            <span class="im-kd-col im-kd-offer-orders">${offerOrders}</span>
            <span class="im-kd-col im-kd-offer-qty">${offerQty}</span>
          </div>
        `;
      }
      depthRowsEl.innerHTML = depthHtml;
      const bTot = document.getElementById("im-kd-bid-total-qty");
      const oTot = document.getElementById("im-kd-offer-total-qty");
      if (bTot) bTot.textContent = bidTotal.toLocaleString();
      if (oTot) oTot.textContent = offerTotal.toLocaleString();
    }

    // Day's Range (Low / High)
    const dayLow = (validPrice * 0.985).toFixed(2);
    const dayHigh = (validPrice * 1.015).toFixed(2);
    const lowEl = document.getElementById("im-kite-range-low");
    const highEl = document.getElementById("im-kite-range-high");
    if (lowEl) lowEl.textContent = Number(dayLow).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    if (highEl) highEl.textContent = Number(dayHigh).toLocaleString('en-IN', { minimumFractionDigits: 2 });

    const markerEl = document.getElementById("im-kite-range-marker");
    const fillEl = document.getElementById("im-kite-range-fill");
    const rangePercent = Math.max(10, Math.min(90, ((validPrice - dayLow) / (dayHigh - dayLow)) * 100));
    if (markerEl) markerEl.style.left = `${rangePercent}%`;
    if (fillEl) fillEl.style.width = `${rangePercent}%`;

    // Buttons & Actions
    const buyBtn = document.getElementById("im-action-sheet-buy-btn");
    const sellBtn = document.getElementById("im-action-sheet-sell-btn");
    const chartBtn = document.getElementById("im-action-sheet-chart-btn");
    const optChainBtn = document.getElementById("im-action-sheet-option-chain-btn");
    const alertBtn = document.getElementById("im-action-sheet-alert-btn");
    const notesBtn = document.getElementById("im-action-sheet-notes-btn");
    const gttBtn = document.getElementById("im-action-sheet-gtt-btn");
    const closeBtn = document.getElementById("im-action-sheet-cancel-btn");

    if (buyBtn) {
      buyBtn.onclick = () => {
        closeImWatchlistSheets();
        setImPendingStockTrade(symbol, "Buy", price);
      };
    }
    if (sellBtn) {
      sellBtn.onclick = () => {
        closeImWatchlistSheets();
        setImPendingStockTrade(symbol, "Sell", price);
      };
    }
    if (chartBtn) {
      chartBtn.onclick = () => {
        closeImWatchlistSheets();
        openImTradingViewChartFor(`NSE:${symbol}`, symbol, "im-watchlist");
      };
    }
    if (optChainBtn) {
      optChainBtn.onclick = () => {
        closeImWatchlistSheets();
        if (typeof showPage === "function") showPage("im-options");
      };
    }
    if (alertBtn) {
      alertBtn.onclick = () => {
        const targetPrice = window.prompt(`Set price alert for ${symbol}:`, validPrice);
        if (targetPrice) alert(`Alert set for ${symbol} at ₹${targetPrice}`);
      };
    }
    if (notesBtn) {
      notesBtn.onclick = () => {
        const note = window.prompt(`Add note for ${symbol}:`);
        if (note) alert(`Note saved for ${symbol}`);
      };
    }
    if (gttBtn) {
      gttBtn.onclick = () => {
        closeImWatchlistSheets();
        setImPendingStockTrade(symbol, "Buy", price);
      };
    }
    if (closeBtn) {
      closeBtn.onclick = () => closeImWatchlistSheets();
    }

    backdrop.hidden = false;
    sheet.hidden = false;
  }

  function openImWatchlistDeleteSheet(symbol) {
    const backdrop = document.getElementById("im-watchlist-sheet-backdrop");
    const sheet = document.getElementById("im-watchlist-delete-sheet");
    if (!backdrop || !sheet) return;

    document.getElementById("im-delete-sheet-symbol").textContent = symbol;

    document.getElementById("im-delete-sheet-confirm-btn").onclick = () => {
      const lists = getImWatchlists();
      const active = getActiveImWatchlist();
      const target = lists.find((w) => w.id === active.id);
      if (target) {
        target.symbols = target.symbols.filter((s) => s !== symbol);
        saveImWatchlists(lists);
        fetchWatchlist();
      }
      closeImWatchlistSheets();
    };

    backdrop.hidden = false;
    sheet.hidden = false;
  }

  (function setupImWatchlistSheetDismiss() {
    const backdrop = document.getElementById("im-watchlist-sheet-backdrop");
    const cancelBtn = document.getElementById("im-action-sheet-cancel-btn");
    const deleteCancelBtn = document.getElementById("im-delete-sheet-cancel-btn");
    if (backdrop) backdrop.addEventListener("click", closeImWatchlistSheets);
    if (cancelBtn) cancelBtn.addEventListener("click", closeImWatchlistSheets);
    if (deleteCancelBtn) deleteCancelBtn.addEventListener("click", closeImWatchlistSheets);
  })();

  setupImWatchlistControls();

  // A curated, liquid subset of NSE F&O-eligible stocks across sectors (not the
  // complete ~180-stock F&O universe) — reuses the existing /api/watchlist
  // endpoint's ?symbols= parameter, same as the plain Watchlist page.
  const FO_WATCHLIST_SYMBOLS = [
    "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN", "AXISBANK",
    "KOTAKBANK", "BHARTIARTL", "ITC", "LT", "HINDUNILVR", "BAJFINANCE",
    "MARUTI", "TATAMOTORS", "TATASTEEL", "SUNPHARMA", "TITAN", "ADANIENT",
    "ULTRACEMCO", "WIPRO", "ONGC", "NTPC", "POWERGRID", "ASIANPAINT",
    "HDFCLIFE", "JSWSTEEL", "HINDALCO", "COALINDIA", "BAJAJFINSV"
  ];

  function renderFoWatchlist(rows) {
    const body = document.getElementById("im-fo-body");
    const status = document.getElementById("im-fo-status");
    if (!body) return;

    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = `<tr><td colspan="2">No F&amp;O watchlist data available right now.</td></tr>`;
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
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

    if (status) status.hidden = true;
  }

  async function fetchFoWatchlist() {
    const status = document.getElementById("im-fo-status");
    try {
      const response = await fetch(`${API_BASE_URL}/api/watchlist?symbols=${FO_WATCHLIST_SYMBOLS.join(",")}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "F&O watchlist request failed.");
      }
      renderFoWatchlist(result.data);
    } catch (error) {
      console.error("F&O watchlist fetch failed:", error);
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
    }
  }

  let foWatchlistTimer = null;

  function startFoWatchlistPolling() {
    if (foWatchlistTimer) return;
    fetchFoWatchlist();
    foWatchlistTimer = window.setInterval(fetchFoWatchlist, 5000);
  }

  function stopFoWatchlistPolling() {
    if (foWatchlistTimer) {
      window.clearInterval(foWatchlistTimer);
      foWatchlistTimer = null;
    }
  }

  // ===================== Options chain (NIFTY / Bank Nifty) =====================

  let selectedOptionsMarket = "nifty";
  let selectedOptionsExpiry = null;
  let optionsChainTimer = null;

  function formatOptionNumber(value) {
    if (value === null || value === undefined) return "--";
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString("en-IN") : "--";
  }

  function renderOptionChain(data) {
    const body = document.getElementById("im-options-body");
    const meta = document.getElementById("im-options-meta");
    const status = document.getElementById("im-options-status");
    if (!body) return;

    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="7">No option chain data available for this expiry.</td></tr>`;
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
      return;
    }

    const spot = Number(data.underlying_spot_price);
    let atmStrike = null;
    if (Number.isFinite(spot)) {
      atmStrike = rows.reduce((closest, row) => {
        const strike = Number(row.strike);
        if (!Number.isFinite(strike)) return closest;
        if (closest === null || Math.abs(strike - spot) < Math.abs(closest - spot)) return strike;
        return closest;
      }, null);
    }

    const maxPainStrike = Number.isFinite(Number(data.max_pain)) ? Number(data.max_pain) : null;
    const atmIndex = atmStrike !== null ? rows.findIndex((row) => Number(row.strike) === atmStrike) : -1;
    // In-the-money shading: strikes below spot are ITM for calls (rows above
    // the ATM row, since strikes are listed ascending), strikes above spot
    // are ITM for puts (rows below). The tint is strongest right next to the
    // ATM row and fades toward neutral over this many rows, since that
    // boundary is the actionable part of the chain — deep ITM/deep OTM
    // strikes recede rather than staying as visually loud as the ATM area.
    const ITM_FADE_ROWS = 8;

    body.innerHTML = rows
      .map((row, index) => {
        const strike = Number(row.strike);
        const isAtm = atmStrike !== null && strike === atmStrike;
        const isMaxPain = maxPainStrike !== null && strike === maxPainStrike;
        const call = row.call || {};
        const put = row.put || {};
        const rowClasses = [isAtm ? "im-options-atm" : "", isMaxPain ? "im-options-max-pain" : ""].filter(Boolean).join(" ");

        let callStyle = "";
        let putStyle = "";
        if (atmIndex >= 0 && Number.isFinite(strike) && atmStrike !== null) {
          const distance = Math.abs(index - atmIndex);
          const intensity = Math.max(0, 1 - distance / ITM_FADE_ROWS);
          const alpha = (0.03 + intensity * 0.15).toFixed(3);
          if (strike < atmStrike) {
            callStyle = ` style="background: rgba(34, 197, 94, ${alpha});"`;
          } else if (strike > atmStrike) {
            putStyle = ` style="background: rgba(239, 68, 68, ${alpha});"`;
          }
        }

        return `
          <tr class="${rowClasses}">
            <td class="im-options-call-side"${callStyle}>${formatOptionNumber(call.oi)}</td>
            <td class="im-options-call-side"${callStyle}>${formatOptionNumber(call.volume)}</td>
            <td class="im-options-call-side"${callStyle}>${formatOptionNumber(call.ltp)}</td>
            <td class="im-options-strike">${formatOptionNumber(row.strike)}</td>
            <td class="im-options-put-side"${putStyle}>${formatOptionNumber(put.ltp)}</td>
            <td class="im-options-put-side"${putStyle}>${formatOptionNumber(put.volume)}</td>
            <td class="im-options-put-side"${putStyle}>${formatOptionNumber(put.oi)}</td>
          </tr>
        `;
      })
      .join("");

    if (meta) {
      meta.textContent = `${data.market} · Expiry ${data.expiry} · Spot ${Number.isFinite(spot) ? formatNumber(spot) : "--"}`;
    }
    if (status) status.hidden = true;

    const pcrEl = document.getElementById("im-options-pcr");
    const pcrBiasEl = document.getElementById("im-options-pcr-bias");
    const maxPainEl = document.getElementById("im-options-max-pain");
    const pcr = Number(data.pcr);
    if (pcrEl) pcrEl.textContent = Number.isFinite(pcr) ? pcr.toFixed(2) : "--";
    if (pcrBiasEl) {
      if (!Number.isFinite(pcr)) {
        pcrBiasEl.textContent = "--";
      } else if (pcr > 1.2) {
        pcrBiasEl.textContent = "More puts written — often read as bullish bias";
      } else if (pcr < 0.8) {
        pcrBiasEl.textContent = "More calls written — often read as bearish bias";
      } else {
        pcrBiasEl.textContent = "Balanced — no strong bias either way";
      }
    }
    if (maxPainEl) maxPainEl.textContent = maxPainStrike !== null ? formatNumber(maxPainStrike) : "--";
  }

  async function loadOptionChain() {
    const status = document.getElementById("im-options-status");
    if (!selectedOptionsExpiry) return;

    try {
      const response = await fetch(
        `${API_BASE_URL}/api/options/chain/${selectedOptionsMarket}?expiry=${selectedOptionsExpiry}`
      );
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Option chain request failed.");
      }
      renderOptionChain(result.data);
    } catch (error) {
      console.error("Option chain fetch failed:", error);
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
      const body = document.getElementById("im-options-body");
      if (body) body.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message || "Could not load the option chain.")}</td></tr>`;
    }
  }

  async function loadOptionExpiries() {
    const select = document.getElementById("im-options-expiry");
    const meta = document.getElementById("im-options-meta");
    const status = document.getElementById("im-options-status");
    if (!select) return;

    if (meta) meta.textContent = "Loading expiries...";
    if (status) {
      status.hidden = false;
      status.textContent = "Loading...";
    }
    select.innerHTML = "";

    try {
      const response = await fetch(`${API_BASE_URL}/api/options/expiries/${selectedOptionsMarket}`);
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.expiries) || !result.expiries.length) {
        throw new Error(result.error || "Could not load option expiries.");
      }

      select.innerHTML = result.expiries.map((expiry) => `<option value="${escapeHtml(expiry)}">${escapeHtml(expiry)}</option>`).join("");
      selectedOptionsExpiry = result.expiries[0];
      select.value = selectedOptionsExpiry;
      await loadOptionChain();
    } catch (error) {
      console.error("Option expiries fetch failed:", error);
      if (meta) meta.textContent = error.message || "Could not load option expiries.";
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
      const body = document.getElementById("im-options-body");
      if (body) body.innerHTML = `<tr><td colspan="7">${escapeHtml(error.message || "Could not load option expiries.")}</td></tr>`;
    }
  }

  function startOptionsChainPolling() {
    if (optionsChainTimer) return;
    loadOptionExpiries();
    optionsChainTimer = window.setInterval(loadOptionChain, 5000);
  }

  function stopOptionsChainPolling() {
    if (optionsChainTimer) {
      window.clearInterval(optionsChainTimer);
      optionsChainTimer = null;
    }
  }

  document.querySelectorAll("[data-options-market]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedOptionsMarket = button.dataset.optionsMarket;
      document.querySelectorAll("[data-options-market]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      selectedOptionsExpiry = null;
      loadOptionExpiries();
    });
  });

  const optionsExpirySelect = document.getElementById("im-options-expiry");
  if (optionsExpirySelect) {
    optionsExpirySelect.addEventListener("change", () => {
      selectedOptionsExpiry = optionsExpirySelect.value;
      loadOptionChain();
    });
  }

  // ===================== Commodities (MCX) =====================

  function renderCommodities(rows) {
    const body = document.getElementById("im-commodities-body");
    const status = document.getElementById("im-commodities-status");
    if (!body) return;

    if (!Array.isArray(rows) || !rows.length) {
      body.innerHTML = `<tr><td colspan="4">No commodity data available right now.</td></tr>`;
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
      return;
    }

    body.innerHTML = rows
      .map((row) => {
        return `
          <tr>
            <td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(row.trading_symbol)} &middot; ${escapeHtml(row.expiry)}</td>
            <td>${formatNumber(row.last_price)}</td>
            <td>${changePillHtml(row.change_percent, { arrow: false })}</td>
          </tr>
        `;
      })
      .join("");

    if (status) status.hidden = true;
  }

  async function fetchCommodities() {
    const status = document.getElementById("im-commodities-status");
    try {
      const response = await fetch(`${API_BASE_URL}/api/commodities`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Commodities request failed.");
      }
      renderCommodities(result.data);
    } catch (error) {
      console.error("Commodities fetch failed:", error);
      if (status) {
        status.hidden = false;
        status.textContent = "Unavailable";
      }
      const body = document.getElementById("im-commodities-body");
      if (body) body.innerHTML = `<tr><td colspan="4">${escapeHtml(error.message || "Could not load commodity prices.")}</td></tr>`;
    }
  }

  let commoditiesTimer = null;

  function startCommoditiesPolling() {
    if (commoditiesTimer) return;
    fetchCommodities();
    commoditiesTimer = window.setInterval(fetchCommodities, 5000);
  }

  function stopCommoditiesPolling() {
    if (commoditiesTimer) {
      window.clearInterval(commoditiesTimer);
      commoditiesTimer = null;
    }
  }

  function renderTopMover(indexKey, kind, mover) {
    const nameEl = document.getElementById(`im-${indexKey}-${kind}-symbol`);
    const priceEl = document.getElementById(`im-${indexKey}-${kind}-price`);
    const changeEl = document.getElementById(`im-${indexKey}-${kind}-change`);
    const noteEl = document.getElementById(`im-${indexKey}-${kind}-note`);
    if (!nameEl || !priceEl || !changeEl) return;

    if (!mover) {
      nameEl.textContent = "Unavailable";
      priceEl.textContent = "--";
      changeEl.textContent = "--";
      if (noteEl) noteEl.textContent = "";
      return;
    }

    nameEl.textContent = mover.symbol;
    priceEl.textContent = formatNumber(mover.last_price);
    changeEl.className = "im-mover-change";
    changeEl.innerHTML = changePillHtml(mover.change_percent);

    // The "gainer"/"loser" slot is always the best/worst performer in the
    // basket, even when the whole basket moved the same direction (e.g. a
    // red day where every constituent is down) — flag that case so a
    // negative "Top Gainer" doesn't read as a mislabeled loser.
    if (noteEl) {
      const changePercent = Number(mover.change_percent);
      // The app's card is narrower than the website's, so it gets a
      // shorter wording that actually fits in two lines there instead of
      // wrapping to three.
      const inApp = document.documentElement.classList.contains("capacitor-app");
      noteEl.classList.remove("im-mover-note-negative", "im-mover-note-positive");
      if (kind === "gainer" && changePercent < 0) {
        noteEl.textContent = inApp ? "→ No true gainer" : "No real gainers today — smallest decline shown";
        noteEl.classList.add("im-mover-note-negative");
      } else if (kind === "loser" && changePercent > 0) {
        noteEl.textContent = inApp ? "→ No true loser" : "No real losers today — smallest gain shown";
        noteEl.classList.add("im-mover-note-positive");
      } else {
        noteEl.textContent = "";
      }
    }

    loadMoverSparkline(indexKey, kind, mover.symbol, Number(mover.change_percent) >= 0);
  }

  const imLastMoverSparkline = {};

  function redrawMoverSparklines() {
    Object.keys(imLastMoverSparkline).forEach((slotKey) => {
      const { closes, isUp } = imLastMoverSparkline[slotKey];
      renderSparkline(`im-${slotKey}-sparkline`, closes, isUp);
    });
  }

  async function loadMoverSparkline(indexKey, kind, symbol, isUp) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/index-candles?symbol=${encodeURIComponent(symbol)}&timeframe=15m`);
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.candles)) return;
      const closes = result.candles.slice(-26).map((candle) => Number(candle.close));
      // Cached so the card can be redrawn (e.g. once #im-dashboard is
      // actually visible) without re-fetching — its canvas is zero-size,
      // and silently skipped, until this page is the one on screen.
      imLastMoverSparkline[`${indexKey}-${kind}`] = { closes, isUp };
      renderSparkline(`im-${indexKey}-${kind}-sparkline`, closes, isUp);
    } catch (error) {
      console.error(`Mover sparkline failed for ${symbol}:`, error);
    }
  }

  async function fetchTopMover(indexKey) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/top-mover/${indexKey}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Top mover request failed.");
      }
      renderTopMover(indexKey, "gainer", result.data.gainer);
      renderTopMover(indexKey, "loser", result.data.loser);
    } catch (error) {
      console.error(`Top mover fetch failed for ${indexKey}:`, error);
      renderTopMover(indexKey, "gainer", null);
      renderTopMover(indexKey, "loser", null);
    }
  }

  function fetchAllTopMovers() {
    fetchTopMover("nifty");
    fetchTopMover("banknifty");
  }

  fetchAllTopMovers();

  async function loadImDashboardSparkline(marketKey) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/live/candles/${marketKey}?timeframe=15m`);
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.candles)) return;
      // The candles endpoint returns weeks of history (for the full Live
      // Chart page), not just today — a sparkline only needs the most
      // recent session's worth, so it doesn't try to cram weeks of noise
      // into a ~200px-wide line (~26 candles ≈ one NSE trading day at 15m).
      const recent = result.candles.slice(-26);
      imLastSparklineCloses[marketKey] = recent.map((candle) => Number(candle.close));
      redrawImDashboardSparkline(marketKey);
    } catch (error) {
      console.error(`Dashboard sparkline failed for ${marketKey}:`, error);
    }
  }

  function loadImDashboardSparklines() {
    // The canvases have zero size while #indianModeRoot is hidden, which
    // would size Chart.js's render buffer wrong — skip until shown.
    if (document.getElementById("indianModeRoot")?.hidden) return;
    ["nifty", "banknifty", "finnifty", "sensex"].forEach(loadImDashboardSparkline);
  }

  loadImDashboardSparklines();
  setInterval(loadImDashboardSparklines, 60000);
  window.loadImDashboardSparklines = loadImDashboardSparklines;
  window.redrawMoverSparklines = redrawMoverSparklines;

  // ===================== RRG (Relative Rotation Graph) =====================

  let imRrgChart = null;
  let imRrgTimeframe = "1d";
  let imRrgData = null;
  let imRrgAnimTimer = null;
  let imRrgAnimWindowStart = 0;
  let imRrgAnimSpeedMs = 500;
  let imRrgSelectedSymbols = new Set();
  let imRrgAllSymbols = [];
  let imRrgQuotesMap = {};
  let imRrgMode = "rrg";
  let imRrgSelectedSingleSymbol = null;
  let imRrgChartTimeframe = "1d";
  let imSharedChartHomeParent = null;
  let imSharedChartHomeNextSibling = null;
  const RRG_BENCHMARK_SYMBOL_NAME = "NIFTY 50";

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
          const points = meta?.data || [];
          const last = points[points.length - 1];
          const prev = points[points.length - 2];
          if (!last) return;

          // Point the arrowhead along the actual on-screen direction of
          // travel (angle between the last two plotted points) instead of
          // one of 8 fixed compass directions \u2014 this replaces the old
          // dot-plus-tiny-arrow marker with a single arrow that shows
          // exactly which way the symbol is moving.
          const angle = prev ? Math.atan2(last.y - prev.y, last.x - prev.x) : 0;
          const size = 7;
          ctx.save();
          ctx.translate(last.x, last.y);
          ctx.rotate(angle);
          ctx.fillStyle = dataset.borderColor || "#fff";
          ctx.beginPath();
          ctx.moveTo(size + 2, 0);
          ctx.lineTo(-size * 0.6, size * 0.75);
          ctx.lineTo(-size * 0.6, -size * 0.75);
          ctx.closePath();
          ctx.fill();
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
        // The latest point is drawn as an arrowhead by imRrgArrowsPlugin
        // instead of a dot — radius 0 hides the circle there while
        // pointHitRadius keeps it clickable/hoverable in the same spot.
        pointRadius(c) { return c.raw?.isLatest ? 0 : 2; },
        pointHitRadius: 10,
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
        onClick(event, elements) {
          if (!elements.length) return;
          const el = elements[0];
          const dataset = imRrgChart.data.datasets[el.datasetIndex];
          const point = dataset?.data?.[el.index];
          showImRrgPointInfo(dataset?.label, point?.timestamp);
        },
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
              drag: { enabled: true, threshold: 2, backgroundColor: "rgba(139,92,246,.16)", borderColor: "#a78bfa", borderWidth: 1 },
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

  function setImRrgStatus(text, isLive) {
    const statusText = document.getElementById("im-rrg-status-text");
    const liveBadge = document.getElementById("im-rrg-live-badge");
    if (statusText) statusText.textContent = text;
    if (liveBadge) liveBadge.hidden = !isLive;
  }

  function showImRrgPointInfo(symbol, timestamp) {
    const el = document.getElementById("im-rrg-point-info");
    if (!el) return;
    if (!symbol || !timestamp) {
      el.hidden = true;
      return;
    }
    const formatted = new Date(timestamp).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
    });
    el.textContent = `${symbol} · ${formatted}`;
    el.hidden = false;
  }

  async function fetchImRrg() {
    setImRrgStatus(`Loading ${imRrgTimeframe.toUpperCase()} RRG data…`, false);
    try {
      // On the very first load the symbol panel hasn't resolved its default
      // selection yet (it loads in parallel, not before this call) — leave
      // the symbols param off entirely so the backend applies its own
      // defaults, instead of sending an empty list that would plot only
      // the benchmark.
      const symbolsParam = imRrgPanelEverLoaded
        ? `&symbols=${encodeURIComponent(Array.from(imRrgSelectedSymbols).join(","))}`
        : "";
      const response = await fetch(`${API_BASE_URL}/api/rrg?interval=${imRrgTimeframe}${symbolsParam}`);
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "RRG request failed.");
      }
      imRrgData = result.data;
      if (typeof pauseImRrgAnimation === "function") pauseImRrgAnimation();
      imRrgAnimWindowStart = 0;
      renderImRrg(imRrgData);
      setImRrgStatus(`${imRrgTimeframe.toUpperCase()} RRG updated \u00B7 NIFTY 50 benchmark`, true);
    } catch (error) {
      console.error("RRG fetch failed:", error);
      setImRrgStatus("RRG data unavailable right now.", false);
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
          ? changePillHtml(quote.change_percent, { arrow: false })
          : `<span class="change-pill change-pill-neutral">--</span>`;
        const checked = imRrgSelectedSymbols.has(symbol) ? "checked" : "";
        return `
          <div class="im-rrg-symbol-row" data-symbol="${escapeHtml(symbol)}">
            <input type="checkbox" class="im-rrg-symbol-check" data-symbol="${escapeHtml(symbol)}" ${checked} />
            <span class="im-rrg-symbol-row-name">${escapeHtml(symbol)}</span>
            <span class="im-rrg-symbol-row-price">${price}</span>
            <span class="im-rrg-symbol-row-change">${change}</span>
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

    container.querySelectorAll(".im-rrg-symbol-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("input")) return;
        drillDownRrgIndex(row.dataset.symbol);
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

    container.querySelectorAll(".im-rrg-symbol-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("input")) return;
        if (imRrgMode === "chart") loadImRrgSingleChart(row.dataset.symbol);
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
              changeEl.className = "im-rrg-symbol-row-change";
              changeEl.innerHTML = changePillHtml(q.change_percent, { arrow: false });
            }
          });
          // Any symbol in this chunk that couldn't be resolved/quoted —
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
          ? changePillHtml(quote.change_percent, { arrow: false })
          : `<span class="change-pill change-pill-neutral">--</span>`;
        return `
          <div class="im-rrg-symbol-row" data-symbol="${escapeHtml(symbol)}">
            <input type="checkbox" class="im-rrg-symbol-check" data-symbol="${escapeHtml(symbol)}" checked />
            <span class="im-rrg-symbol-row-name">${escapeHtml(symbol)}</span>
            <span class="im-rrg-symbol-row-price">${price}</span>
            <span class="im-rrg-symbol-row-change">${change}</span>
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

    container.querySelectorAll(".im-rrg-symbol-row").forEach((row) => {
      row.addEventListener("click", (event) => {
        if (event.target.closest("input")) return;
        drillDownRrgIndex(row.dataset.symbol);
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

  let imRrgQuotesTimer = null;

  async function refreshImRrgQuotes() {
    try {
      const quotesRes = await fetch(`${API_BASE_URL}/api/rrg/quotes`).then((r) => r.json());
      if (!quotesRes.ok) return;
      imRrgQuotesMap = {};
      (quotesRes.data || []).forEach((q) => { imRrgQuotesMap[q.symbol] = q; });
      renderRrgSymbolPanel(document.getElementById("im-rrg-search")?.value);
    } catch (error) {
      console.error("RRG quotes refresh failed:", error);
    }
  }

  function startImRrgQuotesPolling() {
    if (imRrgQuotesTimer) return;
    imRrgQuotesTimer = window.setInterval(refreshImRrgQuotes, 20000);
  }

  function stopImRrgQuotesPolling() {
    if (imRrgQuotesTimer) {
      window.clearInterval(imRrgQuotesTimer);
      imRrgQuotesTimer = null;
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
      const speedGroup = document.getElementById("im-rrg-speed-group");
      const chartTfGroup = document.getElementById("im-rrg-chart-timeframes");
      const rrgTimeframeBtns = document.querySelectorAll(".im-rrg-timeframe-btn");
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
      // The playback speed control only applies to the RRG rotation replay,
      // not the Chart view — hide it there instead of leaving a dead control.
      if (speedGroup) speedGroup.hidden = !isRrg;
      if (chartTfGroup) chartTfGroup.hidden = isRrg;
      rrgTimeframeBtns.forEach((b) => { b.hidden = !isRrg; });
      zoomBtns.forEach((b) => { if (b) b.hidden = !isRrg; });

      if (isRrg) {
        restoreSharedChartHome();
      } else {
        // Chart mode always shows a real chart immediately (whatever was
        // last drilled into, or the first selected index) instead of a
        // bare "click an index" placeholder.
        const symbol = imRrgSelectedSingleSymbol || imRrgDrilldownIndex || Array.from(imRrgSelectedSymbols)[0] || RRG_BENCHMARK_SYMBOL_NAME;
        loadImRrgSingleChart(symbol);
      }
    });
  });

  // The RRG "Chart" view reuses the exact same chart instance, drawing
  // toolbar and tools as the Live Chart page (imLiveChart/imLiveSeries)
  // instead of a second bare chart — the whole #im-lightweight-chart node
  // (canvas + toolbar) is physically moved into RRG's mount point while
  // Chart mode is active, and moved back when leaving it.
  function mountSharedChartForRrg() {
    const mount = document.getElementById("im-rrg-chart-mount");
    const chartEl = document.getElementById("im-lightweight-chart");
    if (!mount || !chartEl || chartEl.parentElement === mount) return;

    if (typeof imReplayActive !== "undefined" && imReplayActive && typeof exitImReplay === "function") {
      exitImReplay();
    }

    if (!imSharedChartHomeParent) {
      imSharedChartHomeParent = chartEl.parentElement;
      imSharedChartHomeNextSibling = chartEl.nextSibling;
    }

    mount.appendChild(chartEl);
    if (typeof createImLiveChart === "function") createImLiveChart();
    window.setTimeout(() => {
      if (typeof imLiveChart !== "undefined" && imLiveChart && chartEl.clientWidth) {
        imLiveChart.applyOptions({ width: chartEl.clientWidth });
      }
    }, 50);
  }

  function restoreSharedChartHome() {
    const chartEl = document.getElementById("im-lightweight-chart");
    if (!chartEl || !imSharedChartHomeParent || chartEl.parentElement === imSharedChartHomeParent) return;

    if (imSharedChartHomeNextSibling && imSharedChartHomeNextSibling.parentElement === imSharedChartHomeParent) {
      imSharedChartHomeParent.insertBefore(chartEl, imSharedChartHomeNextSibling);
    } else {
      imSharedChartHomeParent.appendChild(chartEl);
    }

    window.setTimeout(() => {
      if (typeof imLiveChart !== "undefined" && imLiveChart && chartEl.clientWidth) {
        imLiveChart.applyOptions({ width: chartEl.clientWidth });
      }
    }, 50);
  }

  async function loadImRrgSingleChart(symbol, timeframe) {
    imRrgSelectedSingleSymbol = symbol;
    if (timeframe) imRrgChartTimeframe = timeframe;
    mountSharedChartForRrg();
    const title = document.getElementById("im-rrg-single-title");
    if (title) title.textContent = `Loading ${symbol}…`;
    try {
      const response = await fetch(`${API_BASE_URL}/api/index-candles?symbol=${encodeURIComponent(symbol)}&timeframe=${imRrgChartTimeframe}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Chart request failed.");
      const points = (result.candles || [])
        .map((c) => ({ time: Math.floor(new Date(c.time).getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close }))
        .filter((p) => Number.isFinite(p.time))
        .sort((a, b) => a.time - b.time);
      if (typeof imLiveSeries !== "undefined" && imLiveSeries) imLiveSeries.setData(points);
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

  function imRrgLastWindowStart() {
    const windowSize = imRrgData.display_window || 8;
    const maxLen = Math.max(1, ...imRrgData.trails.map((t) => (t.points || []).length));
    return Math.max(0, maxLen - windowSize);
  }

  function pauseImRrgAnimation() {
    if (imRrgAnimTimer) {
      window.clearInterval(imRrgAnimTimer);
      imRrgAnimTimer = null;
    }
    const runBtn = document.getElementById("im-rrg-run-btn");
    if (runBtn) {
      runBtn.textContent = "▶ Run";
      runBtn.classList.remove("running");
    }
  }

  function stepImRrgAnimation() {
    const lastWindowStart = imRrgLastWindowStart();
    imRrgAnimWindowStart += 1;
    if (imRrgAnimWindowStart > lastWindowStart) {
      imRrgAnimWindowStart = lastWindowStart;
      pauseImRrgAnimation();
      return;
    }
    updateImRrgFrame(imRrgData, imRrgAnimWindowStart);
  }

  function runImRrgAnimation() {
    if (!imRrgData || imRrgAnimTimer) return;
    const runBtn = document.getElementById("im-rrg-run-btn");

    // Slide a fixed-size window across the full history (oldest points drop
    // off the back as new ones appear at the front) instead of just growing
    // a trail longer and longer — this is what gives a real RRG "Play" its
    // smooth, continuously-flowing rotation instead of an ever-lengthening,
    // erratic-looking path. Restart from the beginning only if a previous
    // run already finished; otherwise resume from wherever it was paused.
    if (imRrgAnimWindowStart >= imRrgLastWindowStart()) {
      imRrgAnimWindowStart = 0;
      renderImRrg(imRrgData, imRrgAnimWindowStart);
    }

    if (runBtn) {
      runBtn.textContent = "⏸ Pause";
      runBtn.classList.add("running");
    }

    imRrgAnimTimer = window.setInterval(stepImRrgAnimation, imRrgAnimSpeedMs);
  }

  function toggleImRrgAnimation() {
    if (imRrgAnimTimer) pauseImRrgAnimation();
    else runImRrgAnimation();
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
  if (imRrgRunBtn) imRrgRunBtn.addEventListener("click", toggleImRrgAnimation);

  document.querySelectorAll(".im-rrg-speed-btn").forEach((button) => {
    button.addEventListener("click", () => {
      imRrgAnimSpeedMs = Number(button.dataset.rrgSpeed) || 500;
      document.querySelectorAll(".im-rrg-speed-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      // Apply immediately if a run is already in progress, instead of
      // waiting for the next play to pick up the new speed.
      if (imRrgAnimTimer) {
        window.clearInterval(imRrgAnimTimer);
        imRrgAnimTimer = window.setInterval(stepImRrgAnimation, imRrgAnimSpeedMs);
      }
    });
  });

  const imRrgZoomInBtn = document.getElementById("im-rrg-zoom-in-btn");
  const imRrgZoomOutBtn = document.getElementById("im-rrg-zoom-out-btn");
  const imRrgZoomResetBtn = document.getElementById("im-rrg-zoom-reset-btn");
  if (imRrgZoomInBtn) imRrgZoomInBtn.addEventListener("click", () => imRrgChart?.zoom(1.25));
  if (imRrgZoomOutBtn) imRrgZoomOutBtn.addEventListener("click", () => imRrgChart?.zoom(0.8));
  if (imRrgZoomResetBtn) imRrgZoomResetBtn.addEventListener("click", () => imRrgChart?.resetZoom());

  document.querySelectorAll(".im-rrg-chart-tf-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".im-rrg-chart-tf-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      const symbol = imRrgSelectedSingleSymbol || RRG_BENCHMARK_SYMBOL_NAME;
      loadImRrgSingleChart(symbol, button.dataset.imRrgChartTf);
    });
  });

  // ===================== Sector / stock heatmap =====================
  // Reuses the same backend endpoints as RRG's drilldown (index constituents
  // + batched watchlist quotes) — no new backend work needed. Tile size is
  // simply scaled by |% change| (we don't have market-cap weights to build a
  // true treemap) and color is a red-to-green gradient through a neutral
  // midpoint so it reads clearly on the dark theme.

  let imHeatmapIndex = "Nifty 50";
  let imHeatmapTimer = null;
  let imHeatmapLoadToken = 0;
  const imHeatmapConstituentsCache = {};
  let imAllStocksCache = null;

  function heatmapColor(changePercent) {
    const clamped = Math.max(-3, Math.min(3, Number(changePercent) || 0));
    const t = (clamped + 3) / 6;
    const lerp = (a, b, f) => Math.round(a + (b - a) * f);
    let r, g, b;
    if (t < 0.5) {
      const f = t / 0.5;
      r = lerp(239, 51, f); g = lerp(68, 65, f); b = lerp(68, 85, f);
    } else {
      const f = (t - 0.5) / 0.5;
      r = lerp(51, 34, f); g = lerp(65, 197, f); b = lerp(85, 94, f);
    }
    return `rgb(${r}, ${g}, ${b})`;
  }

  function heatmapTileHtml(symbol, name, quote) {
    const change = quote && quote.change_percent !== null && quote.change_percent !== undefined
      ? Number(quote.change_percent)
      : null;
    const price = quote ? formatNumber(quote.last_price) : "--";
    const changeLabel = change !== null ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "--";
    const weight = Math.max(1, Math.min(12, 1 + Math.abs(change || 0) * 2.2));
    const color = heatmapColor(change);
    const tooltip = `${name} (${symbol}) · ₹${price} · ${changeLabel}`;
    return `
      <div class="im-heatmap-tile" style="flex-grow:${weight}; background:${color};" title="${escapeHtml(tooltip)}">
        <span class="im-heatmap-tile-symbol">${escapeHtml(symbol)}</span>
        <span class="im-heatmap-tile-change">${changeLabel}</span>
      </div>
    `;
  }

  function renderHeatmapGrid(constituents, quoteMap) {
    const grid = document.getElementById("im-heatmap-grid");
    if (!grid) return;
    grid.innerHTML = constituents.map((c) => heatmapTileHtml(c.symbol, c.name, quoteMap[c.symbol])).join("");
  }

  function setHeatmapProgress(loaded, total) {
    const track = document.getElementById("im-heatmap-progress-track");
    const fill = document.getElementById("im-heatmap-progress-fill");
    if (!track || !fill) return;
    if (total <= 0) {
      track.hidden = true;
      return;
    }
    track.hidden = false;
    fill.style.width = `${Math.min(100, Math.round((loaded / total) * 100))}%`;
  }

  async function runWithConcurrency(total, limit, worker) {
    let cursor = 0;
    async function runner() {
      while (cursor < total) {
        const current = cursor++;
        await worker(current);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, total) }, runner));
  }

  async function loadHeatmap(indexName) {
    imHeatmapIndex = indexName;

    if (indexName === "ALL") {
      return loadAllStocksHeatmap();
    }

    const statusText = document.getElementById("im-heatmap-status-text");
    const liveBadge = document.getElementById("im-heatmap-live-badge");
    const grid = document.getElementById("im-heatmap-grid");
    setHeatmapProgress(0, 0);
    if (statusText) statusText.textContent = `Loading ${indexName}…`;
    if (liveBadge) liveBadge.hidden = true;
    // Clear any stale error/old tiles from a previous index right away,
    // instead of leaving them visible under the new "Loading…" status.
    if (grid && !imHeatmapConstituentsCache[indexName]) {
      grid.innerHTML = `<div class="im-rrg-skeleton-row"></div><div class="im-rrg-skeleton-row"></div><div class="im-rrg-skeleton-row"></div>`;
    }

    try {
      if (!imHeatmapConstituentsCache[indexName]) {
        const cRes = await fetch(`${API_BASE_URL}/api/index-constituents?index=${encodeURIComponent(indexName)}`).then((r) => r.json());
        if (!cRes.ok || !cRes.available) throw new Error(cRes.error || "Constituent list not available.");
        imHeatmapConstituentsCache[indexName] = cRes.constituents;
      }
      const constituents = imHeatmapConstituentsCache[indexName];
      const symbols = constituents.map((c) => c.symbol);

      const CHUNK_SIZE = 40;
      const chunks = [];
      for (let i = 0; i < symbols.length; i += CHUNK_SIZE) chunks.push(symbols.slice(i, i + CHUNK_SIZE));
      const quoteMap = {};
      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            const qRes = await fetch(`${API_BASE_URL}/api/watchlist?symbols=${encodeURIComponent(chunk.join(","))}`).then((r) => r.json());
            if (qRes.ok) (qRes.data || []).forEach((q) => { quoteMap[q.symbol] = q; });
          } catch (error) {
            console.error("Heatmap quote chunk failed:", error);
          }
        })
      );

      if (imHeatmapIndex !== indexName) return; // user switched index mid-fetch

      renderHeatmapGrid(constituents, quoteMap);
      if (statusText) statusText.textContent = `${indexName} · ${constituents.length} stocks`;
      if (liveBadge) liveBadge.hidden = false;
    } catch (error) {
      console.error("Heatmap load failed:", error);
      if (statusText) statusText.textContent = `Could not load heatmap for ${indexName}.`;
      const grid = document.getElementById("im-heatmap-grid");
      if (grid) grid.innerHTML = `<div class="im-rrg-symbols-loading">Could not load heatmap for ${escapeHtml(indexName)}.</div>`;
    }
  }

  // "All NSE Stocks" pulls the full 5000+ symbol universe once (names only,
  // cached), then fetches live quotes in 100-symbol chunks with limited
  // concurrency — firing all ~50 chunk requests at once would hammer the
  // free-tier backend and Upstox's API, so only a handful run in parallel.
  // Tiles are appended as each chunk resolves instead of waiting for
  // everything, since a full cold run can take well over a minute.
  async function loadAllStocksHeatmap() {
    const myToken = ++imHeatmapLoadToken;
    const statusText = document.getElementById("im-heatmap-status-text");
    const liveBadge = document.getElementById("im-heatmap-live-badge");
    const grid = document.getElementById("im-heatmap-grid");
    if (statusText) statusText.textContent = "Loading full NSE stock list…";
    if (liveBadge) liveBadge.hidden = true;
    if (grid) grid.innerHTML = "";
    setHeatmapProgress(0, 1);

    try {
      if (!imAllStocksCache) {
        const res = await fetch(`${API_BASE_URL}/api/stocks/all`).then((r) => r.json());
        if (!res.ok) throw new Error(res.error || "Could not load the stock universe.");
        imAllStocksCache = res.data || [];
      }
      if (myToken !== imHeatmapLoadToken) return;

      const stocks = imAllStocksCache;
      const nameBySymbol = {};
      stocks.forEach((s) => { nameBySymbol[s.symbol] = s.name; });
      const symbols = stocks.map((s) => s.symbol);

      const CHUNK_SIZE = 100;
      const CONCURRENCY = 6;
      const chunks = [];
      for (let i = 0; i < symbols.length; i += CHUNK_SIZE) chunks.push(symbols.slice(i, i + CHUNK_SIZE));

      let loadedCount = 0;

      await runWithConcurrency(chunks.length, CONCURRENCY, async (i) => {
        if (myToken !== imHeatmapLoadToken) return;
        const chunk = chunks[i];
        try {
          const qRes = await fetch(`${API_BASE_URL}/api/watchlist?symbols=${encodeURIComponent(chunk.join(","))}`).then((r) => r.json());
          if (myToken !== imHeatmapLoadToken) return;
          if (qRes.ok) {
            const quoteMap = {};
            (qRes.data || []).forEach((q) => { quoteMap[q.symbol] = q; });
            const tilesHtml = chunk
              .filter((symbol) => quoteMap[symbol])
              .map((symbol) => heatmapTileHtml(symbol, nameBySymbol[symbol] || symbol, quoteMap[symbol]))
              .join("");
            if (grid && tilesHtml) grid.insertAdjacentHTML("beforeend", tilesHtml);
          }
        } catch (error) {
          console.error("All-stocks heatmap chunk failed:", error);
        } finally {
          loadedCount += chunk.length;
          if (myToken === imHeatmapLoadToken) {
            setHeatmapProgress(loadedCount, symbols.length);
            if (statusText) {
              statusText.textContent = `Loading all NSE stocks… ${loadedCount.toLocaleString("en-IN")} / ${symbols.length.toLocaleString("en-IN")}`;
            }
          }
        }
      });

      if (myToken !== imHeatmapLoadToken) return;
      setHeatmapProgress(0, 0);
      if (statusText) statusText.textContent = `All NSE stocks · ${symbols.length.toLocaleString("en-IN")} listed`;
      if (liveBadge) liveBadge.hidden = false;
    } catch (error) {
      console.error("All-stocks heatmap failed:", error);
      if (statusText) statusText.textContent = "Could not load the full stock list right now.";
      if (grid) grid.innerHTML = `<div class="im-rrg-symbols-loading">Could not load the full stock list right now.</div>`;
      setHeatmapProgress(0, 0);
    }
  }

  document.querySelectorAll(".im-heatmap-index-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".im-heatmap-index-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      const indexName = button.dataset.heatmapIndex;
      const refreshBtn = document.getElementById("im-heatmap-refresh-btn");
      if (refreshBtn) refreshBtn.hidden = indexName !== "ALL";
      loadHeatmap(indexName);
    });
  });

  const imHeatmapRefreshBtn = document.getElementById("im-heatmap-refresh-btn");
  if (imHeatmapRefreshBtn) {
    imHeatmapRefreshBtn.addEventListener("click", () => {
      if (imHeatmapIndex === "ALL") loadAllStocksHeatmap();
    });
  }

  function startHeatmapPolling() {
    loadHeatmap(imHeatmapIndex);
    if (imHeatmapTimer) return;
    // "All NSE Stocks" is refreshed manually only — auto-polling 5000+
    // symbols every 20 seconds would repeatedly hammer the backend and
    // Upstox for a view that's already a heavy one-off load.
    imHeatmapTimer = window.setInterval(() => {
      if (imHeatmapIndex === "ALL") return;
      loadHeatmap(imHeatmapIndex);
    }, 20000);
  }

  function stopHeatmapPolling() {
    if (imHeatmapTimer) {
      window.clearInterval(imHeatmapTimer);
      imHeatmapTimer = null;
    }
  }

  // ===================== Market scanner =====================
  // Reuses the same universe/quote endpoints as the heatmap (including the
  // shared imAllStocksCache and runWithConcurrency helper) — no new backend
  // work. Switching the FILTER (gainers/losers/strong bullish/bearish) just
  // re-sorts the last fetched batch instantly; switching the UNIVERSE
  // (a sector, or All NSE Stocks) triggers a fresh fetch.

  let imScannerFilter = "gainers";
  let imScannerUniverse = "Nifty 50";
  let imScannerTimer = null;
  let imScannerLoadToken = 0;
  let imScannerLastQuotes = [];
  const imScannerConstituentsCache = {};

  function setScannerProgress(loaded, total) {
    const track = document.getElementById("im-scanner-progress-track");
    const fill = document.getElementById("im-scanner-progress-fill");
    if (!track || !fill) return;
    if (total <= 0) {
      track.hidden = true;
      return;
    }
    track.hidden = false;
    fill.style.width = `${Math.min(100, Math.round((loaded / total) * 100))}%`;
  }

  function renderScannerTable(rows) {
    const body = document.getElementById("im-scanner-body");
    if (!body) return;
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5">No matching stocks right now.</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map((r, i) => {
        return `
          <tr>
            <td>${i + 1}</td>
            <td>${escapeHtml(r.symbol)}</td>
            <td>${escapeHtml(r.name || "")}</td>
            <td>${formatNumber(r.last_price)}</td>
            <td>${changePillHtml(r.change_percent)}</td>
          </tr>
        `;
      })
      .join("");
  }

  function applyScannerFilterAndRender(quotes) {
    let filtered;
    if (imScannerFilter === "losers") {
      filtered = quotes.slice().sort((a, b) => a.change_percent - b.change_percent).slice(0, 25);
    } else if (imScannerFilter === "strong_bullish") {
      filtered = quotes.filter((q) => q.ai_label === "Strong Bullish").sort((a, b) => b.change_percent - a.change_percent).slice(0, 50);
    } else if (imScannerFilter === "strong_bearish") {
      filtered = quotes.filter((q) => q.ai_label === "Strong Bearish").sort((a, b) => a.change_percent - b.change_percent).slice(0, 50);
    } else {
      filtered = quotes.slice().sort((a, b) => b.change_percent - a.change_percent).slice(0, 25);
    }
    renderScannerTable(filtered);
  }

  async function loadScanner() {
    const myToken = ++imScannerLoadToken;
    const statusText = document.getElementById("im-scanner-status-text");
    const liveBadge = document.getElementById("im-scanner-live-badge");
    const body = document.getElementById("im-scanner-body");
    const isAll = imScannerUniverse === "ALL";

    setScannerProgress(0, isAll ? 1 : 0);
    if (statusText) statusText.textContent = isAll ? "Loading full NSE stock list…" : `Loading ${imScannerUniverse}…`;
    if (liveBadge) liveBadge.hidden = true;
    if (body) body.innerHTML = `<tr><td colspan="5">Loading…</td></tr>`;

    try {
      let stocks;
      if (isAll) {
        if (!imAllStocksCache) {
          const res = await fetch(`${API_BASE_URL}/api/stocks/all`).then((r) => r.json());
          if (!res.ok) throw new Error(res.error || "Could not load the stock universe.");
          imAllStocksCache = res.data || [];
        }
        stocks = imAllStocksCache;
      } else {
        if (!imScannerConstituentsCache[imScannerUniverse]) {
          const cRes = await fetch(`${API_BASE_URL}/api/index-constituents?index=${encodeURIComponent(imScannerUniverse)}`).then((r) => r.json());
          if (!cRes.ok || !cRes.available) throw new Error(cRes.error || "Constituent list not available.");
          imScannerConstituentsCache[imScannerUniverse] = cRes.constituents;
        }
        stocks = imScannerConstituentsCache[imScannerUniverse];
      }

      if (myToken !== imScannerLoadToken) return;

      const nameBySymbol = {};
      stocks.forEach((s) => { nameBySymbol[s.symbol] = s.name; });
      const symbols = stocks.map((s) => s.symbol);

      const CHUNK_SIZE = 100;
      const CONCURRENCY = 6;
      const chunks = [];
      for (let i = 0; i < symbols.length; i += CHUNK_SIZE) chunks.push(symbols.slice(i, i + CHUNK_SIZE));

      const allQuotes = [];
      let loadedCount = 0;

      await runWithConcurrency(chunks.length, CONCURRENCY, async (i) => {
        if (myToken !== imScannerLoadToken) return;
        const chunk = chunks[i];
        try {
          const qRes = await fetch(`${API_BASE_URL}/api/watchlist?symbols=${encodeURIComponent(chunk.join(","))}`).then((r) => r.json());
          if (myToken !== imScannerLoadToken) return;
          if (qRes.ok) {
            (qRes.data || []).forEach((q) => {
              if (q.change_percent !== null && q.change_percent !== undefined) {
                allQuotes.push({
                  symbol: q.symbol,
                  name: nameBySymbol[q.symbol] || q.symbol,
                  last_price: q.last_price,
                  change_percent: Number(q.change_percent),
                  ai_label: q.ai_label
                });
              }
            });
          }
        } catch (error) {
          console.error("Scanner quote chunk failed:", error);
        } finally {
          loadedCount += chunk.length;
          if (myToken === imScannerLoadToken && isAll) {
            setScannerProgress(loadedCount, symbols.length);
            if (statusText) {
              statusText.textContent = `Loading all NSE stocks… ${loadedCount.toLocaleString("en-IN")} / ${symbols.length.toLocaleString("en-IN")}`;
            }
          }
        }
      });

      if (myToken !== imScannerLoadToken) return;

      imScannerLastQuotes = allQuotes;
      applyScannerFilterAndRender(allQuotes);
      setScannerProgress(0, 0);
      if (statusText) {
        statusText.textContent = isAll
          ? `All NSE stocks · ${symbols.length.toLocaleString("en-IN")} scanned`
          : `${imScannerUniverse} · ${symbols.length} stocks scanned`;
      }
      if (liveBadge) liveBadge.hidden = false;
    } catch (error) {
      console.error("Scanner load failed:", error);
      if (statusText) statusText.textContent = "Could not load scanner data right now.";
      if (body) body.innerHTML = `<tr><td colspan="5">Could not load scanner data right now.</td></tr>`;
      setScannerProgress(0, 0);
    }
  }

  document.querySelectorAll(".im-scanner-filter-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".im-scanner-filter-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      imScannerFilter = button.dataset.scannerFilter;
      if (imScannerLastQuotes.length) applyScannerFilterAndRender(imScannerLastQuotes);
    });
  });

  document.querySelectorAll(".im-scanner-universe-btn").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".im-scanner-universe-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      imScannerUniverse = button.dataset.scannerUniverse;
      const refreshBtn = document.getElementById("im-scanner-refresh-btn");
      if (refreshBtn) refreshBtn.hidden = imScannerUniverse !== "ALL";
      loadScanner();
    });
  });

  const imScannerRefreshBtn = document.getElementById("im-scanner-refresh-btn");
  if (imScannerRefreshBtn) {
    imScannerRefreshBtn.addEventListener("click", () => {
      if (imScannerUniverse === "ALL") loadScanner();
    });
  }

  function startScannerPolling() {
    loadScanner();
    if (imScannerTimer) return;
    // Same reasoning as the heatmap: never auto-poll "All NSE Stocks".
    imScannerTimer = window.setInterval(() => {
      if (imScannerUniverse === "ALL") return;
      loadScanner();
    }, 20000);
  }

  function stopScannerPolling() {
    if (imScannerTimer) {
      window.clearInterval(imScannerTimer);
      imScannerTimer = null;
    }
  }

  // ===================== AI Chart Scanner =====================
  // Pick any NSE stock, get an instant AI-written technical summary. Reuses
  // the same stock search endpoint as the Watchlist's "add stock" box, and
  // the same renderGeminiReview() text formatter the AI Trade Coach uses —
  // both proven UI patterns, just wired to a new stock-picker + endpoint.

  let imAiScannerSearchDebounce = null;
  let imAiScannerSearchResults = [];
  let imAiScannerSearchActiveIndex = -1;

  function hideImAiScannerSearchResults() {
    const el = document.getElementById("im-ai-scanner-search-results");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
    imAiScannerSearchResults = [];
    imAiScannerSearchActiveIndex = -1;
  }

  function updateImAiScannerActiveHighlight() {
    const resultsEl = document.getElementById("im-ai-scanner-search-results");
    if (!resultsEl) return;
    [...resultsEl.querySelectorAll(".im-watchlist-search-item")].forEach((el, i) => {
      el.classList.toggle("active", i === imAiScannerSearchActiveIndex);
    });
  }

  function renderImAiScannerSearchResults(results) {
    imAiScannerSearchResults = results;
    imAiScannerSearchActiveIndex = -1;
    const el = document.getElementById("im-ai-scanner-search-results");
    if (!el) return;
    if (!results.length) {
      el.innerHTML = `<div class="im-watchlist-search-empty">No matching NSE stocks found.</div>`;
      el.hidden = false;
      return;
    }
    el.innerHTML = results
      .map((s, i) => `
        <div class="im-watchlist-search-item" data-search-index="${i}">
          <strong>${escapeHtml(s.symbol)}</strong>
          <span>${escapeHtml(s.name)}</span>
        </div>
      `)
      .join("");
    el.hidden = false;
  }

  async function runImAiScannerSearch(query) {
    const resultsEl = document.getElementById("im-ai-scanner-search-results");
    if (!query) {
      hideImAiScannerSearchResults();
      return;
    }
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="im-watchlist-search-empty">Searching…</div>`;
      resultsEl.hidden = false;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/stocks/search?q=${encodeURIComponent(query)}&limit=15`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Stock search failed.");
      renderImAiScannerSearchResults(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("AI scanner stock search failed:", error);
      imAiScannerSearchResults = [];
      imAiScannerSearchActiveIndex = -1;
      if (resultsEl) {
        resultsEl.innerHTML = `<div class="im-watchlist-search-empty">${escapeHtml(friendlyAiErrorMessage(error.message))}</div>`;
        resultsEl.hidden = false;
      }
    }
  }

  function renderAiScannerIndicators(snapshot) {
    const grid = document.getElementById("im-ai-scanner-indicators");
    if (!grid) return;
    const tiles = [
      ["Price", formatNumber(snapshot.price)],
      ["RSI (14)", snapshot.rsi_14],
      ["VWAP", formatNumber(snapshot.vwap)],
      ["MACD Hist", snapshot.macd_histogram],
      ["EMA 21", formatNumber(snapshot.ema_21)],
      ["Support", formatNumber(snapshot.support)],
      ["Resistance", formatNumber(snapshot.resistance)],
      ["Trend (5m)", snapshot.trend_5m],
      ["ADX", snapshot.adx ? snapshot.adx.adx : "--"],
      ["Supertrend", snapshot.supertrend ? snapshot.supertrend.trend : "--"],
      ["Volume vs Avg", snapshot.volume_ratio !== undefined ? `${snapshot.volume_ratio}x` : "--"],
      ["Session", snapshot.session_status]
    ];
    grid.innerHTML = tiles
      .map(
        ([label, value]) => `
          <div class="im-ai-scanner-stat">
            <span class="im-ai-scanner-stat-label">${escapeHtml(label)}</span>
            <span class="im-ai-scanner-stat-value">${escapeHtml(String(value === undefined || value === null ? "--" : value))}</span>
          </div>
        `
      )
      .join("");
  }

  async function runAiChartScan(symbol) {
    const statusEl = document.getElementById("im-ai-scanner-status");
    const resultEl = document.getElementById("im-ai-scanner-result");
    const symbolEl = document.getElementById("im-ai-scanner-symbol");
    const updatedEl = document.getElementById("im-ai-scanner-updated");
    const analysisEl = document.getElementById("im-ai-scanner-analysis");

    if (statusEl) statusEl.textContent = `Analysing ${symbol}…`;
    if (resultEl) resultEl.hidden = true;

    try {
      const response = await fetch(`${API_BASE_URL}/api/ai-chart-scanner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "AI chart scan failed.");

      if (symbolEl) symbolEl.textContent = result.symbol;
      if (updatedEl) {
        const generated = new Date(result.generated_at);
        updatedEl.textContent = `Live snapshot · ${generated.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
      }
      renderAiScannerIndicators(result.indicators || {});
      if (analysisEl) renderGeminiReview(analysisEl, result.analysis);
      if (resultEl) resultEl.hidden = false;
      if (statusEl) statusEl.textContent = "";
    } catch (error) {
      console.error("AI chart scan failed:", error);
      if (statusEl) statusEl.textContent = friendlyAiErrorMessage(error.message);
      if (resultEl) resultEl.hidden = true;
      showAiErrorToast(error.message);
    }
  }

  let imDashboardAiMarket = "nifty";
  const IM_DASHBOARD_AI_MARKET_LABELS = {
    nifty: "NIFTY 50",
    banknifty: "Bank Nifty",
    finnifty: "FINNIFTY",
    sensex: "Sensex"
  };

  async function runImDashboardAiReview(marketKey) {
    const statusEl = document.getElementById("im-dashboard-ai-status");
    const providerBadge = document.getElementById("im-dashboard-ai-provider-badge");
    const resultEl = document.getElementById("im-dashboard-ai-result");
    const analysisEl = document.getElementById("im-dashboard-ai-analysis");
    const runBtn = document.getElementById("im-dashboard-ai-run-btn");
    const marketLabel = IM_DASHBOARD_AI_MARKET_LABELS[marketKey] || marketKey;

    if (statusEl) statusEl.textContent = `Analysing ${marketLabel}…`;
    if (resultEl) resultEl.hidden = true;
    if (providerBadge) providerBadge.hidden = true;
    if (runBtn) runBtn.disabled = true;

    try {
      const response = await fetch(`${API_BASE_URL}/api/ai-market-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: marketKey })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "AI market review failed.");

      const generated = new Date(result.generated_at);
      const stamp = generated.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      if (statusEl) {
        statusEl.textContent = result.data_source === "live"
          ? `Live snapshot · ${stamp}`
          : `Demo snapshot (live data unavailable) · ${stamp}`;
      }
      if (providerBadge) {
        providerBadge.textContent = result.provider === "GROQ" ? "AI · Groq" : "AI · Gemini";
        providerBadge.hidden = false;
      }
      if (analysisEl) renderGeminiReview(analysisEl, result.analysis);
      if (resultEl) resultEl.hidden = false;
    } catch (error) {
      console.error("AI market review failed:", error);
      if (statusEl) statusEl.textContent = friendlyAiErrorMessage(error.message);
      if (resultEl) resultEl.hidden = true;
      showAiErrorToast(error.message);
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  async function runImDashboardAiStockReview(symbol) {
    const statusEl = document.getElementById("im-dashboard-ai-status");
    const providerBadge = document.getElementById("im-dashboard-ai-provider-badge");
    const resultEl = document.getElementById("im-dashboard-ai-result");
    const analysisEl = document.getElementById("im-dashboard-ai-analysis");
    const runBtn = document.getElementById("im-dashboard-ai-run-btn");

    if (statusEl) statusEl.textContent = `Analysing ${symbol}…`;
    if (resultEl) resultEl.hidden = true;
    if (providerBadge) providerBadge.hidden = true;
    if (runBtn) runBtn.disabled = true;

    try {
      const response = await fetch(`${API_BASE_URL}/api/ai-chart-scanner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol })
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "AI chart scan failed.");

      const generated = new Date(result.generated_at);
      const stamp = generated.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      if (statusEl) statusEl.textContent = `${result.symbol} · Live snapshot · ${stamp}`;
      if (providerBadge) {
        providerBadge.textContent = result.provider === "GROQ" ? "AI · Groq" : "AI · Gemini";
        providerBadge.hidden = false;
      }
      if (analysisEl) renderGeminiReview(analysisEl, result.analysis);
      if (resultEl) resultEl.hidden = false;
    } catch (error) {
      console.error("AI dashboard stock scan failed:", error);
      if (statusEl) statusEl.textContent = friendlyAiErrorMessage(error.message);
      if (resultEl) resultEl.hidden = true;
      showAiErrorToast(error.message);
    } finally {
      if (runBtn) runBtn.disabled = false;
    }
  }

  let imDashboardAiSearchDebounce = null;
  let imDashboardAiSearchResults = [];
  let imDashboardAiSearchActiveIndex = -1;

  function hideImDashboardAiSearchResults() {
    const el = document.getElementById("im-dashboard-ai-search-results");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
    imDashboardAiSearchResults = [];
    imDashboardAiSearchActiveIndex = -1;
  }

  function updateImDashboardAiSearchHighlight() {
    const resultsEl = document.getElementById("im-dashboard-ai-search-results");
    if (!resultsEl) return;
    [...resultsEl.querySelectorAll(".im-watchlist-search-item")].forEach((el, i) => {
      el.classList.toggle("active", i === imDashboardAiSearchActiveIndex);
    });
  }

  function renderImDashboardAiSearchResults(results) {
    imDashboardAiSearchResults = results;
    imDashboardAiSearchActiveIndex = -1;
    const el = document.getElementById("im-dashboard-ai-search-results");
    if (!el) return;
    if (!results.length) {
      el.innerHTML = `<div class="im-watchlist-search-empty">No matching NSE stocks found.</div>`;
      el.hidden = false;
      return;
    }
    el.innerHTML = results
      .map((s, i) => `
        <div class="im-watchlist-search-item" data-search-index="${i}">
          <strong>${escapeHtml(s.symbol)}</strong>
          <span>${escapeHtml(s.name)}</span>
        </div>
      `)
      .join("");
    el.hidden = false;
  }

  async function runImDashboardAiSearch(query) {
    const resultsEl = document.getElementById("im-dashboard-ai-search-results");
    if (!query) {
      hideImDashboardAiSearchResults();
      return;
    }
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="im-watchlist-search-empty">Searching…</div>`;
      resultsEl.hidden = false;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/stocks/search?q=${encodeURIComponent(query)}&limit=15`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Stock search failed.");
      renderImDashboardAiSearchResults(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("AI dashboard stock search failed:", error);
      imDashboardAiSearchResults = [];
      imDashboardAiSearchActiveIndex = -1;
      if (resultsEl) {
        resultsEl.innerHTML = `<div class="im-watchlist-search-empty">${escapeHtml(friendlyAiErrorMessage(error.message))}</div>`;
        resultsEl.hidden = false;
      }
    }
  }

  function setupImDashboardAiReview() {
    const runBtn = document.getElementById("im-dashboard-ai-run-btn");
    const marketButtons = [...document.querySelectorAll("[data-im-dashboard-ai-market]")];
    if (!runBtn || !marketButtons.length) return;

    marketButtons.forEach((button) => {
      button.addEventListener("click", () => {
        imDashboardAiMarket = button.dataset.imDashboardAiMarket;
        marketButtons.forEach((item) => item.classList.toggle("active", item === button));
      });
    });

    runBtn.addEventListener("click", () => runImDashboardAiReview(imDashboardAiMarket));

    const input = document.getElementById("im-dashboard-ai-search-input");
    const resultsEl = document.getElementById("im-dashboard-ai-search-results");
    if (!input || !resultsEl) return;

    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (imDashboardAiSearchDebounce) window.clearTimeout(imDashboardAiSearchDebounce);
      imDashboardAiSearchDebounce = window.setTimeout(() => runImDashboardAiSearch(query), 250);
    });

    resultsEl.addEventListener("click", (event) => {
      const item = event.target.closest(".im-watchlist-search-item[data-search-index]");
      if (!item) return;
      const stock = imDashboardAiSearchResults[Number(item.dataset.searchIndex)];
      if (!stock) return;
      input.value = stock.symbol;
      hideImDashboardAiSearchResults();
      runImDashboardAiStockReview(stock.symbol);
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const active = imDashboardAiSearchResults[imDashboardAiSearchActiveIndex];
        if (active) {
          input.value = active.symbol;
          hideImDashboardAiSearchResults();
          runImDashboardAiStockReview(active.symbol);
        } else if (input.value.trim()) {
          runImDashboardAiStockReview(input.value.trim().toUpperCase());
        }
      } else if (event.key === "Escape") {
        hideImDashboardAiSearchResults();
      } else if (event.key === "ArrowDown" && imDashboardAiSearchResults.length) {
        event.preventDefault();
        imDashboardAiSearchActiveIndex = Math.min(imDashboardAiSearchActiveIndex + 1, imDashboardAiSearchResults.length - 1);
        updateImDashboardAiSearchHighlight();
      } else if (event.key === "ArrowUp" && imDashboardAiSearchResults.length) {
        event.preventDefault();
        imDashboardAiSearchActiveIndex = Math.max(imDashboardAiSearchActiveIndex - 1, 0);
        updateImDashboardAiSearchHighlight();
      }
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".im-dashboard-ai-search-wrap")) hideImDashboardAiSearchResults();
    });
  }

  function setupImAiScannerSearch() {
    const input = document.getElementById("im-ai-scanner-search-input");
    const resultsEl = document.getElementById("im-ai-scanner-search-results");
    if (!input || !resultsEl) return;

    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (imAiScannerSearchDebounce) window.clearTimeout(imAiScannerSearchDebounce);
      imAiScannerSearchDebounce = window.setTimeout(() => runImAiScannerSearch(query), 250);
    });

    resultsEl.addEventListener("click", (event) => {
      const item = event.target.closest(".im-watchlist-search-item");
      if (!item) return;
      const stock = imAiScannerSearchResults[Number(item.dataset.searchIndex)];
      if (!stock) return;
      input.value = stock.symbol;
      hideImAiScannerSearchResults();
      runAiChartScan(stock.symbol);
    });

    document.addEventListener("click", (event) => {
      if (!input.contains(event.target) && !resultsEl.contains(event.target)) {
        hideImAiScannerSearchResults();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const active = imAiScannerSearchResults[imAiScannerSearchActiveIndex];
        if (active) {
          input.value = active.symbol;
          hideImAiScannerSearchResults();
          runAiChartScan(active.symbol);
        } else if (input.value.trim()) {
          hideImAiScannerSearchResults();
          runAiChartScan(input.value.trim().toUpperCase());
        }
      } else if (event.key === "ArrowDown" && imAiScannerSearchResults.length) {
        event.preventDefault();
        imAiScannerSearchActiveIndex = Math.min(imAiScannerSearchActiveIndex + 1, imAiScannerSearchResults.length - 1);
        updateImAiScannerActiveHighlight();
      } else if (event.key === "ArrowUp" && imAiScannerSearchResults.length) {
        event.preventDefault();
        imAiScannerSearchActiveIndex = Math.max(imAiScannerSearchActiveIndex - 1, 0);
        updateImAiScannerActiveHighlight();
      }
    });
  }

  setupImAiScannerSearch();
  setupImDashboardAiReview();

  // ===================== Stock Detail (any NSE stock) =====================
  // Chart + technicals + news for an arbitrary stock in one page. Reuses
  // /api/index-candles (already symbol-agnostic via resolve_instrument_key),
  // the AI Chart Scanner's indicator-grid styling, and jumps into the AI
  // Chart Scanner itself for the AI write-up instead of duplicating that
  // call here.

  let imStockDetailSearchDebounce = null;
  let imStockDetailSearchResults = [];
  let imStockDetailSearchActiveIndex = -1;
  let imStockDetailSymbol = null;
  let imStockDetailTimeframe = "15m";
  let imStockDetailChart = null;
  let imStockDetailSeries = null;

  function hideImStockDetailSearchResults() {
    const el = document.getElementById("im-stock-detail-search-results");
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
    imStockDetailSearchResults = [];
    imStockDetailSearchActiveIndex = -1;
  }

  function updateImStockDetailActiveHighlight() {
    const resultsEl = document.getElementById("im-stock-detail-search-results");
    if (!resultsEl) return;
    [...resultsEl.querySelectorAll(".im-watchlist-search-item")].forEach((el, i) => {
      el.classList.toggle("active", i === imStockDetailSearchActiveIndex);
    });
  }

  function renderImStockDetailSearchResults(results) {
    imStockDetailSearchResults = results;
    imStockDetailSearchActiveIndex = -1;
    const el = document.getElementById("im-stock-detail-search-results");
    if (!el) return;
    if (!results.length) {
      el.innerHTML = `<div class="im-watchlist-search-empty">No matching NSE stocks found.</div>`;
      el.hidden = false;
      return;
    }
    el.innerHTML = results
      .map((s, i) => `
        <div class="im-watchlist-search-item" data-search-index="${i}">
          <strong>${escapeHtml(s.symbol)}</strong>
          <span>${escapeHtml(s.name)}</span>
        </div>
      `)
      .join("");
    el.hidden = false;
  }

  async function runImStockDetailSearch(query) {
    const resultsEl = document.getElementById("im-stock-detail-search-results");
    if (!query) {
      hideImStockDetailSearchResults();
      return;
    }
    if (resultsEl) {
      resultsEl.innerHTML = `<div class="im-watchlist-search-empty">Searching…</div>`;
      resultsEl.hidden = false;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/api/stocks/search?q=${encodeURIComponent(query)}&limit=15`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Stock search failed.");
      renderImStockDetailSearchResults(Array.isArray(result.data) ? result.data : []);
    } catch (error) {
      console.error("Stock detail search failed:", error);
      imStockDetailSearchResults = [];
      imStockDetailSearchActiveIndex = -1;
      if (resultsEl) {
        resultsEl.innerHTML = `<div class="im-watchlist-search-empty">${escapeHtml(friendlyAiErrorMessage(error.message))}</div>`;
        resultsEl.hidden = false;
      }
    }
  }

  function renderStockDetailIndicators(snapshot) {
    const grid = document.getElementById("im-stock-detail-indicators");
    if (!grid) return;
    const tiles = [
      ["RSI (14)", snapshot.rsi_14],
      ["VWAP", formatNumber(snapshot.vwap)],
      ["MACD Hist", snapshot.macd_histogram],
      ["EMA 9 / 21 / 50", `${formatNumber(snapshot.ema_9)} / ${formatNumber(snapshot.ema_21)} / ${formatNumber(snapshot.ema_50)}`],
      ["Support", formatNumber(snapshot.support)],
      ["Resistance", formatNumber(snapshot.resistance)],
      ["Trend (5m/15m/1h)", `${snapshot.trend_5m || "--"} / ${snapshot.trend_15m || "--"} / ${snapshot.trend_1h || "--"}`],
      ["ADX", snapshot.adx ? snapshot.adx.adx : "--"],
      ["Supertrend", snapshot.supertrend ? snapshot.supertrend.trend : "--"],
      ["Stochastic", snapshot.stochastic ? `${snapshot.stochastic.k} / ${snapshot.stochastic.d}` : "--"],
      ["ATR (14)", snapshot.atr_14],
      ["Volume vs Avg", snapshot.volume_ratio !== undefined ? `${snapshot.volume_ratio}x` : "--"]
    ];
    grid.innerHTML = tiles
      .map(
        ([label, value]) => `
          <div class="im-ai-scanner-stat">
            <span class="im-ai-scanner-stat-label">${escapeHtml(label)}</span>
            <span class="im-ai-scanner-stat-value">${escapeHtml(String(value === undefined || value === null ? "--" : value))}</span>
          </div>
        `
      )
      .join("");
  }

  function ensureImStockDetailChart() {
    const container = document.getElementById("im-stock-detail-chart");
    if (!container || imStockDetailChart || !window.LightweightCharts) return;

    const stockDetailColors = getChartThemeColors();
    imStockDetailChart = registerThemedChart(LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 380,
      layout: { background: { color: stockDetailColors.bg }, textColor: stockDetailColors.text },
      grid: {
        vertLines: { color: stockDetailColors.grid },
        horzLines: { color: stockDetailColors.grid }
      },
      rightPriceScale: { borderColor: stockDetailColors.border },
      timeScale: { borderColor: stockDetailColors.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    }));

    imStockDetailSeries = imStockDetailChart.addCandlestickSeries({
      upColor: "#34d399",
      downColor: "#f87171",
      borderUpColor: "#34d399",
      borderDownColor: "#f87171",
      wickUpColor: "#86efac",
      wickDownColor: "#fca5a5"
    });

    new ResizeObserver(() => {
      if (!imStockDetailChart || !container.clientWidth) return;
      imStockDetailChart.applyOptions({ width: container.clientWidth });
    }).observe(container);
  }

  async function loadImStockDetailCandles(symbol) {
    ensureImStockDetailChart();
    if (!imStockDetailSeries) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/index-candles?symbol=${encodeURIComponent(symbol)}&timeframe=${imStockDetailTimeframe}`);
      const result = await response.json();
      if (!response.ok || !result.ok || !Array.isArray(result.candles)) throw new Error(result.error || "Candle data unavailable.");
      if (symbol !== imStockDetailSymbol) return;

      const points = result.candles
        .map((candle) => ({
          time: Math.floor(new Date(candle.time).getTime() / 1000),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close)
        }))
        .filter((point) => Number.isFinite(point.time))
        .sort((a, b) => a.time - b.time);

      imStockDetailSeries.setData(points);
      imStockDetailChart.timeScale().fitContent();
    } catch (error) {
      console.error("Stock detail candles failed:", error);
    }
  }

  async function loadImStockDetailNews(symbol) {
    const newsSection = document.getElementById("im-stock-detail-news");
    const newsUpdated = document.getElementById("im-stock-detail-news-updated");
    const newsList = document.getElementById("im-stock-detail-news-list");
    if (!newsSection) return;

    newsSection.hidden = false;
    if (newsUpdated) newsUpdated.textContent = "Loading news...";
    if (newsList) newsList.innerHTML = '<p class="empty-note">Loading news...</p>';

    try {
      const response = await fetch(`${API_BASE_URL}/api/stock-news/${encodeURIComponent(symbol)}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Stock news request failed.");
      if (symbol !== imStockDetailSymbol) return;

      if (newsUpdated) {
        newsUpdated.textContent = `${result.count} headline${result.count === 1 ? "" : "s"} for ${result.company_name} · Updated ${new Date(result.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      }
      if (newsList) {
        newsList.innerHTML = result.items.length
          ? result.items
              .map(
                (item) => `
                  <div class="im-news-item">
                    <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline)}</a>
                    <p class="im-news-meta">${escapeHtml(item.source)} &middot; ${escapeHtml(item.published_time)}</p>
                    <p class="im-news-summary">${escapeHtml(item.summary)}</p>
                  </div>
                `
              )
              .join("")
          : '<p class="empty-note">No recent headlines found for this stock.</p>';
      }
    } catch (error) {
      if (newsUpdated) newsUpdated.textContent = "News unavailable";
      if (newsList) newsList.innerHTML = `<p class="empty-note">${escapeHtml(error.message || "Could not load news.")}</p>`;
    }
  }

  async function loadImStockDetail(symbol) {
    imStockDetailSymbol = symbol;
    const statusEl = document.getElementById("im-stock-detail-status");
    const resultEl = document.getElementById("im-stock-detail-result");
    const symbolEl = document.getElementById("im-stock-detail-symbol");
    const updatedEl = document.getElementById("im-stock-detail-updated");
    const priceEl = document.getElementById("im-stock-detail-price");

    if (statusEl) statusEl.textContent = `Loading ${symbol}…`;
    if (resultEl) resultEl.hidden = true;
    document.getElementById("im-stock-detail-news").hidden = true;

    try {
      const response = await fetch(`${API_BASE_URL}/api/stock-technical/${encodeURIComponent(symbol)}`);
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Stock technical data unavailable.");
      if (symbol !== imStockDetailSymbol) return;

      if (symbolEl) symbolEl.textContent = result.symbol;
      if (priceEl) priceEl.textContent = formatNumber(result.indicators.price);
      if (updatedEl) {
        const generated = new Date(result.generated_at);
        updatedEl.textContent = `Live snapshot · ${generated.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
      }
      renderStockDetailIndicators(result.indicators || {});
      if (resultEl) resultEl.hidden = false;
      if (statusEl) statusEl.textContent = "";

      loadImStockDetailCandles(symbol);
      loadImStockDetailNews(symbol);
    } catch (error) {
      console.error("Stock detail load failed:", error);
      if (statusEl) statusEl.textContent = friendlyAiErrorMessage(error.message);
      if (resultEl) resultEl.hidden = true;
    }
  }

  function setupImStockDetailSearch() {
    const input = document.getElementById("im-stock-detail-search-input");
    const resultsEl = document.getElementById("im-stock-detail-search-results");
    if (!input || !resultsEl) return;

    input.addEventListener("input", () => {
      const query = input.value.trim();
      if (imStockDetailSearchDebounce) window.clearTimeout(imStockDetailSearchDebounce);
      imStockDetailSearchDebounce = window.setTimeout(() => runImStockDetailSearch(query), 250);
    });

    resultsEl.addEventListener("click", (event) => {
      const item = event.target.closest(".im-watchlist-search-item");
      if (!item) return;
      const stock = imStockDetailSearchResults[Number(item.dataset.searchIndex)];
      if (!stock) return;
      input.value = stock.symbol;
      hideImStockDetailSearchResults();
      loadImStockDetail(stock.symbol);
    });

    document.addEventListener("click", (event) => {
      if (!input.contains(event.target) && !resultsEl.contains(event.target)) {
        hideImStockDetailSearchResults();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const active = imStockDetailSearchResults[imStockDetailSearchActiveIndex];
        if (active) {
          input.value = active.symbol;
          hideImStockDetailSearchResults();
          loadImStockDetail(active.symbol);
        } else if (input.value.trim()) {
          hideImStockDetailSearchResults();
          loadImStockDetail(input.value.trim().toUpperCase());
        }
      } else if (event.key === "ArrowDown" && imStockDetailSearchResults.length) {
        event.preventDefault();
        imStockDetailSearchActiveIndex = Math.min(imStockDetailSearchActiveIndex + 1, imStockDetailSearchResults.length - 1);
        updateImStockDetailActiveHighlight();
      } else if (event.key === "ArrowUp" && imStockDetailSearchResults.length) {
        event.preventDefault();
        imStockDetailSearchActiveIndex = Math.max(imStockDetailSearchActiveIndex - 1, 0);
        updateImStockDetailActiveHighlight();
      }
    });
  }

  setupImStockDetailSearch();

  document.getElementById("im-stock-detail-timeframes")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-stock-timeframe]");
    if (!button || !imStockDetailSymbol) return;
    imStockDetailTimeframe = button.dataset.stockTimeframe;
    [...document.getElementById("im-stock-detail-timeframes").querySelectorAll("[data-stock-timeframe]")].forEach((btn) => {
      btn.classList.toggle("active", btn === button);
    });
    loadImStockDetailCandles(imStockDetailSymbol);
  });

  document.getElementById("im-stock-detail-ai-btn")?.addEventListener("click", () => {
    if (!imStockDetailSymbol) return;
    const symbol = imStockDetailSymbol;
    pushImDrilldown("im-stock-detail");
    showPage("im-ai-scanner");
    const aiInput = document.getElementById("im-ai-scanner-search-input");
    if (aiInput) aiInput.value = symbol;
    runAiChartScan(symbol);
  });

  let watchlistTimer = null;

  function startWatchlistPolling() {
    if (watchlistTimer) return;
    fetchWatchlist();
    watchlistTimer = window.setInterval(fetchWatchlist, 5000);
  }

  function stopWatchlistPolling() {
    if (watchlistTimer) {
      window.clearInterval(watchlistTimer);
      watchlistTimer = null;
    }
  }

  // ===================== Indian Market news =====================
  // Plain publisher RSS headlines (Economic Times / Business Standard / Livemint markets
  // feeds), fetched via the backend so the browser doesn't need to deal with RSS/XML or
  // CORS directly. Cached client-side per session; the Refresh button forces a re-fetch.

  let imNewsLoaded = false;
  let imNewsItems = [];

  async function loadImMarketNews(forceRefresh = false) {
    if (imNewsLoaded && !forceRefresh) return;

    const listEl = document.getElementById("im-news-list");
    const updatedEl = document.getElementById("im-news-updated");
    const refreshBtn = document.getElementById("im-news-refresh-btn");

    if (refreshBtn) refreshBtn.disabled = true;
    if (updatedEl) updatedEl.textContent = "Loading market news...";
    if (listEl) listEl.innerHTML = '<p class="empty-note">Loading market news...</p>';

    try {
      const response = await fetch("https://api.marketdock.in/api/market-news");
      const result = await response.json();

      if (!response.ok || !result.ok || !Array.isArray(result.items)) {
        throw new Error(result.error || "Market news request failed.");
      }

      imNewsLoaded = true;
      imNewsItems = result.items;

      if (updatedEl) {
        updatedEl.textContent = `${result.count} headlines - Updated ${new Date(result.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      }

      if (listEl) {
        if (!result.items.length) {
          listEl.innerHTML = '<p class="empty-note">No recent market headlines found. Please try refreshing shortly.</p>';
        } else {
          listEl.innerHTML = result.items
            .map(
              (item, index) => `
                <div class="im-news-item">
                  <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.headline)}</a>
                  <p class="im-news-meta">${escapeHtml(item.source)} &middot; ${escapeHtml(item.published_time)}</p>
                  <p class="im-news-summary">${escapeHtml(item.summary)}</p>
                  <button class="im-news-translate-btn" type="button" data-news-translate="${index}">&#127760; हिंदी में पढ़ें</button>
                  <div class="im-news-hindi" data-news-hindi="${index}" hidden></div>
                </div>
              `
            )
            .join("");
        }
      }
    } catch (error) {
      if (updatedEl) updatedEl.textContent = "Market news unavailable";
      if (listEl) {
        listEl.innerHTML = `<p class="empty-note">${escapeHtml(error.message || "Could not load market news. Please try again shortly.")}</p>`;
      }
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  const imNewsRefreshBtn = document.getElementById("im-news-refresh-btn");
  if (imNewsRefreshBtn) {
    imNewsRefreshBtn.addEventListener("click", () => loadImMarketNews(true));
  }

  async function handleImNewsTranslateClick(button) {
    const index = Number(button.dataset.newsTranslate);
    const item = imNewsItems[index];
    const hindiEl = document.querySelector(`[data-news-hindi="${index}"]`);
    if (!item || !hindiEl) return;

    if (hindiEl.dataset.loaded === "true") {
      const nowHidden = !hindiEl.hidden;
      hindiEl.hidden = nowHidden;
      button.textContent = nowHidden ? "\u{1F310} हिंदी में पढ़ें" : "\u{1F310} अंग्रेज़ी में वापस जाएं";
      return;
    }

    button.disabled = true;
    button.textContent = "अनुवाद हो रहा है...";

    try {
      const response = await fetch("https://api.marketdock.in/api/news/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headline: item.headline, summary: item.summary, source: item.source })
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.error || "Hindi translation failed.");
      }

      hindiEl.innerHTML = `
        <strong>${escapeHtml(result.headline_hi)}</strong>
        ${result.summary_hi ? `<p>${escapeHtml(result.summary_hi)}</p>` : ""}
      `;
      hindiEl.dataset.loaded = "true";
      hindiEl.hidden = false;
      button.textContent = "\u{1F310} अंग्रेज़ी में वापस जाएं";
    } catch (error) {
      hindiEl.innerHTML = `<p class="im-news-translate-error">${escapeHtml(friendlyAiErrorMessage(error.message))}</p>`;
      hindiEl.hidden = false;
      button.textContent = "\u{1F310} फिर कोशिश करें";
      showAiErrorToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  const imNewsListEl = document.getElementById("im-news-list");
  if (imNewsListEl) {
    imNewsListEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-news-translate]");
      if (button) handleImNewsTranslateClick(button);
    });
  }

  // ===================== Indian Market price & signal alerts =====================
  // Mirrors the BTC-side alert architecture (browser Notification API, checked on
  // every technical-engine refresh while this tab is open — no background push
  // service). Supports multiple price alerts across both NIFTY 50 and Bank Nifty,
  // plus a single decision-change (BUY/SELL/HOLD) toggle covering both indices.

  const IM_ALERT_SETTINGS_KEY = "imAlertSettingsV1";
  const IM_ALERT_RUNTIME_KEY = "imAlertRuntimeV1";
  const IM_PRICE_ALERTS_KEY = "imPriceAlertsV1";
  const IM_MARKET_LABELS = { nifty: "NIFTY 50", banknifty: "Bank Nifty", finnifty: "FINNIFTY", sensex: "SENSEX" };

  function getImAlertSettings() {
    try {
      return { signalChangeEnabled: true, ...(JSON.parse(localStorage.getItem(IM_ALERT_SETTINGS_KEY)) || {}) };
    } catch (error) {
      return { signalChangeEnabled: true };
    }
  }

  function saveImAlertSettings(settings) {
    try {
      localStorage.setItem(IM_ALERT_SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) { /* ignore */ }
  }

  function getImAlertRuntime() {
    try {
      return { lastPriceByMarket: {}, previousDecisionByMarket: {}, lastAlertMessage: "", lastAlertAt: null, ...(JSON.parse(localStorage.getItem(IM_ALERT_RUNTIME_KEY)) || {}) };
    } catch (error) {
      return { lastPriceByMarket: {}, previousDecisionByMarket: {}, lastAlertMessage: "", lastAlertAt: null };
    }
  }

  function saveImAlertRuntime(runtime) {
    try {
      localStorage.setItem(IM_ALERT_RUNTIME_KEY, JSON.stringify(runtime));
    } catch (error) { /* ignore */ }
  }

  function getImPriceAlerts() {
    try {
      return JSON.parse(localStorage.getItem(IM_PRICE_ALERTS_KEY)) || [];
    } catch (error) {
      return [];
    }
  }

  function saveImPriceAlerts(alerts) {
    try {
      localStorage.setItem(IM_PRICE_ALERTS_KEY, JSON.stringify(alerts));
    } catch (error) { /* ignore */ }
  }

  function getImNotificationPermission() {
    if (!("Notification" in window)) return "unsupported";
    return Notification.permission;
  }

  function updateImNotificationUi(message = "") {
    const badge = document.getElementById("im-notification-permission-badge");
    const status = document.getElementById("im-notification-status");
    const enableButton = document.getElementById("im-enable-notifications-btn");
    const testButton = document.getElementById("im-test-notification-btn");
    const permission = getImNotificationPermission();

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
    if (testButton) testButton.disabled = permission !== "granted";

    if (status) {
      if (message) {
        status.textContent = message;
      } else if (permission === "granted") {
        status.textContent = "Browser alerts are enabled for this dashboard while it remains open.";
      } else if (permission === "denied") {
        status.textContent = "Notifications are blocked in browser settings. Allow notifications for this site, then reload.";
      } else if (permission === "unsupported") {
        status.textContent = "This browser does not support desktop/browser notifications.";
      } else {
        status.textContent = "Enable browser alerts to receive price and decision-change notifications.";
      }
    }
  }

  function sendImBrowserAlert(title, body, tag) {
    const runtime = getImAlertRuntime();
    const message = `${title}: ${body}`;
    playAlertBeep();
    runtime.lastAlertMessage = message;
    runtime.lastAlertAt = Date.now();
    saveImAlertRuntime(runtime);

    const lastAlertEl = document.getElementById("im-last-alert-status");
    if (lastAlertEl) {
      lastAlertEl.textContent = `${message} • ${new Date(runtime.lastAlertAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    }

    if (getImNotificationPermission() !== "granted") {
      updateImNotificationUi("Alert condition detected, but browser notifications are not enabled.");
      return;
    }

    try {
      const notification = new Notification(title, { body, tag, renotify: true });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch (error) {
      console.error(error);
      updateImNotificationUi("Browser could not display the notification.");
    }
  }

  async function requestImBrowserNotifications() {
    if (!("Notification" in window)) {
      updateImNotificationUi("This browser does not support desktop/browser notifications.");
      return;
    }
    if (Notification.permission === "denied") {
      updateImNotificationUi("Notifications are blocked. Open browser site settings, allow notifications, then reload.");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      updateImNotificationUi(permission === "granted" ? "Browser alerts enabled. Use Test Alert to verify." : "Permission was not granted. Alerts will remain on-screen only.");
    } catch (error) {
      console.error(error);
      updateImNotificationUi("Could not request notification permission.");
    }
  }

  function renderImPriceAlertsTable() {
    const body = document.getElementById("im-price-alert-table-body");
    const empty = document.getElementById("im-price-alert-empty");
    const alerts = getImPriceAlerts();

    if (empty) empty.style.display = alerts.length ? "none" : "block";
    if (!body) return;

    body.innerHTML = alerts
      .map(
        (alert) => `
          <tr>
            <td>${escapeHtml(IM_MARKET_LABELS[alert.market] || alert.market)}</td>
            <td>${alert.direction === "above" ? "At or above" : "At or below"}</td>
            <td>${formatNumber(alert.target)}</td>
            <td><button class="delete-trade-button" type="button" data-delete-alert-id="${alert.id}">Delete</button></td>
          </tr>
        `
      )
      .join("");
  }

  function renderImAlerts() {
    const settings = getImAlertSettings();
    const runtime = getImAlertRuntime();
    const signalToggle = document.getElementById("im-signal-change-toggle");
    if (signalToggle) signalToggle.checked = settings.signalChangeEnabled;

    const lastAlertEl = document.getElementById("im-last-alert-status");
    if (lastAlertEl) {
      lastAlertEl.textContent = runtime.lastAlertMessage
        ? `${runtime.lastAlertMessage} • ${new Date(runtime.lastAlertAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
        : "No alert triggered yet.";
    }

    renderImPriceAlertsTable();
    updateImNotificationUi();
  }

  function checkImPriceAlerts(marketKey, price) {
    const currentPrice = Number(price);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const alerts = getImPriceAlerts();
    const runtime = getImAlertRuntime();
    const previousPrice = Number(runtime.lastPriceByMarket[marketKey]);
    let changed = false;
    // Notifications are collected here and fired only after all local state below is
    // persisted — sendImBrowserAlert does its own read-modify-write of the alert
    // runtime (to record the "last alert" message), so firing it before this
    // function's own final saveImAlertRuntime() would have that save clobber it.
    const notifications = [];

    alerts.forEach((alert) => {
      if (alert.market !== marketKey) return;

      if (
        alert.direction === "above" &&
        currentPrice >= alert.target &&
        alert.triggeredFor !== alert.target &&
        (!Number.isFinite(previousPrice) || previousPrice < alert.target)
      ) {
        alert.triggeredFor = alert.target;
        changed = true;
        notifications.push({
          title: `${IM_MARKET_LABELS[marketKey]} Price Alert`,
          body: `${IM_MARKET_LABELS[marketKey]} reached ${formatNumber(currentPrice)}, at or above your target of ${formatNumber(alert.target)}.`,
          tag: `im-${marketKey}-above-${alert.target}`
        });
      } else if (
        alert.direction === "below" &&
        currentPrice <= alert.target &&
        alert.triggeredFor !== alert.target &&
        (!Number.isFinite(previousPrice) || previousPrice > alert.target)
      ) {
        alert.triggeredFor = alert.target;
        changed = true;
        notifications.push({
          title: `${IM_MARKET_LABELS[marketKey]} Price Alert`,
          body: `${IM_MARKET_LABELS[marketKey]} reached ${formatNumber(currentPrice)}, at or below your target of ${formatNumber(alert.target)}.`,
          tag: `im-${marketKey}-below-${alert.target}`
        });
      } else if (alert.direction === "above" && currentPrice < alert.target && alert.triggeredFor === alert.target) {
        alert.triggeredFor = null;
        changed = true;
      } else if (alert.direction === "below" && currentPrice > alert.target && alert.triggeredFor === alert.target) {
        alert.triggeredFor = null;
        changed = true;
      }
    });

    runtime.lastPriceByMarket[marketKey] = currentPrice;
    saveImAlertRuntime(runtime);
    if (changed) {
      saveImPriceAlerts(alerts);
      renderImPriceAlertsTable();
    }

    notifications.forEach((n) => sendImBrowserAlert(n.title, n.body, n.tag));
  }

  function checkImSignalAlert(marketKey, label) {
    const settings = getImAlertSettings();
    const runtime = getImAlertRuntime();
    const decision = String(label || "").toUpperCase() || null;
    const previous = runtime.previousDecisionByMarket[marketKey];
    const shouldNotify = Boolean(settings.signalChangeEnabled && previous && decision && previous !== decision);

    runtime.previousDecisionByMarket[marketKey] = decision;
    saveImAlertRuntime(runtime);

    if (shouldNotify) {
      sendImBrowserAlert(
        `${IM_MARKET_LABELS[marketKey]} Decision Changed`,
        `${previous} changed to ${decision}. Review live technical conditions before taking any action.`,
        `im-${marketKey}-decision-change`
      );
    }
  }

  // ===================== Custom condition alerts =====================
  // Combines up to 3 numeric conditions (Price/RSI/Volume Ratio/MACD
  // Histogram) with AND. Checked from the same market-refresh tick that
  // already re-renders the dashboard for the 4 known indices — no new
  // polling, just reading fields already present in that data.

  const IM_CONDITION_ALERTS_KEY = "imConditionAlertsV1";
  const IM_CONDITION_FIELD_LABELS = {
    price: "Price",
    rsi_14: "RSI (14)",
    volume_ratio: "Volume Ratio",
    macd_histogram: "MACD Histogram"
  };
  const IM_CONDITION_FIELD_GETTERS = {
    price: (d) => Number(d.price),
    rsi_14: (d) => Number(d.indicators?.rsi_14),
    volume_ratio: (d) => Number(d.indicators?.volume_ratio),
    macd_histogram: (d) => Number(d.indicators?.macd_histogram)
  };

  function getImConditionAlerts() {
    try {
      return JSON.parse(localStorage.getItem(IM_CONDITION_ALERTS_KEY)) || [];
    } catch (error) {
      return [];
    }
  }

  function saveImConditionAlerts(alerts) {
    try {
      localStorage.setItem(IM_CONDITION_ALERTS_KEY, JSON.stringify(alerts));
    } catch (error) {
      // Browser storage unavailable: current session will still work.
    }
  }

  function describeImConditionAlert(alert) {
    return alert.conditions
      .map((c) => `${IM_CONDITION_FIELD_LABELS[c.field] || c.field} ${c.operator} ${c.threshold}`)
      .join(" AND ");
  }

  function renderImConditionAlertsTable() {
    const body = document.getElementById("im-condition-alert-table-body");
    const empty = document.getElementById("im-condition-alert-empty");
    const alerts = getImConditionAlerts();

    if (empty) empty.style.display = alerts.length ? "none" : "block";
    if (!body) return;

    body.innerHTML = alerts
      .map(
        (alert) => `
          <tr>
            <td>${escapeHtml(IM_MARKET_LABELS[alert.market] || alert.market)}</td>
            <td>${escapeHtml(describeImConditionAlert(alert))}</td>
            <td><button class="delete-trade-button" type="button" data-delete-condition-alert-id="${alert.id}">Delete</button></td>
          </tr>
        `
      )
      .join("");
  }

  function checkImConditionAlerts(marketKey, data) {
    const alerts = getImConditionAlerts();
    let changed = false;
    const notifications = [];

    alerts.forEach((alert) => {
      if (alert.market !== marketKey) return;

      const allMet = alert.conditions.every((c) => {
        const getter = IM_CONDITION_FIELD_GETTERS[c.field];
        if (!getter) return false;
        const value = getter(data);
        if (!Number.isFinite(value)) return false;
        return c.operator === ">" ? value > c.threshold : value < c.threshold;
      });

      if (allMet && !alert.triggered) {
        alert.triggered = true;
        changed = true;
        notifications.push({
          title: `${IM_MARKET_LABELS[marketKey]} Condition Alert`,
          body: `Conditions met: ${describeImConditionAlert(alert)}`,
          tag: `im-condition-${alert.id}`
        });
      } else if (!allMet && alert.triggered) {
        // Re-arm so the same alert can fire again next time the conditions
        // are freshly met, instead of only ever notifying once.
        alert.triggered = false;
        changed = true;
      }
    });

    if (changed) saveImConditionAlerts(alerts);
    notifications.forEach((n) => sendImBrowserAlert(n.title, n.body, n.tag));
  }

  function setupImConditionAlerts() {
    const form = document.getElementById("im-condition-alert-form");
    const tableBody = document.getElementById("im-condition-alert-table-body");

    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const market = document.getElementById("im-condition-alert-market").value;
        const rows = [...form.querySelectorAll(".im-condition-row")];

        const conditions = rows
          .map((row) => ({
            field: row.querySelector(".im-condition-field").value,
            operator: row.querySelector(".im-condition-operator").value,
            threshold: Number(row.querySelector(".im-condition-value").value)
          }))
          .filter((c) => c.field && Number.isFinite(c.threshold));

        if (!conditions.length) {
          alert("Add at least one condition with a value.");
          return;
        }

        const alerts = getImConditionAlerts();
        alerts.unshift({
          id: `imc${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
          market,
          conditions,
          triggered: false
        });
        saveImConditionAlerts(alerts);
        renderImConditionAlertsTable();
        form.reset();
      });
    }

    if (tableBody) {
      tableBody.addEventListener("click", (event) => {
        const button = event.target.closest("[data-delete-condition-alert-id]");
        if (!button) return;
        const alerts = getImConditionAlerts().filter((alert) => alert.id !== button.dataset.deleteConditionAlertId);
        saveImConditionAlerts(alerts);
        renderImConditionAlertsTable();
      });
    }

    renderImConditionAlertsTable();
  }

  function setupImAlerts() {
    const enableButton = document.getElementById("im-enable-notifications-btn");
    const testButton = document.getElementById("im-test-notification-btn");
    const form = document.getElementById("im-price-alert-form");
    const signalToggle = document.getElementById("im-signal-change-toggle");
    const tableBody = document.getElementById("im-price-alert-table-body");

    if (enableButton) enableButton.addEventListener("click", requestImBrowserNotifications);
    if (testButton) {
      testButton.addEventListener("click", () => {
        sendImBrowserAlert("Indian Market Test Alert", "Browser alerts are working. This is a test notification.", "im-test-alert");
      });
    }

    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const market = document.getElementById("im-alert-market").value;
        const direction = document.getElementById("im-alert-direction").value;
        const targetInput = document.getElementById("im-alert-target");
        const target = Number(targetInput.value);

        if (!Number.isFinite(target) || target <= 0) {
          alert("Please enter a valid target price.");
          return;
        }

        const alerts = getImPriceAlerts();
        alerts.unshift({ id: `ima${Date.now()}${Math.random().toString(16).slice(2, 6)}`, market, direction, target, triggeredFor: null });
        saveImPriceAlerts(alerts);
        renderImPriceAlertsTable();
        form.reset();
      });
    }

    if (signalToggle) {
      signalToggle.addEventListener("change", () => {
        const settings = getImAlertSettings();
        settings.signalChangeEnabled = signalToggle.checked;
        saveImAlertSettings(settings);
      });
    }

    if (tableBody) {
      tableBody.addEventListener("click", (event) => {
        const button = event.target.closest("[data-delete-alert-id]");
        if (!button) return;
        const alerts = getImPriceAlerts().filter((alert) => alert.id !== button.dataset.deleteAlertId);
        saveImPriceAlerts(alerts);
        renderImPriceAlertsTable();
      });
    }

    renderImAlerts();
  }

  setupImAlerts();
  setupImConditionAlerts();

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

    if (marketKey === "finnifty") {
      return {
        name: "Nifty Financial Services",
        price: 25076.65,
        support: 24900,
        resistance: 25150,
        decision: "BUY SETUP",
        entry: "25,076.65 - 25,094.50",
        stop: "24,932.80",
        target1: "25,220.30",
        target2: "25,364.00",
        exit: "Exit if stop-loss is hit, price loses VWAP and EMA 21, or an opposite confirmed signal appears."
      };
    }

    if (marketKey === "sensex") {
      return {
        name: "SENSEX",
        price: 74003.82,
        support: 73500,
        resistance: 74250,
        decision: "BUY SETUP",
        entry: "74,003.82 - 74,050.20",
        stop: "73,640.90",
        target1: "74,366.60",
        target2: "74,729.40",
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

  const LIVE_CANDLE_API_BASE = "https://api.marketdock.in";
  let chartRefreshTimer = null;
  let latestLiveCandleData = null;
  let imChartFullscreenActive = false;

  const IM_CHART_EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
  const IM_CHART_COLLAPSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v3a2 2 0 0 1-2 2H4M15 3v3a2 2 0 0 0 2 2h3M21 15h-3a2 2 0 0 0-2 2v3M3 15h3a2 2 0 0 1 2 2v3"/></svg>';

  // The Android hardware back button closes fullscreen instead of leaving
  // the page or exiting the app, via the shared Capacitor App "backButton"
  // listener set up earlier in this module.
  function setImChartFullscreen(active) {
    const container = document.getElementById("im-lightweight-chart");
    const btn = document.getElementById("im-chart-fullscreen-btn");
    if (!container || active === imChartFullscreenActive) return;

    imChartFullscreenActive = active;
    container.classList.toggle("im-chart-fullscreen-active", active);
    document.body.classList.toggle("im-chart-fullscreen-open", active);

    if (btn) {
      btn.title = active ? "Exit fullscreen" : "Fullscreen";
      btn.setAttribute("aria-label", btn.title);
      btn.innerHTML = active ? IM_CHART_COLLAPSE_ICON : IM_CHART_EXPAND_ICON;
    }

    requestAnimationFrame(() => {
      if (!imLiveChart || !container.clientWidth) return;
      imLiveChart.applyOptions({
        width: container.clientWidth,
        height: active ? container.clientHeight : 600
      });
      scheduleImDrawingReposition();
    });
  }

  function setupImChartFullscreenToggle() {
    const btn = document.getElementById("im-chart-fullscreen-btn");
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "true";

    btn.addEventListener("click", () => setImChartFullscreen(!imChartFullscreenActive));

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && imChartFullscreenActive) {
        setImChartFullscreen(false);
      }
    });
  }

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

    const liveChartColors = getChartThemeColors();
    imLiveChart = registerThemedChart(LightweightCharts.createChart(container, {
      width: container.clientWidth,
      height: 600,
      layout: {
        background: { color: liveChartColors.bg },
        textColor: liveChartColors.text
      },
      grid: {
        vertLines: { color: liveChartColors.grid },
        horzLines: { color: liveChartColors.grid }
      },
      rightPriceScale: {
        borderColor: liveChartColors.border
      },
      timeScale: {
        borderColor: liveChartColors.border,
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal
      }
    }));

    imLiveSeries = imLiveChart.addCandlestickSeries({
      upColor: "#34d399",
      downColor: "#f87171",
      borderUpColor: "#34d399",
      borderDownColor: "#f87171",
      wickUpColor: "#86efac",
      wickDownColor: "#fca5a5"
    });

    new ResizeObserver(() => {
      if (!imLiveChart || !container.clientWidth) return;
      const resizeOptions = { width: container.clientWidth };
      if (imChartFullscreenActive) {
        resizeOptions.height = container.clientHeight;
      }
      imLiveChart.applyOptions(resizeOptions);
      scheduleImDrawingReposition();
    }).observe(container);

    setupImDrawingTools();
    loadSavedImDrawings();
    setupImReplayControls();
    setupImChartFullscreenToggle();
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
  let imDrawingPendingPoints = [];
  let imDrawingRepositionFrame = null;
  let imLiveCandleRawData = [];
  let imBrushDrawing = false;

  const IM_DRAW_TOOL_POINT_COUNTS = {
    trend: 2,
    rectangle: 2,
    measure: 2,
    fibonacci: 2,
    position: 2,
    "volume-profile": 2,
    ray: 2,
    extended: 2,
    circle: 2,
    arrow: 2,
    "price-range": 2,
    "date-range": 2,
    channel: 3
  };

  const IM_BACKTEST_STORAGE_KEY = "imBacktestResultsV1";
  let imReplayActive = false;
  let imReplayPicking = false;
  let imReplayIndex = -1;
  let imReplayPlaying = false;
  let imReplayTimer = null;
  let imReplaySpeedMs = 1000;
  let imOpenBacktestTrade = null;

  function getImDrawingOverlaySvg() {
    return document.getElementById("im-drawing-overlay");
  }

  function setImDrawingToolHint(text) {
    const hint = document.getElementById("im-drawing-tool-hint");
    if (hint) hint.textContent = text || "";
  }

  function setImDrawingMode(mode) {
    imDrawingMode = mode;
    imDrawingPendingPoints = [];
    document.querySelectorAll(".im-drawing-tool-btn[data-im-draw-tool]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.imDrawTool === mode);
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
      "volume-profile": "Click the start of the range, then the end, to show traded volume by price.",
      ray: "Click the anchor point, then a second point — the ray extends forward through it.",
      extended: "Click two points — the line extends infinitely in both directions.",
      channel: "Click the start and end of the base line, then a third point to set the channel width.",
      circle: "Click one corner, then the opposite corner, to fit a circle/ellipse.",
      arrow: "Click the start point, then the point the arrow should point to.",
      text: "Click the chart, then type your note.",
      "price-range": "Click the first price level, then the second, to measure the price range.",
      "date-range": "Click the first point, then the second, to measure the time range.",
      brush: "Press and drag on the chart to draw freehand."
    };
    setImDrawingToolHint(hints[mode] || "");
  }

  function saveImDrawings() {
    try {
      const serializable = imUserDrawings.map(({ id, type, color, price, time, t1, p1, t2, p2, t3, p3, label, points }) => ({ id, type, color, price, time, t1, p1, t2, p2, t3, p3, label, points }));
      localStorage.setItem(IM_DRAWING_STORAGE_KEY, JSON.stringify(serializable));
    } catch (error) {
      console.error(error);
    }
  }

  function scheduleImDrawingReposition() {
    if (imDrawingRepositionFrame) return;
    imDrawingRepositionFrame = window.requestAnimationFrame(imDrawingRepositionLoop);
  }

  const IM_OVERLAY_REPOSITION_TYPES = new Set([
    "vertical", "rectangle", "trend", "measure", "fibonacci", "position", "volume-profile",
    "ray", "extended", "channel", "circle", "arrow", "text", "price-range", "date-range", "brush"
  ]);

  function imDrawingRepositionLoop() {
    repositionImDrawingOverlays();
    const hasOverlayDrawings = imUserDrawings.some((d) => IM_OVERLAY_REPOSITION_TYPES.has(d.type));
    imDrawingRepositionFrame = hasOverlayDrawings ? window.requestAnimationFrame(imDrawingRepositionLoop) : null;
  }

  function getImDrawingIntervalSeconds() {
    const intervals = {
      "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
      "1h": 3600, "2h": 7200, "4h": 14400,
      "1d": 86400, "1w": 604800, "1mo": 2592000
    };
    return intervals[selectedChartTimeframe] || 300;
  }

  function formatImMeasureDuration(totalSeconds) {
    const seconds = Math.abs(Math.round(totalSeconds));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function renderImMeasureLabel(textEl, drawing) {
    const priceDiff = drawing.p2 - drawing.p1;
    const percent = drawing.p1 !== 0 ? (priceDiff / Math.abs(drawing.p1)) * 100 : 0;
    const bars = Math.round(Math.abs(drawing.t2 - drawing.t1) / getImDrawingIntervalSeconds());
    const duration = formatImMeasureDuration(drawing.t2 - drawing.t1);
    const sign = priceDiff >= 0 ? "+" : "";
    textEl.textContent = `${sign}${formatNumber(priceDiff)} (${sign}${percent.toFixed(2)}%) — ${bars} bars — ${duration}`;
  }

  function repositionImDrawingOverlays() {
    if (!imLiveChart || !imLiveSeries) return;
    const container = document.getElementById("im-lightweight-chart");
    const height = container ? container.clientHeight : 600;
    const width = container ? container.clientWidth : 0;

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
      } else if (drawing.type === "vertical" && drawing.el) {
        const x = imLiveChart.timeScale().timeToCoordinate(drawing.time);
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
        const x1 = imLiveChart.timeScale().timeToCoordinate(drawing.t1);
        const x2 = imLiveChart.timeScale().timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) {
          drawing.el.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        drawing.el.setAttribute("x", Math.min(x1, x2));
        drawing.el.setAttribute("y", Math.min(y1, y2));
        drawing.el.setAttribute("width", Math.max(1, Math.abs(x2 - x1)));
        drawing.el.setAttribute("height", Math.max(1, Math.abs(y2 - y1)));
      } else if (drawing.type === "measure" && drawing.el) {
        const x1 = imLiveChart.timeScale().timeToCoordinate(drawing.t1);
        const x2 = imLiveChart.timeScale().timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
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
        if (drawing.textEl) {
          drawing.textEl.setAttribute("opacity", "1");
          drawing.textEl.setAttribute("x", Math.min(x1, x2) + 6);
          drawing.textEl.setAttribute("y", Math.min(y1, y2) - 8 < 12 ? Math.min(y1, y2) + 16 : Math.min(y1, y2) - 8);
          renderImMeasureLabel(drawing.textEl, drawing);
        }
      } else if (drawing.type === "position" && drawing.riskRectEl) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const entryY = imLiveSeries.priceToCoordinate(drawing.p1);
        const stopY = imLiveSeries.priceToCoordinate(drawing.p2);
        if (x1 === null || x2 === null || entryY === null || stopY === null) {
          drawing.riskRectEl.setAttribute("opacity", "0");
          drawing.rewardRectEl.setAttribute("opacity", "0");
          drawing.entryLineEl.setAttribute("opacity", "0");
          drawing.labelEl.setAttribute("opacity", "0");
          return;
        }
        const risk = drawing.p1 - drawing.p2;
        const targetPrice = drawing.p1 + risk * 2;
        const targetY = imLiveSeries.priceToCoordinate(targetPrice);
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
        drawing.labelEl.textContent = `${direction}  Entry ${formatNumber(drawing.p1)}  •  Stop ${formatNumber(drawing.p2)}  •  Target ${formatNumber(targetPrice)}  •  R:R 1:2.00`;
      } else if (drawing.type === "volume-profile" && Array.isArray(drawing.barEls)) {
        const timeScale = imLiveChart.timeScale();
        const rangeStart = Math.min(drawing.t1, drawing.t2);
        const rangeEnd = Math.max(drawing.t1, drawing.t2);
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const hide = () => {
          drawing.barEls.forEach((bar) => bar.setAttribute("opacity", "0"));
          drawing.boundsEl.setAttribute("opacity", "0");
          drawing.labelEl.setAttribute("opacity", "0");
        };
        if (x1 === null || x2 === null) {
          hide();
          return;
        }
        const candlesInRange = imLiveCandleRawData.filter((candle) => candle.time >= rangeStart && candle.time <= rangeEnd);
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
        const topY = imLiveSeries.priceToCoordinate(highestPrice);
        const bottomY = imLiveSeries.priceToCoordinate(lowestPrice);
        if (topY === null || bottomY === null) {
          hide();
          return;
        }
        drawing.boundsEl.setAttribute("y", topY);
        drawing.boundsEl.setAttribute("height", Math.max(1, bottomY - topY));

        drawing.barEls.forEach((bar, index) => {
          const binLowPrice = lowestPrice + index * binSize;
          const binHighPrice = binLowPrice + binSize;
          const binTopY = imLiveSeries.priceToCoordinate(binHighPrice);
          const binBottomY = imLiveSeries.priceToCoordinate(binLowPrice);
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
        drawing.labelEl.textContent = `Volume Profile  •  POC ${formatNumber(lowestPrice + pocIndex * binSize + binSize / 2)}`;
      } else if (drawing.type === "ray" && drawing.el) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null || x1 === x2) {
          drawing.el.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        const slope = (y2 - y1) / (x2 - x1);
        const goingRight = x2 >= x1;
        const edgeX = goingRight ? width : 0;
        const edgeY = y1 + slope * (edgeX - x1);
        drawing.el.setAttribute("x1", x1);
        drawing.el.setAttribute("y1", y1);
        drawing.el.setAttribute("x2", edgeX);
        drawing.el.setAttribute("y2", edgeY);
      } else if (drawing.type === "extended" && drawing.el) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null || x1 === x2) {
          drawing.el.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        const slope = (y2 - y1) / (x2 - x1);
        const yAtLeft = y1 + slope * (0 - x1);
        const yAtRight = y1 + slope * (width - x1);
        drawing.el.setAttribute("x1", 0);
        drawing.el.setAttribute("y1", yAtLeft);
        drawing.el.setAttribute("x2", width);
        drawing.el.setAttribute("y2", yAtRight);
      } else if (drawing.type === "channel" && drawing.baseEl) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
        const y1Offset = imLiveSeries.priceToCoordinate(drawing.p1 + drawing.offsetPrice);
        const y2Offset = imLiveSeries.priceToCoordinate(drawing.p2 + drawing.offsetPrice);
        if (x1 === null || x2 === null || y1 === null || y2 === null || y1Offset === null || y2Offset === null) {
          drawing.baseEl.setAttribute("opacity", "0");
          drawing.offsetEl.setAttribute("opacity", "0");
          drawing.fillEl.setAttribute("opacity", "0");
          return;
        }
        drawing.baseEl.setAttribute("opacity", "1");
        drawing.baseEl.setAttribute("x1", x1);
        drawing.baseEl.setAttribute("y1", y1);
        drawing.baseEl.setAttribute("x2", x2);
        drawing.baseEl.setAttribute("y2", y2);
        drawing.offsetEl.setAttribute("opacity", "1");
        drawing.offsetEl.setAttribute("x1", x1);
        drawing.offsetEl.setAttribute("y1", y1Offset);
        drawing.offsetEl.setAttribute("x2", x2);
        drawing.offsetEl.setAttribute("y2", y2Offset);
        drawing.fillEl.setAttribute("opacity", "1");
        drawing.fillEl.setAttribute("points", `${x1},${y1} ${x2},${y2} ${x2},${y2Offset} ${x1},${y1Offset}`);
      } else if (drawing.type === "circle" && drawing.el) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) {
          drawing.el.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        drawing.el.setAttribute("cx", (x1 + x2) / 2);
        drawing.el.setAttribute("cy", (y1 + y2) / 2);
        drawing.el.setAttribute("rx", Math.max(1, Math.abs(x2 - x1) / 2));
        drawing.el.setAttribute("ry", Math.max(1, Math.abs(y2 - y1) / 2));
      } else if (drawing.type === "arrow" && drawing.el) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
        if (x1 === null || x2 === null || y1 === null || y2 === null) {
          drawing.el.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        drawing.el.setAttribute("x1", x1);
        drawing.el.setAttribute("y1", y1);
        drawing.el.setAttribute("x2", x2);
        drawing.el.setAttribute("y2", y2);
      } else if (drawing.type === "text" && drawing.textEl) {
        const x = imLiveChart.timeScale().timeToCoordinate(drawing.time);
        const y = imLiveSeries.priceToCoordinate(drawing.price);
        if (x === null || y === null) {
          drawing.textEl.setAttribute("opacity", "0");
          if (drawing.bgEl) drawing.bgEl.setAttribute("opacity", "0");
          return;
        }
        drawing.textEl.setAttribute("opacity", "1");
        drawing.textEl.setAttribute("x", x + 6);
        drawing.textEl.setAttribute("y", y);
        if (drawing.bgEl) {
          drawing.bgEl.setAttribute("opacity", "1");
          const textWidth = drawing.label.length * 6.4 + 10;
          drawing.bgEl.setAttribute("x", x + 1);
          drawing.bgEl.setAttribute("y", y - 12);
          drawing.bgEl.setAttribute("width", textWidth);
          drawing.bgEl.setAttribute("height", 17);
        }
      } else if (drawing.type === "price-range" && drawing.el) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        const y1 = imLiveSeries.priceToCoordinate(drawing.p1);
        const y2 = imLiveSeries.priceToCoordinate(drawing.p2);
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
        if (drawing.textEl) {
          const priceDiff = drawing.p2 - drawing.p1;
          const percent = drawing.p1 !== 0 ? (priceDiff / Math.abs(drawing.p1)) * 100 : 0;
          const sign = priceDiff >= 0 ? "+" : "";
          drawing.textEl.setAttribute("opacity", "1");
          drawing.textEl.setAttribute("x", Math.min(x1, x2) + 6);
          drawing.textEl.setAttribute("y", Math.min(y1, y2) - 8 < 12 ? Math.min(y1, y2) + 16 : Math.min(y1, y2) - 8);
          drawing.textEl.textContent = `${sign}${formatNumber(priceDiff)} (${sign}${percent.toFixed(2)}%)`;
        }
      } else if (drawing.type === "date-range" && drawing.el) {
        const timeScale = imLiveChart.timeScale();
        const x1 = timeScale.timeToCoordinate(drawing.t1);
        const x2 = timeScale.timeToCoordinate(drawing.t2);
        if (x1 === null || x2 === null) {
          drawing.el.setAttribute("opacity", "0");
          if (drawing.textEl) drawing.textEl.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        drawing.el.setAttribute("x", Math.min(x1, x2));
        drawing.el.setAttribute("y", 0);
        drawing.el.setAttribute("width", Math.max(1, Math.abs(x2 - x1)));
        drawing.el.setAttribute("height", height);
        if (drawing.textEl) {
          const bars = Math.round(Math.abs(drawing.t2 - drawing.t1) / getImDrawingIntervalSeconds());
          const duration = formatImMeasureDuration(drawing.t2 - drawing.t1);
          drawing.textEl.setAttribute("opacity", "1");
          drawing.textEl.setAttribute("x", Math.min(x1, x2) + 6);
          drawing.textEl.setAttribute("y", 16);
          drawing.textEl.textContent = `${bars} bars — ${duration}`;
        }
      } else if (drawing.type === "brush" && drawing.el && Array.isArray(drawing.points)) {
        const timeScale = imLiveChart.timeScale();
        const coords = drawing.points
          .map((pt) => {
            const x = timeScale.timeToCoordinate(pt.t);
            const y = imLiveSeries.priceToCoordinate(pt.p);
            return x === null || y === null ? null : `${x},${y}`;
          })
          .filter(Boolean);
        if (!coords.length) {
          drawing.el.setAttribute("opacity", "0");
          return;
        }
        drawing.el.setAttribute("opacity", "1");
        drawing.el.setAttribute("points", coords.join(" "));
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
    } else if (type === "vertical") {
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
      el.setAttribute("stroke-dasharray", "4,3");
      svg.appendChild(el);
      drawing.el = el;
    } else if (type === "rectangle") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      el.setAttribute("fill", `${color}26`);
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
      svg.appendChild(el);
      drawing.el = el;
    } else if (type === "measure") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
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
      svg.appendChild(textEl);
      drawing.textEl = textEl;
    } else if (type === "position") {
      if (points.t1 === points.t2 || points.p1 === points.p2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const riskRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      riskRect.setAttribute("fill", "#f8717133");
      riskRect.setAttribute("stroke", "#f87171");
      riskRect.setAttribute("stroke-width", "1");
      svg.appendChild(riskRect);
      drawing.riskRectEl = riskRect;

      const rewardRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rewardRect.setAttribute("fill", "#34d39933");
      rewardRect.setAttribute("stroke", "#34d399");
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
      svg.appendChild(labelEl);
      drawing.labelEl = labelEl;
    } else if (type === "volume-profile") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
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
      svg.appendChild(labelEl);
      drawing.labelEl = labelEl;
    } else if (type === "ray" || type === "extended") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
      svg.appendChild(el);
      drawing.el = el;
    } else if (type === "channel") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const baseSlopePrice = points.p1 + (points.p2 - points.p1) * ((points.t3 - points.t1) / (points.t2 - points.t1));
      drawing.offsetPrice = points.p3 - baseSlopePrice;

      const fillEl = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      fillEl.setAttribute("fill", `${color}22`);
      svg.appendChild(fillEl);
      drawing.fillEl = fillEl;

      const baseEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
      baseEl.setAttribute("stroke", color);
      baseEl.setAttribute("stroke-width", "1.5");
      svg.appendChild(baseEl);
      drawing.baseEl = baseEl;

      const offsetEl = document.createElementNS("http://www.w3.org/2000/svg", "line");
      offsetEl.setAttribute("stroke", color);
      offsetEl.setAttribute("stroke-width", "1.5");
      svg.appendChild(offsetEl);
      drawing.offsetEl = offsetEl;
    } else if (type === "circle") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
      el.setAttribute("fill", `${color}26`);
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
      svg.appendChild(el);
      drawing.el = el;
    } else if (type === "arrow") {
      if (points.t1 === points.t2 && points.p1 === points.p2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      let defs = svg.querySelector("defs");
      if (!defs) {
        defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
        svg.insertBefore(defs, svg.firstChild);
      }
      const markerId = `im-arrowhead-${id}`;
      const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
      marker.setAttribute("id", markerId);
      marker.setAttribute("markerWidth", "8");
      marker.setAttribute("markerHeight", "8");
      marker.setAttribute("refX", "6");
      marker.setAttribute("refY", "4");
      marker.setAttribute("orient", "auto-start-reverse");
      const markerPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      markerPath.setAttribute("d", "M0,0 L8,4 L0,8 Z");
      markerPath.setAttribute("fill", color);
      marker.appendChild(markerPath);
      defs.appendChild(marker);
      drawing.markerEl = marker;

      const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "2");
      el.setAttribute("marker-end", `url(#${markerId})`);
      svg.appendChild(el);
      drawing.el = el;
    } else if (type === "text") {
      const label = String(points.label || "").trim();
      if (!label) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      drawing.label = label;

      const bgEl = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bgEl.setAttribute("fill", "#0c0a14cc");
      bgEl.setAttribute("rx", "3");
      svg.appendChild(bgEl);
      drawing.bgEl = bgEl;

      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("fill", color);
      textEl.setAttribute("font-size", "12");
      textEl.setAttribute("font-weight", "700");
      textEl.textContent = label;
      svg.appendChild(textEl);
      drawing.textEl = textEl;
    } else if (type === "price-range") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      el.setAttribute("fill", `${color}26`);
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
      el.setAttribute("stroke-dasharray", "4,3");
      svg.appendChild(el);
      drawing.el = el;
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("fill", "#f8fafc");
      textEl.setAttribute("font-size", "12");
      textEl.setAttribute("font-weight", "700");
      svg.appendChild(textEl);
      drawing.textEl = textEl;
    } else if (type === "date-range") {
      if (points.t1 === points.t2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      el.setAttribute("fill", `${color}18`);
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
      el.setAttribute("stroke-dasharray", "4,3");
      svg.appendChild(el);
      drawing.el = el;
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.setAttribute("fill", "#f8fafc");
      textEl.setAttribute("font-size", "12");
      textEl.setAttribute("font-weight", "700");
      svg.appendChild(textEl);
      drawing.textEl = textEl;
    } else if (type === "brush") {
      if (!Array.isArray(points.points) || points.points.length < 2) return null;
      const svg = getImDrawingOverlaySvg();
      if (!svg) return null;
      drawing.points = points.points;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "2");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
      svg.appendChild(el);
      drawing.el = el;
    }

    imUserDrawings.push(drawing);
    if (persist) saveImDrawings();
    scheduleImDrawingReposition();
    return drawing;
  }

  function removeImDrawingElements(drawing) {
    if (drawing.type === "horizontal" && drawing.ref) imLiveSeries.removePriceLine(drawing.ref);
    else if (drawing.type === "trend" && drawing.ref) imLiveChart.removeSeries(drawing.ref);
    else if (drawing.type === "fibonacci" && drawing.levelEls) {
      drawing.levelEls.forEach(({ line, text }) => { line.remove(); text.remove(); });
    }
    if (drawing.el) drawing.el.remove();
    if (drawing.textEl) drawing.textEl.remove();
    if (drawing.riskRectEl) drawing.riskRectEl.remove();
    if (drawing.rewardRectEl) drawing.rewardRectEl.remove();
    if (drawing.entryLineEl) drawing.entryLineEl.remove();
    if (drawing.labelEl) drawing.labelEl.remove();
    if (drawing.boundsEl) drawing.boundsEl.remove();
    if (Array.isArray(drawing.barEls)) drawing.barEls.forEach((bar) => bar.remove());
    if (drawing.baseEl) drawing.baseEl.remove();
    if (drawing.offsetEl) drawing.offsetEl.remove();
    if (drawing.fillEl) drawing.fillEl.remove();
    if (drawing.markerEl) drawing.markerEl.remove();
    if (drawing.bgEl) drawing.bgEl.remove();
  }

  function clearAllImDrawings() {
    imUserDrawings.forEach(removeImDrawingElements);
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
    if (imReplayPicking) {
      pickImReplayStart(param);
      return;
    }
    if (imDrawingMode === "cursor" || !param.point || !param.time || !imLiveSeries) return;
    const price = imLiveSeries.coordinateToPrice(param.point.y);
    if (price === null) return;

    if (imDrawingMode === "horizontal") {
      imAddDrawing("horizontal", { price }, imDrawingColor);
      setImDrawingMode("cursor");
      return;
    }

    if (imDrawingMode === "vertical") {
      imAddDrawing("vertical", { time: param.time }, imDrawingColor);
      setImDrawingMode("cursor");
      return;
    }

    if (imDrawingMode === "text") {
      const label = window.prompt("Note text:");
      if (label && label.trim()) {
        imAddDrawing("text", { time: param.time, price, label: label.trim() }, imDrawingColor);
      }
      setImDrawingMode("cursor");
      return;
    }

    const pointCount = IM_DRAW_TOOL_POINT_COUNTS[imDrawingMode] || 2;
    imDrawingPendingPoints.push({ time: param.time, price });

    if (imDrawingPendingPoints.length < pointCount) {
      const remaining = pointCount - imDrawingPendingPoints.length;
      setImDrawingToolHint(`Click ${remaining} more point${remaining > 1 ? "s" : ""} to finish.`);
      return;
    }

    const points = {};
    imDrawingPendingPoints.forEach((pt, index) => {
      points[`t${index + 1}`] = pt.time;
      points[`p${index + 1}`] = pt.price;
    });
    imAddDrawing(imDrawingMode, points, imDrawingColor);
    imDrawingPendingPoints = [];
    setImDrawingMode("cursor");
  }

  let imBrushPreviewEl = null;
  let imBrushPoints = null;

  function coordinateToTimePrice(container, clientX, clientY) {
    if (!imLiveChart || !imLiveSeries) return null;
    const rect = container.getBoundingClientRect();
    const time = imLiveChart.timeScale().coordinateToTime(clientX - rect.left);
    const price = imLiveSeries.coordinateToPrice(clientY - rect.top);
    if (time === null || price === null) return null;
    return { t: time, p: price };
  }

  function renderImBrushPreview() {
    if (!imBrushPoints || imBrushPoints.length < 2) return;
    const svg = getImDrawingOverlaySvg();
    if (!svg) return;
    if (!imBrushPreviewEl) {
      imBrushPreviewEl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      imBrushPreviewEl.setAttribute("fill", "none");
      imBrushPreviewEl.setAttribute("stroke", imDrawingColor);
      imBrushPreviewEl.setAttribute("stroke-width", "2");
      imBrushPreviewEl.setAttribute("stroke-linecap", "round");
      imBrushPreviewEl.setAttribute("stroke-linejoin", "round");
      svg.appendChild(imBrushPreviewEl);
    }
    const timeScale = imLiveChart.timeScale();
    const coords = imBrushPoints
      .map((pt) => {
        const x = timeScale.timeToCoordinate(pt.t);
        const y = imLiveSeries.priceToCoordinate(pt.p);
        return x === null || y === null ? null : `${x},${y}`;
      })
      .filter(Boolean);
    imBrushPreviewEl.setAttribute("points", coords.join(" "));
  }

  function clearImBrushPreview() {
    if (imBrushPreviewEl) {
      imBrushPreviewEl.remove();
      imBrushPreviewEl = null;
    }
  }

  function setupImBrushDrawing(container) {
    const isOnToolbarChrome = (event) =>
      event.target.closest(".drawing-toolbar, .im-chart-fullscreen-btn, .drawing-tool-hint");

    container.addEventListener("pointerdown", (event) => {
      if (imDrawingMode !== "brush" || isOnToolbarChrome(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const point = coordinateToTimePrice(container, event.clientX, event.clientY);
      if (!point) return;
      imBrushPoints = [point];
      imBrushDrawing = true;
      try { container.setPointerCapture(event.pointerId); } catch (error) { /* not critical */ }
    }, true);

    container.addEventListener("pointermove", (event) => {
      if (!imBrushDrawing || !imBrushPoints) return;
      event.preventDefault();
      event.stopPropagation();
      const point = coordinateToTimePrice(container, event.clientX, event.clientY);
      if (!point) return;
      imBrushPoints.push(point);
      renderImBrushPreview();
    }, true);

    function finishBrush(event) {
      if (!imBrushDrawing) return;
      imBrushDrawing = false;
      if (event) {
        try { container.releasePointerCapture(event.pointerId); } catch (error) { /* not critical */ }
      }
      clearImBrushPreview();
      if (imBrushPoints && imBrushPoints.length >= 2) {
        imAddDrawing("brush", { points: imBrushPoints }, imDrawingColor);
      }
      imBrushPoints = null;
      setImDrawingMode("cursor");
    }

    container.addEventListener("pointerup", (event) => {
      if (imDrawingMode !== "brush" || isOnToolbarChrome(event)) return;
      event.preventDefault();
      event.stopPropagation();
      finishBrush(event);
    }, true);

    container.addEventListener("pointercancel", () => finishBrush(null), true);
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

    const chartContainer = document.getElementById("im-lightweight-chart");
    if (chartContainer) setupImBrushDrawing(chartContainer);
  }

  // ===================== Indian Market chart replay & backtesting =====================
  // Replay steps through the already-fetched candle history (imLiveCandleRawData) one
  // bar at a time by re-slicing it into the chart series — no extra network calls.
  // While replay is active, live polling is paused. Backtesting is a single open
  // paper trade at a time: its stop/target are checked against each newly revealed
  // bar's high/low as replay steps forward, and closed trades are logged to a
  // localStorage-backed results table with win rate and R-multiple stats.

  function getImReplayEls() {
    return {
      statusTag: document.getElementById("im-replay-status-tag"),
      pickBtn: document.getElementById("im-replay-pick-btn"),
      stepBackBtn: document.getElementById("im-replay-step-back-btn"),
      playBtn: document.getElementById("im-replay-play-btn"),
      stepBtn: document.getElementById("im-replay-step-btn"),
      speedSelect: document.getElementById("im-replay-speed"),
      exitBtn: document.getElementById("im-replay-exit-btn"),
      positionText: document.getElementById("im-replay-position-text"),
      backtestPanel: document.getElementById("im-backtest-panel"),
      openTradeBox: document.getElementById("im-backtest-open-trade"),
      openTradeSummary: document.getElementById("im-backtest-open-summary"),
      closeBtn: document.getElementById("im-backtest-close-btn"),
      form: document.getElementById("im-backtest-form"),
      directionSelect: document.getElementById("im-backtest-direction"),
      entryInput: document.getElementById("im-backtest-entry"),
      stopInput: document.getElementById("im-backtest-stop"),
      targetInput: document.getElementById("im-backtest-target"),
      summaryText: document.getElementById("im-backtest-summary"),
      tableBody: document.getElementById("im-backtest-table-body"),
      clearBtn: document.getElementById("im-backtest-clear-btn")
    };
  }

  function resetImReplayEntryField() {
    const els = getImReplayEls();
    if (els.entryInput && !imOpenBacktestTrade && imLiveCandleRawData.length) {
      els.entryInput.value = imLiveCandleRawData[imLiveCandleRawData.length - 1].close.toFixed(2);
    }
  }

  function setImReplayControlsEnabled(active) {
    const els = getImReplayEls();
    [els.stepBackBtn, els.playBtn, els.stepBtn, els.speedSelect, els.exitBtn].forEach((el) => {
      if (el) el.disabled = !active;
    });
    if (els.pickBtn) els.pickBtn.disabled = active;
    if (els.backtestPanel) els.backtestPanel.hidden = !active;
    if (els.statusTag) {
      els.statusTag.textContent = active ? "REPLAY" : "Live";
      els.statusTag.style.color = active ? "#fbbf24" : "";
    }
  }

  function startImReplayPicking() {
    if (!imLiveCandleRawData.length) return;
    const els = getImReplayEls();
    if (imReplayPicking) {
      imReplayPicking = false;
      if (els.positionText) els.positionText.textContent = 'Click "Pick Replay Start", then click a candle on the chart above.';
      return;
    }
    imReplayPicking = true;
    setImDrawingMode("cursor");
    if (els.positionText) els.positionText.textContent = "Click any candle on the chart above to set the replay start point (click “Pick Replay Start” again to cancel).";
  }

  function pickImReplayStart(param) {
    imReplayPicking = false;
    if (!param || !param.time) return;
    const index = imLiveCandleRawData.findIndex((candle) => candle.time === param.time);
    if (index < 1) {
      const els = getImReplayEls();
      if (els.positionText) els.positionText.textContent = "Could not read that candle — try clicking directly on a bar.";
      if (els.pickBtn) els.pickBtn.disabled = false;
      return;
    }
    imReplayIndex = index;
    imReplayActive = true;
    stopLiveChartPolling();
    setImReplayControlsEnabled(true);
    renderImReplayFrame();
  }

  function renderImReplayFrame() {
    if (!imLiveSeries || imReplayIndex < 0) return;
    const visible = imLiveCandleRawData.slice(0, imReplayIndex + 1);
    imLiveSeries.setData(visible.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })));

    const current = visible[visible.length - 1];
    const els = getImReplayEls();
    if (els.positionText) {
      els.positionText.textContent = `Replay bar ${imReplayIndex + 1} / ${imLiveCandleRawData.length} — ${formatChartTime(current.time * 1000)} — Close ${formatNumber(current.close)}`;
    }
    const priceEl = document.getElementById("im-chart-last-price");
    if (priceEl) priceEl.textContent = formatNumber(current.close);

    checkImBacktestTrade(current);
    if (!imOpenBacktestTrade && els.entryInput) els.entryInput.value = current.close.toFixed(2);

    if (imReplayIndex + 1 >= imLiveCandleRawData.length) pauseImReplay();
  }

  function stepImReplay(delta) {
    const nextIndex = imReplayIndex + delta;
    if (nextIndex < 0 || nextIndex >= imLiveCandleRawData.length) return;
    imReplayIndex = nextIndex;
    renderImReplayFrame();
  }

  function playImReplay() {
    if (imReplayPlaying) return;
    imReplayPlaying = true;
    const els = getImReplayEls();
    if (els.playBtn) els.playBtn.textContent = "⏸ Pause";
    imReplayTimer = window.setInterval(() => stepImReplay(1), imReplaySpeedMs);
  }

  function pauseImReplay() {
    imReplayPlaying = false;
    if (imReplayTimer) {
      window.clearInterval(imReplayTimer);
      imReplayTimer = null;
    }
    const els = getImReplayEls();
    if (els.playBtn) els.playBtn.textContent = "▶ Play";
  }

  function exitImReplay() {
    if (!imReplayActive) return;
    pauseImReplay();
    if (imOpenBacktestTrade) {
      const current = imLiveCandleRawData[imReplayIndex];
      closeImBacktestTrade(current ? current.close : imOpenBacktestTrade.entry, "Closed (replay exited)", current ? current.time : imOpenBacktestTrade.entryTime);
    }
    imReplayActive = false;
    imReplayIndex = -1;
    imReplayPicking = false;
    setImReplayControlsEnabled(false);
    const els = getImReplayEls();
    if (els.positionText) els.positionText.textContent = 'Click "Pick Replay Start", then click a candle on the chart above.';
    if (els.pickBtn) els.pickBtn.disabled = false;
    startLiveChartPolling();
  }

  function loadImBacktestResults() {
    try {
      return JSON.parse(localStorage.getItem(IM_BACKTEST_STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  }

  function saveImBacktestResults(results) {
    try {
      localStorage.setItem(IM_BACKTEST_STORAGE_KEY, JSON.stringify(results));
    } catch (error) {
      console.error(error);
    }
  }

  function renderImBacktestResults() {
    const els = getImReplayEls();
    const results = loadImBacktestResults();

    if (els.tableBody) {
      els.tableBody.innerHTML = results
        .map((trade) => {
          const resultClass = trade.rMultiple > 0 ? "positive" : trade.rMultiple < 0 ? "negative" : "";
          return `<tr>
            <td>${trade.direction}</td>
            <td>${formatNumber(trade.entry)}</td>
            <td>${formatNumber(trade.stop)}</td>
            <td>${formatNumber(trade.target)}</td>
            <td>${formatNumber(trade.exit)}</td>
            <td class="${resultClass}">${trade.outcome}</td>
            <td class="${resultClass}">${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R</td>
          </tr>`;
        })
        .join("");
    }

    if (els.summaryText) {
      if (!results.length) {
        els.summaryText.textContent = "No backtest trades yet.";
      } else {
        const wins = results.filter((t) => t.rMultiple > 0).length;
        const totalR = results.reduce((sum, t) => sum + t.rMultiple, 0);
        const winRate = (wins / results.length) * 100;
        els.summaryText.textContent = `${results.length} trades — ${wins} wins (${winRate.toFixed(0)}% win rate) — Total ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R — Avg ${(totalR / results.length).toFixed(2)}R`;
      }
    }
  }

  function updateImOpenTradeBox() {
    const els = getImReplayEls();
    if (!els.openTradeBox || !els.openTradeSummary) return;
    if (!imOpenBacktestTrade) {
      els.openTradeBox.hidden = true;
      if (els.form) els.form.hidden = false;
      return;
    }
    els.openTradeBox.hidden = false;
    if (els.form) els.form.hidden = true;
    const t = imOpenBacktestTrade;
    els.openTradeSummary.textContent = `${t.direction} open — Entry ${formatNumber(t.entry)} — Stop ${formatNumber(t.stop)} — Target ${formatNumber(t.target)}`;
  }

  function placeImBacktestTrade(direction, entry, stop, target) {
    if (imOpenBacktestTrade || imReplayIndex < 0) return;
    if (direction === "LONG" && !(stop < entry && entry < target)) return;
    if (direction === "SHORT" && !(target < entry && entry < stop)) return;
    imOpenBacktestTrade = {
      direction,
      entry,
      stop,
      target,
      entryIndex: imReplayIndex,
      entryTime: imLiveCandleRawData[imReplayIndex].time
    };
    updateImOpenTradeBox();
  }

  function closeImBacktestTrade(exitPrice, outcome, exitTime) {
    if (!imOpenBacktestTrade) return;
    const t = imOpenBacktestTrade;
    const risk = Math.abs(t.entry - t.stop) || 1;
    const gain = t.direction === "LONG" ? exitPrice - t.entry : t.entry - exitPrice;
    const rMultiple = gain / risk;

    const results = loadImBacktestResults();
    results.unshift({
      direction: t.direction,
      entry: t.entry,
      stop: t.stop,
      target: t.target,
      exit: exitPrice,
      outcome,
      rMultiple,
      entryTime: t.entryTime,
      exitTime: exitTime || t.entryTime
    });
    saveImBacktestResults(results);
    renderImBacktestResults();

    imOpenBacktestTrade = null;
    updateImOpenTradeBox();
    resetImReplayEntryField();
  }

  function checkImBacktestTrade(currentBar) {
    if (!imOpenBacktestTrade || imReplayIndex <= imOpenBacktestTrade.entryIndex) return;
    const t = imOpenBacktestTrade;
    if (t.direction === "LONG") {
      if (currentBar.low <= t.stop) closeImBacktestTrade(t.stop, "LOSS", currentBar.time);
      else if (currentBar.high >= t.target) closeImBacktestTrade(t.target, "WIN", currentBar.time);
    } else {
      if (currentBar.high >= t.stop) closeImBacktestTrade(t.stop, "LOSS", currentBar.time);
      else if (currentBar.low <= t.target) closeImBacktestTrade(t.target, "WIN", currentBar.time);
    }
  }

  function setupImReplayControls() {
    const els = getImReplayEls();
    if (!els.pickBtn) return;

    els.pickBtn.addEventListener("click", startImReplayPicking);
    els.stepBackBtn.addEventListener("click", () => stepImReplay(-1));
    els.stepBtn.addEventListener("click", () => { pauseImReplay(); stepImReplay(1); });
    els.playBtn.addEventListener("click", () => (imReplayPlaying ? pauseImReplay() : playImReplay()));
    els.exitBtn.addEventListener("click", exitImReplay);
    els.speedSelect.addEventListener("change", () => {
      imReplaySpeedMs = Number(els.speedSelect.value) || 1000;
      if (imReplayPlaying) { pauseImReplay(); playImReplay(); }
    });

    if (els.form) {
      els.form.addEventListener("submit", (event) => {
        event.preventDefault();
        const direction = els.directionSelect.value;
        const entry = Number(els.entryInput.value);
        const stop = Number(els.stopInput.value);
        const target = Number(els.targetInput.value);
        if (![entry, stop, target].every((v) => Number.isFinite(v) && v > 0)) {
          alert("Please enter valid positive stop-loss and target prices.");
          return;
        }
        placeImBacktestTrade(direction, entry, stop, target);
      });
    }

    if (els.closeBtn) {
      els.closeBtn.addEventListener("click", () => {
        if (!imOpenBacktestTrade || imReplayIndex < 0) return;
        const current = imLiveCandleRawData[imReplayIndex];
        closeImBacktestTrade(current.close, "MANUAL", current.time);
      });
    }

    if (els.clearBtn) {
      els.clearBtn.addEventListener("click", () => {
        if (!window.confirm("Clear all backtest results?")) return;
        saveImBacktestResults([]);
        renderImBacktestResults();
      });
    }

    renderImBacktestResults();
  }

  function renderLiveChartCandles(candles) {
    const legend = document.querySelector(".indian-market-mode .chart-legend");

    if (!imLiveSeries || !Array.isArray(candles) || !candles.length) {
      if (legend) legend.style.display = "none";
      return;
    }

    if (legend) legend.style.display = "";

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

    imLiveCandleRawData = candles
      .map((candle) => ({
        time: Math.floor(new Date(candle.time).getTime() / 1000),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume) || 0
      }))
      .filter((point) => Number.isFinite(point.time))
      .sort((a, b) => a.time - b.time);

    if (!imReplayActive) resetImReplayEntryField();
  }

  async function refreshLiveChartCandles() {
    const requestedMarket = selectedChartMarket;
    const requestedTimeframe = selectedChartTimeframe;
    const status = document.getElementById("im-chart-data-status");
    const subtitle = document.getElementById("im-chart-market-subtitle");
    const chartStatusText = document.getElementById("im-chart-status");

    if (status) {
      status.textContent = "Loading live candles...";
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

      if (!result.candles.length) {
        renderLiveChartCandles([]);

        if (chartStatusText) {
          chartStatusText.textContent =
            "No live candles available right now — market may be closed or data hasn't started for today. Retrying every 60 seconds.";
        }
        if (status) {
          status.textContent = "No data yet";
        }
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
        status.textContent = "Live candle feed";
      }

      if (chartStatusText) {
        chartStatusText.textContent = `Live candle feed — last candle ${formatChartTime(latest.time)}.`;
      }

      if (subtitle && latest) {
        subtitle.textContent = `Live market-data candles - Last candle: ${formatChartTime(
          latest.time
        )} - Refreshes every 60 seconds during market hours.`;
      }
    } catch (error) {
      console.error("Live candle refresh failed:", error);

      if (status) {
        status.textContent = `Live error: ${error.message}`;
      }

      if (!latestLiveCandleData) {
        renderLiveChartCandles([]);

        if (chartStatusText) {
          chartStatusText.textContent = `Live candles unavailable: ${error.message}. Retrying every 60 seconds.`;
        }
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

  const MARKET_API_BASE = "https://api.marketdock.in";

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
        "Backend confirmation-engine data. Demo market values remain active until live data is connected.";
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
    subtitle.textContent = "Demo chart only. Live candle feed will replace this after API setup.";
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
      if (imReplayActive) exitImReplay();
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
      if (imReplayActive) exitImReplay();
      selectedChartTimeframe = button.dataset.chartTimeframe;

      root.querySelectorAll("[data-chart-timeframe]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });

      latestLiveCandleData = null;
      updateChartPage();
    });
  });

  setupImChartFullscreenToggle();

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
      chartAiButton.textContent = "Generating AI review...";
      if (title) title.textContent = "AI review in progress";
      if (text) {
        text.textContent =
          "Sending the selected index, timeframe, and technical research snapshot securely to the backend...";
      }

      try {
        const response = await fetch(
          "https://api.marketdock.in/api/gemini/review",
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

        const providerLabel = result.provider === "GROQ" ? "Groq" : "Gemini";
        if (title) title.textContent = `${providerLabel} review - ${result.market} - ${result.timeframe}`;
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
        if (title) title.textContent = "AI review unavailable";
        if (text) {
          text.textContent =
            error.message ||
            "Could not generate the AI review (tried both Gemini and Groq). Please wait a moment and try again.";
        }
        chartAiButton.textContent = "Retry AI Review";
      } finally {
        chartAiButton.disabled = false;
      }
    });
  }

  // ===================== AI Trade Coach =====================
  // Combines the manual Paper Trade journal (indianMarketPaperTrades — entry/stop/target
  // only, no verified outcome) with chart-replay backtest results (imBacktestResultsV1 —
  // has an actual WIN/LOSS exit and R-multiple) into one trade history, and sends it to
  // the backend for a Gemini coaching review. Reuses renderGeminiReview() for consistent
  // heading/bullet formatting with the AI Chart Review card above.

  function collectImCoachTrades() {
    let journalTrades = [];
    let backtestTrades = [];
    try {
      journalTrades = JSON.parse(localStorage.getItem("indianMarketPaperTrades")) || [];
    } catch (error) { /* ignore */ }
    try {
      backtestTrades = JSON.parse(localStorage.getItem("imBacktestResultsV1")) || [];
    } catch (error) { /* ignore */ }

    const fromBacktest = backtestTrades.map((t) => ({
      direction: t.direction,
      entry: t.entry,
      stop: t.stop,
      target: t.target,
      exit: t.exit,
      outcome: t.outcome,
      rMultiple: t.rMultiple
    }));
    const fromJournal = journalTrades.map((t) => ({
      direction: t.direction,
      entry: t.entry,
      stop: t.stop,
      target: t.target
    }));

    return [...fromBacktest, ...fromJournal];
  }

  const coachButton = document.getElementById("im-coach-button");

  if (coachButton) {
    coachButton.addEventListener("click", async () => {
      const title = document.getElementById("im-coach-title");
      const text = document.getElementById("im-coach-text");
      const trades = collectImCoachTrades();

      if (!trades.length) {
        if (title) title.textContent = "No trade history yet";
        if (text) text.textContent = "Add a paper trade above or run a chart-replay backtest on the Live Chart page first.";
        return;
      }

      coachButton.disabled = true;
      coachButton.textContent = "Generating Gemini coaching...";
      if (title) title.textContent = "Gemini coaching in progress";
      if (text) text.textContent = `Sending ${trades.length} logged trade${trades.length === 1 ? "" : "s"} securely to the backend...`;

      try {
        const response = await fetch("https://api.marketdock.in/api/ai-coach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trades })
        });

        const result = await response.json();

        if (!response.ok || !result.ok) {
          throw new Error(result.error || "AI coaching request failed.");
        }

        const stats = result.stats || {};
        title && (title.textContent = stats.closed_trades
          ? `AI Trade Coach — ${stats.win_rate_percent}% win rate over ${stats.closed_trades} backtested trade${stats.closed_trades === 1 ? "" : "s"}`
          : `AI Trade Coach — ${stats.total_trades} trade${stats.total_trades === 1 ? "" : "s"} reviewed`);
        if (text) renderGeminiReview(text, result.coaching);
        coachButton.textContent = "Refresh AI Coaching";
      } catch (error) {
        if (title) title.textContent = "AI coaching unavailable";
        if (text) {
          text.textContent = friendlyAiErrorMessage(error.message);
        }
        coachButton.textContent = "Retry AI Coaching";
        showAiErrorToast(error.message);
      } finally {
        coachButton.disabled = false;
      }
    });
  }

  updateChartPage();

  // Expose start/stop hooks so the top-level mode toggle can pause background
  // polling when this mode isn't visible, and resume it when switched back to.
  window.IndianMarketMode = {
    start() {
      startTechnicalEnginePolling();
      if (!chartRefreshTimer && !imReplayActive) startLiveChartPolling();
    },
    stop() {
      stopTechnicalEnginePolling();
      stopLiveChartPolling();
      stopWatchlistPolling();
      stopFoWatchlistPolling();
      stopOptionsChainPolling();
      stopCommoditiesPolling();
      pauseImReplay();
    }
  };

  // This module loads after the mode-toggle skeleton has already applied the
  // saved mode to the DOM, so check directly whether Indian mode is the
  // currently visible one and start polling immediately if so.
  const indianRootEl = document.getElementById("indianModeRoot");
  if (indianRootEl && !indianRootEl.hidden) {
    window.IndianMarketMode.start();
  }

  // Restore whichever page was open before a reload — otherwise every
  // refresh silently drops the user back on the dashboard. Only within the
  // same session, though (see sessionStorage note in showPage above) — a
  // fresh app launch should still start on the dashboard.
  try {
    const lastPage = sessionStorage.getItem(LAST_PAGE_STORAGE_KEY);
    if (lastPage && lastPage !== "im-dashboard" && [...pages].some((page) => page.id === lastPage)) {
      showPage(lastPage);
    }
  } catch {
    // Ignore — private browsing / storage quota, non-critical.
  }
})();
