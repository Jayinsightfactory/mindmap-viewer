"""Data loading for stocks (yfinance) and crypto (ccxt)."""
import pandas as pd
import numpy as np
from datetime import datetime, timedelta


def load_stock_daily(ticker: str, lookback_days: int = 504) -> pd.DataFrame:
    """Load daily OHLCV from yfinance."""
    import yfinance as yf
    end = datetime.now()
    start = end - timedelta(days=lookback_days)
    df = yf.download(ticker, start=start.strftime("%Y-%m-%d"),
                     end=end.strftime("%Y-%m-%d"), progress=False)
    if df.empty:
        return df
    # Flatten multi-level columns if present
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)
    df.index.name = "date"
    return df[["open", "high", "low", "close", "volume"]].dropna()


def load_crypto_4h(symbol: str, exchange_id: str = "binance",
                   lookback_bars: int = 500) -> pd.DataFrame:
    """Load 4h OHLCV from CCXT."""
    import ccxt
    exchange_cls = getattr(ccxt, exchange_id)
    exchange = exchange_cls({"enableRateLimit": True})

    since_ms = exchange.milliseconds() - lookback_bars * 4 * 3600 * 1000
    ohlcv = exchange.fetch_ohlcv(symbol, timeframe="4h",
                                 since=int(since_ms), limit=lookback_bars)
    df = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["timestamp"], unit="ms")
    df = df.set_index("date")
    return df[["open", "high", "low", "close", "volume"]].dropna()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build ML features from OHLCV data."""
    from ta.momentum import RSIIndicator, StochRSIIndicator
    from ta.trend import MACD, EMAIndicator, ADXIndicator
    from ta.volatility import BollingerBands, AverageTrueRange

    c = df["close"]
    h = df["high"]
    l = df["low"]
    v = df["volume"]

    # Returns
    df["ret_1"] = c.pct_change(1)
    df["ret_3"] = c.pct_change(3)
    df["ret_5"] = c.pct_change(5)
    df["ret_10"] = c.pct_change(10)

    # Momentum
    df["rsi_14"] = RSIIndicator(c, window=14).rsi()
    stoch = StochRSIIndicator(c, window=14, smooth1=3, smooth2=3)
    df["stoch_rsi_k"] = stoch.stochrsi_k()
    macd = MACD(c)
    df["macd_diff"] = macd.macd_diff()

    # Trend
    df["ema_20"] = EMAIndicator(c, window=20).ema_indicator()
    df["ema_60"] = EMAIndicator(c, window=60).ema_indicator()
    df["ema_ratio"] = df["ema_20"] / df["ema_60"]
    adx = ADXIndicator(h, l, c, window=14)
    df["adx"] = adx.adx()
    df["di_plus"] = adx.adx_pos()
    df["di_minus"] = adx.adx_neg()

    # Volatility
    bb = BollingerBands(c, window=20, window_dev=2)
    df["bb_width"] = bb.bollinger_wband()
    df["bb_pct"] = bb.bollinger_pband()
    atr = AverageTrueRange(h, l, c, window=14)
    df["atr_14"] = atr.average_true_range()
    df["atr_pct"] = df["atr_14"] / c

    # Volume
    df["vol_ratio"] = v / v.rolling(20).mean()
    df["vol_std"] = v.rolling(20).std() / v.rolling(20).mean()

    # Price patterns
    df["high_low_range"] = (h - l) / c
    df["close_position"] = (c - l) / (h - l + 1e-10)  # where in daily range

    return df.dropna()


FEATURE_COLS = [
    "ret_1", "ret_3", "ret_5", "ret_10",
    "rsi_14", "stoch_rsi_k", "macd_diff",
    "ema_ratio", "adx", "di_plus", "di_minus",
    "bb_width", "bb_pct", "atr_pct",
    "vol_ratio", "vol_std",
    "high_low_range", "close_position",
]
