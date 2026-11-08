# budget.py: the spending ledger modal_run.py and gcp_run.py check before every run.
#
# The goal is to run every lab inside free credit. Neither Modal nor Google Cloud lets a command read the credit
# left on an account, so this file keeps its own account: the credits you have (credits.json, which you write once
# and update when a new credit arrives) minus what the launchers logged (modal_costs.jsonl and gcp_costs.jsonl).
# The launchers refuse to start a run whose worst-case cost would go past what is left, unless you pass
# --allow-over-budget.
#
# It is an estimate. It knows only what the launchers ran, so anything else on the same accounts (another
# project on the same Google billing account, say) is invisible to it. Keep a billing alert as the real backstop.
#
#   python budget.py          # print what is left on both platforms
import json
import time
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
CREDITS = HERE / "credits.json"
EXAMPLE = HERE / "credits.example.json"


def load_credits() -> dict:
    path = CREDITS if CREDITS.exists() else EXAMPLE
    return json.loads(path.read_text())


def _log(name: str) -> list[dict]:
    path = HERE / name
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _month_start(yyyy_mm: str) -> date:
    y, m = map(int, yyyy_mm.split("-")[:2])
    return date(y, m, 1)


# ---- Modal: a monthly allowance that does not carry over --------------------------------------------------------

def modal_spent_this_month(today: date | None = None) -> float:
    month = (today or date.today()).strftime("%Y-%m")
    return sum(r.get("usd") or 0.0 for r in _log("modal_costs.jsonl") if r["time"].startswith(month))


def modal_left(today: date | None = None) -> tuple[float, float]:
    cap = load_credits().get("modal_monthly_cap_usd", 25.0)
    return cap, cap - modal_spent_this_month(today)


# ---- Google Cloud: credits that each expire on their own date ---------------------------------------------------

def gcp_left(today: date | None = None) -> dict:
    """Spend each logged run against the credits that expire soonest, then add up what is left on unexpired ones.

    Google's own order of applying credits may differ, so treat the per-credit split as approximate; the total is
    what matters. A credit is treated as gone from the first day of the month it expires in, which errs on the
    side of caution.
    """
    today = today or date.today()
    cfg = load_credits()
    rate = cfg.get("usd_to_inr", 95.5)
    credits = sorted(({"amount": c["amount_inr"], "expires": _month_start(c["expires"])} for c in cfg.get("gcp_credits", [])),
                     key=lambda c: c["expires"])
    left = [c["amount"] for c in credits]
    runs = [(date.min, cfg.get("gcp_spent_before_ledger_inr", 0.0))]      # spending from before this ledger existed
    runs += [(date.fromisoformat(r["time"][:10]), (r.get("usd") or 0.0) * rate) for r in _log("gcp_costs.jsonl")]
    overflow = 0.0                                                         # spending no credit covered: it reached the card
    for when, cost in runs:
        for i, c in enumerate(credits):
            if cost <= 0:
                break
            if c["expires"] > when and left[i] > 0:
                take = min(left[i], cost)
                left[i] -= take
                cost -= take
        overflow += max(cost, 0.0)
    live = [(c["expires"], l) for c, l in zip(credits, left) if c["expires"] > today]
    balance = sum(l for _, l in live) - overflow
    upcoming = [(when, l) for when, l in live if l > 0]
    updated = time.strftime("%Y-%m-%d", time.localtime(CREDITS.stat().st_mtime)) if CREDITS.exists() else None
    return {"balance_inr": balance, "balance_usd": balance / rate, "rate": rate, "next_expiry": upcoming[0] if upcoming else None,
            "from_example": not CREDITS.exists(), "credits_file_updated": updated}


def gcp_summary() -> str:
    g = gcp_left()
    lines = [f"Google Cloud credit left: about ₹{g['balance_inr']:,.0f} (${g['balance_usd']:.2f})"]
    if g["next_expiry"]:
        when, amount = g["next_expiry"]
        lines.append(f"  next to expire: ₹{amount:,.0f} unused, gone from {when:%B %Y}; spend it first")
    if g["from_example"]:
        lines.append("  (read from credits.example.json; copy it to credits.json and enter your own credits)")
    elif g["credits_file_updated"] and (date.today() - date.fromisoformat(g["credits_file_updated"])).days > 35:
        lines.append(f"  credits.json last changed {g['credits_file_updated']}: add any monthly credit that has arrived since")
    return "\n".join(lines)


def modal_summary() -> str:
    cap, left = modal_left()
    return f"Modal this month: ${cap - left:.2f} of ${cap:.2f} used (GPU time only), ${left:.2f} left"


def check(platform: str, worst_case_usd: float, allow_over: bool) -> None:
    """Print the balance and stop the run if its worst-case cost does not fit."""
    if platform == "modal":
        print("[budget] " + modal_summary())
        _, left = modal_left()
    else:
        print("[budget] " + gcp_summary().replace("\n", "\n[budget] "))
        left = gcp_left()["balance_usd"]
    print(f"[budget] this run costs at most about ${worst_case_usd:.2f}")
    if worst_case_usd > left and not allow_over:
        raise SystemExit(f"[budget] stopped: ${worst_case_usd:.2f} worst case is more than the ${left:.2f} left. "
                         "Shorten the time limit, use the other platform, or pass --allow-over-budget.")


if __name__ == "__main__":
    print(modal_summary())
    print(gcp_summary())
