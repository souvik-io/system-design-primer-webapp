# Design a hash map

A **hash map** (also called a hash table) stores key-value pairs and finds the value for a key in about the same time whether it holds ten pairs or ten million. A contacts app that maps a name to a phone number, a web server that maps a session ID to the logged-in user, and a compiler that maps variable names to their types all use one. Python's `dict` and Java's `HashMap` are hash maps, and so are the indexes inside many databases and caches.

The trick is a **hash function**: a function that turns a key into a number, which the map uses to pick one of a fixed set of slots called **buckets**. With 10 buckets and the hash function "key modulo 10", the key 42 goes in bucket 2 and the key 1,007 goes in bucket 7. To look a key up, the map recomputes the same bucket number and searches only that bucket. Two keys that land in the same bucket, such as 42 and 52, are a **collision**, and every hash map needs a rule for handling them.

This chapter is an **object-oriented design** question. In this kind of interview question you're asked to model something in code: you clarify the scope with the interviewer, name the classes and say what each one is responsible for, write working code, and then discuss how the design would change under new requirements. The data structure is small, so most of the interview's value is in how well you explain its trade-offs.

## Constraints and assumptions

Ask these questions before writing any code. Each answer removes a whole category of work, so the interviewer learns that you can scope a problem.

- **For simplicity, are the keys integers only?** Yes. *Why it matters:* integer keys let the hash function be plain arithmetic (`key % number_of_buckets`). Strings or objects would need a real hash function, which is a follow-up below.
- **For collision resolution, can we use chaining?** Yes. **Chaining** (also called separate chaining) means each bucket holds a list of every entry whose key lands there. *Why it matters:* the other main approach, open addressing, has trickier deletion. Agreeing on chaining up front keeps the code short.
- **Do we have to worry about load factors?** No. The **load factor** is the number of entries divided by the number of buckets. *Why it matters:* without a load factor limit the bucket count stays fixed, so we skip resizing. We'll discuss resizing as an extension, because it's the first thing an interviewer usually asks next.
- **Can we assume inputs are valid, or do we have to validate them?** Assume they're valid. *Why it matters:* we don't need to check that every key really is an integer.
- **Can we assume this fits in memory?** Yes. *Why it matters:* a single in-process structure is enough. Spreading keys across machines is a different problem, covered under extensions.

Two more answers we assume, since they decide the code's behavior:

- **What should `set` do when the key already exists?** Replace the old value. A key appears in the map at most once.
- **What should `get` and `remove` do when the key is missing?** Raise `KeyError`, the same error Python's `dict` raises. Returning `None` would make "missing" indistinguishable from "stored `None`".

## Class design

The design needs only two classes. The map owns a list of buckets, each bucket is a plain Python list, and each list holds entries.

```diagram
title: HashMap owns its buckets, and each bucket holds zero or more Entry objects
[map] HashMap\nset, get, remove @ 0,0
[buckets] Buckets\nlist of lists @ 1.5,0
[entry] Entry\nkey, value @ 3,0
map -> buckets : owns a fixed number
buckets -> entry : holds 0 or more
```

- **`Entry`** holds one key and its value. It has no behavior; it exists so a bucket can store the key next to the value and tell colliding keys apart.
- **`HashMap`** owns the buckets and is responsible for everything else: hashing a key to a bucket, adding or updating an entry, finding one, and removing one.

A bucket doesn't get its own class. A Python list already does everything a bucket needs (append, scan, delete), and a class that only wrapped a list would add code without adding meaning. Say this out loud in an interview: choosing *not* to create a class is a design decision too.

## Solution

```python
from dataclasses import dataclass
from typing import Any


@dataclass
class Entry:
    """One key-value pair stored in a bucket."""

    key: int
    value: Any


class HashMap:
    """A fixed-size hash map with integer keys and separate chaining."""

    def __init__(self, num_buckets: int = 16) -> None:
        if num_buckets < 1:
            raise ValueError("num_buckets must be at least 1")
        self._buckets: list[list[Entry]] = [[] for _ in range(num_buckets)]
        self._count = 0

    def _bucket_for(self, key: int) -> list[Entry]:
        # The hash function: the remainder after dividing by the bucket count.
        return self._buckets[key % len(self._buckets)]

    def set(self, key: int, value: Any) -> None:
        """Add the key, or replace its value if it's already there."""
        bucket = self._bucket_for(key)
        for entry in bucket:
            if entry.key == key:
                entry.value = value
                return
        bucket.append(Entry(key, value))
        self._count += 1

    def get(self, key: int) -> Any:
        """Return the key's value. Raise KeyError if the key is missing."""
        for entry in self._bucket_for(key):
            if entry.key == key:
                return entry.value
        raise KeyError(key)

    def remove(self, key: int) -> None:
        """Delete the key. Raise KeyError if the key is missing."""
        bucket = self._bucket_for(key)
        for i, entry in enumerate(bucket):
            if entry.key == key:
                bucket[i] = bucket[-1]  # move the last entry into the gap
                bucket.pop()
                self._count -= 1
                return
        raise KeyError(key)

    def __len__(self) -> int:
        return self._count
```

The key parts:

- **The hash function** is `key % len(self._buckets)`. It's cheap, and consecutive integers spread evenly over the buckets. Python's `%` always returns a non-negative result when the divisor is positive, so a negative key such as -3 lands in bucket 2 of 5 and needs no special case. (In C or Java, `-3 % 5` is -3, and you'd have to correct it.)
- **`[[] for _ in range(num_buckets)]`** creates a separate empty list per bucket. Writing `[[]] * num_buckets` would be a classic bug: it repeats one list, so every bucket would be the same list.
- **`set` scans the bucket before appending.** That scan is what makes a second `set(12, ...)` replace the value instead of adding a duplicate entry.
- **`get` and `remove` raise `KeyError(key)`** when the scan finds nothing, which matches the agreed behavior and Python's own `dict`.
- **`remove` swaps the last entry into the gap and pops.** Deleting from the middle of a Python list shifts every later element, while `pop()` from the end doesn't. Order inside a bucket never matters, so the swap is safe. With short chains the difference is tiny, so one sentence about it is enough in an interview.
- **`_count`** keeps `len()` at O(1). Without it, counting would mean walking every bucket. It's also the number the load factor needs, which makes the resizing extension a small change.
- **The `num_buckets` check** is the one validation kept. We agreed inputs are valid, but zero buckets would make the map crash with a division by zero on its first call, so it's better to refuse them up front.

## Walking through an example

Start with `HashMap(num_buckets=5)`, so a key goes to bucket `key % 5`.

| Step | Call | Bucket | What happens | Bucket 2 afterwards |
| --- | --- | --- | --- | --- |
| 1 | `set(12, "apple")` | 12 % 5 = 2 | Bucket 2 is empty. Append `Entry(12, "apple")`. | 12→apple |
| 2 | `set(7, "banana")` | 7 % 5 = 2 | Collision. The scan doesn't find 7, so append. | 12→apple, 7→banana |
| 3 | `set(3, "cherry")` | 3 % 5 = 3 | Bucket 3 is empty. Append. | 12→apple, 7→banana |
| 4 | `set(12, "apricot")` | 2 | The scan finds key 12 and replaces its value. Count stays 3. | 12→apricot, 7→banana |
| 5 | `get(7)` | 2 | Check 12 (no match), then 7 (match). Return `"banana"`. | unchanged |
| 6 | `remove(12)` | 2 | Found at index 0. Move 7 into index 0 and pop the end. Count is 2. | 7→banana |
| 7 | `get(12)` | 2 | The scan finds nothing. Raise `KeyError(12)`. | 7→banana |

After step 4 the map looks like this:

```diagram
title: Five buckets after step 4. Keys 12 and 7 collide in bucket 2 and share its chain.
[b2] Bucket 2 @ 0,0
[e12] 12 → apricot @ 1.5,0
[e7] 7 → banana @ 3,0
[b3] Bucket 3 @ 0,1
[e3] 3 → cherry @ 1.5,1
[rest:note] Buckets 0, 1, 4\nempty @ 3,1
b2 -> e12
e12 -> e7
b3 -> e3
```

Step 5 shows the cost of a collision: `get(7)` compared two keys instead of one. That's harmless at this size. The next section is about what happens when chains get long.

## Complexity and trade-offs

Write **n** for the number of entries and **b** for the number of buckets. The load factor is n ÷ b, the average chain length.

| Operation | Average time | Worst time |
| --- | --- | --- |
| `set` | O(1 + n ÷ b) | O(n) |
| `get` | O(1 + n ÷ b) | O(n) |
| `remove` | O(1 + n ÷ b) | O(n) |
| `len` | O(1) | O(1) |

Space is O(b + n): one list per bucket plus one `Entry` per key.

The "1" is the cost of hashing and indexing. The "n ÷ b" is the average chain scan, assuming keys spread evenly. The worst case is every key in one bucket, which turns the map into a slow linked list.

**The fixed bucket count is the weakness.** We agreed to ignore load factors, so b never changes. With the default 16 buckets and 1,000,000 keys, the average chain holds 1,000,000 ÷ 16 = 62,500 entries, and every lookup scans tens of thousands of them. The design is only O(1) while n stays close to b. Real hash maps fix this by resizing, shown in the extensions.

**The bucket count interacts with the hash function.** With `key % b`, keys that share a factor with b crowd together. With 16 buckets, the keys 0, 16, 32, 48 and so on all land in bucket 0, while the other 15 buckets stay empty. Two common fixes: use a prime number of buckets, or keep a power-of-two count and mix the high bits of the hash into the low bits before taking the remainder. Java's `HashMap` takes the second route. Its source computes `(h = key.hashCode()) ^ (h >>> 16)`, and a comment explains that table indexing uses power-of-two masking, which would otherwise ignore the high bits.

### Chaining vs open addressing

There are two families of collision handling.

- **Chaining** keeps a list per bucket, as our code does. Deletion is simple, and a high load factor degrades gradually. The cost is a separate object per entry, scattered around memory, so a lookup follows pointers.
- **Open addressing** stores entries directly in one big array. When a key's slot is taken, the map **probes**: it tries other slots in a fixed sequence until it finds the key or an empty slot. Everything sits in one contiguous array, which is friendly to the CPU cache. The costs: the table must keep spare empty slots, and deletion can't simply empty a slot, because that would cut a probe sequence and hide keys stored after it. Instead the slot is marked with a **tombstone**, a marker meaning "something was deleted here, keep probing."

Python's `dict` uses open addressing. The comments in CPython's `Objects/dictobject.c` describe it:

- The first probe is the low bits of the hash. After that the slot index follows the recurrence `j = ((5*j) + 1) mod 2**i`, which visits every slot of a table of size 2**i exactly once. A variable called `perturb`, initialized to the full hash and shifted right by 5 bits on each step, is added in so that the hash's high bits also affect the probe order.
- The table is resized when it is two-thirds full (`USABLE_FRACTION`). A new dict starts with 8 slots (`PyDict_MINSIZE`).
- On resize, the new size is based on three times the number of live entries (`GROWTH_RATE`). The comment notes this "means that dicts double in size when growing without deletions."
- Deleted entries leave "dummy" slots, CPython's tombstones. The source explains that a dummy slot can't be made unused again, or the probe sequence would have no way to know a later key exists.
- As of Python 3.6, the layout is "compact and ordered": a small array of indices is the actual hash table, and it points into a separate array of entries kept in insertion order.

Java's `HashMap` uses chaining, with defenses against long chains. From the OpenJDK source and documentation:

- The default capacity is 16 buckets and the default load factor is 0.75. When the number of entries exceeds load factor × capacity, the table is rehashed into approximately twice as many buckets. With the defaults, that's the 13th entry, since 16 × 0.75 = 12.
- When a bucket reaches 8 entries (`TREEIFY_THRESHOLD`), it's converted from a list into a balanced tree, which makes the worst case O(log n) for that bucket. This only happens once the table has at least 64 buckets (`MIN_TREEIFY_CAPACITY`); a smaller table resizes instead. A tree that shrinks to 6 entries (`UNTREEIFY_THRESHOLD`) turns back into a list.
- Trees are a safety net. Tree nodes are about twice the size of list nodes, so the map uses them only when a bucket really needs one. A comment in the source estimates that with random hash codes and the 0.75 load factor, the chance of a bucket holding 8 entries is about 0.00000006.

For an interview answer, chaining is the right default: it's short to write and easy to reason about. Mention open addressing as the faster-in-practice alternative and name its deletion problem.

## Extensions and follow-up questions

**"Support keys of any type, such as strings."** Use Python's built-in `hash(key)` in place of the raw key, and compare keys with `==`. This relies on the contract in Python's data model documentation: "objects which compare equal have the same hash value." If a custom class breaks it, two equal keys can land in different buckets and the map will store both. Also warn against mutable keys: if a key's hash changes after it's stored, the map looks in the wrong bucket and the entry is lost. That's why Python refuses to hash a `list`.

**"Now the map must stay fast as it grows."** Track the load factor and resize. When it passes a threshold, allocate twice as many buckets and re-insert every entry, because each key's bucket depends on the bucket count. This version also accepts any hashable key:

```python
from collections.abc import Hashable
from typing import Any


class ResizingHashMap:
    """Separate chaining for any hashable key, doubling when 3/4 full."""

    MAX_LOAD_FACTOR = 0.75

    def __init__(self, num_buckets: int = 8) -> None:
        self._buckets: list[list[list[Any]]] = [[] for _ in range(num_buckets)]
        self._count = 0

    def _bucket_for(self, key: Hashable) -> list[list[Any]]:
        return self._buckets[hash(key) % len(self._buckets)]

    def set(self, key: Hashable, value: Any) -> None:
        bucket = self._bucket_for(key)
        for pair in bucket:
            if pair[0] == key:
                pair[1] = value
                return
        bucket.append([key, value])
        self._count += 1
        if self._count / len(self._buckets) > self.MAX_LOAD_FACTOR:
            self._resize(2 * len(self._buckets))

    def get(self, key: Hashable) -> Any:
        for stored_key, value in self._bucket_for(key):
            if stored_key == key:
                return value
        raise KeyError(key)

    def _resize(self, num_buckets: int) -> None:
        old_buckets = self._buckets
        self._buckets = [[] for _ in range(num_buckets)]
        for bucket in old_buckets:
            for pair in bucket:
                self._bucket_for(pair[0]).append(pair)
```

Inserting 100 string keys into it grows the table 8 → 16 → 32 → 64 → 128 → 256 buckets. A single resize costs O(n), but doubling makes it rare. Each resize copies all current entries, and the sizes form a series where each is twice the last, so the total copying for n inserts is less than 2n. Spread over n inserts, that's O(1) extra work per insert, called **amortized O(1)**. The interviewer may ask about the pause a big resize causes; the answer is **incremental rehashing**, keeping both tables for a while and moving a few buckets on every operation.

**"How does deletion work if we switch to open addressing?"** Mark the slot with a tombstone. Lookups skip over tombstones and keep probing, and inserts may reuse them. Tombstones still count against the load factor, so a map with heavy churn has to rebuild its table now and then to clear them. CPython's dummy slots work this way.

**"What if an attacker chooses the keys?"** If someone can predict your hash function, they can send thousands of keys that all collide, turning each insert into a scan of one long chain. A web form parsed into a hash map is enough. The oCERT-2011-003 advisory from December 2011 showed this against Java, PHP, Python, Ruby, the V8 JavaScript engine and servers such as Tomcat and Jetty: crafted HTTP requests with many colliding POST parameters could keep a server's CPU at 100% for hours. Python's documentation describes the attack as exploiting "the worst case performance of a dict insertion, O(n²) complexity". Since Python 3.3, the hashes of `str` and `bytes` objects are salted with a random value per process, so attackers can't precompute collisions. Java's tree bins limit the damage differently: a flooded bucket costs O(log n) per lookup when the colliding keys have different full hash codes or are `Comparable`.

**"Make it safe to use from several threads."** The simplest answer is one lock around every method. To reduce contention, use **lock striping**: split the buckets into groups, each with its own lock, so threads touching different groups don't wait for each other.

**"The data no longer fits on one machine."** Now the "buckets" are servers, and the natural first idea is `server = hash(key) % number_of_servers`. It works until a server is added or removed. Then the modulus changes and most keys move to a different server at once, the same reshuffle as a resize, only across the network. [Consistent hashing](/learn/consistent-hashing) is the standard fix: it arranges servers on a ring so that adding one moves only the keys that the new server should own. [Design a key-value store](/learn/design-key-value-store) builds a full distributed version.

**"How would you test this?"** Compare it against Python's `dict`. Run thousands of random `set`, `get` and `remove` calls with keys from a small range, so collisions and repeats are common, and check after each call that both give the same answer and the same length. Add targeted tests for a missing key, an update, and negative keys.

## Check yourself

<details>
<summary>A teammate initializes the buckets with <code>[[]] * num_buckets</code>. Every key seems to land in every bucket. What went wrong?</summary>

`[[]] * n` creates a list holding n references to the *same* empty list. Appending an entry to "bucket 3" appends it to the one shared list, which every bucket points to. Use `[[] for _ in range(n)]`, which creates a new list for each bucket.

</details>

<details>
<summary>You store 1,000,000 integer keys in the fixed 16-bucket map. Roughly how many comparisons does an average <code>get</code> make, and what's the fix?</summary>

The load factor is 1,000,000 ÷ 16 = 62,500, so each chain holds about 62,500 entries. A successful lookup scans about half its chain on average, around 31,000 comparisons, and a miss scans all 62,500. The fix is resizing: double the bucket count whenever the load factor passes a threshold such as 0.75, which keeps chains short and operations amortized O(1).

</details>

<details>
<summary>The keys are all multiples of 16 and the map has 16 buckets. What happens, and name two fixes.</summary>

Every key gives `key % 16 == 0`, so all keys go in bucket 0 and every operation scans one long chain. Fixes: use a prime number of buckets, so common factors in the keys don't line up with the bucket count, or mix the hash's high bits into its low bits before taking the remainder, as Java's `HashMap` does with `h ^ (h >>> 16)`.

</details>

<details>
<summary>Why can't an open-addressing table simply empty a slot when a key is deleted?</summary>

A lookup stops probing when it reaches an empty slot, because that's how it knows the key isn't present. If key A sat in its first-choice slot and key B was stored further along the probe sequence, emptying A's slot makes later lookups for B stop early and report B as missing. A tombstone tells lookups to keep going while still letting inserts reuse the slot.

</details>

<details>
<summary>Why does doubling the table on resize give amortized O(1) inserts, while growing by a fixed 100 buckets each time doesn't?</summary>

With doubling, the resizes copy 8, 16, 32, … entries, and the total across n inserts stays below 2n, so each insert pays a constant amount on average. With fixed growth, a resize happens every ~100 inserts and each one copies all n entries so far, so the total copying is about 100 + 200 + 300 + … + n, roughly n² ÷ 200. That's O(n) per insert on average.

</details>

<details>
<summary>An interviewer asks you to spread this map's keys across 4 cache servers using <code>hash(key) % 4</code>. What problem should you raise?</summary>

When a fifth server is added, the bucket for most keys changes, because `hash(key) % 5` rarely equals `hash(key) % 4`. Most keys suddenly live on the "wrong" server, so a cache sees a burst of misses that falls through to the database. Consistent hashing limits the movement to the keys the new server takes over.

</details>

## Further reading

- [CPython `Objects/dictobject.c`](https://github.com/python/cpython/blob/main/Objects/dictobject.c): the source of Python's `dict`. The long comments near the top explain the compact layout, the probe sequence, the two-thirds load limit, the growth rate and dummy slots.
- [OpenJDK `java/util/HashMap.java`](https://github.com/openjdk/jdk/blob/master/src/java.base/share/classes/java/util/HashMap.java): Java's chained hash map. The "Implementation notes" comment explains tree bins and the Poisson estimate for chain lengths.
- [`java.util.HashMap` documentation](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/HashMap.html): the official description of capacity, load factor and rehashing.
- [Python data model: `object.__hash__`](https://docs.python.org/3/reference/datamodel.html#object.__hash__): the rule that equal objects must have equal hashes, and the note on hash randomization.
- [oCERT-2011-003](https://ocert.org/advisories/ocert-2011-003.html): the 2011 advisory on hash-collision denial-of-service attacks against web frameworks in many languages.
- [Consistent hashing](/learn/consistent-hashing): how to spread keys over many machines without moving most of them when the set of machines changes.
