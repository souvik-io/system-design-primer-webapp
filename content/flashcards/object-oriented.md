<!-- chapter: ood-hash-table -->

## Sketch the classes for a hash map with integer keys and chaining.
<!-- /learn/ood-hash-table#class-design -->

**Constraints:** integer keys, collisions resolved by chaining, no load-factor resizing, everything in memory. `set` on an existing key replaces its value; `get` and `remove` on a missing key raise `KeyError`.

**Classes:**
- `Entry`: one key and its value, so a bucket can tell colliding keys apart.
- `HashMap`: owns the buckets and does everything else: hashes a key to a bucket (`key % number_of_buckets`), adds or updates, finds, removes.
- No `Bucket` class: a plain Python list already appends, scans and deletes. Choosing not to create a class is a decision too.

**Decisions:** `set` scans the bucket before appending, so a repeated key replaces its value. `remove` swaps the last entry into the gap and pops. A `_count` field keeps `len()` O(1).

**Complexity and traps:** O(1 + n ÷ b) on average, O(n) worst case when every key lands in one bucket. With a fixed bucket count, chains grow as n grows. `[[]] * num_buckets` would make every bucket the same list; build them with `[[] for _ in range(num_buckets)]`.

<!-- chapter: ood-lru-cache -->

## Sketch the classes for an LRU cache of web query results.
<!-- /learn/ood-lru-cache#class-design -->

**Constraints:** keys are query strings, values are their results. Capacity is counted in entries. `get` returns `None` on a miss, and a hit counts as a use. `set` on a full cache evicts the least recently used entry first.

**Classes:**
- `Node`: one entry (query, results) with links to its neighbors in recency order.
- `RecencyList`: a doubly linked list from most to least recently used, with sentinel head and tail. Adds at the front, moves to the front, removes the last node.
- `LRUCache`: the public interface. Enforces capacity, decides what counts as a use, keeps the dict and the list in step.

**Decision:** a hash map from query to node plus a doubly linked list. The dict finds a node in O(1), and the back pointer lets a node be unlinked from the middle in O(1). A timestamp scan would make eviction O(n), and a heap O(log n).

**Complexity and trap:** `get` and `set` are both O(1), and space is O(capacity). Each node must store its own query, or eviction can't delete the tail's entry from the dict.

<!-- chapter: ood-call-center -->

## Sketch the classes for a call center with operators, supervisors and directors.
<!-- /learn/ood-call-center#class-design -->

**Constraints:** new calls start with operators. A call moves up when everyone at a rank is busy (overflow) or the person on the line can't help (escalation). Directors can handle anything. If nobody is free, the call waits in a first-in-first-out queue. No VIP calls.

**Classes:**
- `Rank` (an `IntEnum`, so ranks compare) and `CallState` (`READY`, `QUEUED`, `IN_PROGRESS`, `COMPLETE`).
- `Call`: the caller, its state, the employee on the line, and `min_rank`, the lowest rank allowed to take it.
- `Employee`: an abstract base that takes, completes and escalates calls. `Operator`, `Supervisor` and `Director` each answer `escalation_rank()`; a director raises `CannotEscalate`.
- `CallCenter`: owns staff and waiting calls and decides who gets which call, through `dispatch_call()` and `employee_freed()`.

**Decisions:** escalation raises the call's `min_rank` and hands it back to the call center, which keeps the search in one place. There's one queue per rank, and a freed employee takes the most senior waiting call they're allowed to.

**Traps:** one shared queue lets an operator pick up a director-level call. `raise NotImplemented(...)` is a `TypeError`, since `NotImplemented` isn't an exception.

<!-- chapter: ood-deck-of-cards -->

## Sketch the classes for a generic deck of cards that also supports blackjack.
<!-- /learn/ood-deck-of-cards#class-design -->

**Constraints:** a generic 52-card deck (ranks 1 to 13 in 4 suits) for games like poker and blackjack. Blackjack must be added without changing the generic classes. Dealing from an empty deck returns `None`.

**Classes:**
- `Suit`: an enum of the four suits.
- `Card`: a frozen dataclass of rank and suit; its default `value` is the rank.
- `BlackjackCard`: overrides `value` so face cards are 10 and an ace is 1, leaving 1-or-11 to the hand.
- `Deck[C]`: a generic list of cards plus a `deal_index`; deals, reports remaining cards, and shuffles with Fisher-Yates.
- `Hand[C]`: holds a player's cards; `score()` adds up values. `BlackjackHand` overrides `score()`.

**Decisions:** blackjack arrives through inheritance and overriding, and decks and hands hold cards by composition. Scoring lists the n + 1 distinct totals (hard total plus 0, 10, 20...), then picks the highest at 21 or under, or the lowest if all are bust.

**Traps:** an abstract `value` on `Card` would make plain cards impossible. An `is_available` flag on each card drifts from the deck; the deal index is the only record of what's dealt.

<!-- chapter: ood-parking-lot -->

## Sketch the classes for a multi-level parking lot that takes motorcycles, cars and buses.
<!-- /learn/ood-parking-lot#class-design -->

**Constraints:** motorcycles fit any spot; cars fit compact or large spots; a bus needs 5 consecutive large spots in the same row. The lot has several levels, each laid out in rows.

**Classes:**
- `SpotSize`: an enum ordered smallest to largest.
- `Vehicle`: an abstract base with the plate, the spots held, `spots_needed` and `fits_in(size)`. `Motorcycle`, `Car` and `Bus` each answer `fits_in`.
- `ParkingSpot`: its level, row, number, size and current vehicle; refuses to be occupied twice.
- `Row`: finds a run of free, adjacent spots of one size.
- `Level`: owns rows, keeps free counts per size, decides where a vehicle goes on this level.
- `ParkingLot`: tries levels in order and remembers parked vehicles by plate.

**Decisions:** the fit rule lives in the vehicle (polymorphism, no `isinstance` checks), so a new vehicle type is one subclass. Best fit tries the smallest accepted size first, keeping large spots for buses.

**Complexity and trap:** `Row.find_run` is a linear scan, fine for a few thousand spots. Vehicles and spots reference each other, so only `Level.park` and `ParkingLot.leave` may change both sides.

<!-- chapter: ood-online-chat -->

## Sketch the classes for a chat server with friend requests, private chats and group chats.
<!-- /learn/ood-online-chat#class-design -->

**Constraints:** text only; add, remove and update users; friendships via requests the other user approves or rejects; private chats only between friends, one per pair; group chats you invite your own friends to. Everything in memory.

**Classes:**
- `UserService`: the entry point. Owns users and chats and performs every operation that touches two users.
- `User`: id, name, password hash, friends, private chats by friend id, group chats by id, sent and received requests.
- `FriendRequest` with `RequestStatus`: `UNREAD` and `READ` are pending, `ACCEPTED` and `REJECTED` are final.
- `Chat`: an abstract base holding members and messages and implementing `post`. `PrivateChat` (two fixed members, posting only while friends) and `GroupChat` (named, changing members) fill in `can_post` and `title_for`.
- `Message`: id, sender id, text and timestamp.

**Decisions:** two-sided changes such as approving a request or unfriending live in `UserService`, so both users always agree. A request that crosses one already pending the other way counts as accepting it.

**Trap:** removing a user must unfriend everyone, delete pending requests on both sides and leave every group before dropping the user.
