import os
import time
import re
import csv
import io
import json
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

from flask import Flask, jsonify, request
from flask_cors import CORS
from google import genai
import requests

app = Flask(__name__)
CORS(app)

APP_STARTED_AT = time.time()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
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
    "5m": ("minutes", 5),
    "15m": ("minutes", 15),
    "1h": ("hours", 1),
    "1d": ("days", 1),
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


def now_utc():
    return datetime.now(timezone.utc).isoformat()


# ===================== Upstox live data + indicators =====================

CHART_HISTORY_DAYS = {
    "5m": 20,
    "15m": 40,
    "1h": 90,
    "1d": 500,
}


def fetch_upstox_candles(instrument_key, unit, interval, chart_history_days=None):
    """Fetches a multi-day candle history (for proper chart depth/scroll) plus
    today's intraday candles, merged into one chronological series. Falls
    back gracefully if either piece is unavailable. Raises only if BOTH the
    historical and intraday fetches fail."""
    if not UPSTOX_ACCESS_TOKEN:
        raise RuntimeError("Upstox access token is not configured on the server.")

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
    from datetime import timedelta

    encoded_instrument_key = quote(instrument_key, safe="")
    to_date = datetime.now(timezone.utc).date()
    from_date = to_date - timedelta(days=days_back)
    url = (
        f"https://api.upstox.com/v3/historical-candle/{encoded_instrument_key}/{unit}/{interval}"
        f"/{to_date.isoformat()}/{from_date.isoformat()}"
    )
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    response = requests.get(url, headers=headers, timeout=25)
    if not response.ok:
        raise RuntimeError(f"Upstox historical window request failed: status={response.status_code}")

    payload = response.json()
    raw_candles = (payload.get("data") or {}).get("candles") or []
    return _parse_upstox_candles(raw_candles)


def _fetch_upstox_intraday(instrument_key, unit, interval):
    encoded_instrument_key = quote(instrument_key, safe="")
    url = f"https://api.upstox.com/v3/historical-candle/intraday/{encoded_instrument_key}/{unit}/{interval}"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    response = requests.get(url, headers=headers, timeout=20)
    if not response.ok:
        raise RuntimeError(f"Upstox candle request failed: status={response.status_code}")

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

    response = requests.get(url, headers=headers, timeout=20)
    if not response.ok:
        raise RuntimeError(f"Upstox historical candle request failed: status={response.status_code}")

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


def get_real_market_snapshot(market_key):
    """Builds a market dict with the SAME shape as DEMO_MARKETS entries, but
    populated from real Upstox data, so calculate_confirmation_engine can
    consume it unchanged. Raises on failure so the caller can fall back."""
    market = UPSTOX_MARKETS[market_key]
    cached = _live_snapshot_cache.get(market_key)
    if cached and time.time() - cached["fetched_at"] < LIVE_SNAPSHOT_CACHE_SECONDS:
        return cached["data"]

    candles_5m = fetch_upstox_candles(market["instrument_key"], "minutes", 5, chart_history_days=5)
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

    latest_candle_date = candles_5m[-1]["time"][:10]
    today_ist = (datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)).date().isoformat()
    session_status = "live" if latest_candle_date == today_ist else "closed"

    snapshot = {
        "name": market["name"],
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
        "data_source": "upstox_live",
        "session_status": session_status,
        "bollinger_bands": calculate_bollinger_bands(closes),
        "supertrend": calculate_supertrend(candles_5m),
        "adx": calculate_adx(candles_5m),
        "stochastic": calculate_stochastic(candles_5m),
        "pivot_points": calculate_pivot_points(candles_5m),
    }
    _live_snapshot_cache[market_key] = {"data": snapshot, "fetched_at": time.time()}
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

    decision = "WAIT"
    decision_reason = "Confirmations are mixed. Wait for a clearer aligned setup."

    if weighted_score >= 5 and bullish_count >= 4 and price < resistance:
        decision = "BUY SETUP"
        decision_reason = "Bullish confluence with a defined risk plan."
    elif weighted_score <= -5 and bearish_count >= 4 and price > support:
        decision = "SELL SETUP"
        decision_reason = "Bearish confluence with a defined risk plan."
    elif weighted_score >= 3:
        decision = "WAIT FOR BUY CONFIRMATION"
        decision_reason = "Bullish factors exist, but wait for stronger alignment or a clean breakout."
    elif weighted_score <= -3:
        decision = "WAIT FOR SELL CONFIRMATION"
        decision_reason = "Bearish factors exist, but wait for stronger alignment or a clean breakdown."

    risk_buffer = atr * 0.35

    if decision in {"BUY SETUP", "WAIT FOR BUY CONFIRMATION"}:
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
    elif decision in {"SELL SETUP", "WAIT FOR SELL CONFIRMATION"}:
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

# Not the complete official 50/12 — Upstox does not provide an index
# constituents API, so this is a well-known, stable subset of large,
# long-standing constituents used only to find a representative "biggest
# mover" for each index. Reviewed twice a year by NSE (Mar/Sep), so this
# list can drift slightly out of date over time.
NIFTY50_TOP_MOVER_SYMBOLS = [
    "RELIANCE", "TCS", "INFY", "HDFCBANK", "ICICIBANK", "SBIN",
    "BHARTIARTL", "ITC", "KOTAKBANK", "LT", "HINDUNILVR", "TITAN",
    "SUNPHARMA", "BAJFINANCE", "MARUTI", "ASIANPAINT", "AXISBANK",
    "NTPC", "ULTRACEMCO", "WIPRO", "ADANIENT", "TATAMOTORS",
    "TATASTEEL", "POWERGRID", "ONGC",
]

BANKNIFTY_TOP_MOVER_SYMBOLS = [
    "HDFCBANK", "ICICIBANK", "SBIN", "KOTAKBANK", "AXISBANK",
    "INDUSINDBK", "BANKBARODA", "PNB", "FEDERALBNK", "IDFCFIRSTB",
    "AUBANK", "CANBK",
]

_instrument_key_cache = {}
_watchlist_cache = {}
WATCHLIST_CACHE_SECONDS = 20
TOP_MOVER_CACHE_SECONDS = 30
_top_mover_cache = {}


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


@app.get("/api/top-mover/<index_key>")
def top_mover(index_key):
    index_key = index_key.lower().strip()
    symbol_lists = {"nifty": NIFTY50_TOP_MOVER_SYMBOLS, "banknifty": BANKNIFTY_TOP_MOVER_SYMBOLS}

    if index_key not in symbol_lists:
        return jsonify({"ok": False, "error": "Unknown index. Use: nifty or banknifty."}), 404

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Upstox access token is not configured on the server."}), 503

    cached = _top_mover_cache.get(index_key)
    if cached and time.time() - cached["fetched_at"] < TOP_MOVER_CACHE_SECONDS:
        return jsonify({"ok": True, "data": cached["data"]})

    try:
        quotes = fetch_quotes_with_change(symbol_lists[index_key])
        rated = [q for q in quotes if q["change_percent"] is not None]
        if not rated:
            return jsonify({"ok": False, "error": "No quote data available right now."}), 502

        biggest_mover = max(rated, key=lambda q: abs(q["change_percent"]))
        result = {"index": index_key, "mover": biggest_mover, "updated_at": now_utc()}
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
        "source": "Upstox market data",
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
        response = requests.get(url, headers=headers, timeout=15)
        if not response.ok or "Company Name" not in response.text[:200]:
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
        _index_constituents_cache[index_name] = {"data": [], "fetched_at": time.time()}
        return []


@app.get("/api/index-constituents")
def index_constituents():
    index_name = request.args.get("index", "").strip()
    if index_name not in RRG_AVAILABLE_SYMBOLS:
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
        return jsonify({"ok": False, "error": "Upstox access token is not configured on the server."}), 503

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
    return jsonify(
        {
            "ok": True,
            "symbols": RRG_AVAILABLE_SYMBOLS,
            "default_selected": RRG_DEFAULT_SYMBOLS,
        }
    )


_rrg_quotes_cache = {"data": None, "fetched_at": 0}
RRG_QUOTES_CACHE_SECONDS = 60


@app.get("/api/rrg/quotes")
def rrg_quotes():
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Upstox access token is not configured on the server."}), 503

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
    interval = request.args.get("interval", "1d").lower().strip()
    if interval not in {"1d", "1h"}:
        return jsonify({"ok": False, "error": "Unsupported interval. Use: 1d or 1h."}), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "Upstox access token is not configured on the server."}), 503

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
        return jsonify({"ok": True, "data": data})
    except Exception as error:
        app.logger.warning("RRG build failed for %s: %s", interval, error)
        return jsonify({"ok": False, "error": "Could not build RRG data right now."}), 502


@app.get("/api/watchlist")
def watchlist():
    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {"ok": False, "error": "Upstox access token is not configured on the server."}
        ), 503

    symbols_param = request.args.get("symbols", "")
    symbols = [s.strip().upper() for s in symbols_param.split(",") if s.strip()] or DEFAULT_WATCHLIST_SYMBOLS
    cache_key = ",".join(symbols)

    cached = _watchlist_cache.get(cache_key)
    if cached and time.time() - cached["fetched_at"] < WATCHLIST_CACHE_SECONDS:
        return jsonify({"ok": True, "updated_at": cached["updated_at"], "data": cached["data"]})

    try:
        results = fetch_quotes_with_change(symbols)
        results.sort(key=lambda item: symbols.index(item["symbol"]) if item["symbol"] in symbols else 999)

        updated_at = now_utc()
        _watchlist_cache[cache_key] = {"data": results, "fetched_at": time.time(), "updated_at": updated_at}
        return jsonify({"ok": True, "updated_at": updated_at, "data": results})

    except Exception as error:
        app.logger.warning("Watchlist fetch failed: %s", error)
        return jsonify({"ok": False, "error": "Could not fetch watchlist data right now."}), 502


@app.get("/api/live/status")
def live_status():
    return jsonify(
        {
            "ok": True,
            "provider": "upstox",
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
                "error": "Unsupported timeframe. Use: 5m, 15m, 1h, or 1d.",
            }
        ), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {
                "ok": False,
                "error": "Upstox access token is not configured on the server.",
            }
        ), 503

    market = UPSTOX_MARKETS[market_key]
    unit, interval = UPSTOX_TIMEFRAMES[timeframe]

    try:
        candles = fetch_upstox_candles(
            market["instrument_key"], unit, interval,
            chart_history_days=CHART_HISTORY_DAYS.get(timeframe, 30),
        )

        if not candles:
            return jsonify(
                {
                    "ok": False,
                    "provider": "upstox",
                    "error": "No candle data is available for this instrument and timeframe.",
                }
            ), 502

        latest = candles[-1]

        return jsonify(
            {
                "ok": True,
                "provider": "upstox",
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
        )

    except requests.RequestException:
        app.logger.exception("Upstox candle request failed")

        return jsonify(
            {
                "ok": False,
                "provider": "upstox",
                "error": "Could not reach Upstox candle data right now.",
            }
        ), 502
    except Exception as error:
        app.logger.warning("Upstox candle request failed: %s", error)

        return jsonify(
            {
                "ok": False,
                "provider": "upstox",
                "error": "Upstox candle data is temporarily unavailable.",
            }
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

    allowed_timeframes = {"5m", "15m", "1h", "1d"}

    if timeframe not in allowed_timeframes:
        return jsonify(
            {
                "ok": False,
                "error": "Unsupported timeframe. Use: 5m, 15m, 1h, or 1d.",
            }
        ), 400

    if not GEMINI_API_KEY:
        return jsonify(
            {
                "ok": False,
                "error": "Gemini is not configured on the server.",
            }
        ), 503

    market_data, is_live = get_market_snapshot_with_fallback(market_key)
    analysis = calculate_confirmation_engine(market_data)

    prompt = f"""
You are a cautious Indian index-market research assistant. This is strictly for educational research
and paper trading only; do not give financial advice, guarantee an outcome, or tell the user to place
a real trade.

Review the following technical-engine snapshot for {analysis["market"]} on the {timeframe} timeframe.
Data source: {"live Upstox market data" if is_live else "demo/reference data (live feed unavailable right now)"}.

Current price: {analysis["price"]}
Open / high / low: {analysis["open"]} / {analysis["high"]} / {analysis["low"]}
Decision: {analysis["decision"]["label"]}
Decision reason: {analysis["decision"]["reason"]}
Weighted score: {analysis["decision"]["weighted_score"]} of {analysis["decision"]["max_score"]}
RSI 14: {analysis["indicators"]["rsi_14"]}
EMA 9 / EMA 21 / EMA 50: {analysis["indicators"]["ema_9"]} / {analysis["indicators"]["ema_21"]} / {analysis["indicators"]["ema_50"]}
VWAP: {analysis["indicators"]["vwap"]}
MACD histogram: {analysis["indicators"]["macd_histogram"]}
Volume ratio: {analysis["indicators"]["volume_ratio"]}
Support / resistance: {analysis["levels"]["support"]} / {analysis["levels"]["resistance"]}
Entry zone: {analysis["trade_plan"]["entry_zone"]["from"]} to {analysis["trade_plan"]["entry_zone"]["to"]}
Entry condition: {analysis["trade_plan"]["entry_zone"]["condition"]}
Stop loss: {analysis["trade_plan"]["stop_loss"]}
Target 1 / Target 2: {analysis["trade_plan"]["target_1"]} / {analysis["trade_plan"]["target_2"]}
Exit rule: {analysis["trade_plan"]["exit_rule"]}

Write a concise Hinglish review with exactly these five headings:
1. Bias
2. Confirmation
3. Levels
4. Invalidation
5. Risk note

Rules:
- Write your own independent analysis in your own words. Do not copy the "Decision reason" text above verbatim — you may agree with it, but explain why in your own phrasing, citing the specific numbers.
- Mention the data source (live vs demo) if relevant.
- Do not invent live news, option-chain data, candle patterns, or unprovided indicators.
- Do not suggest real-money trading or use imperative execution language.
- Keep the reply below 220 words.
"""

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )

        review_text = (response.text or "").strip()

        if not review_text:
            return jsonify(
                {
                    "ok": False,
                    "error": "Gemini returned an empty review. Please try again.",
                }
            ), 502

        return jsonify(
            {
                "ok": True,
                "market": analysis["market"],
                "timeframe": timeframe,
                "generated_at": now_utc(),
                "valid_for_seconds": 300,
                "review": review_text,
                "disclaimer": "Research and paper-trading only. Not financial advice and not a live-market recommendation.",
            }
        )

    except Exception:
        app.logger.exception("Gemini review request failed")

        return jsonify(
            {
                "ok": False,
                "error": "Gemini review is temporarily unavailable. Please try again later.",
            }
        ), 502


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

    if not GEMINI_API_KEY:
        return jsonify(
            {
                "ok": False,
                "error": "Gemini is not configured on the server.",
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
        client = genai.Client(api_key=GEMINI_API_KEY)

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )

        coaching_text = (response.text or "").strip()

        if not coaching_text:
            return jsonify(
                {
                    "ok": False,
                    "error": "Gemini returned an empty coaching note. Please try again.",
                }
            ), 502

        return jsonify(
            {
                "ok": True,
                "generated_at": now_utc(),
                "coaching": coaching_text,
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

    except Exception:
        app.logger.exception("AI trade coach request failed")

        return jsonify(
            {
                "ok": False,
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


def fetch_india_market_news():
    import xml.etree.ElementTree as element_tree

    collected, seen_urls = [], set()
    now = datetime.now(timezone.utc)
    keywords = (
        "nifty", "sensex", "bse", "nse", "rupee", "rbi", "sebi", "ipo", "share", "stock",
        "market", "index", "earnings", "results", "f&o", "futures", "options", "fii", "dii",
        "bank nifty", "commodity", "gold", "crude",
    )
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
                if not any(keyword in searchable for keyword in keywords):
                    continue

                if published_at and (now - published_at).total_seconds() > 2 * 24 * 60 * 60:
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
    for item in collected[:40]:
        item.pop("_published_at", None)
        result.append(item)
    return result


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

    if not GEMINI_API_KEY:
        return jsonify({"ok": False, "error": "Gemini is not configured on the server."}), 503

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
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        result = parse_json_from_model(response.text)

        headline_hi = str(result.get("headline_hi", "")).strip()
        summary_hi = str(result.get("summary_hi", "")).strip()

        if not headline_hi:
            return jsonify(
                {
                    "ok": False,
                    "error": "Gemini returned an empty Hindi translation. Please try again.",
                }
            ), 502

        return jsonify(
            {
                "ok": True,
                "headline_hi": headline_hi,
                "summary_hi": summary_hi,
                "provider": "GEMINI",
            }
        )

    except ValueError:
        return jsonify(
            {
                "ok": False,
                "error": "Gemini returned an unexpected response. Please try again.",
            }
        ), 502
    except Exception:
        app.logger.exception("Hindi news translation failed")

        return jsonify(
            {
                "ok": False,
                "error": "Hindi translation is temporarily unavailable. Please try again later.",
            }
        ), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
