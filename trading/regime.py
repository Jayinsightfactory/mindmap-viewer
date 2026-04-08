"""
Regime filter with up-shock / down-shock classification.

Regime states:
  NORMAL    — 정상 시장, 트레이딩 허용
  BULL      — 강한 상승 추세
  BEAR      — 하락 추세, 롱 제한
  UP_SHOCK  — 급등 쇼크 (과매수, 풀백 위험) → 신규 진입 중단
  DN_SHOCK  — 급락 쇼크 (패닉) → 신규 진입 중단 + 기존 포지션 익절/손절 강화

쇼크 감지 로직:
  1) 단기 수익률의 z-score 계산 (rolling mean/std 기준)
  2) z > shock_up_threshold → UP_SHOCK
  3) z < shock_down_threshold → DN_SHOCK
  4) 쇼크 후 cooldown_bars 동안 쇼크 상태 유지
"""
from enum import Enum
from dataclasses import dataclass
import numpy as np
import pandas as pd
from config import RegimeConfig


class RegimeState(Enum):
    NORMAL = "normal"
    BULL = "bull"
    BEAR = "bear"
    UP_SHOCK = "up_shock"
    DN_SHOCK = "dn_shock"


@dataclass
class ShockInfo:
    """Snapshot of a detected shock event."""
    bar_idx: int
    state: RegimeState
    z_score: float
    ret: float
    vol_at_shock: float        # rolling vol at shock moment


class RegimeFilter:
    def __init__(self, cfg: RegimeConfig = None):
        self.cfg = cfg or RegimeConfig()

    def classify(self, df: pd.DataFrame) -> pd.DataFrame:
        """Add regime columns to dataframe.

        Adds:
          regime        — RegimeState value string
          shock_type    — 'up_shock', 'dn_shock', or None
          shock_z       — z-score at shock detection
          in_cooldown   — True during post-shock cooldown
          vol_rolling   — rolling volatility
          trend         — 'bull', 'bear', 'neutral'
        """
        df = df.copy()
        c = df["close"]
        cfg = self.cfg

        # --- Rolling volatility (realized vol) ---
        ret = c.pct_change()
        df["vol_rolling"] = ret.rolling(cfg.vol_lookback).std() * np.sqrt(252)
        vol_q80 = df["vol_rolling"].expanding().quantile(cfg.vol_high_quantile)
        df["high_vol"] = df["vol_rolling"] > vol_q80

        # --- Trend detection ---
        fast_ma = c.rolling(cfg.trend_fast_ma).mean()
        slow_ma = c.rolling(cfg.trend_slow_ma).mean()
        df["trend"] = np.where(fast_ma > slow_ma, "bull",
                      np.where(fast_ma < slow_ma, "bear", "neutral"))

        # --- Shock detection (z-score on short-window returns) ---
        short_ret = c.pct_change(cfg.shock_window)
        roll_mean = short_ret.rolling(cfg.vol_lookback).mean()
        roll_std = short_ret.rolling(cfg.vol_lookback).std()
        z = (short_ret - roll_mean) / (roll_std + 1e-10)
        df["shock_z"] = z

        # Raw shock flags
        df["_raw_up_shock"] = z > cfg.shock_up_threshold
        df["_raw_dn_shock"] = z < cfg.shock_down_threshold

        # Apply cooldown — once shocked, stay in shock for cooldown_bars
        df["shock_type"] = None
        df["in_cooldown"] = False
        df["_cooldown_remaining"] = 0

        shock_type_arr = [None] * len(df)
        cooldown_arr = [False] * len(df)
        cooldown_rem = [0] * len(df)
        shock_vol_arr = [0.0] * len(df)

        current_shock = None
        remaining = 0
        shock_peak_vol = 0.0

        for i in range(len(df)):
            raw_up = df["_raw_up_shock"].iloc[i]
            raw_dn = df["_raw_dn_shock"].iloc[i]

            if raw_dn:
                # Down-shock takes priority (more dangerous)
                current_shock = "dn_shock"
                remaining = cfg.cooldown_bars
                shock_peak_vol = df["vol_rolling"].iloc[i]
            elif raw_up:
                current_shock = "up_shock"
                remaining = cfg.cooldown_bars
                shock_peak_vol = df["vol_rolling"].iloc[i]

            if remaining > 0:
                shock_type_arr[i] = current_shock
                cooldown_arr[i] = True
                cooldown_rem[i] = remaining
                shock_vol_arr[i] = shock_peak_vol
                remaining -= 1
            else:
                current_shock = None

        df["shock_type"] = shock_type_arr
        df["in_cooldown"] = cooldown_arr
        df["_cooldown_remaining"] = cooldown_rem
        df["shock_peak_vol"] = shock_vol_arr

        # --- Final regime ---
        def _determine_regime(row):
            if row["shock_type"] == "up_shock":
                return RegimeState.UP_SHOCK.value
            if row["shock_type"] == "dn_shock":
                return RegimeState.DN_SHOCK.value
            if row["trend"] == "bull" and not row["high_vol"]:
                return RegimeState.BULL.value
            if row["trend"] == "bear":
                return RegimeState.BEAR.value
            return RegimeState.NORMAL.value

        df["regime"] = df.apply(_determine_regime, axis=1)

        # Cleanup temp cols
        df = df.drop(columns=["_raw_up_shock", "_raw_dn_shock"])
        return df

    def get_shocks(self, df: pd.DataFrame) -> list[ShockInfo]:
        """Extract list of shock events from classified dataframe."""
        if "shock_type" not in df.columns:
            df = self.classify(df)

        shocks = []
        prev_shock = None
        for i, row in df.iterrows():
            st = row["shock_type"]
            if st and st != prev_shock:
                idx = df.index.get_loc(i) if not isinstance(i, int) else i
                shocks.append(ShockInfo(
                    bar_idx=idx,
                    state=RegimeState(st),
                    z_score=row["shock_z"],
                    ret=row.get("ret_1", 0),
                    vol_at_shock=row["vol_rolling"],
                ))
            prev_shock = st
        return shocks

    def allow_entry(self, df: pd.DataFrame, idx: int = -1) -> tuple[bool, str]:
        """Check if new entry is allowed at given bar index.

        Returns:
          (allowed: bool, reason: str)
        """
        if "regime" not in df.columns:
            df = self.classify(df)

        row = df.iloc[idx]
        regime = row["regime"]

        if regime == RegimeState.UP_SHOCK.value:
            return False, f"UP_SHOCK (z={row['shock_z']:.2f}) — 급등 후 풀백 위험, 진입 대기"
        if regime == RegimeState.DN_SHOCK.value:
            return False, f"DN_SHOCK (z={row['shock_z']:.2f}) — 급락 패닉, 진입 금지"
        if regime == RegimeState.BEAR.value:
            return False, "BEAR 추세 — 롱 진입 제한"
        return True, f"regime={regime}, 진입 허용"

    def shock_action(self, df: pd.DataFrame, idx: int = -1) -> dict:
        """Recommend position management action during shock.

        Returns dict with:
          action: 'hold' | 'tighten_stop' | 'close'
          stop_multiplier: float (1.0 = normal, 0.5 = half stop distance)
          reason: str
        """
        if "regime" not in df.columns:
            df = self.classify(df)

        row = df.iloc[idx]
        regime = row["regime"]
        cooldown_rem = row.get("_cooldown_remaining", 0)

        if regime == RegimeState.DN_SHOCK.value:
            if abs(row["shock_z"]) > 3.5:
                return {"action": "close", "stop_multiplier": 0.0,
                        "reason": "극심한 하락쇼크 — 즉시 청산"}
            return {"action": "tighten_stop", "stop_multiplier": 0.4,
                    "reason": f"하락쇼크 — 스탑 60% 축소 (cooldown {cooldown_rem}봉)"}

        if regime == RegimeState.UP_SHOCK.value:
            return {"action": "tighten_stop", "stop_multiplier": 0.6,
                    "reason": f"상승쇼크 — 스탑 40% 축소, 익절 준비 (cooldown {cooldown_rem}봉)"}

        return {"action": "hold", "stop_multiplier": 1.0, "reason": "정상 상태"}
