"""Trading system configuration."""
from dataclasses import dataclass, field
from typing import List


@dataclass
class SwingConfig:
    """US stock daily swing trading config."""
    tickers: List[str] = field(default_factory=lambda: [
        "SPY", "QQQ", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA",
        "AMD", "AVGO", "CRM", "NFLX", "COST", "LLY",
    ])
    lookback_days: int = 504          # 2 years training window
    hold_days_min: int = 3
    hold_days_max: int = 15
    prob_threshold: float = 0.58      # XGBoost probability threshold
    stop_loss_pct: float = 0.04       # 4%
    take_profit_pct: float = 0.10     # 10%
    max_positions: int = 5
    capital: float = 100_000.0


@dataclass
class CryptoConfig:
    """4h crypto short-term trading config."""
    exchange: str = "binance"
    symbols: List[str] = field(default_factory=lambda: [
        "BTC/USDT", "ETH/USDT", "SOL/USDT", "BNB/USDT",
    ])
    timeframe: str = "4h"
    lookback_bars: int = 500
    prob_threshold: float = 0.55
    stop_loss_pct: float = 0.025      # 2.5%
    take_profit_pct: float = 0.06     # 6%
    max_positions: int = 3
    capital: float = 50_000.0
    poll_interval_sec: int = 60       # check every 60s


@dataclass
class RegimeConfig:
    """Regime filter thresholds."""
    # Volatility regime
    vol_lookback: int = 20
    vol_high_quantile: float = 0.80   # above = high-vol regime
    # Shock detection
    shock_window: int = 5
    shock_up_threshold: float = 2.5   # z-score for up-shock
    shock_down_threshold: float = -2.5
    # Cooldown after shock
    cooldown_bars: int = 6            # bars to wait after shock
    # Trend regime
    trend_fast_ma: int = 20
    trend_slow_ma: int = 60


@dataclass
class ReentryConfig:
    """Re-entry timing parameters."""
    min_cooldown_bars: int = 3        # minimum wait after exit
    max_cooldown_bars: int = 12       # max wait
    confirmation_bars: int = 2        # consecutive bars confirming re-entry
    vol_decay_ratio: float = 0.6      # vol must drop to 60% of shock peak
    momentum_flip: bool = True        # require momentum direction change


@dataclass
class DashConfig:
    """Dashboard settings."""
    host: str = "0.0.0.0"
    port: int = 8050
    debug: bool = False
    refresh_interval_sec: int = 30
