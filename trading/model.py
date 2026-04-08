"""XGBoost signal model — train / predict / save / load."""
import os
import json
import numpy as np
import pandas as pd
from xgboost import XGBClassifier
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from data_loader import FEATURE_COLS


def _make_labels(df: pd.DataFrame, horizon: int = 5,
                 target_ret: float = 0.03) -> pd.Series:
    """Binary label: 1 if forward return > target within horizon."""
    fwd = df["close"].shift(-horizon) / df["close"] - 1
    return (fwd > target_ret).astype(int)


def train_model(df: pd.DataFrame, horizon: int = 5,
                target_ret: float = 0.03,
                n_splits: int = 4) -> dict:
    """Train XGBoost with time-series CV. Returns model + metrics."""
    df = df.copy()
    df["label"] = _make_labels(df, horizon, target_ret)
    df = df.dropna(subset=["label"] + FEATURE_COLS)

    X = df[FEATURE_COLS].values
    y = df["label"].values

    tscv = TimeSeriesSplit(n_splits=n_splits)
    metrics_list = []

    model = XGBClassifier(
        n_estimators=300,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=0.1,
        reg_lambda=1.0,
        use_label_encoder=False,
        eval_metric="logloss",
        random_state=42,
    )

    for train_idx, val_idx in tscv.split(X):
        X_tr, X_val = X[train_idx], X[val_idx]
        y_tr, y_val = y[train_idx], y[val_idx]
        model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)], verbose=False)
        preds = model.predict(X_val)
        proba = model.predict_proba(X_val)[:, 1]
        metrics_list.append({
            "accuracy": accuracy_score(y_val, preds),
            "f1": f1_score(y_val, preds, zero_division=0),
            "auc": roc_auc_score(y_val, proba) if len(set(y_val)) > 1 else 0.0,
        })

    # Final fit on all data
    model.fit(X, y, verbose=False)

    avg_metrics = {k: np.mean([m[k] for m in metrics_list]) for k in metrics_list[0]}
    return {"model": model, "metrics": avg_metrics, "feature_cols": FEATURE_COLS}


def predict_signals(model: XGBClassifier, df: pd.DataFrame,
                    threshold: float = 0.58) -> pd.DataFrame:
    """Generate buy signals from model predictions."""
    df = df.copy()
    X = df[FEATURE_COLS].values
    proba = model.predict_proba(X)[:, 1]
    df["prob"] = proba
    df["signal"] = (proba >= threshold).astype(int)
    return df


def save_model(result: dict, path: str = "models"):
    """Save model + metadata."""
    os.makedirs(path, exist_ok=True)
    result["model"].save_model(os.path.join(path, "xgb_model.json"))
    meta = {"metrics": result["metrics"], "feature_cols": result["feature_cols"]}
    with open(os.path.join(path, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)


def load_model(path: str = "models") -> dict:
    """Load saved model + metadata."""
    model = XGBClassifier()
    model.load_model(os.path.join(path, "xgb_model.json"))
    with open(os.path.join(path, "meta.json")) as f:
        meta = json.load(f)
    return {"model": model, **meta}
