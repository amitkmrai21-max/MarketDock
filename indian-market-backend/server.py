import os
import time
import re
import csv
import io
import json
import gzip
import threading
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

from flask import Flask, jsonify, request
from flask_cors import CORS
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from groq import Groq
import groq as groq_sdk
import requests
import redis

app = Flask(__name__)
CORS(app)

APP_STARTED_AT = time.time()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b").strip()
UPSTOX_ACCESS_TOKEN = os.environ.get("UPSTOX_ACCESS_TOKEN", "").strip()

UPSTOX_MARKETS = {
    "nifty": {
        "name": "NIFTY 50",
        "instrument_key": "NSE_INDEX|Nifty 50",
    },
    "banknifty": {
        "name": "Bank Nifty",
        "instrument_key": "NSE_INDEX|Nifty Bank",
    },
    "finnifty": {
        "name": "Nifty Financial Services",
        "instrument_key": "NSE_INDEX|Nifty Fin Service",
    },
    "sensex": {
        "name": "SENSEX",
        "instrument_key": "BSE_INDEX|SENSEX",
    },
}

UPSTOX_TIMEFRAMES = {
    "1m": ("minutes", 1),
    "3m": ("minutes", 3),
    "5m": ("minutes", 5),
    "15m": ("minutes", 15),
    "30m": ("minutes", 30),
    "1h": ("hours", 1),
    "2h": ("hours", 2),
    "4h": ("hours", 4),
    "1d": ("days", 1),
    "1w": ("weeks", 1),
    "1mo": ("months", 1),
}
DEMO_MARKETS = {
    "nifty": {
        "name": "NIFTY 50",
        "price": 24680.55,
        "open": 24592.20,
        "high": 24718.90,
        "low": 24540.10,
        "previous_close": 24528.50,
        "volume_ratio": 1.18,
        "rsi_14": 58.4,
        "ema_9": 24654.20,
        "ema_21": 24618.80,
        "ema_50": 24580.10,
        "vwap": 24620.40,
        "macd_histogram": 12.6,
        "atr_14": 118.0,
        "support": 24580.0,
        "resistance": 24760.0,
        "trend_5m": "bullish",
        "trend_15m": "bullish",
        "trend_1h": "neutral",
    },
    "banknifty": {
        "name": "Bank Nifty",
        "price": 55112.40,
        "open": 54940.50,
        "high": 55220.80,
        "low": 54888.10,
        "previous_close": 54886.30,
        "volume_ratio": 1.10,
        "rsi_14": 54.8,
        "ema_9": 55072.30,
        "ema_21": 55020.80,
        "ema_50": 54940.40,
        "vwap": 55035.60,
        "macd_histogram": 18.2,
        "atr_14": 248.0,
        "support": 54920.0,
        "resistance": 55250.0,
        "trend_5m": "bullish",
        "trend_15m": "neutral",
        "trend_1h": "bullish",
    },
    "finnifty": {
        "name": "Nifty Financial Services",
        "price": 25076.65,
        "open": 24960.30,
        "high": 25128.40,
        "low": 24902.10,
        "previous_close": 24948.90,
        "volume_ratio": 1.05,
        "rsi_14": 56.2,
        "ema_9": 25040.10,
        "ema_21": 24995.60,
        "ema_50": 24932.80,
        "vwap": 25010.20,
        "macd_histogram": 9.4,
        "atr_14": 132.0,
        "support": 24900.0,
        "resistance": 25150.0,
        "trend_5m": "bullish",
        "trend_15m": "neutral",
        "trend_1h": "bullish",
    },
    "sensex": {
        "name": "SENSEX",
        "price": 74003.82,
        "open": 73680.40,
        "high": 74180.60,
        "low": 73510.20,
        "previous_close": 73598.10,
        "volume_ratio": 1.12,
        "rsi_14": 57.6,
        "ema_9": 73920.50,
        "ema_21": 73810.20,
        "ema_50": 73640.90,
        "vwap": 73860.30,
        "macd_histogram": 24.8,
        "atr_14": 340.0,
        "support": 73500.0,
        "resistance": 74250.0,
        "trend_5m": "bullish",
        "trend_15m": "bullish",
        "trend_1h": "neutral",
    },
}

# How long a live market snapshot stays cached before re-fetching from Upstox,
# so simultaneous dashboard/technical-engine requests don't each hit the API.
LIVE_SNAPSHOT_CACHE_SECONDS = 20
_live_snapshot_cache = {}
_stock_snapshot_cache = {}

try:
    redis_client = redis.Redis(host='127.0.0.1', port=6379, db=0, decode_responses=True)
    redis_client.ping()
except Exception as e:
    redis_client = None


def now_utc():
    return datetime.now(timezone.utc).isoformat()


def describe_ai_error(error):
    """Classifies a Gemini OR Groq SDK exception into one of a few honest,
    specific reasons instead of one generic "temporarily unavailable" for
    everything — so the frontend can tell the user what's actually going on
    (busy vs quota exhausted vs a real config problem) instead of leaving
    them guessing. Gemini's genai_errors.APIError exposes .code (int) and
    .status (str); Groq's APIStatusError exposes .status_code (int) —
    both checked here since this runs after either provider's call fails."""
    code = getattr(error, "code", None)
    if code is None:
        code = getattr(error, "status_code", None)
    status = str(getattr(error, "status", "") or "").upper()

    if code == 503 or status == "UNAVAILABLE":
        return "busy", "The AI service is busy right now (high demand). Please try again in a few minutes."
    if code == 429 or status == "RESOURCE_EXHAUSTED":
        return "quota", "The AI service's usage quota/rate limit is exhausted right now. Please try again later."
    if code in (401, 403) or status in ("PERMISSION_DENIED", "UNAUTHENTICATED"):
        return "auth", "An AI provider's API key is invalid or not authorized — this needs to be fixed in the server configuration."
    return "unknown", "AI analysis is temporarily unavailable. Please try again later."


# By default the Gemini SDK retries a failing request up to 5 times with
# exponential backoff on exactly the status codes that mean "busy"/"quota
# exhausted" (429/500/502/503/504) — so on a busy day the SDK alone can
# spend 15-30+ seconds retrying before generate_ai_text below ever gets a
# chance to fall back to Groq. Measured against the live endpoint: cutting
# just the retry *count* wasn't enough — Gemini was slow to respond rather
# than failing fast, so each of the 2 attempts ran out its own 15s timeout
# (~30s total, matching what was actually observed). No retry at all
# (attempts=1) plus a short per-request timeout means a real outage or a
# slow response either one hands off to Groq in a few seconds.
GEMINI_HTTP_OPTIONS = genai_types.HttpOptions(
    timeout=8000,
    retry_options=genai_types.HttpRetryOptions(attempts=1),
)


def generate_ai_text(prompt, json_mode=False):
    """Tries Gemini first; if it fails for ANY reason (busy, quota, auth,
    network), automatically falls back to Groq instead of surfacing an
    error — both providers are already configured for this app specifically
    so a transient outage on one doesn't have to be user-facing. Raises the
    last error only if neither provider is configured or both calls fail,
    so the caller's own except block can still classify/report it."""
    last_error = None

    if GEMINI_API_KEY:
        try:
            client = genai.Client(api_key=GEMINI_API_KEY, http_options=GEMINI_HTTP_OPTIONS)
            response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
            text = (response.text or "").strip()
            if text:
                return text, "GEMINI"
            last_error = RuntimeError("Gemini returned an empty response.")
        except Exception as error:
            app.logger.warning("Gemini call failed, falling back to Groq: %s", error)
            last_error = error

    if GROQ_API_KEY:
        try:
            groq_client = Groq(api_key=GROQ_API_KEY)
            kwargs = {"model": GROQ_MODEL, "messages": [{"role": "user", "content": prompt}]}
            if json_mode:
                kwargs["response_format"] = {"type": "json_object"}
            completion = groq_client.chat.completions.create(**kwargs)
            text = (completion.choices[0].message.content or "").strip()
            if text:
                return text, "GROQ"
            last_error = RuntimeError("Groq returned an empty response.")
        except Exception as error:
            app.logger.warning("Groq fallback also failed: %s", error)
            last_error = error

    if last_error:
        raise last_error
    raise RuntimeError("Neither Gemini nor Groq is configured on the server.")


# Indian-market AI readouts describe what the indicators show; they must not
# read as trading advice (SEBI research-analyst territory). The prompts say
# so, but a model can still slip in "a prudent stop-loss should be placed
# below support" — so any sentence that talks about stop-losses, targets,
# entries/exits, position sizing, buying/selling or what the reader should
# do is dropped from the reply before it reaches the user.
AI_ADVICE_PATTERN = re.compile(
    r"\b("
    r"stop[\s-]?loss\w*|stoploss\w*|trailing\s+stop\w*|targets?|take[\s-]profit|"
    r"entry|entries|enter|exit|exits|"
    r"position[\s-]?siz\w*|lot\s+size|risk[\s-]?reward|risk\s+per\s+trade|capital|"
    r"buy|sell|go\s+long|go\s+short|book\s+profits?|accumulate|"
    r"should|consider|recommend\w*|advis\w*|prudent|"
    r"kharid\w*|khareed\w*|bech\w*|lagaye\w*|lagayein|rakhein|karein"
    r")\b",
    re.IGNORECASE,
)
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?\u0964])\s+")


def strip_trading_advice(text):
    kept_lines = []
    for line in str(text or "").splitlines():
        sentences = [part for part in _SENTENCE_SPLIT.split(line) if part.strip()]
        kept = [part for part in sentences if not AI_ADVICE_PATTERN.search(part)]
        if kept:
            kept_lines.append(" ".join(kept))
        elif not sentences:
            kept_lines.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept_lines)).strip()


# ===================== Upstox live data + indicators =====================

CHART_HISTORY_DAYS = {
    "1m": 120,
    "3m": 120,
    "5m": 120,
    "15m": 120,
    "30m": 120,
    "1h": 120,
    "2h": 150,
    "4h": 250,
    "1d": 500,
    "1w": 1500,
    "1mo": 3650,
}


def _upstox_get(url, headers, timeout):
    """requests.get with a short retry on Upstox rate-limiting (429) or a
    transient 502/503/504 — without this, firing several markets' candle
    requests at once (e.g. the dashboard loading NIFTY/Bank Nifty/FinNifty/
    Sensex in parallel) reliably has only the first one or two succeed and
    the rest get rate-limited and fail outright, even though a short pause
    and a single retry would have gone through fine."""
    last_response = None
    for attempt in range(3):
        response = requests.get(url, headers=headers, timeout=timeout)
        if response.status_code not in (429, 502, 503, 504):
            return response
        last_response = response
        if attempt < 2:
            retry_after = response.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else None
            except ValueError:
                delay = None
            time.sleep(delay if delay is not None else 0.6 * (attempt + 1))
    return last_response


def fetch_upstox_candles(instrument_key, unit, interval, chart_history_days=None):
    """Fetches a multi-day candle history (for proper chart depth/scroll) plus
    today's intraday candles, merged into one chronological series. Falls
    back gracefully if either piece is unavailable. Raises only if BOTH the
    historical and intraday fetches fail.

    Deliberately sequential, not threaded: this already runs inside an outer
    per-symbol thread pool (e.g. RRG fetches ~13 symbols at once), and the
    free-tier instance's CPU is small enough that nesting another thread
    pool per symbol added scheduling overhead and made things slower, not
    faster."""
    if not UPSTOX_ACCESS_TOKEN:
        raise RuntimeError("Live market data is not configured on the server.")

    history_candles = []
    intraday_candles = []
    history_error = None
    intraday_error = None

    try:
        history_candles = _fetch_upstox_history_window(
            instrument_key, unit, interval, chart_history_days or 30
        )
    except Exception as error:
        history_error = error

    try:
        intraday_candles = _fetch_upstox_intraday(instrument_key, unit, interval)
    except Exception as error:
        intraday_error = error

    if not history_candles and not intraday_candles:
        raise history_error or intraday_error or RuntimeError("No candle data available.")

    merged = {candle["time"]: candle for candle in history_candles}
    for candle in intraday_candles:
        merged[candle["time"]] = candle

    combined = sorted(merged.values(), key=lambda c: c["time"])
    if combined:
        return combined

    # Neither historical nor today's intraday had data (e.g. a long holiday
    # stretch) — fall back to the most recent single trading day available.
    return _fetch_upstox_last_trading_day(instrument_key, unit, interval)


def _fetch_upstox_history_window(instrument_key, unit, interval, days_back):
    """Upstox enforces a maximum lookback window per candle unit/interval
    that isn't documented cleanly enough to hardcode confidently — a
    too-large request comes back as a 400, not a partial result, so asking
    for e.g. 120 days of 1-minute candles can fail outright and silently
    leave the caller with only today's intraday candles. Ask for the
    requested window first, then retry with a smaller one on a 400 until it
    succeeds or gives up, so this adapts to whatever Upstox's real limit is
    for this specific unit/interval instead of guessing one number for
    everything."""
    from datetime import timedelta

    encoded_instrument_key = quote(instrument_key, safe="")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    attempt_days = days_back
    last_error = None
    while attempt_days >= 3:
        to_date = datetime.now(timezone.utc).date()
        from_date = to_date - timedelta(days=attempt_days)
        url = (
            f"https://api.upstox.com/v3/historical-candle/{encoded_instrument_key}/{unit}/{interval}"
            f"/{to_date.isoformat()}/{from_date.isoformat()}"
        )

        response = _upstox_get(url, headers, timeout=25)
        if response.ok:
            payload = response.json()
            raw_candles = (payload.get("data") or {}).get("candles") or []
            return _parse_upstox_candles(raw_candles)

        last_error = RuntimeError(f"Live historical data request failed: status={response.status_code}")
        if response.status_code != 400:
            raise last_error

        app.logger.info(
            "Upstox rejected a %s-day %s/%s history request (400) — retrying with a shorter window.",
            attempt_days, unit, interval,
        )
        attempt_days //= 2

    raise last_error or RuntimeError("Live historical data request failed.")


def _fetch_upstox_intraday(instrument_key, unit, interval):
    encoded_instrument_key = quote(instrument_key, safe="")
    url = f"https://api.upstox.com/v3/historical-candle/intraday/{encoded_instrument_key}/{unit}/{interval}"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    response = _upstox_get(url, headers, timeout=20)
    if not response.ok:
        raise RuntimeError(f"Live candle request failed: status={response.status_code}")

    payload = response.json()
    raw_candles = (payload.get("data") or {}).get("candles") or []
    return _parse_upstox_candles(raw_candles)


def _fetch_upstox_last_trading_day(instrument_key, unit, interval):
    from datetime import timedelta

    encoded_instrument_key = quote(instrument_key, safe="")
    to_date = datetime.now(timezone.utc).date()
    from_date = to_date - timedelta(days=7)
    url = (
        f"https://api.upstox.com/v3/historical-candle/{encoded_instrument_key}/{unit}/{interval}"
        f"/{to_date.isoformat()}/{from_date.isoformat()}"
    )
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    response = _upstox_get(url, headers, timeout=20)
    if not response.ok:
        raise RuntimeError(f"Live historical candle request failed: status={response.status_code}")

    payload = response.json()
    raw_candles = (payload.get("data") or {}).get("candles") or []
    all_candles = _parse_upstox_candles(raw_candles)
    if not all_candles:
        return []

    # Keep only the candles from the single most recent trading day present
    # in the window, so indicators reflect one coherent session, not a
    # multi-day blend.
    last_day = all_candles[-1]["time"][:10]
    return [c for c in all_candles if c["time"][:10] == last_day]


def _parse_upstox_candles(raw_candles):
    return [
        {
            "time": row[0],
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
        }
        for row in reversed(raw_candles)
        if isinstance(row, list) and len(row) >= 6
    ]


def ema_series(values, period):
    """Returns the full EMA series (same length as values, with leading None
    entries before the series has enough data to seed the average)."""
    if len(values) < period:
        return [None] * len(values)
    multiplier = 2 / (period + 1)
    result = [None] * (period - 1)
    seed = sum(values[:period]) / period
    result.append(seed)
    previous = seed
    for value in values[period:]:
        current = (value - previous) * multiplier + previous
        result.append(current)
        previous = current
    return result


def last_ema(values, period):
    series = ema_series(values, period)
    return series[-1] if series and series[-1] is not None else (values[-1] if values else 0)


def calculate_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def calculate_macd_histogram(closes):
    if len(closes) < 26:
        return 0.0
    ema12 = ema_series(closes, 12)
    ema26 = ema_series(closes, 26)
    macd_line = [
        (a - b) if (a is not None and b is not None) else None
        for a, b in zip(ema12, ema26)
    ]
    macd_values = [value for value in macd_line if value is not None]
    if len(macd_values) < 9:
        return round(macd_values[-1], 2) if macd_values else 0.0
    signal = ema_series(macd_values, 9)
    if not signal or signal[-1] is None:
        return round(macd_values[-1], 2)
    return round(macd_values[-1] - signal[-1], 2)


def calculate_atr(candles, period=14):
    if len(candles) < period + 1:
        return 0.0
    true_ranges = []
    for i in range(1, len(candles)):
        high, low = candles[i]["high"], candles[i]["low"]
        prev_close = candles[i - 1]["close"]
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return round(sum(true_ranges[-period:]) / period, 2)


def calculate_vwap(candles):
    cumulative_pv, cumulative_volume = 0.0, 0.0
    for candle in candles:
        typical_price = (candle["high"] + candle["low"] + candle["close"]) / 3
        cumulative_pv += typical_price * candle["volume"]
        cumulative_volume += candle["volume"]
    if cumulative_volume == 0:
        return candles[-1]["close"] if candles else 0.0
    return round(cumulative_pv / cumulative_volume, 2)


def calculate_bollinger_bands(closes, period=20, num_std=2):
    if len(closes) < period:
        return {"upper": 0.0, "middle": 0.0, "lower": 0.0}
    window = closes[-period:]
    middle = sum(window) / period
    variance = sum((c - middle) ** 2 for c in window) / period
    std_dev = variance ** 0.5
    return {
        "upper": round(middle + num_std * std_dev, 2),
        "middle": round(middle, 2),
        "lower": round(middle - num_std * std_dev, 2),
    }


def calculate_true_range_series(candles):
    true_ranges = []
    for i in range(1, len(candles)):
        high, low = candles[i]["high"], candles[i]["low"]
        prev_close = candles[i - 1]["close"]
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return true_ranges


def calculate_supertrend(candles, period=10, multiplier=3):
    if len(candles) < period + 1:
        return {"value": 0.0, "trend": "neutral"}

    true_ranges = calculate_true_range_series(candles)
    atr_series = [None] * period
    atr = sum(true_ranges[:period]) / period
    atr_series.append(atr)
    for tr in true_ranges[period:]:
        atr = (atr * (period - 1) + tr) / period
        atr_series.append(atr)

    trend = "bullish"
    final_upper = final_lower = None
    supertrend_value = candles[period]["close"]

    for i in range(period, len(candles)):
        atr_value = atr_series[i] or 0
        mid = (candles[i]["high"] + candles[i]["low"]) / 2
        basic_upper = mid + multiplier * atr_value
        basic_lower = mid - multiplier * atr_value
        close = candles[i]["close"]

        if final_upper is None:
            final_upper, final_lower = basic_upper, basic_lower
        else:
            final_upper = basic_upper if (basic_upper < final_upper or candles[i - 1]["close"] > final_upper) else final_upper
            final_lower = basic_lower if (basic_lower > final_lower or candles[i - 1]["close"] < final_lower) else final_lower

        if close > final_upper:
            trend = "bullish"
        elif close < final_lower:
            trend = "bearish"

        supertrend_value = final_lower if trend == "bullish" else final_upper

    return {"value": round(supertrend_value, 2), "trend": trend}


def calculate_adx(candles, period=14):
    if len(candles) < period + 1:
        return {"adx": 0.0, "plus_di": 0.0, "minus_di": 0.0}

    plus_dm, minus_dm, true_ranges = [], [], []
    for i in range(1, len(candles)):
        up_move = candles[i]["high"] - candles[i - 1]["high"]
        down_move = candles[i - 1]["low"] - candles[i]["low"]
        plus_dm.append(up_move if (up_move > down_move and up_move > 0) else 0.0)
        minus_dm.append(down_move if (down_move > up_move and down_move > 0) else 0.0)
        true_ranges.append(max(
            candles[i]["high"] - candles[i]["low"],
            abs(candles[i]["high"] - candles[i - 1]["close"]),
            abs(candles[i]["low"] - candles[i - 1]["close"]),
        ))

    if len(true_ranges) < period:
        return {"adx": 0.0, "plus_di": 0.0, "minus_di": 0.0}

    smoothed_tr = sum(true_ranges[:period])
    smoothed_plus_dm = sum(plus_dm[:period])
    smoothed_minus_dm = sum(minus_dm[:period])
    dx_values = []

    for i in range(period, len(true_ranges)):
        smoothed_tr = smoothed_tr - (smoothed_tr / period) + true_ranges[i]
        smoothed_plus_dm = smoothed_plus_dm - (smoothed_plus_dm / period) + plus_dm[i]
        smoothed_minus_dm = smoothed_minus_dm - (smoothed_minus_dm / period) + minus_dm[i]

        plus_di = (smoothed_plus_dm / smoothed_tr) * 100 if smoothed_tr else 0
        minus_di = (smoothed_minus_dm / smoothed_tr) * 100 if smoothed_tr else 0
        di_sum = plus_di + minus_di
        dx = (abs(plus_di - minus_di) / di_sum) * 100 if di_sum else 0
        dx_values.append((dx, plus_di, minus_di))

    if not dx_values:
        return {"adx": 0.0, "plus_di": 0.0, "minus_di": 0.0}

    adx = sum(v[0] for v in dx_values[-period:]) / min(period, len(dx_values))
    latest_plus_di = dx_values[-1][1]
    latest_minus_di = dx_values[-1][2]
    return {"adx": round(adx, 2), "plus_di": round(latest_plus_di, 2), "minus_di": round(latest_minus_di, 2)}


def calculate_stochastic(candles, period=14, smooth=3):
    if len(candles) < period:
        return {"k": 50.0, "d": 50.0}
    k_values = []
    for i in range(period - 1, len(candles)):
        window = candles[i - period + 1:i + 1]
        highest = max(c["high"] for c in window)
        lowest = min(c["low"] for c in window)
        close = candles[i]["close"]
        k = ((close - lowest) / (highest - lowest)) * 100 if highest != lowest else 50.0
        k_values.append(k)
    d_value = sum(k_values[-smooth:]) / min(smooth, len(k_values))
    return {"k": round(k_values[-1], 2), "d": round(d_value, 2)}


def calculate_pivot_points(candles):
    if not candles:
        return {}
    latest = candles[-1]
    high, low, close = latest["high"], latest["low"], latest["close"]
    pivot = (high + low + close) / 3
    return {
        "pivot": round(pivot, 2),
        "r1": round(2 * pivot - low, 2),
        "s1": round(2 * pivot - high, 2),
        "r2": round(pivot + (high - low), 2),
        "s2": round(pivot - (high - low), 2),
        "r3": round(high + 2 * (pivot - low), 2),
        "s3": round(low - 2 * (high - pivot), 2),
    }


def resample_candles(candles, group_size):
    """Aggregates consecutive candles into larger buckets (e.g. 3x 5m -> 15m)."""
    resampled = []
    for i in range(0, len(candles), group_size):
        chunk = candles[i:i + group_size]
        if not chunk:
            continue
        resampled.append(
            {
                "time": chunk[0]["time"],
                "open": chunk[0]["open"],
                "high": max(c["high"] for c in chunk),
                "low": min(c["low"] for c in chunk),
                "close": chunk[-1]["close"],
                "volume": sum(c["volume"] for c in chunk),
            }
        )
    return resampled


def is_nse_market_hours():
    """True only within NSE's regular equity session — 09:15 to 15:30 IST,
    Monday to Friday. (Doesn't account for exchange holidays, which would
    need a maintained holiday calendar; those still fall on a weekday so
    this alone can't catch them.)"""
    now_ist = datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
    if now_ist.weekday() >= 5:  # Saturday=5, Sunday=6
        return False
    market_open = now_ist.replace(hour=9, minute=15, second=0, microsecond=0)
    market_close = now_ist.replace(hour=15, minute=30, second=0, microsecond=0)
    return market_open <= now_ist <= market_close


def classify_trend(candles, fast_period=9, slow_period=21):
    """Bullish/bearish/neutral from EMA alignment on a candle series."""
    closes = [c["close"] for c in candles]
    if len(closes) < slow_period:
        return "neutral"
    fast = last_ema(closes, fast_period)
    slow = last_ema(closes, slow_period)
    price = closes[-1]
    if price > fast > slow:
        return "bullish"
    if price < fast < slow:
        return "bearish"
    return "neutral"


def build_technical_snapshot(name, candles_5m):
    """Computes the full technical readout (RSI/EMA/VWAP/MACD/ATR/support-
    resistance/trend/Bollinger/Supertrend/ADX/Stochastic/Pivots) from 5-
    minute candles. Shared by the known-index snapshot below and the AI
    Chart Scanner (any NSE stock) so the indicator math isn't duplicated."""
    if len(candles_5m) < 30:
        raise RuntimeError("Not enough live candle history yet for a reliable snapshot.")

    closes = [c["close"] for c in candles_5m]
    price = closes[-1]
    session_open = candles_5m[0]["open"]
    session_high = max(c["high"] for c in candles_5m)
    session_low = min(c["low"] for c in candles_5m)
    # Upstox's intraday endpoint only covers the current session, so the
    # session's own open is used as the reference point for change%.
    previous_close = session_open

    recent_volumes = [c["volume"] for c in candles_5m[-20:]]
    avg_volume = sum(recent_volumes[:-1]) / max(len(recent_volumes) - 1, 1)
    volume_ratio = round(candles_5m[-1]["volume"] / avg_volume, 2) if avg_volume else 1.0

    support = round(min(c["low"] for c in candles_5m[-40:]), 2)
    resistance = round(max(c["high"] for c in candles_5m[-40:]), 2)

    candles_15m = resample_candles(candles_5m, 3)
    candles_1h = resample_candles(candles_5m, 12)

    session_status = "live" if is_nse_market_hours() else "closed"

    return {
        "name": name,
        "price": round(price, 2),
        "open": round(session_open, 2),
        "high": round(session_high, 2),
        "low": round(session_low, 2),
        "previous_close": round(previous_close, 2),
        "volume_ratio": volume_ratio,
        "rsi_14": calculate_rsi(closes),
        "ema_9": round(last_ema(closes, 9), 2),
        "ema_21": round(last_ema(closes, 21), 2),
        "ema_50": round(last_ema(closes, 50), 2) if len(closes) >= 50 else round(last_ema(closes, 21), 2),
        "vwap": calculate_vwap(candles_5m),
        "macd_histogram": calculate_macd_histogram(closes),
        "atr_14": calculate_atr(candles_5m),
        "support": support,
        "resistance": resistance,
        "trend_5m": classify_trend(candles_5m),
        "trend_15m": classify_trend(candles_15m) if len(candles_15m) >= 21 else "neutral",
        "trend_1h": classify_trend(candles_1h) if len(candles_1h) >= 21 else "neutral",
        "session_status": session_status,
        "bollinger_bands": calculate_bollinger_bands(closes),
        "supertrend": calculate_supertrend(candles_5m),
        "adx": calculate_adx(candles_5m),
        "stochastic": calculate_stochastic(candles_5m),
        "pivot_points": calculate_pivot_points(candles_5m),
    }


def get_real_market_snapshot(market_key):
    """Builds a market dict with the SAME shape as DEMO_MARKETS entries, but
    populated from real Upstox data, so calculate_confirmation_engine can
    consume it unchanged. Raises on failure so the caller can fall back."""
    market = UPSTOX_MARKETS[market_key]
    cache_key = f"market_snapshot:{market_key}"
    
    if redis_client:
        try:
            val = redis_client.get(cache_key)
            if val:
                return json.loads(val)
        except Exception:
            pass
    else:
        cached = _live_snapshot_cache.get(market_key)
        if cached and time.time() - cached["fetched_at"] < LIVE_SNAPSHOT_CACHE_SECONDS:
            return cached["data"]

    candles_5m = fetch_upstox_candles(market["instrument_key"], "minutes", 5, chart_history_days=5)
    snapshot = build_technical_snapshot(market["name"], candles_5m)
    snapshot["data_source"] = "live"
    
    if redis_client:
        try:
            redis_client.setex(cache_key, LIVE_SNAPSHOT_CACHE_SECONDS, json.dumps(snapshot))
        except Exception:
            pass
    _live_snapshot_cache[market_key] = {"data": snapshot, "fetched_at": time.time()}
    return snapshot


def get_stock_technical_snapshot(symbol):
    """Same technical snapshot as get_real_market_snapshot, but for any NSE
    stock symbol (used by the AI Chart Scanner) instead of one of the 4
    fixed index markets."""
    symbol_key = symbol.upper()
    cache_key = f"stock_snapshot:{symbol_key}"
    
    if redis_client:
        try:
            val = redis_client.get(cache_key)
            if val:
                return json.loads(val)
        except Exception:
            pass
    else:
        cached = _stock_snapshot_cache.get(symbol_key)
        if cached and time.time() - cached["fetched_at"] < LIVE_SNAPSHOT_CACHE_SECONDS:
            return cached["data"]

    instrument_key = resolve_instrument_key(symbol)
    candles_5m = fetch_upstox_candles(instrument_key, "minutes", 5, chart_history_days=5)
    snapshot = build_technical_snapshot(symbol_key, candles_5m)
    
    if redis_client:
        try:
            redis_client.setex(cache_key, LIVE_SNAPSHOT_CACHE_SECONDS, json.dumps(snapshot))
        except Exception:
            pass
    _stock_snapshot_cache[symbol_key] = {"data": snapshot, "fetched_at": time.time()}
    _prune_cache(_stock_snapshot_cache, 300)
    return snapshot


def get_market_snapshot_with_fallback(market_key):
    """Tries real live data first; falls back to demo data (clearly labelled)
    if Upstox isn't configured, the market is closed, or the request fails."""
    try:
        return get_real_market_snapshot(market_key), True
    except Exception as error:
        app.logger.warning("Live snapshot for %s unavailable, using demo data: %s", market_key, error)
        demo = dict(DEMO_MARKETS[market_key])
        demo["data_source"] = "demo_fallback"
        return demo, False


# ===================== Routes =====================

@app.get("/")
def home():
    return jsonify(
        {
            "service": "Indian Market AI Dashboard API",
            "status": "running",
            "uptime_seconds": round(time.time() - APP_STARTED_AT, 1),
            "message": "Research and paper-trading API only. No broker or real-money trading.",
        }
    )


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "indian-market-api",
            "time_utc": now_utc(),
        }
    )


def status_from_bool(value, bullish_text, bearish_text, neutral_text):
    if value > 0:
        return {
            "state": "bullish",
            "score": 1,
            "reason": bullish_text,
        }

    if value < 0:
        return {
            "state": "bearish",
            "score": -1,
            "reason": bearish_text,
        }

    return {
        "state": "neutral",
        "score": 0,
        "reason": neutral_text,
    }


def calculate_confirmation_engine(market):
    price = market["price"]
    open_price = market["open"]
    previous_close = market["previous_close"]
    rsi = market["rsi_14"]
    ema_9 = market["ema_9"]
    ema_21 = market["ema_21"]
    ema_50 = market["ema_50"]
    vwap = market["vwap"]
    macd_histogram = market["macd_histogram"]
    volume_ratio = market["volume_ratio"]
    atr = market["atr_14"]
    support = market["support"]
    resistance = market["resistance"]

    confirmations = []

    ema_signal = 0
    if price > ema_9 > ema_21 > ema_50:
        ema_signal = 1
    elif price < ema_9 < ema_21 < ema_50:
        ema_signal = -1

    confirmations.append(
        {
            "name": "EMA alignment",
            "weight": 2,
            **status_from_bool(
                ema_signal,
                "Price and EMA 9/21/50 are aligned bullish.",
                "Price and EMA 9/21/50 are aligned bearish.",
                "EMA alignment is mixed.",
            ),
        }
    )

    vwap_signal = 1 if price > vwap else -1 if price < vwap else 0
    confirmations.append(
        {
            "name": "VWAP position",
            "weight": 2,
            **status_from_bool(
                vwap_signal,
                "Price is trading above VWAP.",
                "Price is trading below VWAP.",
                "Price is at VWAP.",
            ),
        }
    )

    rsi_signal = 1 if rsi >= 55 else -1 if rsi <= 45 else 0
    confirmations.append(
        {
            "name": "RSI momentum",
            "weight": 1,
            **status_from_bool(
                rsi_signal,
                f"RSI {rsi:.1f} supports bullish momentum.",
                f"RSI {rsi:.1f} supports bearish momentum.",
                f"RSI {rsi:.1f} is neutral.",
            ),
        }
    )

    macd_signal = 1 if macd_histogram > 0 else -1 if macd_histogram < 0 else 0
    confirmations.append(
        {
            "name": "MACD momentum",
            "weight": 1,
            **status_from_bool(
                macd_signal,
                "MACD histogram is positive.",
                "MACD histogram is negative.",
                "MACD histogram is flat.",
            ),
        }
    )

    volume_signal = 1 if volume_ratio >= 0.85 else 0
    confirmations.append(
        {
            "name": "Volume participation",
            "weight": 1,
            **status_from_bool(
                volume_signal,
                f"Volume is {volume_ratio:.2f}x its reference average.",
                "Volume filter does not support a bearish setup by itself.",
                f"Volume is only {volume_ratio:.2f}x its reference average.",
            ),
        }
    )

    timeframe_values = {
        "bullish": 1,
        "bearish": -1,
        "neutral": 0,
    }

    timeframe_score = (
        timeframe_values[market["trend_5m"]]
        + timeframe_values[market["trend_15m"]]
        + timeframe_values[market["trend_1h"]]
    )

    confirmations.append(
        {
            "name": "Multi-timeframe trend",
            "weight": 2,
            **status_from_bool(
                1 if timeframe_score >= 2 else -1 if timeframe_score <= -2 else 0,
                "5m, 15m, and 1h trend alignment is bullish.",
                "5m, 15m, and 1h trend alignment is bearish.",
                "Timeframes are not fully aligned.",
            ),
        }
    )

    level_signal = 0
    midpoint = (support + resistance) / 2

    if price > midpoint and price < resistance:
        level_signal = 1
    elif price < midpoint and price > support:
        level_signal = -1

    confirmations.append(
        {
            "name": "Support and resistance context",
            "weight": 1,
            **status_from_bool(
                level_signal,
                "Price is in the upper half of its current research range.",
                "Price is in the lower half of its current research range.",
                "Price is at an important range midpoint or boundary.",
            ),
        }
    )

    weighted_score = sum(item["score"] * item["weight"] for item in confirmations)
    max_score = sum(item["weight"] for item in confirmations)
    bullish_count = sum(1 for item in confirmations if item["state"] == "bullish")
    bearish_count = sum(1 for item in confirmations if item["state"] == "bearish")

    change = price - previous_close
    change_percent = (change / previous_close) * 100

    # Practical technical confluence engine (Active & Sensitive, SEBI-Compliant)
    total_checks = len(confirmations) if confirmations else 7
    bullish_count = sum(1 for item in confirmations if item.get('state') == 'bullish')
    bearish_count = sum(1 for item in confirmations if item.get('state') == 'bearish')

    # 1. Clear Bullish Trending Structure
    if bullish_count >= 4 or (bullish_count >= 3 and price >= vwap):
        decision = 'BULLISH MOMENTUM ACTIVE'
        decision_reason = f'Bullish alignment across {bullish_count}/{total_checks} technical checks. Price holding favorable market structure.'
    # 2. Clear Bearish Trending Structure
    elif bearish_count >= 4 or (bearish_count >= 3 and price <= vwap):
        decision = 'BEARISH MOMENTUM ACTIVE'
        decision_reason = f'Bearish alignment across {bearish_count}/{total_checks} technical checks. Downward price action observed.'
    # 3. Early Bullish Watch
    elif bullish_count >= 3:
        decision = 'BULLISH STRUCTURE FORMING'
        decision_reason = f'Positive momentum building ({bullish_count}/{total_checks} checks). Tracking price action near key levels.'
    # 4. Early Bearish Watch
    elif bearish_count >= 3:
        decision = 'BEARISH STRUCTURE FORMING'
        decision_reason = f'Negative pressure building ({bearish_count}/{total_checks} checks). Tracking price action near support.'
    # 5. Rangebound / Consolidation
    elif bullish_count <= 2 and bearish_count <= 2:
        decision = 'SIDEWAYS'
        decision_reason = 'Low directional conviction between buyers and sellers. Observing intraday price behavior.'
    else:
        decision = 'NEUTRAL / BALANCED'
        decision_reason = 'Even distribution between buyers and sellers. Observing intraday price behavior.'

    risk_buffer = atr * 0.35

    if decision in {"BULLISH BIAS", "AWAITING BULLISH SETUP"}:
        entry_zone = {
            "from": round(max(price, vwap), 2),
            "to": round(max(price, vwap) + atr * 0.15, 2),
            "condition": "Use only after a confirmed bullish candle close or a successful retest.",
        }
        stop_loss = round(min(support, vwap) - risk_buffer, 2)
        risk = max(entry_zone["from"] - stop_loss, atr * 0.25)
        target_1 = round(entry_zone["from"] + risk, 2)
        target_2 = round(entry_zone["from"] + risk * 2, 2)
        exit_rule = "Exit if stop-loss is hit, price loses VWAP and EMA 21, or an opposite confirmed signal appears."
    elif decision in {"BEARISH BIAS", "AWAITING BEARISH SETUP"}:
        entry_zone = {
            "from": round(min(price, vwap) - atr * 0.15, 2),
            "to": round(min(price, vwap), 2),
            "condition": "Use only after a confirmed bearish candle close or a failed retest.",
        }
        stop_loss = round(max(resistance, vwap) + risk_buffer, 2)
        risk = max(stop_loss - entry_zone["to"], atr * 0.25)
        target_1 = round(entry_zone["to"] - risk, 2)
        target_2 = round(entry_zone["to"] - risk * 2, 2)
        exit_rule = "Exit if stop-loss is hit, price regains VWAP and EMA 21, or an opposite confirmed signal appears."
    else:
        entry_zone = {
            "from": None,
            "to": None,
            "condition": "No entry. Wait until multiple confirmations align.",
        }
        stop_loss = None
        target_1 = None
        target_2 = None
        exit_rule = "No position. Reassess after the next confirmed technical refresh."

    return {
        "market": market["name"],
        "updated_at": now_utc(),
        "data_source": market.get("data_source", "demo_fallback"),
        "session_status": market.get("session_status", "closed"),
        "price": price,
        "open": open_price,
        "high": market["high"],
        "low": market["low"],
        "previous_close": previous_close,
        "change": round(change, 2),
        "change_percent": round(change_percent, 2),
        "indicators": {
            "rsi_14": rsi,
            "ema_9": ema_9,
            "ema_21": ema_21,
            "ema_50": ema_50,
            "vwap": vwap,
            "macd_histogram": macd_histogram,
            "volume_ratio": volume_ratio,
            "atr_14": atr,
            "bollinger_bands": market.get("bollinger_bands", {"upper": 0, "middle": 0, "lower": 0}),
            "supertrend": market.get("supertrend", {"value": 0, "trend": "neutral"}),
            "adx": market.get("adx", {"adx": 0, "plus_di": 0, "minus_di": 0}),
            "stochastic": market.get("stochastic", {"k": 50, "d": 50}),
            "pivot_points": market.get("pivot_points", {}),
        },
        "levels": {
            "support": support,
            "resistance": resistance,
        },
        "timeframes": {
            "5m": market["trend_5m"],
            "15m": market["trend_15m"],
            "1h": market["trend_1h"],
        },
        "confirmations": confirmations,
        "decision": {
            "label": decision,
            "weighted_score": weighted_score,
            "max_score": max_score,
            "bullish_count": bullish_count,
            "bearish_count": bearish_count,
            "reason": decision_reason,
        },
        "trade_plan": {
            "entry_zone": entry_zone,
            "stop_loss": stop_loss,
            "target_1": target_1,
            "target_2": target_2,
            "exit_rule": exit_rule,
        },
        "disclaimer": "Research and paper-trading only. This is not financial advice and does not place orders.",
    }


@app.get("/api/market/<market_key>")
def market_analysis(market_key):
    market_key = market_key.lower().strip()

    if market_key not in DEMO_MARKETS:
        return jsonify(
            {
                "ok": False,
                "error": "Unknown market. Use: " + ", ".join(DEMO_MARKETS.keys()) + ".",
            }
        ), 404

    market_data, is_live = get_market_snapshot_with_fallback(market_key)
    analysis = calculate_confirmation_engine(market_data)

    return jsonify(
        {
            "ok": True,
            "data": analysis,
        }
    )


@app.get("/api/markets")
def all_markets_analysis():
    markets = {}
    for market_key in DEMO_MARKETS:
        market_data, _ = get_market_snapshot_with_fallback(market_key)
        markets[market_key] = calculate_confirmation_engine(market_data)

    return jsonify(
        {
            "ok": True,
            "updated_at": now_utc(),
            "markets": markets,
        }
    )


DEFAULT_WATCHLIST_SYMBOLS = [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK",
    "SBIN", "BHARTIARTL", "ITC", "KOTAKBANK", "LT",
]

_instrument_key_cache = {}
_watchlist_cache = {}
# Short on purpose: every request for the same symbol set (e.g. all users
# viewing the "Nifty 50" Scanner filter) shares this one cached snapshot
# instead of each triggering its own Upstox call, so a low value here keeps
# quotes fresh without the per-user request count ever reaching Upstox.
WATCHLIST_CACHE_SECONDS = 2
TOP_MOVER_CACHE_SECONDS = 30
_top_mover_cache = {}

# Same reasoning as WATCHLIST_CACHE_SECONDS: every viewer of the same
# market+timeframe (the common case — Live Chart has no per-user state)
# shares one cached candle set instead of each 2s poll hitting Upstox's
# historical-candle API directly, which is far heavier per call than a
# plain LTP quote and more tightly rate-limited.
LIVE_CANDLES_CACHE_SECONDS = 2
_live_candles_cache = {}


def fetch_quotes_with_change(symbols, resolver=None):
    """Resolves symbols to instrument keys (via the given resolver, default
    the stock resolver) and fetches LTP + previous close (via the LTP V3
    endpoint's `cp` field) in one batched call, returning each symbol's
    price and change percent. Resolution requests run in parallel — doing
    them one at a time was the main cause of slow load times for large
    symbol lists."""
    resolver = resolver or resolve_instrument_key
    key_map = {}

    def _resolve_one(symbol):
        try:
            return symbol, resolver(symbol)
        except Exception as error:
            app.logger.warning("Could not resolve %s: %s", symbol, error)
            return symbol, None

    with ThreadPoolExecutor(max_workers=20) as executor:
        for symbol, instrument_key in executor.map(_resolve_one, symbols):
            if instrument_key:
                key_map[symbol] = instrument_key

    if not key_map:
        return []

    instrument_keys = ",".join(key_map.values())
    url = f"https://api.upstox.com/v3/market-quote/ltp?instrument_key={quote(instrument_keys, safe=',')}"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    response = requests.get(url, headers=headers, timeout=20)
    if not response.ok:
        raise RuntimeError(f"LTP quote request failed: status={response.status_code}")

    quote_data = (response.json().get("data") or {})
    reverse_map = {v: k for k, v in key_map.items()}

    results = []
    for info in quote_data.values():
        instrument_key = info.get("instrument_token", "")
        symbol = reverse_map.get(instrument_key)
        if not symbol:
            continue
        last_price = info.get("last_price")
        previous_close = info.get("cp")
        change_percent = None
        if last_price is not None and previous_close:
            change_percent = round(((last_price - previous_close) / previous_close) * 100, 2)
        results.append(
            {
                "symbol": symbol,
                "last_price": last_price,
                "previous_close": previous_close,
                "change_percent": change_percent,
            }
        )
    return results


def compute_ai_score(change_percent):
    """A deterministic momentum score (0-100) from today's live % change —
    not an LLM call, so it computes instantly for every watchlist row on
    every poll with no extra API cost. Saturates at +/-3% change (treated
    as maximally bullish/bearish) and reads 50 (neutral) at 0% change."""
    if change_percent is None:
        return None, "Unknown"

    capped = max(-3.0, min(3.0, change_percent))
    score = round(50 + (capped / 3.0) * 50)

    if score >= 80:
        label = "Strong Bullish"
    elif score >= 60:
        label = "Bullish"
    elif score > 40:
        label = "Neutral"
    elif score > 20:
        label = "Bearish"
    else:
        label = "Strong Bearish"

    return score, label


@app.get("/api/top-mover/<index_key>")
def top_mover(index_key):
    index_key = index_key.lower().strip()
    # Matches the same "Nifty 50" / "Nifty Bank" names the Dashboard's
    # Top Gainers/Losers drill-down page passes to /api/index-constituents,
    # so this card and that full list always agree on who's actually
    # biggest — this used to run against a small fixed basket of
    # heavyweight stocks instead, which could (and did) pick a different,
    # less-moved stock than the real biggest mover across the full index.
    index_names = {"nifty": "Nifty 50", "banknifty": "Nifty Bank"}

    if index_key not in index_names:
        return jsonify({"ok": False, "error": "Unknown index. Use: nifty or banknifty."}), 404

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    cached = _top_mover_cache.get(index_key)
    if cached and time.time() - cached["fetched_at"] < TOP_MOVER_CACHE_SECONDS:
        return jsonify({"ok": True, "data": cached["data"]})

    try:
        constituents = fetch_index_constituents(index_names[index_key])
        if not constituents:
            return jsonify({"ok": False, "error": "Constituent list not available right now."}), 502

        symbols = [c["symbol"] for c in constituents if c.get("symbol")]
        quotes = fetch_quotes_with_change(symbols)
        rated = [q for q in quotes if q["change_percent"] is not None]
        if not rated:
            return jsonify({"ok": False, "error": "No quote data available right now."}), 502

        top_gainer = max(rated, key=lambda q: q["change_percent"])
        top_loser = min(rated, key=lambda q: q["change_percent"])
        result = {
            "index": index_key,
            "gainer": top_gainer,
            "loser": top_loser,
            "mover": top_gainer,  # kept for any older client still reading .mover
            "updated_at": now_utc(),
        }
        _top_mover_cache[index_key] = {"data": result, "fetched_at": time.time()}
        return jsonify({"ok": True, "data": result})
    except Exception as error:
        app.logger.warning("Top mover fetch failed for %s: %s", index_key, error)
        return jsonify({"ok": False, "error": "Could not fetch top mover data right now."}), 502


def resolve_instrument_key(trading_symbol, exchange="NSE", segment="EQ"):
    """Looks up a stock's real Upstox instrument_key by trading symbol, using
    Upstox's own instrument search — never a guessed/hardcoded ISIN, since a
    wrong ISIN would silently point at the wrong company."""
    cache_key = f"{exchange}:{segment}:{trading_symbol.upper()}"
    if cache_key in _instrument_key_cache:
        return _instrument_key_cache[cache_key]

    url = "https://api.upstox.com/v2/instruments/search"
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }
    params = {"query": trading_symbol, "exchanges": exchange, "segments": segment}

    response = requests.get(url, headers=headers, params=params, timeout=15)
    if not response.ok:
        raise RuntimeError(f"Instrument search failed for {trading_symbol}: status={response.status_code}")

    results = (response.json().get("data") or [])
    exact = next(
        (item for item in results if str(item.get("trading_symbol", "")).upper() == trading_symbol.upper()),
        None,
    )
    match = exact or (results[0] if results else None)
    if not match or not match.get("instrument_key"):
        raise RuntimeError(f"No instrument found for {trading_symbol}")

    instrument_key = match["instrument_key"]
    _instrument_key_cache[cache_key] = instrument_key
    return instrument_key


# Matches an MCX futures contract's trading symbol exactly as
# /api/commodities returns it (e.g. GOLD25DECFUT) — see
# find_current_mcx_future() below, which resolves these in the first place.
MCX_FUTURES_SYMBOL_PATTERN = re.compile(r"^[A-Z]+\d{2}[A-Z]{3}FUT$")


def _parse_int(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _prune_cache(cache, max_age, limit=500):
    """Per-symbol caches gain a key for every instrument anyone ever asked
    for and never shrank. Once one grows past `limit`, drop entries older
    than `max_age` seconds (they would be refetched anyway)."""
    if len(cache) <= limit:
        return
    cutoff = time.time() - max_age
    for key, entry in list(cache.items()):
        if entry.get("fetched_at", 0) < cutoff:
            cache.pop(key, None)


def resolve_order_instrument_key(symbol):
    """Resolves a trading symbol to its Upstox instrument_key for order
    placement/brokerage-estimate purposes, covering both regular NSE equity
    symbols (the common case, via resolve_instrument_key above) and MCX
    commodity futures contracts (via resolve_mcx_instrument_key further
    below, alongside the rest of the commodities code) — the Commodities
    page passes its rows' real current contract symbol here, not a plain
    "GOLD"/"SILVER" key, since that's what Upstox's own order API needs."""
    symbol = symbol.upper()
    if MCX_FUTURES_SYMBOL_PATTERN.match(symbol):
        return resolve_mcx_instrument_key(symbol)
    return resolve_instrument_key(symbol)


RRG_BENCHMARK_SYMBOL = "NIFTY 50"
RRG_BENCHMARK_INSTRUMENT_KEY = "NSE_INDEX|Nifty 50"
RRG_AVAILABLE_SYMBOLS = [
    "Nifty SME Emerge", "Nifty IPO", "Nifty Microcap 250",
    "Nifty Smallcap250 Momentum Quality 100 Index", "Nifty Smallcap 100",
    "Nifty Pharma", "Nifty Smallcap 50", "Nifty500 Healthcare",
    "Nifty India Defence", "Nifty Smallcap 250", "Nifty Private Bank",
    "Nifty MidSmall Healthcare", "Nifty CPSE", "Nifty Healthcare Index",
    "Nifty MidSmall Financial Services", "Nifty Energy", "Nifty PSE",
    "Nifty MidSmallcap 400", "Nifty Oil & Gas", "Nifty Bank",
    "Nifty Chemicals", "Nifty500 LargeMidSmall Equal-Cap Weighted",
    "Nifty500 Equal Weight", "Nifty500 Value 50",
    "NIFTY 500 Multicap 50:25:25 Index", "Nifty Smallcap250 Quality 50",
    "Nifty Commodities", "Nifty200 Value 30", "Nifty500 Multifactor MQVLv 50",
    "Nifty Total Market", "Nifty500 Quality 50",
    "Nifty500 Multicap Infrastructure 50:30:20 index",
    "Nifty Top 10 Equal Weight", "Nifty India Infrastructure & Logistics",
    "Nifty50 USD", "Nifty50 Value 20", "Nifty Infrastructure",
    "Nifty Financial Services", "Nifty Services Sector", "Nifty Housing",
    "Nifty FMCG", "Nifty 100 Low Volatility 30",
    "Nifty Dividend Opportunities 50", "Nifty Low Volatility 50",
    "NIFTY Quality Low-Volatility 30", "Nifty500 Low Volatility 50",
    "NIFTY Alpha Quality Value Low-Volatility 30",
    "Nifty Financial Services 25/50", "Nifty Tata Group 25% Cap",
    "NIFTY Alpha Quality Low Volatility 30", "Nifty 50 Equal Weight",
    "NIFTY Alpha Low Volatility 30", "Nifty India Internet",
    "Nifty MidSmall IT & Telecom", "Nifty Capital Market", "Nifty Alpha 50",
    "Nifty500 Momentum 50", "Nifty Metal", "Nifty Midcap Liquid 15",
    "Nifty Total Market Momentum Quality 50",
    "NIFTY Midcap150 Momentum 50 Index", "Nifty India Digital",
    "Nifty200 Alpha 30", "Nifty MidSmallcap400 Momentum Quality 100 index",
    "Nifty200 Momentum 30 Index", "Nifty Midcap 50", "Nifty Midcap 100",
    "Nifty Realty", "Nifty Midcap 150",
    "Nifty500 Multicap India Manufacturing 50:30:20", "Nifty Midcap Select",
    "Nifty High Beta 50", "Nifty India New Age Consumption",
    "NIFTY Consumer Durables", "Nifty India Manufacturing Index",
    "Nifty PSU Bank", "Nifty LargeMidcap 250", "Nifty 500", "Nifty Next 50",
    "Nifty 200", "NIFTY100 Quality 30", "Nifty India FPI 150",
    "Nifty100 Equal Weight", "Nifty 100", "Nifty Auto",
    "Nifty EV and New Age Automotive", "Nifty Rural",
    "NIFTY Transportation & Logistics", "Nifty India Consumption",
    "Nifty MNC", "Nifty Core Housing", "Nifty Non-Cyclical Consumer",
    "Nifty Mobility", "Nifty Media", "Nifty Growth Sectors 15",
    "Nifty India Tourism", "Nifty Waves", "NIFTY100 Alpha 30",
    "Nifty Midcap150 Quality 50", "Nifty IT", "Nifty Top 15 Equal Weight",
    "Nifty500 Flexicap Quality 30", "Nifty Financial Services Ex-Bank",
    "Nifty India Select 5 Corporate Groups (MAATR)", "Nifty 100 Liquid 15",
    "Nifty MidSmall India Consumption", "NIFTY200 Quality 30",
    "Nifty Top 20 Equal Weight",
]

# Sensible default selection shown ticked on first load — the rest are
# available via search/checkboxes but not fetched until selected, since
# fetching all 108 on every load would be slow and mostly unnecessary.
RRG_DEFAULT_SYMBOLS = [
    "Nifty Bank", "Nifty Auto", "Nifty IT", "Nifty Pharma", "Nifty FMCG",
    "Nifty Metal", "Nifty Realty", "Nifty Energy", "Nifty PSU Bank",
    "Nifty Private Bank", "Nifty Financial Services", "Nifty Infrastructure",
]

RRG_CACHE_SECONDS = 150
_rrg_cache = {}


def resolve_index_instrument_key(index_name):
    """Resolves an NSE index name (e.g. 'Nifty Auto') to its Upstox
    instrument_key via Upstox's own instrument search — never a guessed key,
    since indices don't follow one predictable ISIN-like pattern."""
    cache_key = f"INDEX:{index_name.upper()}"
    if cache_key in _instrument_key_cache:
        return _instrument_key_cache[cache_key]

    url = "https://api.upstox.com/v2/instruments/search"
    headers = {"Accept": "application/json", "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}"}
    params = {"query": index_name, "exchanges": "NSE", "segments": "INDEX"}

    response = requests.get(url, headers=headers, params=params, timeout=15)
    if not response.ok:
        raise RuntimeError(f"Index search failed for {index_name}: status={response.status_code}")

    results = (response.json().get("data") or [])
    exact = next(
        (item for item in results if str(item.get("trading_symbol", item.get("name", ""))).upper() == index_name.upper()),
        None,
    )
    match = exact or (results[0] if results else None)
    if not match or not match.get("instrument_key"):
        raise RuntimeError(f"No index instrument found for {index_name}")

    instrument_key = match["instrument_key"]
    _instrument_key_cache[cache_key] = instrument_key
    return instrument_key


def average(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else None


def build_rrg_data(interval, symbols=None):
    settings = {
        "1h": {"unit": "hours", "step": 1, "history_days": 90, "lookback": 30, "tail": 60},
        "1d": {"unit": "days", "step": 1, "history_days": 320, "lookback": 30, "tail": 60},
    }
    if interval not in settings:
        raise ValueError("Unsupported RRG interval.")
    config = settings[interval]
    plotted_symbols = RRG_DEFAULT_SYMBOLS if symbols is None else symbols

    benchmark_candles = fetch_upstox_candles(
        RRG_BENCHMARK_INSTRUMENT_KEY, config["unit"], config["step"],
        chart_history_days=config["history_days"],
    )
    if len(benchmark_candles) < config["lookback"] + 10:
        raise RuntimeError("Not enough benchmark history for RRG yet.")

    benchmark_closes = [c["close"] for c in benchmark_candles]
    benchmark_times = [c["time"] for c in benchmark_candles]

    trails = [
        {
            "symbol": RRG_BENCHMARK_SYMBOL,
            "points": [{"x": 100.0, "y": 100.0, "timestamp": t} for t in benchmark_times[-config["tail"]:]],
            "direction": "Flat",
        }
    ]

    def _fetch_symbol_candles(symbol):
        try:
            is_known_index = symbol in RRG_AVAILABLE_SYMBOLS
            instrument_key = (
                resolve_index_instrument_key(symbol) if is_known_index else resolve_instrument_key(symbol)
            )
            candles = fetch_upstox_candles(
                instrument_key, config["unit"], config["step"],
                chart_history_days=config["history_days"],
            )
            return symbol, candles
        except Exception as error:
            app.logger.warning("RRG: could not fetch %s: %s", symbol, error)
            return symbol, None

    with ThreadPoolExecutor(max_workers=20) as executor:
        fetched = dict(executor.map(_fetch_symbol_candles, plotted_symbols))

    for symbol in plotted_symbols:
        candles = fetched.get(symbol)
        if not candles:
            continue

        # Align this stock's candles to the benchmark's timestamps so the
        # ratio math compares like-for-like points.
        # Align by calendar date (and hour, for the 1h timeframe) rather
        # than the exact timestamp string — the benchmark and each stock are
        # fetched in separate API calls, so their timestamps can differ by a
        # few seconds even for the "same" candle, which silently dropped
        # most points and produced a sparse, jumpy trail instead of a smooth
        # continuous rotation.
        align_len = 13 if config["unit"] == "hours" else 10
        by_time = {c["time"][:align_len]: c["close"] for c in candles}
        aligned_closes = [by_time.get(t[:align_len]) for t in benchmark_times]

        ratios = [
            (asset / base) * 100 if asset is not None and base else None
            for asset, base in zip(aligned_closes, benchmark_closes)
        ]

        lookback = config["lookback"]
        ratio_sma = [
            average(ratios[i - lookback + 1:i + 1]) if i >= lookback - 1 else None
            for i in range(len(ratios))
        ]
        ratio_index = [
            (ratios[i] / ratio_sma[i]) * 100 if ratios[i] is not None and ratio_sma[i] else None
            for i in range(len(ratios))
        ]
        momentum_sma = [
            average([v for v in ratio_index[i - 9:i + 1] if v is not None])
            if i >= lookback + 8 and ratio_index[i] is not None else None
            for i in range(len(ratio_index))
        ]
        momentum_index = [
            (ratio_index[i] / momentum_sma[i]) * 100 if ratio_index[i] is not None and momentum_sma[i] else None
            for i in range(len(ratio_index))
        ]

        valid_points = [
            {"x": round(ratio_index[i], 2), "y": round(momentum_index[i], 2), "timestamp": benchmark_times[i]}
            for i in range(len(ratio_index))
            if ratio_index[i] is not None and momentum_index[i] is not None
        ]

        direction = "Flat"
        if len(valid_points) >= 2:
            dx = valid_points[-1]["x"] - valid_points[-2]["x"]
            dy = valid_points[-1]["y"] - valid_points[-2]["y"]
            if abs(dx) < 0.03 and abs(dy) < 0.03:
                direction = "Flat"
            elif dx >= 0 and dy >= 0:
                direction = "North-East"
            elif dx >= 0:
                direction = "South-East"
            elif dy >= 0:
                direction = "North-West"
            else:
                direction = "South-West"

        trails.append({"symbol": symbol, "points": valid_points[-config["tail"]:], "direction": direction})

    return {
        "benchmark": RRG_BENCHMARK_SYMBOL,
        "interval": interval,
        "tail_points": config["tail"],
        "display_window": 8,
        "trails": trails,
        "source": "Live market data",
        "updated_at": now_utc(),
        "disclaimer": (
            "Stocks are compared with NIFTY 50 as benchmark in this RRG-style "
            "normalized relative-strength visualization. It is not official "
            "JdK RRG and is not financial advice."
        ),
    }


INDEX_SLUG_OVERRIDES = {
    "Nifty 50": "50", "Nifty Next 50": "junior", "Nifty 100": "100",
    "Nifty 200": "200", "Nifty 500": "500", "Nifty Bank": "bank",
    "Nifty Auto": "auto", "Nifty IT": "it", "Nifty Pharma": "pharma",
    "Nifty FMCG": "fmcg", "Nifty Metal": "metal", "Nifty Realty": "realty",
    "Nifty Energy": "energy", "Nifty Media": "media",
    "Nifty PSU Bank": "psubank", "Nifty Private Bank": "pvtbank",
    "Nifty Financial Services": "finance", "Nifty Infrastructure": "infra",
    "Nifty Midcap 50": "midcap50", "Nifty Midcap 100": "midcap100",
    "Nifty Midcap 150": "midcap150", "Nifty Smallcap 50": "smlcap50",
    "Nifty Smallcap 100": "smlcap100", "Nifty Smallcap 250": "smallcap250",
    "Nifty Oil & Gas": "oilgas", "Nifty Commodities": "commodities",
    "Nifty Consumer Durables": "consumerdurables",
    "Nifty India Consumption": "consumption",
    "Nifty Healthcare Index": "healthcare",
}

_index_constituents_cache = {}
CONSTITUENTS_CACHE_SECONDS = 3600  # constituent lists change rarely
CONSTITUENTS_ERROR_CACHE_SECONDS = 60  # but a fetch error should retry soon, not wait the full hour


def derive_index_slug(index_name):
    if index_name in INDEX_SLUG_OVERRIDES:
        return INDEX_SLUG_OVERRIDES[index_name]
    slug = index_name.replace("Nifty", "").replace("NIFTY", "")
    slug = re.sub(r"[^a-zA-Z0-9]", "", slug).lower()
    return slug


def fetch_index_constituents(index_name):
    """Fetches an index's real stock constituents from NSE Indices'
    official published CSV (niftyindices.com) — never a guessed/fabricated
    list. Returns [] (not an error) if the derived URL doesn't resolve,
    since many niche index slugs can't be confirmed without NSE's own
    lookup tool."""
    cached = _index_constituents_cache.get(index_name)
    if cached and time.time() - cached["fetched_at"] < CONSTITUENTS_CACHE_SECONDS:
        return cached["data"]

    slug = derive_index_slug(index_name)
    url = f"https://www.niftyindices.com/IndexConstituent/ind_nifty{slug}list.csv"
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "text/csv,*/*"}

    try:
        response = requests.get(url, headers=headers, timeout=10)
        if not response.ok or "Company Name" not in response.text[:200]:
            # A bad response for this slug means the index genuinely isn't
            # published this way — worth remembering for the full hour.
            _index_constituents_cache[index_name] = {"data": [], "fetched_at": time.time()}
            return []

        reader = csv.DictReader(io.StringIO(response.text))
        constituents = [
            {"name": row.get("Company Name", "").strip(), "symbol": row.get("Symbol", "").strip()}
            for row in reader
            if row.get("Symbol", "").strip()
        ]
        _index_constituents_cache[index_name] = {"data": constituents, "fetched_at": time.time()}
        return constituents
    except Exception as error:
        app.logger.warning("Could not fetch constituents for %s: %s", index_name, error)
        # A network error/timeout is likely transient — cache it only
        # briefly so a temporary hiccup doesn't look "unavailable" for a
        # full hour once niftyindices.com responds normally again.
        _index_constituents_cache[index_name] = {
            "data": [],
            "fetched_at": time.time() - CONSTITUENTS_CACHE_SECONDS + CONSTITUENTS_ERROR_CACHE_SECONDS,
        }
        return []


@app.get("/api/index-constituents")
def index_constituents():
    index_name = request.args.get("index", "").strip()
    # "Nifty 50" is deliberately absent from RRG_AVAILABLE_SYMBOLS (it's the
    # RRG benchmark, not a valid rotation target against itself), but the
    # Scanner page has its own "NIFTY 50" universe button that needs this
    # same endpoint — allow it explicitly rather than treating it as unknown.
    if index_name not in RRG_AVAILABLE_SYMBOLS and index_name != "Nifty 50":
        return jsonify({"ok": False, "error": "Unknown index."}), 404

    constituents = fetch_index_constituents(index_name)
    return jsonify(
        {
            "ok": True,
            "index": index_name,
            "constituents": constituents,
            "available": bool(constituents),
            "source": "NSE Indices (niftyindices.com)" if constituents else None,
        }
    )


@app.get("/api/index-candles")
def index_candles():
    symbol = request.args.get("symbol", "").strip()
    timeframe = request.args.get("timeframe", "1d").lower().strip()

    if not symbol:
        return jsonify({"ok": False, "error": "Missing symbol."}), 400

    if timeframe not in UPSTOX_TIMEFRAMES:
        return jsonify({"ok": False, "error": "Unsupported timeframe. Use: 5m, 15m, 1h, or 1d."}), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    try:
        if symbol == RRG_BENCHMARK_SYMBOL:
            instrument_key = RRG_BENCHMARK_INSTRUMENT_KEY
        elif symbol in RRG_AVAILABLE_SYMBOLS:
            instrument_key = resolve_index_instrument_key(symbol)
        else:
            instrument_key = resolve_instrument_key(symbol)
        unit, interval = UPSTOX_TIMEFRAMES[timeframe]
        candles = fetch_upstox_candles(instrument_key, unit, interval, chart_history_days=90)

        if not candles:
            return jsonify({"ok": False, "error": "No candle data available for this symbol."}), 502

        return jsonify(
            {
                "ok": True,
                "symbol": symbol,
                "timeframe": timeframe,
                "candles": candles,
                "updated_at": now_utc(),
            }
        )
    except Exception as error:
        app.logger.warning("Index candles fetch failed for %s: %s", symbol, error)
        return jsonify({"ok": False, "error": "Could not fetch candle data right now."}), 502


@app.get("/api/rrg/symbols")
def rrg_symbols():
    denied = require_rrg_maintenance_owner()
    if denied is not None:
        return denied
    return jsonify(
        {
            "ok": True,
            "symbols": RRG_AVAILABLE_SYMBOLS,
            "default_selected": RRG_DEFAULT_SYMBOLS,
        }
    )


RRG_MAINTENANCE_OWNER_EMAIL = "amitkmrai21@gmail.com"
SUPABASE_AUTH_URL = "https://qvgfxtjwgrtytjdjcebj.supabase.co/auth/v1/user"
SUPABASE_PUBLISHABLE_KEY = "sb_publishable_DRsCPkKaKRYPrQDFtqV0xQ_7QeP4kYh"


def require_rrg_maintenance_owner():
    """Verify the access token with Auth, not a browser-provided email or JWT claim."""
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer ") or not authorization[7:].strip():
        return jsonify({"ok": False, "error": "Sign in to access RRG."}), 401
    try:
        response = requests.get(
            SUPABASE_AUTH_URL,
            headers={"apikey": SUPABASE_PUBLISHABLE_KEY, "Authorization": authorization},
            timeout=8,
        )
    except requests.RequestException:
        return jsonify({"ok": False, "error": "RRG access check unavailable."}), 503
    if response.status_code != 200:
        return jsonify({"ok": False, "error": "Sign in again to access RRG."}), 401
    try:
        user = response.json()
    except ValueError:
        return jsonify({"ok": False, "error": "RRG access check unavailable."}), 503
    email = (user.get("email") or "").strip().lower()
    if not user.get("id") or not user.get("email_confirmed_at") or email != RRG_MAINTENANCE_OWNER_EMAIL:
        return jsonify({"ok": False, "error": "RRG is under maintenance."}), 403
    return None


_rrg_quotes_cache = {"data": None, "fetched_at": 0}
RRG_QUOTES_CACHE_SECONDS = 60


@app.get("/api/rrg/quotes")
def rrg_quotes():
    denied = require_rrg_maintenance_owner()
    if denied is not None:
        return denied
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    cached = _rrg_quotes_cache["data"]
    if cached and time.time() - _rrg_quotes_cache["fetched_at"] < RRG_QUOTES_CACHE_SECONDS:
        return jsonify({"ok": True, "data": cached})

    try:
        quotes = fetch_quotes_with_change(RRG_AVAILABLE_SYMBOLS, resolver=resolve_index_instrument_key)
        _rrg_quotes_cache["data"] = quotes
        _rrg_quotes_cache["fetched_at"] = time.time()
        return jsonify({"ok": True, "data": quotes})
    except Exception as error:
        app.logger.warning("RRG quotes fetch failed: %s", error)
        return jsonify({"ok": False, "error": "Could not fetch index quotes right now."}), 502


@app.get("/api/rrg")
def rrg():
    denied = require_rrg_maintenance_owner()
    if denied is not None:
        return denied
    interval = request.args.get("interval", "1d").lower().strip()
    if interval not in {"1d", "1h"}:
        return jsonify({"ok": False, "error": "Unsupported interval. Use: 1d or 1h."}), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    symbols_param_present = "symbols" in request.args
    symbols_param = request.args.get("symbols", "")
    parsed_symbols = [s.strip() for s in symbols_param.split(",") if s.strip()]
    valid_symbols = [s for s in parsed_symbols if s in RRG_AVAILABLE_SYMBOLS]
    # None -> build_rrg_data uses RRG_DEFAULT_SYMBOLS (first load, param never sent).
    # [] -> user explicitly unchecked everything, so plot nothing but the benchmark.
    symbols_arg = valid_symbols if symbols_param_present else None

    cache_key = f"{interval}:{','.join(symbols_arg) if symbols_arg else ('default' if symbols_arg is None else 'none')}"
    cached = _rrg_cache.get(cache_key)
    if cached and time.time() - cached["fetched_at"] < RRG_CACHE_SECONDS:
        return jsonify({"ok": True, "data": cached["data"]})

    try:
        data = build_rrg_data(interval, symbols=symbols_arg)
        _rrg_cache[cache_key] = {"data": data, "fetched_at": time.time()}
        _prune_cache(_rrg_cache, RRG_CACHE_SECONDS, limit=50)
        return jsonify({"ok": True, "data": data})
    except Exception as error:
        app.logger.warning("RRG build failed for %s: %s", interval, error)
        return jsonify({"ok": False, "error": "Could not build RRG data right now."}), 502


def fetch_quotes_cached(symbols):
    """Fetches live quotes for the given symbols, caching per SYMBOL rather
    than per requested combination — so two different personal watchlists
    that both happen to include, say, RELIANCE, always see the exact same
    RELIANCE price and freshness. Caching by the full comma-joined symbol
    list instead would give every distinct combination its own cache
    entry, so the same stock could show a slightly different price to
    different users purely because their other watchlist picks differed."""
    now = time.time()
    cached_rows = {}
    stale_symbols = []
    for symbol in symbols:
        cached = _watchlist_cache.get(symbol)
        if cached and now - cached["fetched_at"] < WATCHLIST_CACHE_SECONDS:
            cached_rows[symbol] = cached
        else:
            stale_symbols.append(symbol)

    if stale_symbols:
        fetched_rows = fetch_quotes_with_change(stale_symbols)
        fetched_at = time.time()
        for row in fetched_rows:
            score, label = compute_ai_score(row.get("change_percent"))
            row["ai_score"] = score
            row["ai_label"] = label
            entry = {"row": row, "fetched_at": fetched_at}
            _watchlist_cache[row["symbol"]] = entry
            cached_rows[row["symbol"]] = entry
        _prune_cache(_watchlist_cache, 60)

    ordered = [cached_rows[s]["row"] for s in symbols if s in cached_rows]
    oldest_fetched_at = min((cached_rows[s]["fetched_at"] for s in symbols if s in cached_rows), default=now)
    return ordered, oldest_fetched_at


@app.get("/api/watchlist")
def watchlist():
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {"ok": False, "error": "Live market data is not configured on the server."}
        ), 503

    symbols_param = request.args.get("symbols", "")
    symbols = [s.strip().upper() for s in symbols_param.split(",") if s.strip()] or DEFAULT_WATCHLIST_SYMBOLS

    try:
        results, oldest_fetched_at = fetch_quotes_cached(symbols)
        updated_at = datetime.fromtimestamp(oldest_fetched_at, tz=timezone.utc).isoformat()
        return jsonify({"ok": True, "updated_at": updated_at, "data": results})

    except Exception as error:
        app.logger.warning("Watchlist fetch failed: %s", error)
        return jsonify({"ok": False, "error": "Could not fetch watchlist data right now."}), 502


# Plain LTP for the 4 fixed index markets, keyed by market_key (nifty,
# banknifty, ...). /api/market/<key> also carries a price, but it's the full
# technical-engine snapshot (candles + indicators, 20s cache) — far heavier
# than needed just to mark open paper positions to market every 2s.
INDEX_QUOTES_CACHE_SECONDS = 2
_index_quotes_cache = {"data": None, "fetched_at": 0}


@app.get("/api/index-quotes")
def index_quotes():
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    if _index_quotes_cache["data"] is not None and time.time() - _index_quotes_cache["fetched_at"] < INDEX_QUOTES_CACHE_SECONDS:
        return jsonify({"ok": True, "data": _index_quotes_cache["data"]})

    try:
        quotes = fetch_quotes_with_change(
            list(UPSTOX_MARKETS.keys()),
            resolver=lambda market_key: UPSTOX_MARKETS[market_key]["instrument_key"],
        )
        _index_quotes_cache["data"] = quotes
        _index_quotes_cache["fetched_at"] = time.time()
        return jsonify({"ok": True, "data": quotes})
    except Exception as error:
        app.logger.warning("Index quotes fetch failed: %s", error)
        return jsonify({"ok": False, "error": "Could not fetch index quotes right now."}), 502


# LTP by exact Upstox instrument_key — for paper positions in contracts that
# can't be looked up by a plain symbol (option legs, whose key comes straight
# from the option chain). Rows come back with `symbol` set to the key itself.
LTP_BY_KEY_CACHE_SECONDS = 2
_ltp_by_key_cache = {}


@app.get("/api/ltp")
def ltp_by_instrument_key():
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    keys = [k.strip() for k in request.args.get("instrument_keys", "").split(",") if k.strip()][:50]
    if not keys:
        return jsonify({"ok": False, "error": "Pass one or more instrument_keys."}), 400

    now = time.time()
    rows = {}
    stale = []
    for key in keys:
        cached = _ltp_by_key_cache.get(key)
        if cached and now - cached["fetched_at"] < LTP_BY_KEY_CACHE_SECONDS:
            rows[key] = cached["row"]
        else:
            stale.append(key)

    if stale:
        try:
            fetched = fetch_quotes_with_change(stale, resolver=lambda key: key)
        except Exception as error:
            app.logger.warning("LTP by key fetch failed: %s", error)
            if not rows:
                return jsonify({"ok": False, "error": "Could not fetch prices right now."}), 502
            fetched = []
        fetched_at = time.time()
        for row in fetched:
            _ltp_by_key_cache[row["symbol"]] = {"row": row, "fetched_at": fetched_at}
            rows[row["symbol"]] = row
        _prune_cache(_ltp_by_key_cache, 60)

    return jsonify({"ok": True, "data": [rows[k] for k in keys if k in rows]})


@app.get("/api/live/status")
def live_status():
    return jsonify(
        {
            "ok": True,
            "provider": "live_feed",
            "token_configured": bool(UPSTOX_ACCESS_TOKEN),
            "mode": "intraday-candle-polling",
            "markets": list(UPSTOX_MARKETS.keys()),
            "supported_timeframes": list(UPSTOX_TIMEFRAMES.keys()),
            "note": (
                "Read-only market-data endpoint. This service does not place, "
                "modify, or cancel orders."
            ),
            "updated_at": now_utc(),
        }
    )


@app.get("/api/live/candles/<market_key>")
def live_candles(market_key):
    market_key = market_key.lower().strip()
    timeframe = request.args.get("timeframe", "5m").lower().strip()

    if market_key not in UPSTOX_MARKETS:
        return jsonify(
            {
                "ok": False,
                "error": "Unknown market. Use: " + ", ".join(DEMO_MARKETS.keys()) + ".",
            }
        ), 404

    if timeframe not in UPSTOX_TIMEFRAMES:
        return jsonify(
            {
                "ok": False,
                "error": "Unsupported timeframe. Use: " + ", ".join(UPSTOX_TIMEFRAMES.keys()) + ".",
            }
        ), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {
                "ok": False,
                "error": "Live market data is not configured on the server.",
            }
        ), 503

    market = UPSTOX_MARKETS[market_key]
    unit, interval = UPSTOX_TIMEFRAMES[timeframe]

    cache_key = f"{market_key}:{timeframe}"
    cached = _live_candles_cache.get(cache_key)
    if cached and time.time() - cached["fetched_at"] < LIVE_CANDLES_CACHE_SECONDS:
        return jsonify(cached["response"])

    try:
        candles = fetch_upstox_candles(
            market["instrument_key"], unit, interval,
            chart_history_days=CHART_HISTORY_DAYS.get(timeframe, 30),
        )

        if not candles:
            return jsonify(
                {
                    "ok": False,
                    "provider": "live_feed",
                    "error": "No candle data is available for this instrument and timeframe.",
                }
            ), 502

        latest = candles[-1]

        response_body = {
            "ok": True,
            "provider": "live_feed",
            "mode": "intraday-candle-polling",
            "market": market["name"],
            "market_key": market_key,
            "instrument_key": market["instrument_key"],
            "timeframe": timeframe,
            "updated_at": now_utc(),
            "latest": latest,
            "candles": candles,
            "disclaimer": (
                "Read-only market data for research and paper trading only. "
                "No order placement is available."
            ),
        }
        _live_candles_cache[cache_key] = {"response": response_body, "fetched_at": time.time()}
        _prune_cache(_live_candles_cache, 60, limit=100)
        return jsonify(response_body)

    except requests.RequestException:
        app.logger.exception("Live candle request failed")

        return jsonify(
            {
                "ok": False,
                "provider": "live_feed",
                "error": "Could not reach live candle data right now.",
            }
        ), 502
    except Exception as error:
        app.logger.warning("Live candle request failed: %s", error)

        return jsonify(
            {
                "ok": False,
                "provider": "live_feed",
                "error": "Live candle data is temporarily unavailable.",
            }
        ), 502


# ===================== Options chain (NIFTY / Bank Nifty) =====================
# Uses Upstox's dedicated option-contract and option-chain endpoints (v2), not
# the LTP/candle endpoints used elsewhere. Field names are best-effort based on
# Upstox's published option-chain response shape; fields are read defensively
# with .get() so an unexpected shape degrades to "--" values on the frontend
# rather than a 500 error.

UPSTOX_OPTIONS_UNDERLYINGS = {
    "nifty": {"name": "NIFTY 50", "instrument_key": "NSE_INDEX|Nifty 50"},
    "banknifty": {"name": "Bank Nifty", "instrument_key": "NSE_INDEX|Nifty Bank"},
}


def resolve_options_underlying(market_key):
    """Returns (instrument_key, display_name) for an option chain's
    underlying — one of the two hardcoded indices above, or any NSE equity
    trading symbol resolved live via Upstox's instrument search. This is
    what lets the option chain work for any of the ~180 F&O-eligible stocks
    without hardcoding which of the 5000+ NSE symbols those are: a symbol
    with no listed options just comes back with no expiries below."""
    key = market_key.lower().strip()
    if key in UPSTOX_OPTIONS_UNDERLYINGS:
        entry = UPSTOX_OPTIONS_UNDERLYINGS[key]
        return entry["instrument_key"], entry["name"]

    symbol = market_key.strip().upper()
    if not symbol:
        return None, None
    try:
        # MCX commodity options are options on that month's futures
        # contract, not a separate spot/index instrument — the Commodities
        # page passes a specific contract's own trading symbol (e.g.
        # CRUDEOIL26OCTFUT) here as market_key once a user picks it.
        if MCX_FUTURES_SYMBOL_PATTERN.match(symbol):
            return resolve_mcx_instrument_key(symbol), symbol
        return resolve_instrument_key(symbol), symbol
    except Exception:
        return None, None


_option_expiry_cache = {}
OPTION_EXPIRY_CACHE_SECONDS = 3600
_option_chain_cache = {}
OPTION_CHAIN_CACHE_SECONDS = 2


# ---- MCX commodity options -------------------------------------------------
# Upstox's put/call option-chain and option-contract APIs don't cover MCX, so
# a commodity's chain is assembled here instead: its option contracts come
# from the instrument master (same source the futures already use), and
# their live LTP / OI / day change from the full market-quote API.

MCX_OPTION_CONTRACTS_CACHE_SECONDS = 60 * 60
_mcx_option_contracts_cache = {}
MCX_OPTION_QUOTE_BATCH = 100


def _parse_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_master_date(value):
    try:
        return datetime.strptime(str(value or "")[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def find_mcx_option_contracts(future_symbol):
    """Every live option contract written on one MCX futures contract (e.g.
    GOLD26OCTFUT). MCX labels each option series with the contract month of
    the future it belongs to (GOLD26OCT...CE), so an option belongs to this
    future when it shares the future's contract-month token and is on the
    same commodity (instrument-master `name`).

    Some months have no live options of their own left (a Sep contract whose
    Sep options have already expired, for instance), so when the future's own
    month has no active options the nearest later option month of the same
    commodity is used instead — the same strikes traders actually see on the
    exchange. Contracts carry `underlying_future` so the chain can quote the
    right underlying when that fallback kicks in."""
    future_symbol = future_symbol.upper()
    cached = _mcx_option_contracts_cache.get(future_symbol)
    if cached and time.time() - cached["fetched_at"] < MCX_OPTION_CONTRACTS_CACHE_SECONDS:
        return cached["data"]

    rows = get_instrument_master_rows()
    month_match = re.match(r"^([A-Z]+)(\d{2}[A-Z]{3})FUT$", future_symbol)
    if not month_match:
        return []
    prefix, month_token = month_match.groups()
    future_row = next(
        (r for r in rows if r.get("exchange") == "MCX_FO" and r.get("tradingsymbol", "").upper() == future_symbol),
        None,
    )
    if not future_row:
        return []
    commodity_name = (future_row.get("name") or "").strip().upper()
    today = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()

    def _contracts_for_month_token(token):
        # Exact commodity only: CRUDEOIL options, not CRUDEOILM (mini) ones,
        # which can share the same instrument `name` but trade a much
        # smaller lot.
        symbol_pattern = re.compile(rf"^{re.escape(prefix)}\s*{re.escape(token)}\d+(?:CE|PE)$")
        matched = []
        for row in rows:
            if row.get("exchange") != "MCX_FO":
                continue
            symbol = row.get("tradingsymbol", "").upper()
            if not symbol_pattern.match(symbol):
                continue
            name = (row.get("name") or "").strip().upper()
            if commodity_name and name and name != commodity_name:
                continue
            option_type = (row.get("option_type") or "").upper()
            if option_type not in ("CE", "PE"):
                if "OPT" in (row.get("instrument_type") or "").upper() and symbol[-2:] in ("CE", "PE"):
                    option_type = symbol[-2:]
                else:
                    continue
            expiry = _parse_master_date(row.get("expiry"))
            if not expiry or expiry < today:
                continue
            strike = _parse_float(row.get("strike"))
            if strike is None:
                continue
            matched.append(
                {
                    "instrument_key": row.get("instrument_key"),
                    "trading_symbol": row.get("tradingsymbol"),
                    "option_type": option_type,
                    "strike": int(strike) if strike.is_integer() else strike,
                    "expiry": expiry.isoformat(),
                    "lot_size": _parse_int(row.get("lot_size")),
                    "underlying_future": f"{prefix}{token}FUT",
                }
            )
        return matched

    contracts = _contracts_for_month_token(month_token)
    if not contracts:
        # The future's own option month is gone (expired out). Fall back to
        # the nearest still-active option month of the same commodity.
        token_pattern = re.compile(rf"^{re.escape(prefix)}\s*(\d{{2}}[A-Z]{{3}})\d+(?:CE|PE)$")
        active_months = []
        for row in rows:
            if row.get("exchange") != "MCX_FO":
                continue
            month_hit = token_pattern.match(row.get("tradingsymbol", "").upper())
            if not month_hit:
                continue
            name = (row.get("name") or "").strip().upper()
            if commodity_name and name and name != commodity_name:
                continue
            expiry = _parse_master_date(row.get("expiry"))
            if not expiry or expiry < today:
                continue
            active_months.append((expiry, month_hit.group(1)))
        if active_months:
            nearest_token = min(active_months, key=lambda item: item[0])[1]
            contracts = _contracts_for_month_token(nearest_token)

    _mcx_option_contracts_cache[future_symbol] = {"data": contracts, "fetched_at": time.time()}
    return contracts


def fetch_full_quotes(instrument_keys):
    """Full market quotes (LTP, OI, volume, net change) keyed by
    instrument_key, fetched in parallel batches."""
    headers = {"Accept": "application/json", "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}"}
    batches = [instrument_keys[i:i + MCX_OPTION_QUOTE_BATCH] for i in range(0, len(instrument_keys), MCX_OPTION_QUOTE_BATCH)]

    def _fetch(batch):
        url = f"https://api.upstox.com/v2/market-quote/quotes?instrument_key={quote(','.join(batch), safe=',')}"
        response = requests.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        return (response.json() or {}).get("data") or {}

    result = {}
    with ThreadPoolExecutor(max_workers=6) as executor:
        for data in executor.map(_fetch, batches):
            for info in data.values():
                token = info.get("instrument_token")
                if token:
                    result[token] = info
    return result


def build_mcx_option_chain(future_symbol, expiry):
    contracts = [c for c in find_mcx_option_contracts(future_symbol) if c["expiry"] == expiry]
    if not contracts:
        return None
    # When the chain fell back to a later option month (e.g. a Sep copper
    # future whose Sep options have expired), the strikes are written on
    # that later future — quote it as the underlying so spot stays
    # meaningful next to them.
    underlying_symbol = contracts[0].get("underlying_future") or future_symbol
    try:
        future_key = resolve_mcx_instrument_key(underlying_symbol)
    except Exception:
        future_key = resolve_mcx_instrument_key(future_symbol)
        underlying_symbol = future_symbol
    quotes = fetch_full_quotes([c["instrument_key"] for c in contracts] + [future_key])

    by_strike = {}
    for contract in contracts:
        info = quotes.get(contract["instrument_key"]) or {}
        ltp = info.get("last_price")
        net_change = info.get("net_change")
        close_price = round(ltp - net_change, 2) if ltp is not None and net_change is not None else None
        leg = {
            "ltp": ltp,
            "close_price": close_price,
            "oi": info.get("oi"),
            "prev_oi": None,
            "volume": info.get("volume"),
            "iv": None,
            "delta": None,
            "instrument_key": contract["instrument_key"],
            "trading_symbol": contract["trading_symbol"],
            "lot_size": contract["lot_size"],
        }
        row = by_strike.setdefault(contract["strike"], {"strike": contract["strike"], "call": {}, "put": {}})
        row["call" if contract["option_type"] == "CE" else "put"] = leg

    rows = sorted(by_strike.values(), key=lambda row: row["strike"])
    total_call_oi = sum((row["call"].get("oi") or 0) for row in rows)
    total_put_oi = sum((row["put"].get("oi") or 0) for row in rows)
    return {
        "market": future_symbol,
        "underlying": underlying_symbol,
        "expiry": expiry,
        "underlying_spot_price": (quotes.get(future_key) or {}).get("last_price"),
        "rows": rows,
        "total_call_oi": total_call_oi,
        "total_put_oi": total_put_oi,
        "pcr": round(total_put_oi / total_call_oi, 2) if total_call_oi else None,
        "max_pain": compute_max_pain(rows),
    }


@app.get("/api/options/expiries/<market_key>")
def option_expiries(market_key):
    cache_key = market_key.lower().strip()

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {"ok": False, "error": "Live market data is not configured on the server."}
        ), 503

    cached = _option_expiry_cache.get(cache_key)
    if cached and time.time() - cached["fetched_at"] < OPTION_EXPIRY_CACHE_SECONDS:
        return jsonify({"ok": True, "expiries": cached["data"]})

    if MCX_FUTURES_SYMBOL_PATTERN.match(market_key.strip().upper()):
        try:
            expiries = sorted({c["expiry"] for c in find_mcx_option_contracts(market_key)})
        except Exception as error:
            app.logger.warning("MCX option expiries failed for %s: %s", market_key, error)
            return jsonify({"ok": False, "error": "Could not fetch option expiries right now."}), 502
        if not expiries:
            # Futures-only commodities (Aluminium has no listed options on
            # MCX) get an explicit message instead of a generic error.
            prefix_hit = re.match(r"^([A-Z]+)\d{2}[A-Z]{3}FUT$", market_key.strip().upper())
            commodity_name = next(
                (
                    cfg["name"]
                    for cfg in MCX_COMMODITIES.values()
                    if prefix_hit and cfg["prefix"] == prefix_hit.group(1)
                ),
                None,
            )
            if commodity_name:
                return jsonify(
                    {
                        "ok": False,
                        "error": f"Options are not listed for {commodity_name} on MCX — only futures trade on it.",
                    }
                ), 404
            return jsonify({"ok": False, "error": "No options are listed on this commodity contract."}), 404
        _option_expiry_cache[cache_key] = {"data": expiries, "fetched_at": time.time()}
        return jsonify({"ok": True, "expiries": expiries})

    instrument_key, _name = resolve_options_underlying(market_key)
    if not instrument_key:
        return jsonify(
            {"ok": False, "error": "Could not find that symbol."}
        ), 404

    url = f"https://api.upstox.com/v2/option/contract?instrument_key={quote(instrument_key, safe='')}"
    headers = {"Accept": "application/json", "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}"}

    try:
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        contracts = (response.json() or {}).get("data", [])
        expiries = sorted({c.get("expiry") for c in contracts if c.get("expiry")})

        if not expiries:
            return jsonify(
                {"ok": False, "error": "This stock does not have listed options."}
            ), 404

        _option_expiry_cache[cache_key] = {"data": expiries, "fetched_at": time.time()}
        return jsonify({"ok": True, "expiries": expiries})

    except Exception as error:
        app.logger.warning("Option expiries fetch failed for %s: %s", market_key, error)
        return jsonify(
            {"ok": False, "error": "Could not fetch option expiries right now."}
        ), 502


def compute_max_pain(rows):
    """Max Pain: the strike at which option WRITERS collectively pay out the
    least if the underlying settles there at expiry (the strike most option
    buyers would be worst off at). For each candidate settlement strike,
    sums (in-the-money amount x OI) across every strike's calls and puts,
    then picks the candidate with the smallest total payout. Pure math over
    OI already in `rows` — no extra API calls."""
    strikes = [row["strike"] for row in rows if row.get("strike") is not None]
    if not strikes:
        return None

    best_strike = None
    best_payout = None
    for candidate in strikes:
        payout = 0
        for row in rows:
            strike = row.get("strike")
            if strike is None:
                continue
            if candidate > strike:
                payout += (candidate - strike) * (row["call"].get("oi") or 0)
            elif candidate < strike:
                payout += (strike - candidate) * (row["put"].get("oi") or 0)
        if best_payout is None or payout < best_payout:
            best_payout = payout
            best_strike = candidate

    return best_strike


@app.get("/api/options/chain/<market_key>")
def option_chain(market_key):
    expiry = request.args.get("expiry", "").strip()

    if not expiry:
        return jsonify(
            {"ok": False, "error": "expiry query parameter is required (YYYY-MM-DD)."}
        ), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {"ok": False, "error": "Live market data is not configured on the server."}
        ), 503

    redis_opt_key = f"option_chain:{market_key.lower().strip()}:{expiry}"
    if redis_client:
        try:
            cached_raw = redis_client.get(redis_opt_key)
            if cached_raw:
                cached_json = json.loads(cached_raw)
                return jsonify({"ok": True, "updated_at": cached_json.get("updated_at"), "data": cached_json.get("data")})
        except Exception:
            pass

    cache_key = f"{market_key.lower().strip()}:{expiry}"
    cached = _option_chain_cache.get(cache_key)
    if cached and time.time() - cached["fetched_at"] < OPTION_CHAIN_CACHE_SECONDS:
        return jsonify({"ok": True, "updated_at": cached["updated_at"], "data": cached["data"]})

    if MCX_FUTURES_SYMBOL_PATTERN.match(market_key.strip().upper()):
        try:
            result = build_mcx_option_chain(market_key.strip().upper(), expiry)
        except Exception as error:
            app.logger.warning("MCX option chain failed for %s %s: %s", market_key, expiry, error)
            return jsonify({"ok": False, "error": "Could not fetch the option chain right now."}), 502
        if not result:
            return jsonify({"ok": False, "error": "No options are listed for this expiry."}), 404
        updated_at = now_utc()
        _option_chain_cache[cache_key] = {"data": result, "fetched_at": time.time(), "updated_at": updated_at}
        _prune_cache(_option_chain_cache, 60, limit=40)
        if redis_client:
            try:
                redis_client.setex(redis_opt_key, 10, json.dumps({"updated_at": updated_at, "data": result}))
            except Exception:
                pass
        return jsonify({"ok": True, "updated_at": updated_at, "data": result})

    instrument_key, display_name = resolve_options_underlying(market_key)
    if not instrument_key:
        return jsonify(
            {"ok": False, "error": "Could not find that symbol."}
        ), 404

    url = (
        "https://api.upstox.com/v2/option/chain"
        f"?instrument_key={quote(instrument_key, safe='')}&expiry_date={quote(expiry, safe='')}"
    )
    headers = {"Accept": "application/json", "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}"}

    try:
        response = requests.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        raw_chain = (response.json() or {}).get("data", [])

        if not raw_chain:
            return jsonify(
                {"ok": False, "error": "No option chain data was returned for this expiry."}
            ), 502

        underlying_spot = None
        rows = []
        for item in raw_chain:
            if underlying_spot is None:
                underlying_spot = item.get("underlying_spot_price")

            call = item.get("call_options") or {}
            put = item.get("put_options") or {}
            call_market = call.get("market_data") or {}
            put_market = put.get("market_data") or {}
            call_greeks = call.get("option_greeks") or {}
            put_greeks = put.get("option_greeks") or {}

            rows.append(
                {
                    "strike": item.get("strike_price"),
                    "call": {
                        "ltp": call_market.get("ltp"),
                        "close_price": call_market.get("close_price"),
                        "oi": call_market.get("oi"),
                        "prev_oi": call_market.get("prev_oi"),
                        "volume": call_market.get("volume"),
                        "iv": call_greeks.get("iv"),
                        "delta": call_greeks.get("delta"),
                        # Carried straight through from Upstox rather than
                        # re-resolved by symbol, so a paper trade recorded
                        # against a specific strike always identifies the
                        # exact contract shown here.
                        "instrument_key": call.get("instrument_key"),
                        "trading_symbol": call.get("trading_symbol") or call.get("tradingsymbol"),
                        "lot_size": _parse_int(call.get("lot_size")),
                    },
                    "put": {
                        "ltp": put_market.get("ltp"),
                        "close_price": put_market.get("close_price"),
                        "oi": put_market.get("oi"),
                        "prev_oi": put_market.get("prev_oi"),
                        "volume": put_market.get("volume"),
                        "iv": put_greeks.get("iv"),
                        "delta": put_greeks.get("delta"),
                        "instrument_key": put.get("instrument_key"),
                        "trading_symbol": put.get("trading_symbol") or put.get("tradingsymbol"),
                        "lot_size": _parse_int(put.get("lot_size")),
                    },
                }
            )

        rows.sort(key=lambda row: row["strike"] if row["strike"] is not None else 0)

        # Upstox's option-chain legs carry an instrument_key but not always a
        # trading symbol or lot size. Both are needed to trade a leg from
        # the chain (the sheet is keyed by symbol; the order by lot), so any
        # gap is filled from the instrument master by instrument_key.
        missing = [
            leg for row in rows for leg in (row["call"], row["put"])
            if leg.get("instrument_key") and (not leg.get("trading_symbol") or leg.get("lot_size") is None)
        ]
        if missing:
            try:
                index = get_instrument_master_index()
                for leg in missing:
                    master = index.get(leg["instrument_key"])
                    if not master:
                        continue
                    trading_symbol, lot_size = master
                    if not leg.get("trading_symbol"):
                        leg["trading_symbol"] = trading_symbol
                    if leg.get("lot_size") is None:
                        leg["lot_size"] = lot_size
            except Exception as error:
                app.logger.warning("Option leg fill from instrument master failed for %s: %s", market_key, error)

        total_call_oi = sum((row["call"].get("oi") or 0) for row in rows)
        total_put_oi = sum((row["put"].get("oi") or 0) for row in rows)
        pcr = round(total_put_oi / total_call_oi, 2) if total_call_oi else None
        max_pain = compute_max_pain(rows)

        result = {
            "market": display_name,
            "expiry": expiry,
            "underlying_spot_price": underlying_spot,
            "rows": rows,
            "total_call_oi": total_call_oi,
            "total_put_oi": total_put_oi,
            "pcr": pcr,
            "max_pain": max_pain,
        }
        updated_at = now_utc()
        _option_chain_cache[cache_key] = {"data": result, "fetched_at": time.time(), "updated_at": updated_at}
        _prune_cache(_option_chain_cache, 60, limit=40)
        if redis_client:
            try:
                redis_client.setex(redis_opt_key, 10, json.dumps({"updated_at": updated_at, "data": result}))
            except Exception:
                pass
        return jsonify({"ok": True, "updated_at": updated_at, "data": result})

    except Exception as error:
        app.logger.warning("Option chain fetch failed for %s %s: %s", market_key, expiry, error)
        return jsonify(
            {"ok": False, "error": "Could not fetch the option chain right now."}
        ), 502


@app.post("/api/gemini/review")
def gemini_chart_review():
    payload = request.get_json(silent=True) or {}

    market_key = str(payload.get("market", "")).lower().strip()
    timeframe = str(payload.get("timeframe", "5m")).lower().strip()

    if market_key not in DEMO_MARKETS:
        return jsonify(
            {
                "ok": False,
                "error": "Unknown market. Use: " + ", ".join(DEMO_MARKETS.keys()) + ".",
            }
        ), 400

    if timeframe not in UPSTOX_TIMEFRAMES:
        return jsonify(
            {
                "ok": False,
                "error": "Unsupported timeframe. Use: " + ", ".join(UPSTOX_TIMEFRAMES.keys()) + ".",
            }
        ), 400

    if not GEMINI_API_KEY and not GROQ_API_KEY:
        return jsonify(
            {
                "ok": False,
                "error": "AI analysis is not configured on the server.",
            }
        ), 503

    market_data, is_live = get_market_snapshot_with_fallback(market_key)
    analysis = calculate_confirmation_engine(market_data)

    prompt = f"""
You are a cautious Indian index-market research assistant. This is strictly for educational research
and paper trading only; do not give financial advice, guarantee an outcome, or tell the user to place
a real trade.

Review the following technical-engine snapshot for {analysis["market"]} on the {timeframe} timeframe.
Data source: {"live market data" if is_live else "demo/reference data (live feed unavailable right now)"}.

Current price: {analysis["price"]}
Open / high / low: {analysis["open"]} / {analysis["high"]} / {analysis["low"]}
RSI 14: {analysis["indicators"]["rsi_14"]}
EMA 9 / EMA 21 / EMA 50: {analysis["indicators"]["ema_9"]} / {analysis["indicators"]["ema_21"]} / {analysis["indicators"]["ema_50"]}
VWAP: {analysis["indicators"]["vwap"]}
MACD histogram: {analysis["indicators"]["macd_histogram"]}
Volume ratio: {analysis["indicators"]["volume_ratio"]}
Support / resistance: {analysis["levels"]["support"]} / {analysis["levels"]["resistance"]}

Write a concise Hinglish review with exactly these five headings:
1. Trend
2. Momentum
3. Key Levels
4. Chart Structure
5. Volatility

Rules:
- Describe what the indicators show right now and what each reading commonly means in technical analysis, citing the specific numbers. Do not predict where the price will go.
- Mention the data source (live vs demo) if relevant.
- Do not invent live news, option-chain data, candle patterns, or unprovided indicators.
- Never tell the reader what to do: no buy/sell, no entry or exit, no stop-loss, no target, no position size, no "should" or "consider" — not even as general guidance.
- Keep the reply below 220 words.
"""

    try:
        review_text, provider = generate_ai_text(prompt)
        review_text = strip_trading_advice(review_text)

        return jsonify(
            {
                "ok": True,
                "market": analysis["market"],
                "timeframe": timeframe,
                "generated_at": now_utc(),
                "valid_for_seconds": 300,
                "review": review_text,
                "provider": provider,
                "disclaimer": "Research and paper-trading only. Not financial advice and not a live-market recommendation.",
            }
        )

    except (genai_errors.APIError, groq_sdk.APIError) as error:
        app.logger.exception("Chart AI review request failed")
        reason, friendly_message = describe_ai_error(error)
        return jsonify({"ok": False, "error": friendly_message, "reason": reason}), 502
    except Exception:
        app.logger.exception("Chart AI review request failed")
        return jsonify(
            {
                "ok": False,
                "error": "AI review is temporarily unavailable. Please try again later.",
                "reason": "unknown",
            }
        ), 502


@app.post("/api/ai-chart-scanner")
def ai_chart_scanner():
    """Pick-any-stock AI technical readout: computes the same indicator set
    used for the known indices (RSI/EMA/VWAP/MACD/Bollinger/Supertrend/ADX/
    Stochastic/Pivots) for an arbitrary NSE stock, then asks Gemini to
    explain it in plain Hinglish. Educational only — never an instruction to
    place a real trade."""
    payload = request.get_json(silent=True) or {}
    symbol = str(payload.get("symbol", "")).strip().upper()

    if not symbol:
        return jsonify({"ok": False, "error": "Please provide a stock symbol."}), 400

    if not GEMINI_API_KEY and not GROQ_API_KEY:
        return jsonify({"ok": False, "error": "AI analysis is not configured on the server."}), 503

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    try:
        snapshot = get_stock_technical_snapshot(symbol)
    except Exception as error:
        app.logger.warning("AI chart scanner snapshot failed for %s: %s", symbol, error)
        return jsonify(
            {"ok": False, "error": f"Could not fetch live data for {symbol}. Check the symbol and try again."}
        ), 502

    indicators_text = f"""Price: {snapshot['price']}
Open: {snapshot['open']} | High: {snapshot['high']} | Low: {snapshot['low']}
RSI(14): {snapshot['rsi_14']}
EMA 9/21/50: {snapshot['ema_9']} / {snapshot['ema_21']} / {snapshot['ema_50']}
VWAP: {snapshot['vwap']}
MACD histogram: {snapshot['macd_histogram']}
ATR(14): {snapshot['atr_14']}
Support: {snapshot['support']} | Resistance: {snapshot['resistance']}
Trend (5m/15m/1h): {snapshot['trend_5m']} / {snapshot['trend_15m']} / {snapshot['trend_1h']}
Bollinger Bands: {snapshot['bollinger_bands']}
Supertrend: {snapshot['supertrend']}
ADX/+DI/-DI: {snapshot['adx']}
Stochastic: {snapshot['stochastic']}
Pivot Points: {snapshot['pivot_points']}
Volume vs 20-candle average: {snapshot['volume_ratio']}x"""

    prompt = f"""
You are an educational technical-analysis explainer for a retail Indian-market research/paper-trading app.
This is strictly educational, not financial advice, and must never instruct the user to place a real trade.

Here are the current live technical readings for {symbol} (NSE), from 5-minute candles today:
{indicators_text}

Write a concise Hinglish summary with exactly these five headings:
1. Trend
2. Momentum
3. Key Levels
4. Chart Structure
5. Volatility

Rules:
- Base your analysis only on the numbers given above. Do not invent news, fundamentals, or data not shown.
- Describe what the indicators show right now and what each reading commonly means in technical analysis. Do not predict where the price will go.
- For "Chart Structure", name what the data shows (Trending / Pullback / Range / Near support / Near resistance / Mixed) — do not force a pattern if the indicators are mixed.
- For "Volatility", describe the ATR and today's range in points only.
- Never tell the reader what to do: no buy/sell, no entry or exit, no stop-loss, no target, no position size, no "should" or "consider" — not even as general guidance.
- Keep the reply under 180 words.
"""

    try:
        analysis_text, provider = generate_ai_text(prompt)
        analysis_text = strip_trading_advice(analysis_text)

        return jsonify(
            {
                "ok": True,
                "symbol": symbol,
                "generated_at": now_utc(),
                "indicators": snapshot,
                "analysis": analysis_text,
                "provider": provider,
                "disclaimer": "Educational technical-analysis summary only. Not financial advice.",
            }
        )
    except (genai_errors.APIError, groq_sdk.APIError) as error:
        app.logger.exception("AI chart scanner request failed for %s", symbol)
        reason, friendly_message = describe_ai_error(error)
        return jsonify({"ok": False, "error": friendly_message, "reason": reason}), 502
    except Exception:
        app.logger.exception("AI chart scanner request failed for %s", symbol)
        return jsonify({"ok": False, "error": "AI analysis is temporarily unavailable. Please try again later.", "reason": "unknown"}), 502


@app.post("/api/ai-market-review")
def ai_market_review():
    """Dashboard-level AI review for one of the fixed index markets (NIFTY 50
    / Bank Nifty / etc.) — same Gemini/Groq Hinglish readout as the AI Chart
    Scanner, just sourced from the index snapshot (with its demo-data
    fallback) instead of an arbitrary stock lookup. Educational only."""
    payload = request.get_json(silent=True) or {}
    market_key = str(payload.get("market", "")).strip().lower()

    if market_key not in UPSTOX_MARKETS:
        return jsonify({"ok": False, "error": "Please provide a valid market (nifty or banknifty)."}), 400

    if not GEMINI_API_KEY and not GROQ_API_KEY:
        return jsonify({"ok": False, "error": "AI analysis is not configured on the server."}), 503

    market_name = UPSTOX_MARKETS[market_key]["name"]
    snapshot, is_live = get_market_snapshot_with_fallback(market_key)

    def field(key, default="--"):
        value = snapshot.get(key)
        return default if value is None else value

    indicators_text = f"""Price: {field('price')}
Open: {field('open')} | High: {field('high')} | Low: {field('low')}
RSI(14): {field('rsi_14')}
EMA 9/21/50: {field('ema_9')} / {field('ema_21')} / {field('ema_50')}
VWAP: {field('vwap')}
MACD histogram: {field('macd_histogram')}
ATR(14): {field('atr_14')}
Support: {field('support')} | Resistance: {field('resistance')}
Trend (5m/15m/1h): {field('trend_5m')} / {field('trend_15m')} / {field('trend_1h')}
Volume vs 20-candle average: {field('volume_ratio')}x"""

    prompt = f"""
You are an educational technical-analysis explainer for a retail Indian-market research/paper-trading app.
This is strictly educational, not financial advice, and must never instruct the user to place a real trade.

Here are the current {'live' if is_live else 'demo (market data unavailable right now)'} technical readings for {market_name}, from 5-minute candles today:
{indicators_text}

Write a concise Hinglish summary with exactly these five headings:
1. Trend
2. Momentum
3. Key Levels
4. Chart Structure
5. Volatility

Rules:
- Base your analysis only on the numbers given above. Do not invent news, fundamentals, or data not shown.
- Describe what the indicators show right now and what each reading commonly means in technical analysis. Do not predict where the price will go.
- For "Chart Structure", name what the data shows (Trending / Pullback / Range / Near support / Near resistance / Mixed) — do not force a pattern if the indicators are mixed.
- For "Volatility", describe the ATR and today's range in points only.
- Never tell the reader what to do: no buy/sell, no entry or exit, no stop-loss, no target, no position size, no "should" or "consider" — not even as general guidance.
- Keep the reply under 180 words.
"""

    try:
        analysis_text, provider = generate_ai_text(prompt)
        analysis_text = strip_trading_advice(analysis_text)

        return jsonify(
            {
                "ok": True,
                "market": market_key,
                "market_name": market_name,
                "generated_at": now_utc(),
                "data_source": "live" if is_live else "demo_fallback",
                "indicators": snapshot,
                "analysis": analysis_text,
                "provider": provider,
                "disclaimer": "Educational technical-analysis summary only. Not financial advice.",
            }
        )
    except (genai_errors.APIError, groq_sdk.APIError) as error:
        app.logger.exception("AI market review request failed for %s", market_key)
        reason, friendly_message = describe_ai_error(error)
        return jsonify({"ok": False, "error": friendly_message, "reason": reason}), 502
    except Exception:
        app.logger.exception("AI market review request failed for %s", market_key)
        return jsonify({"ok": False, "error": "AI analysis is temporarily unavailable. Please try again later.", "reason": "unknown"}), 502


@app.get("/api/stock-technical/<symbol>")
def stock_technical(symbol):
    """Same indicator set as the AI Chart Scanner, but plain JSON with no AI
    call -- powers the per-stock detail page's chart/technicals view without
    needing GEMINI_API_KEY/GROQ_API_KEY configured, only Upstox."""
    symbol = symbol.strip().upper()

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    try:
        snapshot = get_stock_technical_snapshot(symbol)
    except Exception as error:
        app.logger.warning("Stock technical snapshot failed for %s: %s", symbol, error)
        return jsonify({"ok": False, "error": f"Could not fetch live data for {symbol}. Check the symbol and try again."}), 502

    return jsonify(
        {
            "ok": True,
            "symbol": symbol,
            "generated_at": now_utc(),
            "indicators": snapshot,
            "disclaimer": "Educational technical data only. Not financial advice.",
        }
    )


@app.get("/api/stock-news/<symbol>")
def stock_news(symbol):
    symbol = symbol.strip().upper()

    try:
        universe = get_nse_equity_universe()
    except Exception as error:
        app.logger.warning("Stock universe fetch failed for news lookup: %s", error)
        return jsonify({"ok": False, "error": "Could not load stock news right now."}), 502

    company_name = next((stock["name"] for stock in universe if stock["symbol"] == symbol), "")
    if not company_name:
        return jsonify({"ok": False, "error": f"Unknown symbol: {symbol}."}), 404

    items = fetch_stock_news(symbol, company_name)

    return jsonify(
        {
            "ok": True,
            "symbol": symbol,
            "company_name": company_name,
            "generated_at": now_utc(),
            "count": len(items),
            "items": items,
            "disclaimer": "Publisher RSS headlines matched by company name, for research context only. Not financial advice. Coverage may be sparse for less-covered stocks.",
        }
    )


@app.post("/api/ai-coach")
def ai_trade_coach():
    payload = request.get_json(silent=True) or {}
    trades = payload.get("trades")

    if not isinstance(trades, list) or not trades:
        return jsonify(
            {
                "ok": False,
                "error": "No trade history to review yet. Add a paper trade or run a chart-replay backtest first.",
            }
        ), 400

    if not GEMINI_API_KEY and not GROQ_API_KEY:
        return jsonify(
            {
                "ok": False,
                "error": "AI coaching is not configured on the server.",
            }
        ), 503

    trades = trades[:30]
    closed = [t for t in trades if str(t.get("outcome", "")).upper() in ("WIN", "LOSS")]
    wins = [t for t in closed if str(t.get("outcome", "")).upper() == "WIN"]
    total_r = sum(float(t.get("rMultiple", 0) or 0) for t in closed)
    win_rate = round((len(wins) / len(closed)) * 100, 1) if closed else None
    avg_r = round(total_r / len(closed), 2) if closed else None
    long_count = sum(1 for t in trades if str(t.get("direction", "")).upper() in ("LONG", "BUY"))
    short_count = len(trades) - long_count

    trades_text = "\n".join(
        f"- {t.get('direction', '?')} | Entry {t.get('entry', '?')} | Stop {t.get('stop', '?')} | "
        f"Target {t.get('target', '?')} | Exit {t.get('exit', '-')} | Outcome {t.get('outcome', 'OPEN/UNVERIFIED')} | "
        f"R {t.get('rMultiple', '-')}"
        for t in trades
    )

    stats_text = f"Total trades logged: {len(trades)} (Long: {long_count}, Short: {short_count}).\n"
    if closed:
        stats_text += (
            f"Of these, {len(closed)} are verified chart-replay backtest results — "
            f"Win rate: {win_rate}%, Total: {round(total_r, 2)}R, Average: {avg_r}R per trade.\n"
        )
    else:
        stats_text += "None of these have a verified win/loss outcome yet — they are unconfirmed research log entries only.\n"

    prompt = f"""
You are a cautious, encouraging trading coach for a retail Indian-market paper-trading student. This is
strictly educational research and paper-trading coaching; do not give financial advice, guarantee any
outcome, or tell the user to place a real trade.

Here is the student's trade history (paper trades and/or chart-replay backtests, most recent first):
{trades_text}

Aggregate stats (already computed correctly from the data above — use these numbers, do not recalculate them yourself):
{stats_text}

Write a concise Hinglish coaching note with exactly these five headings:
1. Overall Performance
2. Strengths
3. Weaknesses / Mistakes
4. Pattern Noticed
5. Next Steps

Rules:
- Base your analysis only on the trade data and stats given above. Do not invent trades, news, or indicators.
- Be specific: reference the actual entry/stop/target numbers or risk:reward ratios you can see, not generic advice.
- If there are fewer than 5 trades, say so and note this is only a preliminary read.
- Do not suggest real-money trading or use imperative execution language.
- Keep the reply below 220 words.
"""

    try:
        coaching_text, provider = generate_ai_text(prompt)

        return jsonify(
            {
                "ok": True,
                "generated_at": now_utc(),
                "coaching": coaching_text,
                "provider": provider,
                "stats": {
                    "total_trades": len(trades),
                    "closed_trades": len(closed),
                    "win_rate_percent": win_rate,
                    "total_r": round(total_r, 2) if closed else None,
                    "avg_r": avg_r,
                },
                "disclaimer": "Research and paper-trading coaching only. Not financial advice.",
            }
        )

    except (genai_errors.APIError, groq_sdk.APIError) as error:
        app.logger.exception("AI trade coach request failed")
        reason, friendly_message = describe_ai_error(error)
        return jsonify({"ok": False, "error": friendly_message, "reason": reason}), 502
    except Exception:
        app.logger.exception("AI trade coach request failed")

        return jsonify(
            {
                "ok": False,
                "reason": "unknown",
                "error": "AI coaching is temporarily unavailable. Please try again later.",
            }
        ), 502


INDIA_NEWS_SOURCES = [
    {"name": "Economic Times Markets", "url": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"},
    {"name": "Business Standard Markets", "url": "https://www.business-standard.com/rss/markets-106.rss"},
    {"name": "Livemint Markets", "url": "https://www.livemint.com/rss/markets"},
]
INDIA_NEWS_CACHE_SECONDS = 180
india_news_cache = {"data": None, "updated_at": 0}


def strip_html_tags(text):
    text = str(text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    replacements = {"&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">"}
    for old, new in replacements.items():
        text = text.replace(old, new)
    return " ".join(text.split())


def parse_rss_time(value):
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError, IndexError):
        return None


def format_rss_time(value):
    parsed = parse_rss_time(value)
    return parsed.strftime("%d %b %Y, %I:%M %p UTC") if parsed else "Published time unavailable"


def get_xml_tag_text(node, tag_name):
    tag = node.find(tag_name)
    return tag.text.strip() if tag is not None and tag.text else ""


def _fetch_rss_news(keyword_matcher, max_age_seconds, limit):
    """Shared RSS pull used by both the general market-news feed and the
    per-stock news filter below -- only the match condition and the age
    window differ between the two callers."""
    import xml.etree.ElementTree as element_tree

    collected, seen_urls = [], set()
    now = datetime.now(timezone.utc)
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; IndianMarketAI-News/1.0)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    }

    for source in INDIA_NEWS_SOURCES:
        source_name, source_url = source.get("name", "Market news"), source.get("url", "")
        try:
            response = requests.get(source_url, timeout=12, headers=headers)
            response.raise_for_status()
            root = element_tree.fromstring(response.content)

            for item in root.findall(".//item")[:40]:
                headline = strip_html_tags(get_xml_tag_text(item, "title"))
                url = get_xml_tag_text(item, "link")
                description = strip_html_tags(get_xml_tag_text(item, "description"))
                published_raw = get_xml_tag_text(item, "pubDate")
                published_at = parse_rss_time(published_raw)

                if not headline or not url.startswith(("https://", "http://")):
                    continue

                normalized_url = url.split("?")[0].rstrip("/")
                if normalized_url in seen_urls:
                    continue

                searchable = f"{headline} {description}".lower()
                if not keyword_matcher(searchable):
                    continue

                if published_at and (now - published_at).total_seconds() > max_age_seconds:
                    continue

                seen_urls.add(normalized_url)
                collected.append(
                    {
                        "headline": headline[:260],
                        "source": source_name,
                        "url": url[:1000],
                        "published_time": format_rss_time(published_raw),
                        "summary": description[:400] if description else "Open the original article for the publisher summary.",
                        "_published_at": published_at.timestamp() if published_at else 0,
                    }
                )
        except (requests.exceptions.RequestException, ValueError) as error:
            app.logger.warning("India market news source unavailable (%s): %s", source_name, error)

    collected.sort(key=lambda item: item.get("_published_at", 0), reverse=True)
    result = []
    for item in collected[:limit]:
        item.pop("_published_at", None)
        result.append(item)
    return result


def fetch_india_market_news():
    keywords = (
        "nifty", "sensex", "bse", "nse", "rupee", "rbi", "sebi", "ipo", "share", "stock",
        "market", "index", "earnings", "results", "f&o", "futures", "options", "fii", "dii",
        "bank nifty", "commodity", "gold", "crude",
    )
    return _fetch_rss_news(
        keyword_matcher=lambda text: any(keyword in text for keyword in keywords),
        max_age_seconds=2 * 24 * 60 * 60,
        limit=40,
    )


def fetch_stock_news(symbol, company_name):
    """There's no dedicated per-stock news API wired up -- this reuses the
    same general-market RSS pool and filters by the stock's own symbol/name
    instead of generic market keywords. Coverage is limited to whatever the
    publishers actually wrote about this specific stock, so results can be
    sparse or empty for less-covered names."""
    name_lower = (company_name or "").strip().lower()
    name_short = re.sub(r"\s+(ltd|limited|inc|corp|corporation)\.?$", "", name_lower).strip()
    search_terms = {term for term in {symbol.strip().lower(), name_lower, name_short} if len(term) >= 3}

    if not search_terms:
        return []

    return _fetch_rss_news(
        keyword_matcher=lambda text: any(term in text for term in search_terms),
        max_age_seconds=14 * 24 * 60 * 60,
        limit=15,
    )


@app.get("/api/market-news")
def market_news():
    now = time.time()

    if india_news_cache["data"] is not None and (now - india_news_cache["updated_at"]) < INDIA_NEWS_CACHE_SECONDS:
        items = india_news_cache["data"]
    else:
        items = fetch_india_market_news()
        if items:
            india_news_cache["data"] = items
            india_news_cache["updated_at"] = now
        elif india_news_cache["data"] is not None:
            items = india_news_cache["data"]

    if not items:
        return jsonify(
            {
                "ok": False,
                "error": "No recent market news could be loaded right now. Please try again shortly.",
            }
        ), 502

    return jsonify(
        {
            "ok": True,
            "generated_at": now_utc(),
            "count": len(items),
            "items": items,
            "disclaimer": "Publisher RSS headlines shown for research context only. Not financial advice.",
        }
    )


def parse_json_from_model(text):
    cleaned = str(text or "").strip()

    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        cleaned = cleaned[start : end + 1]

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise ValueError("AI returned invalid JSON.") from error


@app.post("/api/news/translate")
def translate_news_to_hindi():
    payload = request.get_json(silent=True) or {}
    headline = str(payload.get("headline", "")).strip()[:300]
    summary = str(payload.get("summary", "")).strip()[:1200]
    source = str(payload.get("source", "")).strip()[:100]

    if not headline:
        return jsonify({"ok": False, "error": "News headline is required for translation."}), 400

    if not GEMINI_API_KEY and not GROQ_API_KEY:
        return jsonify({"ok": False, "error": "AI translation is not configured on the server."}), 503

    prompt = f"""Translate this Indian stock-market news headline and publisher summary into simple, natural
Hindi in Devanagari script. Preserve company names, numbers, tickers, index names (NIFTY, SENSEX, Bank
Nifty, etc.), prices, and dates exactly as given. Do not add predictions, advice, or any fact not present
in the original text.

Source: {source}
Headline: {headline}
Summary: {summary}

Return only one JSON object and nothing else, in this exact shape:
{{"headline_hi": "...", "summary_hi": "..."}}
"""

    try:
        response_text, provider = generate_ai_text(prompt, json_mode=True)
        result = parse_json_from_model(response_text)

        headline_hi = str(result.get("headline_hi", "")).strip()
        summary_hi = str(result.get("summary_hi", "")).strip()

        if not headline_hi:
            return jsonify(
                {
                    "ok": False,
                    "error": "AI returned an empty Hindi translation. Please try again.",
                }
            ), 502

        return jsonify(
            {
                "ok": True,
                "headline_hi": headline_hi,
                "summary_hi": summary_hi,
                "provider": provider,
            }
        )

    except ValueError:
        return jsonify(
            {
                "ok": False,
                "error": "AI returned an unexpected response. Please try again.",
            }
        ), 502
    except (genai_errors.APIError, groq_sdk.APIError) as error:
        app.logger.exception("Hindi news translation failed")
        reason, friendly_message = describe_ai_error(error)
        return jsonify({"ok": False, "error": friendly_message, "reason": reason}), 502
    except Exception:
        app.logger.exception("Hindi news translation failed")

        return jsonify(
            {
                "ok": False,
                "reason": "unknown",
                "error": "Hindi translation is temporarily unavailable. Please try again later.",
            }
        ), 502


# ===================== Commodities (MCX) =====================
# MCX futures contracts expire monthly/periodically (unlike a perpetual index),
# so there is no single fixed instrument_key to hardcode. Instead, this
# resolves the current nearest-expiry, standard-lot contract for each
# commodity from Upstox's public instrument master (no auth required for the
# catalog itself — only the live quote afterwards needs the access token),
# and re-resolves it once the cache expires so the rollover to the next
# month's contract happens automatically without a code change.

MCX_COMMODITIES = {
    "gold": {"name": "Gold", "prefix": "GOLD"},
    "silver": {"name": "Silver", "prefix": "SILVER"},
    "crudeoil": {"name": "Crude Oil", "prefix": "CRUDEOIL"},
    "naturalgas": {"name": "Natural Gas", "prefix": "NATURALGAS"},
    "copper": {"name": "Copper", "prefix": "COPPER"},
    "zinc": {"name": "Zinc", "prefix": "ZINC"},
    "aluminium": {"name": "Aluminium", "prefix": "ALUMINIUM"},
}

INSTRUMENT_MASTER_URL = "https://assets.upstox.com/market-quote/instruments/exchange/complete.csv.gz"
INSTRUMENT_MASTER_CACHE_SECONDS = 12 * 60 * 60
_instrument_master_cache = {"rows": None, "by_key": {}, "fetched_at": 0}

COMMODITY_CONTRACT_CACHE_SECONDS = 12 * 60 * 60
_commodity_contract_cache = {}

COMMODITY_QUOTE_CACHE_SECONDS = 2
_commodity_quote_cache = {"data": None, "fetched_at": 0}


# The master lists every instrument on every Indian exchange (well over a
# lakh rows). Only two slices are ever read, so only those are kept:
# - full rows (needed columns only) for MCX futures/options and NSE equities,
#   used by the Commodities pages and stock search;
# - instrument_key -> (trading symbol, lot size) for F&O option contracts,
#   used to fill option-chain legs.
# Holding the whole file as dicts cost 200+ MB per worker on a 1 GB server.
MASTER_ROW_EXCHANGES = {"MCX_FO", "NSE_EQ"}
MASTER_ROW_FIELDS = ("instrument_key", "tradingsymbol", "name", "exchange", "instrument_type", "option_type", "expiry", "strike", "lot_size")
MASTER_INDEX_EXCHANGES = {"NSE_FO", "BSE_FO", "MCX_FO"}


def _load_instrument_master():
    response = requests.get(INSTRUMENT_MASTER_URL, timeout=30)
    response.raise_for_status()
    rows, by_key = [], {}
    # Stream the gzip so the decompressed CSV is never held in memory whole.
    with gzip.GzipFile(fileobj=io.BytesIO(response.content)) as raw:
        for row in csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8")):
            exchange = row.get("exchange")
            if exchange in MASTER_ROW_EXCHANGES:
                rows.append({field: row[field] for field in MASTER_ROW_FIELDS if field in row})
            key = row.get("instrument_key")
            if key and exchange in MASTER_INDEX_EXCHANGES and "OPT" in (row.get("instrument_type") or "").upper():
                by_key[key] = (row.get("tradingsymbol"), _parse_int(row.get("lot_size")))
    return rows, by_key


def _ensure_instrument_master():
    now = time.time()
    if _instrument_master_cache["rows"] is None or (now - _instrument_master_cache["fetched_at"]) >= INSTRUMENT_MASTER_CACHE_SECONDS:
        rows, by_key = _load_instrument_master()
        _instrument_master_cache["rows"] = rows
        _instrument_master_cache["by_key"] = by_key
        _instrument_master_cache["fetched_at"] = now
    return _instrument_master_cache


def get_instrument_master_rows():
    """MCX_FO and NSE_EQ rows of the instrument master (see above)."""
    return _ensure_instrument_master()["rows"]


def get_instrument_master_index():
    """instrument_key -> (trading_symbol, lot_size) for F&O option contracts."""
    return _ensure_instrument_master()["by_key"]


def find_all_mcx_futures(prefix):
    """Finds every not-yet-expired, standard-lot MCX future for the given
    commodity prefix (GOLD/SILVER/CRUDEOIL/...), nearest expiry first —
    matching the trading symbol exactly against PREFIX + 2-digit-year +
    3-letter-month + FUT, which excludes mini/guinea/petal/other variant
    contracts that share the same instrument `name` but trade as separate,
    smaller-lot contracts."""
    pattern = re.compile(rf"^{re.escape(prefix)}\d{{2}}[A-Z]{{3}}FUT$")
    today = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date()

    candidates = []
    for row in get_instrument_master_rows():
        if row.get("exchange") != "MCX_FO" or row.get("instrument_type") != "FUTCOM":
            continue
        if not pattern.match(row.get("tradingsymbol", "")):
            continue
        try:
            expiry_date = datetime.strptime(row.get("expiry", ""), "%Y-%m-%d").date()
        except ValueError:
            continue
        if expiry_date >= today:
            candidates.append((expiry_date, row))

    candidates.sort(key=lambda pair: pair[0])
    return [
        {
            "instrument_key": row.get("instrument_key"),
            "trading_symbol": row.get("tradingsymbol"),
            "expiry": expiry_date.isoformat(),
            "lot_size": _parse_int(row.get("lot_size")),
        }
        for expiry_date, row in candidates
    ]


def find_current_mcx_future(prefix):
    """The nearest-expiry contract from find_all_mcx_futures() — what the
    Commodities list itself quotes, before a specific expiry is chosen."""
    all_futures = find_all_mcx_futures(prefix)
    return all_futures[0] if all_futures else None


def resolve_mcx_instrument_key(trading_symbol):
    """Looks up an MCX futures contract's instrument_key by its exact
    trading symbol (e.g. GOLD25DECFUT) from Upstox's instrument master —
    the same source find_current_mcx_future() above already resolves
    quotes from, so this always agrees with what /api/commodities shows."""
    cache_key = f"MCX_FO:{trading_symbol.upper()}"
    if cache_key in _instrument_key_cache:
        return _instrument_key_cache[cache_key]

    for row in get_instrument_master_rows():
        if row.get("exchange") == "MCX_FO" and row.get("tradingsymbol", "").upper() == trading_symbol.upper():
            instrument_key = row.get("instrument_key")
            if instrument_key:
                _instrument_key_cache[cache_key] = instrument_key
                return instrument_key

    raise RuntimeError(f"No MCX instrument found for {trading_symbol}")


def get_current_commodity_contract(commodity_key):
    cached = _commodity_contract_cache.get(commodity_key)
    now = time.time()
    if cached and now - cached["fetched_at"] < COMMODITY_CONTRACT_CACHE_SECONDS:
        return cached["data"]

    contract = find_current_mcx_future(MCX_COMMODITIES[commodity_key]["prefix"])
    if contract:
        _commodity_contract_cache[commodity_key] = {"data": contract, "fetched_at": now}
    return contract


@app.get("/api/commodities")
def commodities():
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {"ok": False, "error": "Live market data is not configured on the server."}
        ), 503

    cache_key = "commodities:overview"
    if redis_client:
        try:
            cached_raw = redis_client.get(cache_key)
            if cached_raw:
                cached_json = json.loads(cached_raw)
                return jsonify({"ok": True, "updated_at": cached_json.get("updated_at"), "data": cached_json.get("data")})
        except Exception:
            pass

    now = time.time()
    if _commodity_quote_cache["data"] is not None and (now - _commodity_quote_cache["fetched_at"]) < COMMODITY_QUOTE_CACHE_SECONDS:
        return jsonify({"ok": True, "updated_at": _commodity_quote_cache["updated_at"], "data": _commodity_quote_cache["data"]})

    try:
        contracts = {}
        for key in MCX_COMMODITIES:
            contract = get_current_commodity_contract(key)
            if contract:
                contracts[key] = contract

        if not contracts:
            return jsonify(
                {"ok": False, "error": "Could not resolve current commodity contracts."}
            ), 502

        instrument_keys = ",".join(c["instrument_key"] for c in contracts.values())
        url = f"https://api.upstox.com/v3/market-quote/ltp?instrument_key={quote(instrument_keys, safe=',')}"
        headers = {"Accept": "application/json", "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}"}

        response = requests.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        quote_data = (response.json().get("data") or {})

        reverse_map = {contract["instrument_key"]: key for key, contract in contracts.items()}

        results = []
        for info in quote_data.values():
            commodity_key = reverse_map.get(info.get("instrument_token", ""))
            if not commodity_key:
                continue

            last_price = info.get("last_price")
            previous_close = info.get("cp")
            change_percent = None
            if last_price is not None and previous_close:
                change_percent = round(((last_price - previous_close) / previous_close) * 100, 2)

            results.append(
                {
                    "key": commodity_key,
                    "name": MCX_COMMODITIES[commodity_key]["name"],
                    "trading_symbol": contracts[commodity_key]["trading_symbol"],
                    "expiry": contracts[commodity_key]["expiry"],
                    "lot_size": contracts[commodity_key].get("lot_size"),
                    "last_price": last_price,
                    "previous_close": previous_close,
                    "change_percent": change_percent,
                }
            )

        order = list(MCX_COMMODITIES.keys())
        results.sort(key=lambda row: order.index(row["key"]) if row["key"] in order else 999)

        updated_at = now_utc()
        _commodity_quote_cache["data"] = results
        _commodity_quote_cache["fetched_at"] = now
        _commodity_quote_cache["updated_at"] = updated_at

        if redis_client:
            try:
                redis_client.setex(cache_key, COMMODITY_QUOTE_CACHE_SECONDS, json.dumps({"updated_at": updated_at, "data": results}))
            except Exception:
                pass

        return jsonify({"ok": True, "updated_at": updated_at, "data": results})

    except Exception as error:
        app.logger.warning("Commodities fetch failed: %s", error)
        return jsonify(
            {"ok": False, "error": "Could not fetch commodity prices right now."}
        ), 502


@app.get("/api/commodities/<commodity_key>/expiries")
def commodity_expiries(commodity_key):
    """Every currently tradable expiry for one commodity (e.g. all of
    Gold's live monthly contracts), each with its own live quote — lets the
    user pick a specific contract before Buy/Sell, instead of only ever
    trading the nearest-expiry one /api/commodities shows on the list."""
    commodity_key = commodity_key.lower().strip()
    if commodity_key not in MCX_COMMODITIES:
        return jsonify({"ok": False, "error": "Unknown commodity."}), 404

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Live market data is not configured on the server."}), 503

    try:
        contracts = find_all_mcx_futures(MCX_COMMODITIES[commodity_key]["prefix"])
        if not contracts:
            return jsonify({"ok": False, "error": "No live contracts found for this commodity."}), 502

        instrument_keys = ",".join(c["instrument_key"] for c in contracts)
        url = f"https://api.upstox.com/v3/market-quote/ltp?instrument_key={quote(instrument_keys, safe=',')}"
        headers = {"Accept": "application/json", "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}"}

        response = requests.get(url, headers=headers, timeout=20)
        response.raise_for_status()
        quote_data = (response.json().get("data") or {})
        quote_by_instrument = {info.get("instrument_token", ""): info for info in quote_data.values()}

        results = []
        for contract in contracts:
            info = quote_by_instrument.get(contract["instrument_key"], {})
            last_price = info.get("last_price")
            previous_close = info.get("cp")
            change_percent = None
            if last_price is not None and previous_close:
                change_percent = round(((last_price - previous_close) / previous_close) * 100, 2)

            results.append(
                {
                    "trading_symbol": contract["trading_symbol"],
                    "expiry": contract["expiry"],
                    "lot_size": contract.get("lot_size"),
                    "last_price": last_price,
                    "change_percent": change_percent,
                }
            )

        return jsonify(
            {
                "ok": True,
                "key": commodity_key,
                "name": MCX_COMMODITIES[commodity_key]["name"],
                "data": results,
                "updated_at": now_utc(),
            }
        )
    except Exception as error:
        app.logger.warning("Commodity expiries fetch failed for %s: %s", commodity_key, error)
        return jsonify({"ok": False, "error": "Could not fetch commodity expiries right now."}), 502


# ===================== NSE stock search (for building watchlists) =====================
# Reuses the same public instrument master as the commodities feature (no auth
# needed for the catalog). Filtered to genuine NSE-listed equities and ETFs —
# identified by ISIN prefix (INE = equity, INF = mutual-fund/ETF units) rather
# than instrument_type, since Upstox tags government/state bonds on this
# segment as "EQUITY" too. This gives a searchable universe of 5000+ symbols
# without ever sending the whole list to the frontend.

EQUITY_ISIN_PREFIXES = ("INE", "INF")
_nse_equity_universe_cache = {"rows": None, "fetched_at": 0}


def get_nse_equity_universe():
    now = time.time()
    if _nse_equity_universe_cache["rows"] is not None and (now - _nse_equity_universe_cache["fetched_at"]) < INSTRUMENT_MASTER_CACHE_SECONDS:
        return _nse_equity_universe_cache["rows"]

    universe = []
    seen_symbols = set()
    for row in get_instrument_master_rows():
        if row.get("exchange") != "NSE_EQ":
            continue
        instrument_key = row.get("instrument_key", "")
        isin = instrument_key.split("|")[-1] if "|" in instrument_key else ""
        if not isin.startswith(EQUITY_ISIN_PREFIXES):
            continue
        symbol = row.get("tradingsymbol", "").strip()
        if not symbol or symbol in seen_symbols:
            continue
        seen_symbols.add(symbol)
        universe.append({"symbol": symbol, "name": row.get("name", "").strip()})

    _nse_equity_universe_cache["rows"] = universe
    _nse_equity_universe_cache["fetched_at"] = now
    return universe


@app.get("/api/stocks/search")
def search_stocks():
    query = request.args.get("q", "").strip().upper()
    try:
        limit = max(1, min(50, int(request.args.get("limit", 25))))
    except ValueError:
        limit = 25

    if not query:
        return jsonify({"ok": True, "data": []})

    try:
        universe = get_nse_equity_universe()
    except Exception as error:
        app.logger.warning("Stock universe fetch failed: %s", error)
        return jsonify({"ok": False, "error": "Could not search stocks right now."}), 502

    starts_with = []
    contains = []
    for stock in universe:
        symbol = stock["symbol"]
        name = stock["name"].upper()
        if symbol.startswith(query):
            starts_with.append(stock)
        elif query in symbol or query in name:
            contains.append(stock)

    starts_with.sort(key=lambda s: (len(s["symbol"]), s["symbol"]))
    results = (starts_with + contains)[:limit]

    return jsonify({"ok": True, "count": len(results), "universe_size": len(universe), "data": results})


@app.get("/api/stocks/all")
def all_stocks():
    """Returns the full NSE equity/ETF universe (symbol + name only, no
    prices) for the market-wide heatmap. Deliberately separate from the
    price-fetching endpoints — the frontend fetches this once and then
    pulls live quotes for it in its own chunked batches."""
    try:
        universe = get_nse_equity_universe()
    except Exception as error:
        app.logger.warning("Stock universe fetch failed: %s", error)
        return jsonify({"ok": False, "error": "Could not load the stock universe right now."}), 502

    return jsonify({"ok": True, "count": len(universe), "data": universe})


def _warm_nse_equity_universe():
    # Downloading and parsing Upstox's full instrument master (several MB
    # gzipped) is the slow part of every stock-search/heatmap/F&O request
    # that hits a cold cache. Kick it off in the background as soon as the
    # process starts (including under gunicorn, since this runs at import
    # time) so a Render free-tier cold start doesn't stack that download on
    # top of the instance already waking up.
    try:
        get_nse_equity_universe()
    except Exception as error:
        app.logger.warning("Instrument master warmup failed: %s", error)


threading.Thread(target=_warm_nse_equity_universe, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
