"""
Position sizer — regime-aware Kelly + ATR sizing.

Sizing logic:
  1) Kelly fraction from model probability
  2) Scale by regime multiplier
  3) Cap by ATR-based risk budget
  4) Floor / ceiling constraints
"""
import numpy as np
import pandas as pd
from config import SwingConfig, CryptoConfig, RegimeConfig
from regime import RegimeState


class PositionSizer:
    def __init__(self, capital: float, max_positions: int = 5):
        self.capital = capital
        self.max_positions = max_positions

    def kelly_fraction(self, prob: float, win_ratio: float = 2.5) -> float:
        """Half-Kelly for safety.
        win_ratio = avg_win / avg_loss (reward:risk ratio)
        """
        if prob <= 0 or prob >= 1:
            return 0.0
        q = 1 - prob
        kelly = (prob * win_ratio - q) / win_ratio
        return max(0.0, kelly * 0.5)  # half-Kelly

    def atr_risk_size(self, price: float, atr: float,
                      risk_per_trade: float = 0.02) -> float:
        """Position size based on ATR risk budget.
        risk_per_trade: fraction of capital risked per trade (default 2%)
        """
        if atr <= 0 or price <= 0:
            return 0.0
        risk_amount = self.capital * risk_per_trade
        stop_distance = atr * 2  # 2x ATR stop
        shares = risk_amount / stop_distance
        return shares

    def regime_multiplier(self, regime: str) -> float:
        """Scale position size by regime."""
        multipliers = {
            RegimeState.BULL.value: 1.0,
            RegimeState.NORMAL.value: 0.8,
            RegimeState.BEAR.value: 0.3,
            RegimeState.UP_SHOCK.value: 0.0,   # no new entry
            RegimeState.DN_SHOCK.value: 0.0,    # no new entry
        }
        return multipliers.get(regime, 0.5)

    def compute(self, price: float, prob: float, atr: float,
                regime: str, current_positions: int = 0) -> dict:
        """Compute final position size.

        Returns:
          shares: int
          dollar_amount: float
          fraction_of_capital: float
          method: str (which constraint was binding)
        """
        if current_positions >= self.max_positions:
            return {"shares": 0, "dollar_amount": 0, "fraction_of_capital": 0,
                    "method": "max_positions_reached"}

        # Regime gate
        rmult = self.regime_multiplier(regime)
        if rmult == 0:
            return {"shares": 0, "dollar_amount": 0, "fraction_of_capital": 0,
                    "method": f"regime_blocked ({regime})"}

        # Kelly sizing
        kelly = self.kelly_fraction(prob)
        kelly_dollars = self.capital * kelly * rmult

        # ATR sizing
        atr_shares = self.atr_risk_size(price, atr)
        atr_dollars = atr_shares * price * rmult

        # Take the smaller (more conservative)
        if kelly_dollars <= atr_dollars:
            dollars = kelly_dollars
            method = "kelly"
        else:
            dollars = atr_dollars
            method = "atr_risk"

        # Per-position cap: max 25% of capital
        cap = self.capital * 0.25
        if dollars > cap:
            dollars = cap
            method = "cap_25pct"

        # Floor: minimum meaningful trade
        if dollars < self.capital * 0.02:
            return {"shares": 0, "dollar_amount": 0, "fraction_of_capital": 0,
                    "method": "below_minimum"}

        shares = int(dollars / price)
        return {
            "shares": shares,
            "dollar_amount": round(shares * price, 2),
            "fraction_of_capital": round(shares * price / self.capital, 4),
            "method": method,
            "kelly_f": round(kelly, 4),
            "regime_mult": rmult,
        }


def size_portfolio(signals_df: pd.DataFrame, capital: float,
                   max_positions: int = 5) -> pd.DataFrame:
    """Size all signals in a dataframe. Expects columns: prob, regime, atr_14, close."""
    sizer = PositionSizer(capital, max_positions)
    results = []
    pos_count = 0

    for idx, row in signals_df.iterrows():
        if row.get("signal", 0) != 1:
            continue
        sizing = sizer.compute(
            price=row["close"],
            prob=row["prob"],
            atr=row["atr_14"],
            regime=row["regime"],
            current_positions=pos_count,
        )
        if sizing["shares"] > 0:
            pos_count += 1
            results.append({
                "date": idx,
                "close": row["close"],
                "prob": row["prob"],
                "regime": row["regime"],
                **sizing,
            })

    return pd.DataFrame(results) if results else pd.DataFrame()
