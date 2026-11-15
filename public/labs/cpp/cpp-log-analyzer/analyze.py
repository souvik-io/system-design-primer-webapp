#!/usr/bin/env python3
"""Project A: the reference log analyzer, in pure Python.

    python3 analyze.py big.log > report_py.txt
    time python3 analyze.py big.log > report_py.txt

It prints the same report, byte for byte, as the C++ version (build/log_analyzer), so `diff` can compare them.
Timings go to stderr, so they do not end up in the report. Standard library only.

A valid line has exactly five fields separated by single spaces:
    <timestamp ms> <method> <endpoint> <status> <latency us>
The timestamp, status and latency must be 1 to 20 ASCII digits whose value fits in 64 bits; the status must be
100 to 599; the latency must be at most one hour; the method must not be empty and the endpoint must start with "/".
Anything else is counted as malformed and skipped. The C++ parser in src/log_parser.cpp applies exactly the same rules.
"""

import sys
import time

MAX_LATENCY_US = 3_600_000_000  # one hour; larger values are treated as damage, and fit in a 32-bit unsigned int
MAX_UINT64 = 2**64 - 1  # the C++ version parses numbers into 64-bit unsigned integers
PERMILLES = (500, 950, 990, 999)  # p50, p95, p99 and p99.9, in thousandths so the arithmetic stays in integers


def number(field):
    """A field of 1 to 20 ASCII digits whose value fits in 64 bits, as an int, or None. bytes.isdigit() accepts
    only the ASCII digits 0-9 and is False for an empty field. The C++ version applies the same rule."""
    if not field.isdigit() or len(field) > 20:
        return None
    value = int(field)
    return value if value <= MAX_UINT64 else None


def parse_line(line):
    """Return (status, endpoint, latency_us) for a valid line of bytes, or None."""
    if line.endswith(b"\n"):
        line = line[:-1]
    parts = line.split(b" ")
    if len(parts) != 5:
        return None
    timestamp, method, endpoint, status, latency = parts
    if not method or not endpoint.startswith(b"/"):
        return None
    timestamp, status, latency = number(timestamp), number(status), number(latency)
    if timestamp is None or status is None or latency is None:
        return None
    if not 100 <= status <= 599 or latency > MAX_LATENCY_US:
        return None
    return status, endpoint, latency


def rank_index(n, permille):
    """Nearest-rank percentile: the 0-based index of the smallest value with at least permille/1000 of the
    values at or below it, in a sorted list of n values. ceil(permille * n / 1000), computed with integers."""
    return max((permille * n + 999) // 1000, 1) - 1


def summarize(values):
    """count, mean (rounded down), p50, p95, p99, p99.9 and max, all in microseconds. Sorts values in place."""
    values.sort()
    n = len(values)
    return [n, sum(values) // n] + [values[rank_index(n, q)] for q in PERMILLES] + [values[-1]]


def ms(us):
    """Microseconds as milliseconds with three decimals, using integer arithmetic only."""
    return f"{us // 1000}.{us % 1000:03d}"


def share(count, total):
    """count as a percentage of total with three decimals, rounded down, using integer arithmetic only."""
    v = count * 100_000 // total
    return f"{v // 1000}.{v % 1000:03d}%"


def main():
    if len(sys.argv) != 2:
        sys.stderr.write("usage: python3 analyze.py <log file>\n")
        return 1

    t0 = time.perf_counter()
    lines = malformed = 0
    by_status = {}
    by_endpoint = {}
    all_latencies = []
    with open(sys.argv[1], "rb") as f:  # binary: no decoding, and no newline translation
        for line in f:
            lines += 1
            record = parse_line(line)
            if record is None:
                malformed += 1
                continue
            status, endpoint, latency = record
            by_status[status] = by_status.get(status, 0) + 1
            all_latencies.append(latency)
            by_endpoint.setdefault(endpoint, []).append(latency)
    t1 = time.perf_counter()

    requests = len(all_latencies)
    out = [f"lines read: {lines}", f"malformed lines: {malformed}", f"valid requests: {requests}"]
    if requests > 0:
        out.append("")
        out.append(f"{'status':<8}{'count':>12}{'share':>10}")
        for status in sorted(by_status):
            out.append(f"{status:<8}{by_status[status]:>12}{share(by_status[status], requests):>10}")

        rows = [(b"(all)", summarize(all_latencies))]
        endpoint_rows = [(name, summarize(values)) for name, values in by_endpoint.items()]
        endpoint_rows.sort(key=lambda row: (-row[1][4], row[0]))  # slowest p99 first, then by name
        rows += endpoint_rows

        out.append("")
        out.append("latency in ms, nearest-rank percentiles, endpoints by p99, slowest first")
        out.append(f"{'endpoint':<24}{'count':>10}{'mean':>12}{'p50':>12}{'p95':>12}{'p99':>12}{'p99.9':>12}{'max':>12}")
        for name, s in rows:
            # latin-1 maps each byte to one character, so any bytes in the endpoint are written back unchanged.
            cells = "".join(f"{ms(v):>12}" for v in s[1:])
            out.append(f"{name.decode('latin-1'):<24}{s[0]:>10}{cells}")
    t2 = time.perf_counter()

    sys.stdout.buffer.write(("\n".join(out) + "\n").encode("latin-1"))
    sys.stderr.write(f"read and parse: {t1 - t0:.3f} s, summarize and format: {t2 - t1:.3f} s\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
