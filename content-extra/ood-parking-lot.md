# Design a parking lot

Picture a three-storey garage next to a train station. Motorcycles, cars and the occasional bus drive in at the entrance. The garage has to decide where each one goes, refuse it when there's no room, and free the space again when it drives out. A bus is the awkward case: it's too long for one space, so it needs a stretch of large spaces side by side.

"Design a parking lot" is an **object-oriented design** question. You aren't asked for servers or databases. You're asked to model a small world in code. A good answer has four parts: clarify the scope with a few questions, name the classes and what each one is responsible for, write the code, and then discuss how you'd extend it. The interviewer is listening for clean responsibilities and sensible trade-offs more than for clever algorithms.

## Constraints and assumptions

Ask these questions first. Each answer changes the classes you need.

- **What types of vehicles should we support?** Motorcycles, cars and buses. *Why it matters:* this fixes the vehicle classes, and three types with different rules is a hint that polymorphism will help.
- **Does each vehicle type take up a different amount of parking space?** Yes. *Why it matters:* the lot needs spot sizes, and a rule for which vehicle may use which size. The rules we'll use:

  | Spot size | Who can park there |
  | --- | --- |
  | Motorcycle spot | Motorcycle |
  | Compact spot | Motorcycle, car |
  | Large spot | Motorcycle, car |
  | Five consecutive large spots | Bus |

- **Can a bus park in a single spot?** No. A bus can park only if there are 5 consecutive large spots free. *Why it matters:* parking stops being "find one free spot" and becomes "find a run of adjacent free spots", so the code needs to know which spots are next to each other.
- **Does the parking lot have multiple levels?** Yes. *Why it matters:* the lot is made of levels, and the search for a space has to go level by level.

We add a few assumptions of our own and say them out loud:

- Each level is laid out in **rows**, and each row holds 10 spots in a line. "Consecutive" means next to each other in the same row on the same level. Two spots at the ends of different rows don't count, even if their numbers are adjacent.
- A vehicle is identified by its license plate, and the same plate can't be parked twice.
- One entrance handles one vehicle at a time. Concurrency, tickets and payment are extensions we discuss at the end.

## Class design

```diagram
title: A lot is made of levels, levels of rows, rows of spots. Vehicles decide which spot sizes they fit.
[lot] ParkingLot @ 0,0
[level] Level @ 1,0
[row] Row @ 2,0
[spot] ParkingSpot @ 3,0
[size:note] SpotSize\nenum @ 4,0
[veh] Vehicle\n(abstract) @ 3,1.5
[moto] Motorcycle @ 2,2.5
[car] Car @ 3,2.5
[bus] Bus\n5 spots @ 4,2.5
lot -> level : has many
level -> row : has many
row -> spot : has many
spot -> size : has a
veh -> spot : occupies
moto -> veh
car -> veh
bus -> veh
```

Each class has one job:

- **`SpotSize`** is an **enum**, a fixed set of named values: `MOTORCYCLE`, `COMPACT` and `LARGE`. Using an enum instead of strings means a typo like `"compcat"` fails at once instead of quietly never matching. We number the sizes smallest to largest so that sorting them gives a "try the smallest first" order.
- **`Vehicle`** is an **abstract base class**: a class that defines what every vehicle can do but can't be created on its own. It holds the license plate and the list of spots the vehicle currently holds. Its abstract method `fits_in(size)` answers "can I use a spot of this size?". A class attribute `spots_needed` says how many consecutive spots it takes, 1 by default.
- **`Motorcycle`, `Car` and `Bus`** are subclasses that each answer `fits_in` their own way. A motorcycle fits anywhere. A car fits compact or large spots. A bus fits only large spots and sets `spots_needed = 5`. This is **polymorphism**: the level calls `vehicle.fits_in(size)` without checking which kind of vehicle it has, and each class supplies the right answer.
- **`ParkingSpot`** knows its level, row, number and size, and which vehicle is in it, if any. It can be occupied and released, and it refuses to be occupied twice.
- **`Row`** is an ordered list of spots. Its one job is to find a run of free, adjacent spots of a given size that is long enough for a vehicle.
- **`Level`** owns its rows and keeps a count of free spots of each size. It decides where on this level a vehicle goes.
- **`ParkingLot`** owns the levels, tries them in order, and remembers which vehicles are parked so it can free their spots when they leave.

The lot, level, row and spot are joined by **composition**: each one is built out of the smaller ones and owns them. Vehicles and spots point at each other only while a vehicle is parked.

## Solution

```python
from __future__ import annotations

from abc import ABC, abstractmethod
from enum import IntEnum


class SpotSize(IntEnum):
    """Spot sizes, smallest first, so sorting them gives a best-fit order."""
    MOTORCYCLE = 1
    COMPACT = 2
    LARGE = 3


class Vehicle(ABC):
    spots_needed = 1  # how many consecutive spots the vehicle takes

    def __init__(self, license_plate: str) -> None:
        self.license_plate = license_plate
        self.spots: list[ParkingSpot] = []  # spots it holds while parked

    @abstractmethod
    def fits_in(self, size: SpotSize) -> bool:
        """Can this vehicle use a spot of this size?"""

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.license_plate!r})"


class Motorcycle(Vehicle):
    def fits_in(self, size: SpotSize) -> bool:
        return True  # any spot


class Car(Vehicle):
    def fits_in(self, size: SpotSize) -> bool:
        return size in (SpotSize.COMPACT, SpotSize.LARGE)


class Bus(Vehicle):
    spots_needed = 5

    def fits_in(self, size: SpotSize) -> bool:
        return size == SpotSize.LARGE


class ParkingSpot:
    def __init__(self, level: int, row: int, number: int, size: SpotSize) -> None:
        self.level = level
        self.row = row
        self.number = number
        self.size = size
        self.vehicle: Vehicle | None = None

    def is_free(self) -> bool:
        return self.vehicle is None

    def occupy(self, vehicle: Vehicle) -> None:
        if not self.is_free():
            raise ValueError(f"spot {self} is already taken")
        self.vehicle = vehicle

    def release(self) -> None:
        self.vehicle = None

    def __repr__(self) -> str:
        return f"L{self.level}-R{self.row}-#{self.number}({self.size.name})"


class Row:
    """Spots in a row, in order. Only spots in the same row are consecutive."""

    def __init__(self, spots: list[ParkingSpot]) -> None:
        self.spots = spots

    def find_run(self, vehicle: Vehicle, size: SpotSize) -> list[ParkingSpot] | None:
        """First run of free, adjacent spots of this size that is long enough."""
        run: list[ParkingSpot] = []
        for spot in self.spots:
            if spot.is_free() and spot.size == size:
                run.append(spot)
                if len(run) == vehicle.spots_needed:
                    return run
            else:
                run = []  # a taken or wrong-size spot breaks the run
        return None


class Level:
    def __init__(self, floor: int, row_layouts: list[list[SpotSize]]) -> None:
        self.floor = floor
        self.rows = [
            Row([ParkingSpot(floor, r, n, size) for n, size in enumerate(layout)])
            for r, layout in enumerate(row_layouts)
        ]
        self.free_by_size = {size: 0 for size in SpotSize}
        for row in self.rows:
            for spot in row.spots:
                self.free_by_size[spot.size] += 1

    def park(self, vehicle: Vehicle) -> bool:
        # Best fit: try the smallest spot size the vehicle accepts first.
        for size in sorted(s for s in SpotSize if vehicle.fits_in(s)):
            if self.free_by_size[size] < vehicle.spots_needed:
                continue  # quick skip: not enough spots of this size left
            for row in self.rows:
                run = row.find_run(vehicle, size)
                if run:
                    for spot in run:
                        spot.occupy(vehicle)
                    vehicle.spots = run
                    self.free_by_size[size] -= len(run)
                    return True
        return False

    def spot_freed(self, spot: ParkingSpot) -> None:
        self.free_by_size[spot.size] += 1


class ParkingLot:
    def __init__(self, levels: list[Level]) -> None:
        self.levels = levels
        self.levels_by_floor = {level.floor: level for level in levels}
        self.parked: dict[str, Vehicle] = {}  # license plate -> vehicle

    def park(self, vehicle: Vehicle) -> bool:
        if vehicle.license_plate in self.parked:
            raise ValueError(f"{vehicle} is already parked")
        for level in self.levels:
            if level.park(vehicle):
                self.parked[vehicle.license_plate] = vehicle
                return True
        return False  # lot full for this kind of vehicle

    def leave(self, license_plate: str) -> Vehicle:
        vehicle = self.parked.pop(license_plate)  # KeyError if not parked
        for spot in vehicle.spots:
            spot.release()
            self.levels_by_floor[spot.level].spot_freed(spot)
        vehicle.spots = []
        return vehicle

    def free_spots(self) -> dict[int, dict[str, int]]:
        return {
            level.floor: {size.name: n for size, n in level.free_by_size.items()}
            for level in self.levels
        }
```

The key parts:

- **The fit rule lives in the vehicle.** `Level.park` asks `vehicle.fits_in(size)` and never checks `isinstance(vehicle, Bus)`. Adding a new vehicle type, such as a van that needs two compact spots, means writing one subclass. No other class changes.
- **Best fit.** `Level.park` tries the spot sizes the vehicle accepts from smallest to largest. A motorcycle takes a motorcycle spot if one is free, then a compact one, and only then a large one. This keeps large spots free for the buses that can't use anything else.
- **Consecutive spots.** `Row.find_run` walks the row in order and builds a run of free spots of the right size. A taken spot, or a spot of the wrong size, resets the run to empty. As soon as the run reaches `spots_needed`, it returns those spots. A car or a motorcycle needs a run of 1, so the same code handles every vehicle.
- **Free counts that go both ways.** Each level keeps `free_by_size`, counted from its layout when it's built. Parking subtracts the spots taken and `spot_freed` adds one back for each spot released. The counts let a level skip a size at once when it can't possibly have enough spots, and they power an availability display. A count that only ever goes up, or that starts at 0, would be wrong after the first car.
- **Leaving.** `ParkingLot.leave` looks up the vehicle by plate, releases every spot it holds (five for a bus), tells each spot's level, and clears the vehicle's list. Removing the vehicle from `parked` first means a second `leave` with the same plate raises a `KeyError` instead of freeing spots twice.
- **Guard rails.** `ParkingSpot.occupy` raises if the spot is taken, and `ParkingLot.park` raises if the plate is already parked. Bugs like these are much easier to find when they fail loudly.

## Walking through an example

Build a lot with two levels. Level 0 has two rows of 10 spots. Row 0 is two motorcycle spots, three compact and five large. Row 1 is five compact, four large and one compact at the end. Level 1 has one row of 10 large spots.

```python
from parking_lot import *

M, C, L = SpotSize.MOTORCYCLE, SpotSize.COMPACT, SpotSize.LARGE
lot = ParkingLot([
    Level(0, [[M, M, C, C, C, L, L, L, L, L],
              [C, C, C, C, C, L, L, L, L, C]]),
    Level(1, [[L] * 10]),
])
for v in [Motorcycle("MOTO-1"), Car("CAR-1"), Bus("BUS-1"), Bus("BUS-2")]:
    print(v, lot.park(v), v.spots)
lot.leave("BUS-1")
```

What happens, step by step:

1. **The motorcycle** arrives. Level 0 tries the smallest size first, `MOTORCYCLE`, and finds spot 0 in row 0. It's parked at `L0-R0-#0`.
2. **The car** can't use motorcycle spots, so level 0 starts at `COMPACT`. Spot 2 in row 0 is the first compact spot, so the car goes to `L0-R0-#2`.
3. **The first bus** needs five consecutive large spots. Row 0 has large spots 5 to 9, all free, so the run reaches five at spot 9. The bus holds `L0-R0-#5` to `#9`.
4. **The second bus** tries level 0 again. The level now has 4 large spots free, fewer than 5, so it skips the level without scanning a single row. That's the free count paying off. (Even scanning would fail: row 1's four large spots are boxed in by compact spots on both sides.) Level 1 has a run of ten, so the bus takes `L1-R0-#0` to `#4`.
5. **The first bus leaves.** All five spots are released, and level 0's large count goes from 4 back to 9.

The free counts after each stage, as `lot.free_spots()` prints them:

| Moment | Level 0 (motorcycle, compact, large) | Level 1 (large) |
| --- | --- | --- |
| Empty lot | 2, 9, 9 | 10 |
| After all four park | 1, 8, 4 | 5 |
| After the first bus leaves | 1, 8, 9 | 5 |

The tests for this chapter also check the edge cases: a car is refused when only motorcycle spots are left, a third motorcycle is refused by a lot with two motorcycle spots, a car parked in the middle of six large spots blocks a bus, and a motorcycle falls back to a compact spot and then a large one.

## Design choices and trade-offs

**Who decides whether a vehicle fits?** We put the rule in the vehicle (`fits_in`). The alternative is to put it in the spot, with a table of sizes to allowed vehicle types. The vehicle-side rule makes new vehicle types cheap to add. A spot-side table makes new spot types cheap to add, such as a disabled-access spot that any vehicle with a permit can use. Pick the side that's more likely to change, and say which one you picked.

**Where should the bus go?** We search levels in order and take the first run that fits, with a best-fit preference for small spots within a level. That's simple and predictable. It isn't globally optimal: a motorcycle on level 0 may take a compact spot while a motorcycle spot is free on level 1. Fixing that means checking every level before choosing, which costs more work per arrival. A real garage usually prefers the simple rule, because drivers enter at the bottom anyway.

**Fragmentation.** Cars parked in large spots can break up the runs a bus needs, the same way small allocations fragment memory. Best fit reduces this by sending cars to compact spots first. A stricter rule would forbid cars from large spots while buses are expected, at the cost of turning cars away when compact spots run out.

**Linear search.** `Row.find_run` scans every spot, so parking costs time proportional to the number of spots. For a garage of a few thousand spots, that's a few thousand checks, which is nothing. For a lot that size the clarity is worth more than an index. If it ever mattered, a level could keep a set of free spots per size for single-spot vehicles and only scan rows for buses.

**Two-way references.** A vehicle knows its spots and a spot knows its vehicle. That makes "where is this car?" and "who's in this spot?" both instant, but the two sides must be updated together. Keeping every change inside `Level.park` and `ParkingLot.leave` is what keeps them in step.

**Counts that can drift.** `free_by_size` duplicates information you could get by scanning every spot. It's faster, but if code anywhere changes a spot without telling its level, the count goes wrong. The alternative is to recompute on demand. We keep the count and make `Level` and `ParkingLot` the only code that parks or frees vehicles.

## Extensions and follow-up questions

**Payments and tickets.** Add a `Ticket` class with an id, the plate, the spots, the entry time and an exit time. `park` returns a ticket instead of `True`, and `leave` takes the ticket. A `RateCard` object (a price per hour for each vehicle type) computes the fee from the two times, and a `Payment` records how it was paid. Keeping pricing in its own class means a change to the prices never touches the parking logic. For how real systems avoid charging twice when a payment is retried, see [Design a payment system](/learn/design-payment-system#idempotency-keys).

**An availability display.** The sign at the entrance that says "Level 2: 14 compact free" is just `free_spots()`. To keep the sign up to date without polling, let `Level` notify listeners whenever a count changes. This is the **observer pattern**: the level keeps a list of callbacks and calls each one after parking or freeing a spot, without knowing whether the listener is a sign, a mobile app or a log.

**Two cars claiming the same spot.** With two entrances, two threads could run `find_run` at the same time, both see spot 7 free, and both park there. The simplest fix is a lock around every change:

```python
import threading
from parking_lot import ParkingLot, Vehicle


class ThreadSafeParkingLot(ParkingLot):
    """One lock around every change, so two cars can't claim the same spot."""

    def __init__(self, levels):
        super().__init__(levels)
        self._lock = threading.Lock()

    def park(self, vehicle: Vehicle) -> bool:
        with self._lock:
            return super().park(vehicle)

    def leave(self, license_plate: str) -> Vehicle:
        with self._lock:
            return super().leave(license_plate)
```

With a single lock, only one arrival or departure runs at a time. Our test sends 50 cars at a lot with 10 compact spots from 50 threads, and exactly 10 park. A single lock limits the lot to one change at a time, which is plenty for a garage. A busier system could lock per level, but then a bus search that spans levels must take locks in a fixed order to avoid deadlock. Once the state lives in a database, the same problem is solved with a transaction or a conditional update such as "set vehicle = X where vehicle is null". See [isolation in relational databases](/learn/relational-databases#isolation-transactions-dont-see-each-others-half-finished-work).

**EV charging spots.** An electric car may want a spot with a charger. One option is a new `SpotSize` member. That's the wrong axis, though: a charger can be fitted to a compact or a large spot. A better model is a separate set of **features** on each spot, such as `{CHARGER}`. The vehicle states what it requires (`requires = {CHARGER}` for a car that must charge), and the search accepts a spot only if its features include them. Charging also adds new rules to discuss: a time limit, a fee per kWh, and what to do when the car is full but still parked.

**Other follow-ups worth a sentence each.** Reserved spots (a `reserved_for` field checked by the search). Monthly permits (a lookup by plate before the search). Lot-wide full signs (sum the levels' counts). Handicapped spots (another feature, like the charger).

## Check yourself

<details>
<summary>Why is `Vehicle` an abstract base class instead of a regular class?</summary>

Because there's no such thing as a plain vehicle in this lot. Every vehicle is a motorcycle, a car or a bus, and each one must say which spot sizes it fits. Marking `fits_in` as abstract makes Python refuse to create a `Vehicle` directly, or a subclass that forgot to implement `fits_in`. You get a `TypeError` when the object is created instead of a wrong answer later.

</details>

<details>
<summary>A row is laid out compact, large, large, large, large, large, large. A car is parked in the second large spot. Can a bus park in this row?</summary>

No. The large spots are positions 1 to 6, and the car is in position 2. That leaves a run of one large spot before the car and a run of four after it. Neither reaches five, so `find_run` returns nothing. The row has five free large spots in total, which is why counting free spots isn't enough: they must be next to each other.

</details>

<details>
<summary>Why does a motorcycle try a motorcycle spot before a compact or large one?</summary>

To keep the bigger spots for vehicles that need them. A motorcycle can use any spot, but a car can't use a motorcycle spot and a bus can only use large ones. If motorcycles took the first free spot of any size, they could scatter across the large spots and break up the runs of five that buses need. Trying sizes from smallest to largest is a simple best-fit rule.

</details>

<details>
<summary>How would you add a van that needs two adjacent compact or large spots?</summary>

Write one subclass: `class Van(Vehicle)` with `spots_needed = 2` and a `fits_in` that accepts `COMPACT` and `LARGE`. Nothing else changes. `Level.park` already tries each accepted size, and `Row.find_run` already looks for a run of `spots_needed` adjacent spots. Note one limit of our search: it looks for a run of a single size, so two adjacent spots where one is compact and one is large wouldn't count. Allowing mixed runs would mean checking `fits_in` on each spot instead of comparing sizes.

</details>

<details>
<summary>Two entrance gates call `park` at the same moment and both pick spot 12. What went wrong, and what's the simplest fix?</summary>

Both threads read the spot as free before either one wrote to it, a race condition. The simplest fix is a lock around `park` and `leave`, so that finding a spot and occupying it happen as one step. `ParkingSpot.occupy` raising on a taken spot is a useful second line of defence, because it turns a silent double booking into a visible error.

</details>

<details>
<summary>Why keep a count of free spots per size when you could just scan the spots?</summary>

Two reasons. It lets a level skip a size immediately when it can't have enough spots, which the second bus in the example shows. And it gives the availability display its numbers without a scan. The cost is that the count must be updated on every park and every departure. If any code changes a spot without telling its level, the count drifts.

</details>

## Further reading

- [abc: Abstract Base Classes](https://docs.python.org/3/library/abc.html): Python's documentation for `ABC` and `abstractmethod`, which this design uses for `Vehicle`.
- [enum: Support for enumerations](https://docs.python.org/3/library/enum.html): the documentation for `Enum` and `IntEnum`, used here for spot sizes.
- [threading: Lock objects](https://docs.python.org/3/library/threading.html#lock-objects): how `threading.Lock` works and how to use it with a `with` statement, as in the concurrency extension.
- [Tell Don't Ask](https://martinfowler.com/bliki/TellDontAsk.html): Martin Fowler's short 2013 note on asking an object to apply its own logic, which is why the level asks each vehicle whether it fits.
- [Design a chat server](/learn/ood-online-chat): the other object-oriented design question in the handbook, with friend requests, chats and a service that ties them together.
- [The system design interview, step by step](/learn/system-design-interview): the same habit of clarifying scope first, applied to whole systems.
