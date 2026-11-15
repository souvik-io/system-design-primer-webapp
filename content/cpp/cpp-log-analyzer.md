# Project A: a log analyzer in Python and C++

It is the middle of the night, and the inference service you run has an alert: users say chat responses feel slow. The dashboards are down, but every server writes one line per request to an access log, and you have the last few million lines. The questions anyone asks first are simple. How many requests failed, and with which status codes? Which endpoint is slow? What are the p50, p95 and p99 latencies? Someone will reach for Python, and that is a fine first move. This project builds that tool twice, once in Python and once in C++, and then compares them honestly.

Latency percentiles are the language of serving systems. A service-level objective for an LLM API is usually written as a percentile, such as "p99 time to first token under two seconds", because the average hides the users who wait longest. The [LLM inference chapter](/learn/llm-inference#latency-and-throughput-metrics) defines time to first token and the other serving metrics, and Project E later in this course measures percentiles again on a simulated inference server. Here you compute them from raw data, and you learn exactly what "p99" means, which turns out to need a precise definition.

This is also your first real C++ program: several source files, a library and a test executable built by CMake, checked under the sanitizers from [Chapter 5](/learn/cpp-undefined-behavior), and timed against Python. Along the way you meet a few pieces of the standard library that make text processing fast, each introduced when it is needed. Chapter 9 covers the containers and algorithms properly. The goal is not just a fast program but a correct one: the two versions must print the same report, byte for byte, so that `diff` can prove they agree.

## What the analyzer reports

The input is a text file with one request per line. The output is a short report with three parts:

1. How many lines were read, how many were malformed and skipped, and how many valid requests remain.
2. A table of status codes, in increasing order, with each code's count and share of the requests.
3. A latency table: one row for all requests together, then one row per endpoint, with the endpoints sorted so the one with the worst p99 comes first. Each row has the count, the mean, p50, p95, p99, p99.9 and the maximum, in milliseconds.

Why report percentiles at all, instead of the average? The system design course explains it in [Averages hide the slow requests](/learn/performance-and-latency#averages-hide-the-slow-requests): a mean blends fast and slow requests into a number that describes neither, while p99 tells you what the slowest 1 in 100 users experienced. The widget below lets you see it. It holds 10,000 simulated latencies, and you choose how many of them are slow and how slow they are.

```widget
latency-percentiles
```

Try these settings:

- Start at 0% slow. The mean and the median are almost the same, and p99 is only a little more than twice the median, which is the ordinary spread of fast requests.
- Set 2% slow at 20×. The median barely moves, but p99 jumps to the slow requests. The mean rises too, yet it still looks like an ordinary fast request and says nothing about the 1 user in 50 who waited most of a second.
- Set 0.5% slow at 50×. Now p99 stays fast, because fewer than 1 request in 100 is slow and the whole tail fits above the 99th percentile. This is why serving teams also watch p99.9 and the maximum, and why the analyzer reports both.

## The log format and the generator

Real access logs come in many formats. This project uses a simple one with five fields separated by single spaces:

```text
<timestamp in Unix milliseconds> <method> <endpoint> <status> <latency in microseconds>
1763164800123 POST /v1/chat/completions 200 734211
```

Every number is an integer, and that choice is deliberate. Storing the latency as a whole number of microseconds, rather than as `734.211` milliseconds, means neither analyzer has to parse a floating-point number, every value is exact, and both can print milliseconds with integer arithmetic (734211 becomes "734" and "211"), so their output cannot differ in the last decimal place. Many real systems log integer durations for the same reasons.

The generator, [`gen_logs.py`](/labs/cpp/cpp-log-analyzer/gen_logs.py), writes a log that looks like an OpenAI-compatible inference API. It uses only the standard library and a fixed seed, so two runs with the same arguments write identical files. Each endpoint has its own share of traffic and its own latency distribution, a log-normal one, which is a common rough model for request latencies because they cannot be negative and have a long right tail:

| Endpoint                    | Share of traffic | Median latency | Why it behaves this way                                               |
| --------------------------- | ---------------- | -------------- | --------------------------------------------------------------------- |
| `POST /v1/chat/completions` | 45%              | 900 ms         | generates many tokens; 0.2% wait in a queue and take ten times longer |
| `POST /v1/completions`      | 10%              | 450 ms         | generates fewer tokens                                                |
| `POST /v1/embeddings`       | 25%              | 35 ms          | one forward pass, no generation                                       |
| `POST /v1/moderations`      | 5%               | 60 ms          | a small classifier                                                    |
| `GET /v1/models`            | 5%               | 3 ms           | returns a list from memory                                            |
| `GET /health`               | 10%              | 0.8 ms         | a load balancer checking the server is alive                          |

About 97% of requests succeed with status 200. The rest are 400 (a bad request) and 429 (rate limited), which are rejected in about a millisecond, 500 and 503 (server errors), and 504 (the gateway gave up after 60 seconds). About one line in 100,000 is cut short, the way a log looks when the process writing it crashed mid-line, so the analyzers have something to reject.

```bash
python3 gen_logs.py big.log                    # 5,000,000 lines
python3 gen_logs.py small.log --lines 200000   # a small file for the sanitizer runs
```

A line is about 46 bytes on average, from 34 bytes for a health check to 51 for a chat completion, so the big file is about 230 MB. The generator is pure Python and takes a while; that is part of the lesson, because the same interpreter overhead will show up in the Python analyzer.

<!-- measure: how long gen_logs.py takes for 5,000,000 lines on the Mac, and the exact size of big.log (ls -l) -->

## Version 1: Python

Write the Python version first. It is short, it is obviously correct, and it becomes the reference the C++ version must match. The full program is [`analyze.py`](/labs/cpp/cpp-log-analyzer/analyze.py). Its heart is a parser that returns `None` for any line that breaks the rules:

```python
def number(field):
    """A field of 1 to 20 ASCII digits whose value fits in 64 bits, as an int, or None."""
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
```

The rules look fussy, and they are fussy on purpose. "Valid" must mean exactly the same thing in both languages, or the two reports will disagree on malformed lines and you will not know which one is wrong. So the rules are written to be easy to implement identically: exactly five fields split on single spaces, numbers made only of the ASCII digits 0 to 9 (`bytes.isdigit()` accepts nothing else), at most 20 digits and a value that fits in 64 bits, a status from 100 to 599, and a latency of at most one hour. The one-hour limit also guarantees that every latency fits in a 32-bit unsigned integer, which the C++ version uses to halve its memory.

The file is opened in binary mode, `open(path, "rb")`. That skips decoding every line from UTF-8, and it stops Python from translating Windows line endings, which C++ does not do either. The main loop counts statuses in a dictionary and appends each latency to two lists, one for all requests and one for the request's endpoint:

```python
with open(sys.argv[1], "rb") as f:
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
```

Think about what this costs per line, because it predicts the comparison later. Every line becomes a new `bytes` object, `split` makes five more, `int` makes up to three integer objects, and the call to `parse_line` returns a new tuple. Each step runs through the interpreter. Memory adds up too: a CPython `int` above 256 is a separate object, 28 bytes for values below 2^30, and each list slot is an 8-byte pointer to it. Both lists point to the same object, so each request costs roughly 28 + 8 + 8 = 44 bytes, or a little over 200 MB for five million requests.

### Pinning down "p99"

"The 99th percentile" sounds precise, but there are many definitions in use. Statisticians Rob Hyndman and Yanan Fan catalogued nine of them in 1996, and statistics packages disagree on which to use by default. NumPy's `np.percentile`, for example, defaults to linear interpolation: when the rank falls between two values, it returns a weighted blend of the two, which may be a latency that no request actually had.

This project uses the simplest definition, the **nearest-rank** method: p is the smallest value such that at least p% of the values are less than or equal to it. In a sorted list of n values, that is the value at 1-based rank ⌈p × n / 100⌉. For the 10 values 1 to 10, p50 is the 5th value, 5, and p95, p99 and p99.9 are all the 10th, 10. NumPy can compute the same thing with `np.percentile(a, 99, method="inverted_cdf")`, which is Hyndman and Fan's definition 1.

Both analyzers compute the rank with integers only, writing the percentile in thousandths (p99 is 990, p99.9 is 999) so that p99.9 needs no fractions:

```python
def rank_index(n, permille):
    return max((permille * n + 999) // 1000, 1) - 1   # ceil(permille * n / 1000), as a 0-based index
```

Adding 999 before the integer division rounds up, which turns floor division into a ceiling. Avoiding floating point here is not pedantry: in floating point, `0.55 * 100` is 55.00000000000001, whose ceiling is 56, so p55 of 100 values would come out one rank too high. With integers, both languages get the same rank for every n.

The mean is the integer sum divided by the count, rounded down to a whole microsecond, and the report prints milliseconds as `us // 1000`, a dot and `us % 1000` padded to three digits. Every number in the report is therefore computed and printed with integer arithmetic, which is what makes a byte-for-byte comparison possible.

## Version 2: C++, file by file

The C++ version is split the way a real project would be:

| File                                                                                                                                     | What it holds                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`src/log_parser.h`](/labs/cpp/cpp-log-analyzer/src/log_parser.h), [`src/log_parser.cpp`](/labs/cpp/cpp-log-analyzer/src/log_parser.cpp) | the `LogRecord` struct and `parse_line`, with the same rules as the Python parser |
| [`src/stats.h`](/labs/cpp/cpp-log-analyzer/src/stats.h), [`src/stats.cpp`](/labs/cpp/cpp-log-analyzer/src/stats.cpp)                     | `rank_index`, `summarize` and the integer-only number formatting                  |
| [`src/main.cpp`](/labs/cpp/cpp-log-analyzer/src/main.cpp)                                                                                | the command line, the read loop, the counting and the report                      |
| [`tests/test_core.cpp`](/labs/cpp/cpp-log-analyzer/tests/test_core.cpp)                                                                  | checks for the parser, the percentiles and the formatting                         |
| [`CMakeLists.txt`](/labs/cpp/cpp-log-analyzer/CMakeLists.txt)                                                                            | builds a library, the program and the tests                                       |

The parser and the statistics do not know about files or the command line, so they go into a library that two programs link: the analyzer and the tests. This is the same `add_library` and `target_link_libraries` pattern as Chapter 1's tinymath, with one addition, a test registered with CTest:

```cmake
add_library(loga_core src/log_parser.cpp src/stats.cpp)
target_include_directories(loga_core PUBLIC src)

add_executable(log_analyzer src/main.cpp)
target_link_libraries(log_analyzer PRIVATE loga_core)

add_executable(test_core tests/test_core.cpp)
target_link_libraries(test_core PRIVATE loga_core)

enable_testing()
add_test(NAME test_core COMMAND test_core)
```

After a build, `ctest --test-dir build` runs every registered test and reports which passed. Everything lives in a namespace, `loga`, so that names like `summarize` cannot collide with anything else. The code uses plain structs and functions only; Chapter 6 introduces classes.

### Reading lines: ifstream and getline

```cpp
std::ifstream in(path, std::ios::binary);
std::string line;   // reused for every line
while (std::getline(in, line)) {
  ++lines;
  // parse and count ...
}
```

`std::ifstream`, from `<fstream>`, is a file opened for reading, and `std::getline` reads characters into `line` up to the next `'\n'`, which it consumes and does not store. Both are buffered: the stream reads the file in large blocks and hands out lines from its buffer, so there is not one system call per line. Declaring `line` once, outside the loop, matters more than it looks. `getline` reuses the string's existing buffer, so after the first few lines no more memory is allocated. A `std::string` declared inside the loop would be created and destroyed five million times.

The `while (std::getline(...))` form stops at the end of the file, and it still returns the last line if the file does not end with a newline, just as Python's `for line in f` does. `std::ios::binary` means "no newline translation", which makes no difference on Linux and macOS but keeps the behavior identical on Windows.

### Splitting without copying: string_view

Python's `split` makes a new object for every field. C++ can avoid copying the fields at all with `std::string_view`, from `<string_view>`: a pointer to some characters and a length, which refers to text stored somewhere else. `parse_line` takes the line as a `string_view` and splits it into five more views of the same characters:

```cpp
bool parse_line(std::string_view line, LogRecord& out) {
  std::string_view fields[5];
  std::size_t count = 0;
  std::size_t start = 0;
  while (true) {
    std::size_t space = line.find(' ', start);
    if (count == 5) return false;  // a sixth field: too many
    if (space == std::string_view::npos) {
      fields[count++] = line.substr(start);
      break;
    }
    fields[count++] = line.substr(start, space - start);
    start = space + 1;
  }
  if (count != 5) return false;
  // ... check the method and endpoint, parse the three numbers, apply the ranges
}
```

`find` returns the position of the next space, or `npos` when there is none, and `substr` on a view returns another view, not a copy. Two spaces in a row produce an empty field, and a trailing space produces an empty sixth field, both rejected, exactly like `split(b" ")` in Python.

There is a catch, and it is Chapter 3's dangling pointer in a new form. A view does not own its characters. `LogRecord::endpoint` points into `line`, and the next `getline` overwrites `line`. So the per-endpoint map must own a copy of each endpoint name:

```cpp
std::unordered_map<std::string, std::vector<std::uint32_t>> by_endpoint;
std::string key;  // reused, like line
// in the loop:
key.assign(record.endpoint);
by_endpoint[key].push_back(record.latency_us);
```

If the map's key type were `std::string_view`, every key would point into `line` and silently change as the loop read more lines. It would compile without a warning, and AddressSanitizer would not necessarily catch it, because `line`'s buffer is still allocated: the keys would simply read the wrong characters. Reusing `key` with `assign` copies the characters into an existing buffer, so the copy costs no allocation, and `by_endpoint[key]` copies the string into the map only the first time an endpoint is seen.

### Parsing numbers: from_chars

There are several ways to turn `"734211"` into a number in C++, and the obvious ones are a poor fit here. `std::stoi` takes a `std::string`, not a view, so each call would need a copy; it skips leading spaces and stops quietly at the first non-digit, so `"12abc"` becomes 12; and it reports errors by throwing exceptions. A `std::stringstream` is flexible but slow, partly because it consults the locale for every number.

`std::from_chars`, from `<charconv>`, was added in C++17 for exactly this job. It reads digits from a range of characters, writes the value, and returns where it stopped and an error code. It does not allocate, does not throw, ignores the locale, and does not skip spaces. For an unsigned type it also refuses a minus sign. One helper wraps it with the same rule as Python's `number`:

```cpp
bool parse_number(std::string_view field, std::uint64_t& value) {
  if (field.empty() || field.size() > 20) return false;
  const char* end = field.data() + field.size();
  auto [ptr, ec] = std::from_chars(field.data(), end, value);
  return ec == std::errc{} && ptr == end;
}
```

`ec == std::errc{}` means a number was read and it fit in 64 bits; `ptr == end` means every character of the field was a digit. A value too large for 64 bits gives `std::errc::result_out_of_range`, which Python matches by comparing with `2**64 - 1`.

### Counting: unordered_map

```cpp
std::unordered_map<int, std::uint64_t> by_status;
++by_status[record.status];
```

`std::unordered_map`, from `<unordered_map>`, is a hash table, the closest relative of a Python `dict`. Its `operator[]` returns a reference to the value for a key, and if the key is missing it first inserts one with a zero value, which makes it behave like Python's `defaultdict(int)`. That is convenient for counting and a trap elsewhere, because merely reading `m[k]` for a missing key adds it.

An unordered map has no useful iteration order, so the report copies the status counts into a vector of pairs and sorts it before printing. A `std::map`, which keeps its keys sorted, would also work. Chapter 9 compares the containers properly.

### Percentiles: sort or nth_element

To find a percentile, you need the value that would sit at a given position if the data were sorted. Python sorts each list, which costs O(n log n) comparisons. But a report needs only four positions (and the maximum), not a fully sorted list, and the standard library has an algorithm for exactly that. `std::nth_element(first, nth, last)` rearranges the range so that the element at `nth` is the one that would be there after sorting, with nothing larger before it and nothing smaller after it. It runs in linear time on average.

```cpp
auto first = values.begin();
for (int i = 0; i < kNumPercentiles; ++i) {
  auto nth = values.begin() + static_cast<std::ptrdiff_t>(rank_index(values.size(), kPermilles[i]));
  std::nth_element(first, nth, values.end());
  s.percentile[i] = *nth;
  first = nth;
}
s.max = *std::max_element(first, values.end());
```

Because the ranks increase (p50, then p95, then p99, then p99.9), each search can start at the previous answer: after the first call, everything from `nth` onward is at least as large as the p50 value, so the p95 value is somewhere in that part. The maximum is in that part too. The analyzer also accepts `--sort`, which uses `std::sort` and reads the ranks directly, so you can measure the difference.

`rank_index` is where Chapter 5 earns its place. With `n` at five million and the permille at 999, the product `permille * n` is about 5 × 10^9, which is larger than the 2.1 billion an `int` can hold. Computed with `int`, it would be signed overflow, undefined behavior, and almost certainly a wrong rank. The code computes it with `std::uint64_t`, and one of the tests checks the five-million case.

```cpp
std::size_t rank_index(std::size_t n, std::uint64_t permille) {
  std::uint64_t rank = (permille * n + 999) / 1000;
  if (rank == 0) rank = 1;
  return static_cast<std::size_t>(rank - 1);
}
```

Latencies are stored as `std::uint32_t`, 4 bytes each, since the one-hour limit guarantees they fit. Two vectors of five million latencies, one for all requests and one split by endpoint, then need about 40 MB, plus spare capacity while the vectors grow, compared with the roughly 200 MB estimated for Python. The sum used for the mean, though, is a `std::uint64_t`: a 32-bit sum would wrap around after a few thousand one-second requests.

### The same report, byte for byte

The report is printed with `std::cout` and the manipulators from `<iomanip>`: `std::setw(12)` pads the next value to 12 characters, and `std::left` and `std::right` choose the side. These match Python's format specifications `:<24` and `:>12` exactly. Milliseconds are formatted the same way in both languages:

```cpp
std::string format_ms(std::uint64_t us) { return std::to_string(us / 1000) + "." + three_digits(us); }
```

The endpoint rows are sorted by p99, slowest first, and by name when two p99s are equal, so the order is fully determined. Both programs write their timings to standard error rather than standard output, so the timings never end up in the report files you compare.

## Build, test, and run under the sanitizers

Download the folder's files, keeping `src/` and `tests/` as subfolders, and build a Release version for timing:

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build
```

The tests use a small `CHECK` macro instead of `assert`, for a reason worth knowing. CMake's Release build passes `-DNDEBUG`, and `assert` expands to nothing when `NDEBUG` is defined, so tests written with `assert` silently test nothing in Release. `CHECK` prints the failing condition and its line and keeps going.

Now prove the C++ version agrees with the reference on the small file first, where mistakes are cheap:

```bash
python3 analyze.py small.log > small_py.txt
./build/log_analyzer small.log > small_cpp.txt
diff small_py.txt small_cpp.txt && echo identical
```

If `diff` prints anything, one of the two versions has a bug, and the differing lines tell you where to look. Then build a second copy with AddressSanitizer and UndefinedBehaviorSanitizer and run it on the small file:

```bash
cmake -S . -B build-san -DCMAKE_BUILD_TYPE=Debug -DLAB_SANITIZE=ON
cmake --build build-san
./build-san/test_core
./build-san/log_analyzer small.log > /dev/null
```

A clean run prints only the timings line. Use the small file because a sanitized Debug build is several times slower than Release, and nothing about the bugs it looks for depends on the file's size. If you change the code, for example to try a `string_view` key, run this build again before you trust the result.

<!-- measure: does diff report the small-file reports identical on the first try (if not, what differed and why); the test output; and whether the sanitizer run of log_analyzer and test_core is clean on the Mac -->

## Timing it fairly

A comparison is only worth something if it is fair, and timing programs that read a 230 MB file has several traps:

- **Build in Release.** A Debug build is unoptimized and can be many times slower. Timing it measures the compiler's settings, not your code.
- **Warm the file cache.** The first run after generating the file may read it from disk, and later runs read it from the operating system's page cache in memory. Run each program once without timing it, then time it several times and look at the spread. (To measure cold reads on purpose, Linux can drop the cache with `sync; echo 3 | sudo tee /proc/sys/vm/drop_caches`, and macOS has `sudo purge`.)
- **Time the whole program, and its phases.** The shell's `time` command reports wall-clock time (`real`) and CPU time (`user` and `sys`) for the whole run. Inside the programs, Python uses `time.perf_counter()` and C++ uses `std::chrono::steady_clock`, a clock that never jumps backwards when the system time is adjusted, to time the two phases separately: reading and parsing, then summarizing and printing.
- **Check the output every time.** A faster program that prints a different report is not faster, it is wrong. Keep the `diff`.

The C++ timer is a few lines:

```cpp
const auto t0 = std::chrono::steady_clock::now();
// ... read and parse ...
double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
```

`std::chrono::duration<double>` converts the difference to seconds as a `double`. For repeated runs with statistics, the [hyperfine](https://github.com/sharkdp/hyperfine) tool runs a command many times, with warm-up runs, and reports the mean and spread. Chapter 14 is about measuring performance properly.

## The comparison

Now run both on the big file:

```bash
time python3 analyze.py big.log > report_py.txt
time ./build/log_analyzer big.log > report_cpp.txt
time ./build/log_analyzer --sort big.log > report_sort.txt
diff report_py.txt report_cpp.txt && diff report_cpp.txt report_sort.txt && echo identical
```

Before you look at the numbers, predict them. Which phase dominates in Python, parsing or summarizing? Python's sort is written in C and is fast, but the parsing loop runs a handful of interpreted operations and allocates several objects for every one of five million lines. In C++ the parsing loop allocates nothing after the first few lines, so expect most of its time to go to reading the file and finding the spaces, and very little to the statistics. Then predict the ratio between the two total times, and write it down.

<!-- measure: on the Mac (chip, Apple clang version, Python version), three timed runs each of analyze.py, log_analyzer and log_analyzer --sort on big.log: real time from `time`, and the two phase times each program prints; whether the three reports were identical -->

Memory is worth measuring too. On macOS, `/usr/bin/time -l` prints the maximum resident set size, the peak physical memory the process used, in bytes. On Linux, `/usr/bin/time -v` prints it in kilobytes. Compare it with the estimates above: roughly 200 MB of integer objects and list slots for Python, and about 40 MB of latencies plus vector growth for C++.

<!-- measure: maximum resident set size of analyze.py and log_analyzer on big.log (/usr/bin/time -l on the Mac) -->

Finally, look at the report itself. Which endpoint has the worst p99, and is it the one with the worst mean? Is p99 of all requests dominated by one endpoint? Which status codes have the strange latencies, and why? The generator's table above says what to expect.

<!-- measure: the full report for big.log (report_cpp.txt), to show in the chapter as the sample output -->

## Stretch goals

- **Compare with NumPy.** Load the latencies into a NumPy array and compute `np.percentile(a, [50, 95, 99, 99.9], method="inverted_cdf")`. It should match the report. Then try the default method and see how far the interpolated values move.
- **Read the file in one go.** Replace `getline` with reading the whole file into one buffer and splitting it yourself, or map the file into memory with `mmap`, which Chapter 21 covers. Measure how much of the C++ time was the line-by-line reading.
- **Use two cores.** Split the file into two halves at a line boundary and parse each half in its own thread, then merge the counts and the latency vectors. Part IV teaches threads properly; this is a preview of why merging results is the hard part.
- **Bound the memory.** Storing every latency does not scale to a billion lines. Replace the vectors with a fixed set of logarithmic latency buckets, like the widget's histogram, and report approximate percentiles from the bucket counts. HdrHistogram, in the further reading below, is a well-known implementation of this idea.
- **Try PyPy or pandas.** Run `analyze.py` under PyPy, a Python implementation with a just-in-time compiler, or rewrite it with pandas' `read_csv`, and see how much of the gap each one closes.

## Check yourself

<details>
<summary>Why does the log store latency as integer microseconds instead of fractional milliseconds?</summary>

Integers are exact, so both analyzers compute identical sums, ranks and percentiles, and both can print milliseconds with integer division and remainder, which makes the two reports identical byte for byte. It also means neither program parses floating-point text, which is slower and harder to make identical across languages.

</details>

<details>
<summary>For the latencies 10, 20, 30, 40 and 1000 ms, what are the nearest-rank p50 and p99, and what is the mean?</summary>

With n = 5, p50 is at rank ⌈0.5 × 5⌉ = 3, which is 30 ms, and p99 is at rank ⌈0.99 × 5⌉ = 5, which is 1000 ms. The mean is 1100 / 5 = 220 ms, a latency that no request had, which is why the report leads with percentiles.

</details>

<details>
<summary>The C++ version stores each endpoint as a std::string_view key in an unordered_map pointing into the line buffer. What goes wrong?</summary>

The view does not own its characters. `getline` overwrites the line buffer on every iteration, so each key would point at whatever the latest line contains, and the map's keys and hashes would no longer match. The map must own a copy of each endpoint, which is why the code assigns it into a `std::string` first. AddressSanitizer may not catch it, because the buffer is still allocated memory.

</details>

<details>
<summary>Why use std::from_chars rather than std::stoi to parse the status and latency fields?</summary>

`from_chars` works directly on a range of characters, so it needs no copy of the field, never allocates or throws, ignores the locale, and reports exactly where it stopped, so the code can require that the whole field was digits. `stoi` needs a `std::string`, skips leading spaces, quietly accepts trailing junk such as `12abc`, and reports errors with exceptions.

</details>

<details>
<summary>Why is std::nth_element enough for a percentile, and what does it cost compared with sorting?</summary>

A percentile is the value at one rank of the sorted data, and `nth_element` puts exactly that value at that position, with smaller values before and larger values after, in linear time on average. A full sort costs O(n log n) and also orders everything else, which the report never uses. Because the four ranks increase, each later search can start at the previous answer.

</details>

<details>
<summary>The project's tests pass in a Debug build but would test nothing in a Release build if they used assert. Why?</summary>

CMake's Release configuration defines `NDEBUG`, and `assert` expands to nothing when `NDEBUG` is defined, so every check disappears and the tests always pass. The project's own `CHECK` macro does not depend on `NDEBUG`, so the checks run in every build type.

</details>

## Further reading

- [Sample Quantiles in Statistical Packages](https://www.jstor.org/stable/2684934), by Rob Hyndman and Yanan Fan (The American Statistician, 1996), compares nine definitions of a sample quantile and recommends one; the nearest-rank method is their definition 1.
- [numpy.percentile](https://numpy.org/doc/stable/reference/generated/numpy.percentile.html) documents NumPy's `method` argument, its linear default and the `inverted_cdf` option.
- [cppreference: std::from_chars](https://en.cppreference.com/w/cpp/utility/from_chars) describes exactly what it accepts and the errors it reports, and [std::basic_string_view](https://en.cppreference.com/w/cpp/string/basic_string_view) warns about views that outlive their characters.
- [cppreference: std::nth_element](https://en.cppreference.com/w/cpp/algorithm/nth_element) and [std::unordered_map](https://en.cppreference.com/w/cpp/container/unordered_map) give the guarantees and complexity of the two workhorses of this project.
- [The Tail at Scale](https://www.barroso.org/publications/TheTailAtScale.pdf), by Jeffrey Dean and Luiz André Barroso, explains why tail latency dominates in large services.
- [HdrHistogram](https://hdrhistogram.github.io/HdrHistogram/) is a widely used histogram for recording latencies with bounded memory and known precision, the idea behind the "bound the memory" stretch goal.
- [hyperfine](https://github.com/sharkdp/hyperfine) is a command-line benchmarking tool that handles warm-up runs and repetitions for you.
