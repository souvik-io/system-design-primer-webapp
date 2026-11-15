#!/usr/bin/env python3
"""Project A: write a synthetic access log for an LLM inference server.

    python3 gen_logs.py big.log                      # 5,000,000 lines, about 230 MB
    python3 gen_logs.py small.log --lines 200000     # a small file for sanitizer runs

Each line has five fields separated by single spaces:

    <timestamp in Unix milliseconds> <method> <endpoint> <status> <latency in microseconds>
    1763164800123 POST /v1/chat/completions 200 734211

The output depends only on --lines and --seed, so two runs with the same arguments write identical files.
Standard library only; it needs Python 3.8 or newer.
"""

import argparse
import bisect
import math
import random

# (method, endpoint, share of traffic, median latency in ms, spread of the log-normal distribution)
ENDPOINTS = [
    ("POST", "/v1/chat/completions", 0.45, 900.0, 0.8),
    ("POST", "/v1/completions", 0.10, 450.0, 0.7),
    ("POST", "/v1/embeddings", 0.25, 35.0, 0.5),
    ("GET", "/v1/models", 0.05, 3.0, 0.4),
    ("GET", "/health", 0.10, 0.8, 0.3),
    ("POST", "/v1/moderations", 0.05, 60.0, 0.5),
]

# (status code, share of requests). Most succeed; a few are rejected, rate limited, fail or time out.
STATUSES = [(200, 0.970), (400, 0.010), (429, 0.012), (500, 0.004), (503, 0.002), (504, 0.002)]

MALFORMED_SHARE = 0.00001  # about 1 line in 100,000 is damaged, so the analyzers have something to skip
SLOW_SHARE = 0.002  # 0.2% of successful chat requests wait in a queue and take ten times longer
GATEWAY_TIMEOUT_MS = 60_000.0


def cumulative(weights):
    """Running totals, so that bisect on a uniform random number picks an item with the given weights."""
    total, out = 0.0, []
    for w in weights:
        total += w
        out.append(total)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="where to write the log")
    ap.add_argument("--lines", type=int, default=5_000_000, help="number of lines (default 5,000,000)")
    ap.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    endpoint_cdf = cumulative(e[2] for e in ENDPOINTS)
    status_cdf = cumulative(s[1] for s in STATUSES)
    timestamp = 1_763_164_800_000  # 15 November 2025, 00:00 UTC, in milliseconds

    with open(args.path, "w", encoding="ascii", newline="\n") as f:
        chunk = []
        for _ in range(args.lines):
            timestamp += rng.randrange(0, 3)  # a request every millisecond or so
            method, endpoint, _, median_ms, sigma = ENDPOINTS[
                min(bisect.bisect(endpoint_cdf, rng.random() * endpoint_cdf[-1]), len(ENDPOINTS) - 1)
            ]
            status = STATUSES[min(bisect.bisect(status_cdf, rng.random() * status_cdf[-1]), len(STATUSES) - 1)][0]

            if status == 504:
                latency_ms = GATEWAY_TIMEOUT_MS + rng.uniform(0.0, 50.0)  # the gateway gave up after 60 s
            elif status in (400, 429):
                latency_ms = rng.lognormvariate(math.log(1.0), 0.5)  # rejected before reaching the model
            else:
                latency_ms = rng.lognormvariate(math.log(median_ms), sigma)
                if endpoint == "/v1/chat/completions" and rng.random() < SLOW_SHARE:
                    latency_ms *= 10.0
            latency_us = max(1, int(latency_ms * 1000.0))

            line = f"{timestamp} {method} {endpoint} {status} {latency_us}\n"
            if rng.random() < MALFORMED_SHARE:
                # Cut the line short, as a writer that crashed mid-line would leave it. The cut comes before the
                # last space, so the damaged line always has fewer than five fields and both analyzers reject it.
                line = line[: rng.randrange(1, line.rfind(" "))] + "\n"
            chunk.append(line)

            if len(chunk) == 100_000:
                f.write("".join(chunk))
                chunk.clear()
        f.write("".join(chunk))


if __name__ == "__main__":
    main()
