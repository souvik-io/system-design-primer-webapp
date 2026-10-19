# Design a call center

Picture a support line with three levels of staff. Operators answer the phone. When an operator can't solve a caller's problem, they hand the call to a supervisor. When a supervisor can't solve it either, it goes to a director, and a director can solve anything. On a busy morning every phone is taken, so new callers wait on hold until someone frees up. The question asks you to model that in code: who takes a new call, what happens when a call is passed up, and who picks up the callers on hold.

This is an **object-oriented design question**. Object-oriented design (OOD) means describing a program as a set of objects, each holding its own data and offering a few operations on it. In the interview you clarify the scope with a few questions, name the classes and what each one is responsible for, write the code, and then discuss how the design would change if the requirements grew. There are no servers here: the interviewer judges whether the classes are easy to understand, easy to change and correct.

## Constraints and assumptions

Ask these questions before writing any code. Each answer is what we assume for the rest of the chapter.

- **What levels of employees are in the call center?** Operator, supervisor and director. This fixes the number of ranks, and so the number of employee classes.
- **Can we assume operators always get the initial calls?** Yes. Every new call starts at the lowest rank, so routing always begins in the same place.
- **If no operator is available, or the operator can't handle the call, does the call go to the supervisors?** Yes. This gives two different reasons a call moves up: everyone at a rank is busy (overflow), or the person on the line can't help (escalation). The code has to handle both.
- **If no supervisor is available, or the supervisor can't handle the call, does the call go to the directors?** Yes. The same two rules apply one level higher.
- **Can we assume the directors can handle all calls?** Yes. The chain of escalation has an end, so a call can never be passed up forever.
- **What happens if nobody can answer the call?** It gets queued. We need a waiting line and a rule for who takes the next waiting call when someone frees up.
- **Do we need to handle "VIP" calls, where we put someone at the front of the line?** No. The waiting line is first in, first out, which keeps the queue simple. Priorities come back as an extension.
- **Can we assume inputs are valid, or do we have to validate them?** Assume they're valid. We skip checks such as "is this a real employee ID?" and keep the code focused on routing.

Three smaller assumptions fill gaps the questions leave open:

- An employee handles one call at a time.
- A call that has been escalated may only go to the rank it was escalated to or higher. An operator can't take it back.
- When an employee frees up, they take the waiting call that most needs someone of their rank. The [Class design](/learn/ood-call-center#class-design) section explains the rule.

## Class design

Start with the nouns in the problem: employee, operator, supervisor, director, call, call center. Most of them become classes. Then add the two fixed lists of values the problem mentions: the ranks and the states a call can be in.

```diagram
title: Classes in the call center. Solid lines show which class holds or uses which.
[cc] CallCenter @ 1,0
[call] Call @ 3,0
[emp] Employee\n(abstract) @ 1,1
[state:note] CallState\n(enum) @ 3,1
[op] Operator @ 0,2
[sup] Supervisor @ 1,2
[dir] Director @ 2,2
[rank:note] Rank (enum) @ 3,2
cc -> call : queues waiting calls
cc -> emp : staff, by rank
emp -> call : handles one
call -> state
op -> emp : is an
sup -> emp : is an
dir -> emp : is an
emp -> rank
```

- **`Rank`** is an enum, a type with a fixed set of named values: `OPERATOR`, `SUPERVISOR` and `DIRECTOR`. We make it an `IntEnum`, whose members are also integers 0, 1 and 2, so the code can write `rank >= call.min_rank` and loop over ranks from lowest to highest.
- **`CallState`** is an enum of where a call is in its life: `READY` (just created or just escalated), `QUEUED` (on hold), `IN_PROGRESS` (someone is talking to the caller) and `COMPLETE`.
- **`Call`** holds one caller's data: an ID, the caller, its state, the employee on the line, and `min_rank`, the lowest rank allowed to take it. Escalation raises `min_rank`. It also keeps `handled_by`, the names of everyone who has taken the call, which is handy for reporting and for the walkthrough.
- **`Employee`** is an **abstract base class**: a class that defines what every employee can do but can't be created on its own. It knows how to take, complete and escalate a call. The one thing it leaves open is `escalation_rank()`, the rank a call goes to when this employee passes it on. Python's `abc` module enforces this: `Employee(1, "Ana")` raises a `TypeError`, because a method marked `@abstractmethod` has no body.
- **`Operator`, `Supervisor` and `Director`** are subclasses of `Employee`. This is **inheritance**: each one "is an" employee and gets all of the shared behavior for free. Each sets its `rank` and answers `escalation_rank()`. An operator escalates to supervisors, a supervisor to directors, and a director refuses with a `CannotEscalate` error.
- **`CallCenter`** owns the staff and the waiting calls, grouped by rank. This is **composition**: the call center "has" employees and calls, and it's the only class that decides who gets which call. It offers `dispatch_call()` for a call that needs someone and `employee_freed()` for an employee who has just become free.

The division of work matters. An employee knows what *it* can do, and the call center knows about *everyone*. When an operator escalates, it doesn't search for a supervisor itself. It raises the call's `min_rank` and asks the call center to place the call. That keeps the search logic in one place.

### Who takes a waiting call

The waiting calls live in one first-in-first-out queue per rank. A queue is a line where items leave in the order they arrived. A call waits in the queue for its `min_rank`. When an employee frees up, `employee_freed()` checks the queues they're allowed to serve, starting with the most senior. A free director first takes calls escalated to directors, then calls escalated to supervisors, then ordinary calls. An operator can only take ordinary calls.

The reason is scarcity. Only directors can take a director-level call, so a free director should take one if any is waiting. Ordinary calls can be served by anyone, so they can wait for whoever frees up next.

## Solution

Here is the complete program. It uses only the standard library and runs on Python 3.9 or later.

```python
from __future__ import annotations

from abc import ABC, abstractmethod
from collections import deque
from enum import Enum, IntEnum


class Rank(IntEnum):
    """Employee ranks, lowest first. IntEnum lets us compare ranks with < and >=."""
    OPERATOR = 0
    SUPERVISOR = 1
    DIRECTOR = 2


class CallState(Enum):
    READY = "ready"              # created or just escalated, not yet placed
    QUEUED = "queued"            # waiting because nobody eligible is free
    IN_PROGRESS = "in progress"  # an employee is on the line
    COMPLETE = "complete"        # finished


class CannotEscalate(Exception):
    """Raised when the highest rank tries to pass a call on."""


class Call:
    def __init__(self, call_id: int, caller: str) -> None:
        self.call_id = call_id
        self.caller = caller
        self.min_rank = Rank.OPERATOR   # lowest rank allowed to take this call
        self.state = CallState.READY
        self.employee: Employee | None = None
        self.handled_by: list[str] = []  # everyone who has taken the call

    def __repr__(self) -> str:
        return f"Call({self.call_id}, {self.state.value}, min_rank={self.min_rank.name})"


class Employee(ABC):
    rank: Rank  # each concrete subclass sets this

    def __init__(self, employee_id: int, name: str) -> None:
        self.employee_id = employee_id
        self.name = name
        self.call: Call | None = None
        self.call_center: CallCenter | None = None  # set when the center hires them

    @property
    def is_free(self) -> bool:
        return self.call is None

    def take_call(self, call: Call) -> None:
        self.call = call
        call.employee = self
        call.state = CallState.IN_PROGRESS
        call.handled_by.append(self.name)

    def complete_call(self) -> Call:
        call = self._hang_up()
        call.state = CallState.COMPLETE
        self.call_center.employee_freed(self)
        return call

    def escalate_call(self) -> Call:
        target = self.escalation_rank()     # raises for a director, before anything changes
        call = self._hang_up()
        call.min_rank = target
        call.state = CallState.READY
        self.call_center.dispatch_call(call)  # find someone senior first
        self.call_center.employee_freed(self)  # then this employee picks up new work
        return call

    @abstractmethod
    def escalation_rank(self) -> Rank:
        """The rank a call goes to when this employee can't handle it."""

    def _hang_up(self) -> Call:
        if self.call is None:
            raise RuntimeError(f"{self.name} has no call")
        call, self.call = self.call, None
        call.employee = None
        return call

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.name})"


class Operator(Employee):
    rank = Rank.OPERATOR

    def escalation_rank(self) -> Rank:
        return Rank.SUPERVISOR


class Supervisor(Employee):
    rank = Rank.SUPERVISOR

    def escalation_rank(self) -> Rank:
        return Rank.DIRECTOR


class Director(Employee):
    rank = Rank.DIRECTOR

    def escalation_rank(self) -> Rank:
        raise CannotEscalate("Directors handle every call")


class CallCenter:
    def __init__(self, employees: list[Employee]) -> None:
        self.staff: dict[Rank, list[Employee]] = {rank: [] for rank in Rank}
        self.waiting: dict[Rank, deque[Call]] = {rank: deque() for rank in Rank}
        for employee in employees:
            self.hire(employee)

    def hire(self, employee: Employee) -> None:
        employee.call_center = self
        self.staff[employee.rank].append(employee)
        self.employee_freed(employee)  # a new hire can take a waiting call at once

    def dispatch_call(self, call: Call) -> Employee | None:
        """Give the call to the lowest eligible rank with someone free, else queue it."""
        for rank in Rank:
            if rank < call.min_rank:
                continue
            employee = self._first_free(rank)
            if employee is not None:
                employee.take_call(call)
                return employee
        call.state = CallState.QUEUED
        self.waiting[call.min_rank].append(call)
        return None

    def employee_freed(self, employee: Employee) -> None:
        """Hand a newly free employee the most senior call they are allowed to take."""
        if not employee.is_free:
            return
        for rank in sorted(Rank, reverse=True):
            if rank <= employee.rank and self.waiting[rank]:
                employee.take_call(self.waiting[rank].popleft())
                return

    def queued_calls(self) -> int:
        return sum(len(q) for q in self.waiting.values())

    def _first_free(self, rank: Rank) -> Employee | None:
        for employee in self.staff[rank]:
            if employee.is_free:
                return employee
        return None
```

The key parts:

- **Routing a call.** `dispatch_call()` walks the ranks from lowest to highest, skipping any below the call's `min_rank`. It gives the call to the first free employee it finds. A new call therefore goes to an operator when one is free, then spills over to a supervisor, then a director. If nobody eligible is free, the call is marked `QUEUED` and joins the queue for its `min_rank`.
- **Escalating.** `escalate_call()` first asks `escalation_rank()` where the call should go. For a director that raises `CannotEscalate` before anything has changed, so the call stays with the director. Otherwise the employee hangs up, the call's `min_rank` goes up, and the call center places it again. Only after that does the employee look for new work. That order matters: the call has already left, so the employee can't pick it straight back up from the queue.
- **Completing.** `complete_call()` hangs up, marks the call `COMPLETE` and tells the call center that the employee is free. The call center then gives them the most senior waiting call they're allowed to take, if any.
- **Hiring.** `hire()` links the employee to the call center and immediately offers them a waiting call. A new hire on a busy morning starts working at once.
- **Shared code in the base class.** `take_call()`, `complete_call()`, `escalate_call()` and `_hang_up()` are written once in `Employee`. Each subclass is only a few lines long. Adding a fourth rank such as "manager" means one new enum value and one new subclass.

### Mistakes this code avoids

Code for this question often has the right shape and still fails when you run it. These are the usual traps, and how this version avoids each one:

- **Constructors that need the call center.** If every employee needs the call center passed to its constructor, it's easy to forget an argument or name the wrong class in `super()`, and then no employee can be created. Here `hire()` sets the call center, so employees can be created first.
- **Two names for one idea.** If escalation sets an attribute called `level` while routing reads one called `rank`, an escalated call is routed as if it was never escalated. Here both use `min_rank`.
- **Employees who never become free.** If completing a call doesn't clear the employee's current call, every employee stays busy after their first call. `_hang_up()` clears it.
- **Empty methods.** The steps for escalated, completed and queued calls are the heart of the design, and they're the easiest to leave as stubs. Here they're implemented as `dispatch_call()` and `employee_freed()`.
- **One shared queue for every rank.** With one queue, a freed operator can pull out a call that needs a director. Here there's one queue per rank, and an employee only takes calls at or below their rank.
- **`raise NotImplemented(...)`.** `NotImplemented` is a special value, not an exception class, so that line fails with a `TypeError`. Here the director's refusal raises a dedicated `CannotEscalate` exception.
- **A call on hold that looks like any other.** A `QUEUED` state tells a waiting call apart from one that was just escalated and is about to be placed.

## Walking through an example

Take a small team: two operators (Ana and Ben), one supervisor (Sam) and one director (Dee). Five calls arrive one after another.

```python
ana, ben = Operator(1, "Ana"), Operator(2, "Ben")
sam = Supervisor(3, "Sam")
dee = Director(4, "Dee")
center = CallCenter([ana, ben, sam, dee])

calls = [Call(i, f"caller-{i}") for i in range(1, 6)]
for call in calls:
    print(call.call_id, center.dispatch_call(call))
```

1. Call 1 goes to Ana and call 2 to Ben, the two operators.
2. Call 3 is an ordinary call, but both operators are busy, so it spills over to Sam.
3. Call 4 spills over again, to Dee.
4. Call 5 finds everyone busy. `dispatch_call()` returns `None` and the call waits in the operator queue with state `QUEUED`.

Now the calls start to move.

5. Ana can't solve call 1 and calls `ana.escalate_call()`. The call's `min_rank` becomes `SUPERVISOR`. Sam and Dee are both busy, so call 1 waits in the supervisor queue. Ana is now free, and `employee_freed(ana)` hands her call 5 from the operator queue. The caller on hold is finally answered.
6. Sam finishes call 3 with `sam.complete_call()`. Sam checks the supervisor queue first and finds call 1, so call 1 is now in progress with Sam.
7. Sam can't solve call 1 either and escalates it. Its `min_rank` becomes `DIRECTOR`. Dee is busy, so call 1 waits in the director queue. Sam checks the supervisor and operator queues, finds both empty, and stays free.
8. Dee finishes call 4. The director queue holds call 1, so Dee takes it.
9. Dee completes call 1. Its `handled_by` list reads `['Ana', 'Sam', 'Dee']`, and `center.queued_calls()` is 0.

If Dee tried `dee.escalate_call()` in step 9, the call would raise `CannotEscalate` and the call would stay with Dee, unchanged.

Notice step 7. Sam, the only supervisor, was busy with call 3, an ordinary call that had spilled over from the operators, while call 1 waited for a supervisor. Overflow made the escalated caller wait longer. The next section discusses that trade-off.

## Design choices and trade-offs

**Escalation: a chain of responsibility or a dispatcher.** Chain of responsibility is a design pattern in which a request is passed along a chain of handlers, and each handler either deals with it or passes it to the next one. Escalation looks like that chain: operator, then supervisor, then director. A literal version would give each employee a link to the next employee. This design keeps the chain as data instead. Each employee class only names the next *rank*, and a central dispatcher, the `CallCenter`, picks which person at that rank gets the call. Links between individual people break as soon as that person is busy, on leave or replaced. A dispatcher can pick any free person, queue the call, and track waiting time in one place. The cost is that `CallCenter` becomes the class that knows most things, so keep it focused on routing.

**Inheritance for ranks or a rank field.** We used a subclass per rank. A simpler design would have one `Employee` class with a `rank` field and an `escalation_rank` looked up from a table. With only three ranks that differ in a single rule, both are fine, and the field version is shorter. Subclasses earn their place when the ranks start to behave differently. Directors might approve refunds, and supervisors might be able to listen in on calls. Interviewers usually want to see that you know both options and why you picked one. A good answer is "subclasses, because behavior will diverge; a field if it's only data."

**Overflow to senior staff.** Sending ordinary calls up to supervisors when operators are busy answers callers sooner. As step 7 showed, it can also tie up the only people who can take escalated calls. A real center might keep one supervisor out of the overflow pool, or let senior staff take overflow only when their own queue is empty. Our `employee_freed()` already prefers senior work when someone frees up. A stricter rule would also stop `dispatch_call()` from spilling over while any escalated call is waiting.

**Where escalated callers wait.** An escalated call joins the back of its rank's queue. That's fair by the rule "first in, first out," but the caller may already have waited once. Putting escalated calls at the front would be kinder, and it's a one-line change (`appendleft` instead of `append`). We kept plain first-in-first-out order because the constraints said there's no line-jumping.

**Enums instead of strings or numbers.** `Rank.SUPERVISOR` can't be misspelled the way the string `"supervisr"` can, and an editor can list every valid value. `IntEnum` adds ordering, which the routing loop relies on.

## Extensions and follow-up questions

**Priorities.** Suppose VIP callers now jump the line. Replace each rank's `deque` with a priority queue from `heapq`, keyed on (priority, arrival number). The arrival number breaks ties so that callers with equal priority stay in first-in-first-out order. Watch for starvation, where low-priority callers wait forever behind a steady stream of VIPs. A common fix is to raise a call's priority the longer it waits. [Queues and asynchronous work](/learn/queues-and-async#priorities) covers priority queues in more depth.

**Skills-based routing.** Real centers route by skill as well as rank: billing questions to billing staff, Spanish speakers to Spanish-speaking staff. Give each employee a set of skills and each call a set of required skills. `dispatch_call()` then looks for a free employee whose skills cover the call's. The waiting lines can no longer be one per rank. One option is a queue per combination of skills that actually occurs, and another is to scan a single queue for the oldest call the freed employee can handle.

**Concurrency.** Our code assumes calls arrive one at a time. In a real phone system, events arrive on many threads at once. Two threads could both see Ben as free and give him two calls. The simplest fix is a single `threading.Lock` held inside `dispatch_call()` and `employee_freed()`, so only one routing decision happens at a time. Routing is fast compared with a phone call, so one lock is rarely the bottleneck. Another option is to run the call center as one event loop that handles one event at a time.

**Persistence.** If the process restarts, every queued call disappears. Store calls and their states in a database, write a row whenever a call changes state, and rebuild the queues from the `QUEUED` rows on start-up. The same rows give you reporting for free: average waiting time, how often each rank escalates, and how long calls last.

**Abandoned calls.** Callers hang up while on hold. Add an `ABANDONED` state and a `cancel(call)` method that removes the call from its queue. Removing from the middle of a `deque` is slow for long queues, so a common trick is to mark the call cancelled and skip it when it reaches the front.

**Making it a distributed system.** A national support line has thousands of agents in many offices, so one in-memory `CallCenter` can't hold them all. The queues move out of the program into a message queue or a shared store, and each rank or skill gets its own queue. Agents' desktops pull calls from the queues they are allowed to serve, which is the same rule `employee_freed()` follows. The telephony system pushes new calls in. You then have to handle questions the single program never faced:

- What happens to a call if the agent's desktop crashes after taking it? The queue should only delete a call once the agent confirms it, and redeliver it after a timeout.
- How does each agent's presence ("free", "busy", "on break") reach the router quickly? Usually through heartbeats, small "I'm still here" messages sent every few seconds.
- How do you measure waiting time across all the queues?

[Queues and asynchronous work](/learn/queues-and-async) explains acknowledgements, redelivery and back pressure, the tools for those questions. For more practice in the same style, try the [deck of cards](/learn/ood-deck-of-cards) and [parking lot](/learn/ood-parking-lot) designs.

## Check yourself

<details>
<summary>An operator escalates a call while every supervisor and director is busy. Trace what happens to the call and to the operator.</summary>

The call's `min_rank` becomes `SUPERVISOR` and `dispatch_call()` tries supervisors, then directors. Nobody is free, so the call is marked `QUEUED` and joins the supervisor queue. The operator is now free, so `employee_freed()` gives them the oldest ordinary call waiting in the operator queue, if there is one. The escalated call can't come back to the operator, because the operator's rank is below the call's `min_rank`.

</details>

<details>
<summary>Why does `escalate_call()` re-dispatch the call before it calls `employee_freed()` for the employee who escalated?</summary>

If the employee looked for work first, they would be free while the call was still unplaced. For an operator that's harmless, because the call needs a supervisor. But the order makes the rule obvious and safe for every rank: the escalated call is placed or queued first, and only then does the employee take new work. It also means the call gets first chance at any free senior employee before anything else changes.

</details>

<details>
<summary>A director, a supervisor-level call and an ordinary call are all waiting when the director frees up. Which call does the director take, and why?</summary>

The supervisor-level call, assuming no director-level call is waiting. `employee_freed()` checks queues from the most senior rank the employee can serve downward. Ordinary calls can be served by anyone who frees up later, but a supervisor-level call can only be served by supervisors or directors, which are scarcer. Serving the scarcest work first keeps the hardest calls from waiting the longest.

</details>

<details>
<summary>When would you replace the three employee subclasses with a single `Employee` class and a `rank` field?</summary>

When the ranks differ only in data. If the only difference is which rank comes next, a field and a small lookup table are shorter and just as clear. Subclasses are worth it when the ranks gain different behavior, such as directors approving refunds or supervisors monitoring calls. In that case each class keeps its own rules, and nothing else has to check the rank with `if` statements.

</details>

<details>
<summary>Two threads route calls at the same moment and both give a call to Ben. What went wrong, and what's the simplest fix?</summary>

Both threads read `ben.is_free` as true before either one called `take_call()`. This is a race condition: the result depends on the timing of the two threads. The simplest fix is one lock that every routing operation holds, so checking for a free employee and assigning the call happen as one step that no other thread can interrupt.

</details>

<details>
<summary>The call center grows to 5,000 agents in ten offices. What replaces the `waiting` dictionary, and what new failure do you have to handle?</summary>

A shared message queue or store, with a queue per rank or skill, that every office's router and agent desktops can reach. The new failure is a crash partway through: an agent's desktop takes a call and then dies. The queue should only delete the call after the agent confirms it is being handled, and redeliver it to someone else if no confirmation arrives in time.

</details>

## Further reading

- [abc: Abstract Base Classes](https://docs.python.org/3/library/abc.html): Python's documentation for `ABC` and `@abstractmethod`, which make `Employee` impossible to create on its own.
- [enum: Support for enumerations](https://docs.python.org/3/library/enum.html): how `Enum` and `IntEnum` work, including why `IntEnum` members can be compared with `<`.
- [Chain of Responsibility (Refactoring.Guru)](https://refactoring.guru/design-patterns/chain-of-responsibility): an illustrated explanation of the pattern escalation resembles, with its pros and cons.
- [threading: Lock objects](https://docs.python.org/3/library/threading.html#lock-objects): the lock you'd add to make routing safe with several threads.
- [Queues and asynchronous work](/learn/queues-and-async): the handbook chapter on the message queues a distributed call center would be built on.
