# Design a deck of cards

Lay a standard pack of playing cards on the table: 52 cards, four suits (hearts, diamonds, clubs and spades), and in each suit an ace, the numbers 2 to 10, and a jack, queen and king. Poker, blackjack, bridge and solitaire all use the same pack, but each game gives the cards different meanings. In blackjack a king is worth 10 and an ace is worth 1 or 11. The question asks you to model the pack once, in a way any game can reuse, and then build blackjack on top of it.

This is an **object-oriented design question**. Object-oriented design (OOD) means describing a program as a set of objects, each holding its own data and offering a few operations on it. In the interview you clarify the scope with a few questions, name the classes and what each one is responsible for, write the code, and then discuss how the design would change if the requirements grew. What the interviewer judges is how you split the problem: which parts are shared by every card game, which belong to one game, and how the two connect.

## Constraints and assumptions

Ask these questions before writing any code. Each answer is what we assume for the rest of the chapter.

- **Is this a generic deck of cards for games like poker and blackjack?** Yes. Design a generic deck, then extend it to blackjack. This is the central requirement: the deck, card and hand classes must not contain blackjack rules, and blackjack must be added without changing them.
- **Can we assume the deck has 52 cards (2 to 10, jack, queen, king and ace) in 4 suits?** Yes. That fixes the data: 13 ranks times 4 suits. Jokers and decks of other sizes are out of scope, though the code shouldn't make them impossible.
- **Can we assume inputs are valid, or do we have to validate them?** Assume they're valid. We won't check for a rank of 14 or a card that appears twice, and the code stays focused on the design.

Two smaller assumptions fill gaps the questions leave open:

- Dealing from an empty deck returns `None` instead of raising an error. The caller decides what an empty deck means in its game.
- Shuffling gathers every card back into the deck, as you would between rounds at a real table.

## Class design

The nouns in the problem are suit, card, deck and hand. Each becomes a class. Blackjack adds a blackjack card, which knows its blackjack points, and a blackjack hand, which knows how to score aces.

```diagram
title: Classes for a generic deck and the blackjack extension.
[fy:note] fisher_yates() @ 0,0
[deck] Deck[C] @ 1,0
[card] Card @ 3,0
[suit:note] Suit (enum) @ 4,0
[hand] Hand[C] @ 1,1
[bjc] BlackjackCard @ 3,1
[bjh] BlackjackHand @ 1,2
deck -> fy : shuffles with
deck -> card : holds
card -> suit
hand -> card : holds
bjc -> card : is a
bjh -> hand : is a
bjh -> bjc : holds
```

- **`Suit`** is an enum, a type with a fixed set of named values: `HEARTS`, `DIAMONDS`, `CLUBS` and `SPADES`. Each value is the suit's symbol, so a card can print itself as `Q♠`.
- **`Card`** holds a rank and a suit. The rank is a number from 1 to 13: the ace is 1, the number cards are 2 to 10, and the jack, queen and king are 11, 12 and 13. Its `value` property gives the card's points in a game that doesn't say otherwise, which is just the rank. `Card` is a **frozen dataclass**: Python writes the constructor, equality and hashing for us, and nobody can change a card after it's made. A card is a value, like the number 7, so it shouldn't change.
- **`BlackjackCard`** is a subclass of `Card`. It overrides `value`: jacks, queens and kings are worth 10, and an ace is worth 1. Whether an ace should count as 11 depends on the rest of the hand, so the card leaves that decision to the hand. It adds `is_ace()` and `is_face_card()`.
- **`Deck[C]`** holds a list of cards and a `deal_index`, the position of the next card to deal. Cards before the index have been dealt. It can report `remaining_cards()`, `deal_card()` and `shuffle()`. It is **generic**: the `C` in `Deck[C]` stands for whichever card type the deck holds, so a `Deck[BlackjackCard]` deals blackjack cards. Its `standard()` method builds the usual 52 cards of any card type, or several packs at once.
- **`fisher_yates()`** is the shuffling function the deck uses. It's a plain function, separate from the deck, so it can be tested on its own.
- **`Hand[C]`** holds the cards one player has. It can `add_card()`, and its `score()` adds up the cards' values.
- **`BlackjackHand`** is a subclass of `Hand[BlackjackCard]`. It overrides `score()` with the blackjack rule for aces, and adds `possible_scores()`, `is_soft()`, `is_bust()` and `is_blackjack()`.

Three object-oriented ideas carry the design:

- **Inheritance** adds blackjack to the generic classes. `BlackjackCard` "is a" card and `BlackjackHand` "is a" hand. Code that works with any hand, such as printing it, still works with a blackjack hand.
- **Overriding** lets each game change one rule. The generic `score()` adds up values. The blackjack version replaces it, and nothing else changes.
- **Composition** connects the pieces. A deck "has" cards and a hand "has" cards. Neither is a kind of card.

### Blackjack scoring

These are the blackjack rules the code needs. Number cards are worth their pip value, the number printed on them. Face cards (jack, queen and king) are worth 10. An ace is worth 1 or 11, whichever the player prefers. A hand whose total goes over 21 is **bust** and loses. A **blackjack** is a two-card hand of an ace and a 10-value card, and in the Bicycle rules it pays 3 to 2. A hand is **soft** when it holds an ace that is being counted as 11. A soft hand can't bust by taking one more card, because the ace can drop back to 1.

The scoring rule follows from these. Count every ace as 1 to get the **hard total**. Each ace you raise to 11 adds 10. The hand's score is the highest possible total that is 21 or less. If every total is over 21, the hand is bust, and its score is the lowest total.

## Solution

Here is the complete program. It uses only the standard library and runs on Python 3.9 or later.

```python
from __future__ import annotations

import random
from dataclasses import dataclass
from enum import Enum
from typing import Generic, Optional, TypeVar


class Suit(Enum):
    HEARTS = "♥"
    DIAMONDS = "♦"
    CLUBS = "♣"
    SPADES = "♠"


RANK_NAMES = {1: "A", 11: "J", 12: "Q", 13: "K"}


@dataclass(frozen=True)
class Card:
    """A playing card. rank runs 1 to 13: ace = 1, 2-10, jack = 11, queen = 12, king = 13."""
    rank: int
    suit: Suit

    @property
    def value(self) -> int:
        """Points in a game that doesn't override them: the rank itself."""
        return self.rank

    def __str__(self) -> str:
        return f"{RANK_NAMES.get(self.rank, str(self.rank))}{self.suit.value}"


@dataclass(frozen=True)
class BlackjackCard(Card):
    def is_ace(self) -> bool:
        return self.rank == 1

    def is_face_card(self) -> bool:
        return 11 <= self.rank <= 13

    @property
    def value(self) -> int:
        """Face cards are 10. An ace is 1 here; the hand decides if it counts 11."""
        return 10 if self.is_face_card() else self.rank


C = TypeVar("C", bound=Card)


def fisher_yates(items: list, rng: random.Random) -> None:
    """Shuffle items in place so every order is equally likely."""
    for i in range(len(items) - 1, 0, -1):
        j = rng.randint(0, i)          # 0 <= j <= i, inclusive
        items[i], items[j] = items[j], items[i]


class Deck(Generic[C]):
    def __init__(self, cards: list[C], rng: Optional[random.Random] = None) -> None:
        self.cards = cards
        self.deal_index = 0                 # cards before this index have been dealt
        self.rng = rng or random.Random()

    @classmethod
    def standard(cls, card_type: type[C] = Card, num_decks: int = 1,
                 rng: Optional[random.Random] = None) -> Deck[C]:
        cards = [card_type(rank, suit)
                 for _ in range(num_decks) for suit in Suit for rank in range(1, 14)]
        return cls(cards, rng)

    def remaining_cards(self) -> int:
        return len(self.cards) - self.deal_index

    def deal_card(self) -> Optional[C]:
        if self.deal_index >= len(self.cards):
            return None
        card = self.cards[self.deal_index]
        self.deal_index += 1
        return card

    def shuffle(self) -> None:
        """Gather every card back into the deck and shuffle all of them."""
        self.deal_index = 0
        fisher_yates(self.cards, self.rng)


class Hand(Generic[C]):
    def __init__(self, cards: Optional[list[C]] = None) -> None:
        self.cards: list[C] = list(cards or [])

    def add_card(self, card: C) -> None:
        self.cards.append(card)

    def score(self) -> int:
        return sum(card.value for card in self.cards)

    def __str__(self) -> str:
        return " ".join(str(card) for card in self.cards)


class BlackjackHand(Hand[BlackjackCard]):
    BLACKJACK = 21

    def possible_scores(self) -> list[int]:
        """Every total the hand can make, counting each ace as 1 or 11."""
        hard = sum(card.value for card in self.cards)   # all aces as 1
        aces = sum(1 for card in self.cards if card.is_ace())
        return [hard + 10 * k for k in range(aces + 1)]  # k aces raised to 11

    def score(self) -> int:
        """The best total: the highest one not over 21, or the lowest if all bust."""
        scores = self.possible_scores()
        under = [s for s in scores if s <= self.BLACKJACK]
        return max(under) if under else min(scores)

    def is_soft(self) -> bool:
        """True when an ace is counted as 11 in the best total."""
        return self.score() != self.possible_scores()[0]

    def is_bust(self) -> bool:
        return self.score() > self.BLACKJACK

    def is_blackjack(self) -> bool:
        return len(self.cards) == 2 and self.score() == self.BLACKJACK
```

The key parts:

- **Building a deck.** `Deck.standard()` creates one card for every suit and rank, repeated `num_decks` times. Passing `BlackjackCard` as `card_type` gives a deck of blackjack cards, and the deck code itself doesn't know anything about blackjack.
- **Dealing.** `deal_card()` returns the card at `deal_index` and moves the index on by one. It never removes cards from the list, so `shuffle()` can bring them all back just by resetting the index to 0. `remaining_cards()` is the list's length minus the index.
- **Shuffling.** `shuffle()` resets the deck, then calls `fisher_yates()`, explained below. The deck takes an optional `random.Random` object, so a test can pass one with a fixed seed and get the same order every run.
- **Possible scores.** `BlackjackHand.possible_scores()` counts the aces and returns the hard total plus 0, 10, 20 and so on, one entry for each number of aces raised to 11. A hand of ace, ace, 9 has hard total 11 and possible scores `[11, 21, 31]`.
- **The best score.** `score()` keeps the totals that are 21 or less and returns the largest. If none is left, it returns the smallest, which is the hard total.
- **Soft hands.** `is_soft()` is true when the best score differs from the hard total, meaning an ace is being counted as 11.

### Mistakes this code avoids

Code for this question often has the right shape and still fails when you run it. These are the usual traps, and how this version avoids each one:

- **An abstract `value` on `Card`.** If `Card` declares `value` as abstract, plain cards can never be created, and the generic deck can only hold blackjack cards. Here `Card` has a sensible default value, and subclasses override it.
- **A sentinel that doesn't exist.** Scoring code that starts from `sys.MAXSIZE` crashes, because the constant is `sys.maxsize`. Here the score doesn't need a sentinel at all.
- **Empty methods.** `possible_scores()` and `shuffle()` are where the interesting logic lives, and they're the easiest to leave as stubs. Both are implemented here.
- **A missing `self`.** A method written without `self`, or one that reads `deal_index` without `self.`, fails as soon as it's called.
- **Two records of the same fact.** If each card carries an `is_available` flag that dealing sets to false and nothing sets back, the flag and the deck drift apart. Here the deck's `deal_index` is the only record of what has been dealt, so a card can't be "dealt" and "in the deck" at the same time.

## Walking through an example

This example stacks the deck, putting cards in a known order instead of shuffling, so the result is the same every time it runs. Cards are dealt alternately to the player and the dealer.

```python
S, H, D, C = Suit.SPADES, Suit.HEARTS, Suit.DIAMONDS, Suit.CLUBS
deck = Deck([BlackjackCard(1, S), BlackjackCard(13, H), BlackjackCard(6, C),
             BlackjackCard(4, D), BlackjackCard(9, D), BlackjackCard(5, S),
             BlackjackCard(12, C)])

player, dealer = BlackjackHand(), BlackjackHand()
for _ in range(2):                      # deal alternately: player, dealer
    player.add_card(deck.deal_card())
    dealer.add_card(deck.deal_card())

player.add_card(deck.deal_card())       # the player hits on soft 17

while dealer.score() < 17:              # the dealer draws to 17 or more
    dealer.add_card(deck.deal_card())
```

1. The player gets A♠ and 6♣. The hard total is 1 + 6 = 7. With one ace there are two possible scores, `[7, 17]`. The best one at or under 21 is 17, and since that counts the ace as 11, `is_soft()` is true. This is a soft 17.
2. The dealer gets K♥ and 4♦. The king counts 10, so the score is 14, with no aces and only one possible score.
3. The player takes another card, the 9♦. The hard total is now 1 + 6 + 9 = 16, and the possible scores are `[16, 26]`. 26 is over 21, so the score is 16, and the ace has dropped back to 1. The hand is no longer soft. The player didn't bust, which is why hitting a soft hand is safe.
4. The dealer follows a fixed rule: draw until the total is 17 or more. At 14, the dealer draws 5♠ and reaches 19, then stops.
5. The dealer wins, 19 to 16. One card, the Q♣, is left in the deck, so `remaining_cards()` is 1. One more `deal_card()` returns it, and the next returns `None`.

A few more hands show the edge cases:

| Hand | Possible scores | Score | Soft? | Blackjack? |
| --- | --- | --- | --- | --- |
| A, K | 11, 21 | 21 | yes | yes |
| 7, 7, 7 | 21 | 21 | no | no (three cards) |
| A, A | 2, 12, 22 | 12 | yes | no |
| A, A, A, A | 4, 14, 24, 34, 44 | 14 | yes | no |
| 10, Q, 5 | 25 | 25 | no | no, bust |

## Design choices and trade-offs

**Why the blackjack hand subclasses the generic hand.** Adding cards, holding them and printing them are the same in every game. Only scoring differs. Subclassing `Hand` lets `BlackjackHand` reuse everything and replace `score()` alone. A poker hand would be another subclass with its own `score()`, perhaps ranking pairs and flushes. The alternative is composition: one `Hand` class that takes a scoring function or "rules" object. Composition is better when the rules can change at run time, for example a casino app that switches between blackjack variants, or when a hand needs rules from two games at once. For a fixed set of games, the subclass is simpler.

**Why blackjack cards are a subclass too.** `BlackjackCard` exists so a blackjack card can say what it's worth. An alternative keeps `Card` game-neutral and puts a `card_points(card)` function in the blackjack code. That avoids a second card type, at the cost of the deck no longer telling you which game its cards belong to. Both are defensible. The subclass shows the idea the question is testing, and the generic `Deck[C]` keeps it from leaking into the deck.

**How to score aces.** There are three common ways:

- **List every combination.** Try each ace as 1 or 11. With n aces that is 2 to the power n combinations, many of them equal.
- **List the distinct totals.** Every ace is 1 plus an optional 10, so only the number of aces raised to 11 matters. That gives n + 1 totals: the hard total, plus 10, plus 20 and so on. This is what `possible_scores()` does.
- **Use the shortcut.** Two aces at 11 already make 22, which is bust, so at most one ace can ever count as 11. The best score is the hard total plus 10 if the hand has an ace and that stays at 21 or under, and the hard total otherwise. This is the fastest.

We used the second way because `possible_scores()` is useful in its own right, for example to display "7 or 17" to a player. We checked that it agrees with the shortcut on every hand of one to six cards.

**Tracking dealt cards with an index.** Popping cards off the list would also work, but the deck would then need another list to collect the dealt cards before the next shuffle. An index keeps every card in one list and makes "return all cards" a single assignment. A real game also lets players discard cards, and that would call for a separate discard pile.

**Immutable cards.** Because cards are frozen, two hands can hold the same card object safely, and cards can be stored in sets or used as dictionary keys.

## Extensions and follow-up questions

**Other games.** Poker needs a `PokerHand` whose score ranks the hand (pair, two pair, straight, flush and so on), and it may want the ace to rank above the king. A `PokerCard` could override `value` to make the ace 14. Bridge needs a hand that can be sorted by suit. Neither change touches `Deck` or `Hand`.

**Jokers and other decks.** A deck with jokers needs a card with no suit. Make `suit` optional, or add a `Joker` subclass. A 32-card deck that leaves out ranks 2 to 6 only needs a different factory method.

**Multiple decks.** Casino blackjack is often dealt from a **shoe**, a box holding several packs shuffled together. For example, the rules Ontario's gaming regulator sets for blackjack at fairs and exhibitions require six decks dealt from a dealing shoe. `Deck.standard(BlackjackCard, num_decks=6)` builds that 312-card shoe (6 × 52). Duplicate cards are now normal, so any check for "this card was already dealt" must count copies instead of looking for the card itself. The same rules place a plastic cutting card in the stack and require a reshuffle once the cutting card is reached and the hand in progress is finished. In our code that's a `cut_index` next to `deal_index`: when `deal_index` passes it, the game calls `shuffle()` before the next round.

**Fair shuffling with Fisher–Yates.** A shuffle is fair when every one of the 52! orders of the deck is equally likely. 52! is about 8.07 × 10^67. The Fisher–Yates shuffle does this. It was first described by Ronald Fisher and Frank Yates in 1938 as a pen-and-paper method. Richard Durstenfeld gave the computer version in 1964, and Donald Knuth popularized it as "Algorithm P". It walks from the last position down to the second. At each position i it picks a random position j from 0 to i, inclusive, and swaps the two. Each position is visited once, so it runs in O(n) time, meaning the work grows in step with the number of cards.

The easy mistake is choosing j from the whole list every time. With n cards that gives n^n equally likely sequences of swaps, and n^n can't be split evenly among the n! orders. For three cards there are 27 sequences and 6 orders. Running all 27 shows three orders coming up 5 times and three coming up 4 times, so some orders are 25% more likely than others. Shuffling three cards 60,000 times with our version gives each of the six orders close to 10,000 times.

**Python's `random.shuffle`.** You don't have to write Fisher–Yates yourself in Python. CPython's `random.shuffle` uses the same loop, from the last index down to 1, swapping with a random index from 0 to i. We wrote our own here to show the algorithm. Two caveats from Python's documentation apply to any shuffle driven by the `random` module:

- The generator underneath is the Mersenne Twister, with a period of 2^19937 − 1. A shuffle can't produce more orders than the generator has states, and the documentation notes that most orders of a long list can never be generated. It gives 2080 as the longest list whose orders all fit in that period. A 52-card deck needs only about 226 bits of state, so it's well inside the limit. Generators with only 32 bits of state reach a tiny fraction of the 52! orders.
- The `random` module is deterministic and must not be used for security. For a game with real money, where a player who works out the generator's state could predict the cards, use `random.SystemRandom`, which draws from the operating system's randomness source. Our `Deck` accepts any `random.Random` object, so `Deck.standard(rng=random.SystemRandom())` is all it takes.

**Dealer rules and house variations.** The walkthrough's dealer draws until 17. Casinos differ on whether the dealer also draws on a soft 17, so a `BlackjackRules` object holding settings like this, the number of decks and the blackjack payout keeps the variations out of the hand class.

For more practice, try the [call center](/learn/ood-call-center), [parking lot](/learn/ood-parking-lot) and [LRU cache](/learn/ood-lru-cache) designs.

## Check yourself

<details>
<summary>A hand holds A, A, 9. What does `possible_scores()` return, and what is the score?</summary>

The hard total, counting both aces as 1, is 1 + 1 + 9 = 11. With two aces there are three possible totals: 11, 21 and 31. The best total at or under 21 is 21, so the score is 21, with one ace counted as 11. The hand is soft, but it isn't a blackjack, because a blackjack has exactly two cards.

</details>

<details>
<summary>Why can at most one ace in a blackjack hand ever count as 11?</summary>

Two aces counted as 11 already add up to 22, which is over 21. Any hand with two aces at 11 is bust, and dropping one of them to 1 always gives a lower total. So the best score is the hard total, plus 10 if the hand has an ace and the result stays at 21 or under.

</details>

<details>
<summary>Why is `BlackjackHand` a subclass of `Hand`, and when would you choose composition instead?</summary>

Holding, adding and printing cards are the same in every game, and only scoring differs. The subclass reuses all of that and overrides `score()`. Choose composition, a single `Hand` that takes a rules object, when the rules must change at run time or when you need many variants of the same game. Then you swap the rules object without creating new classes.

</details>

<details>
<summary>A colleague's shuffle swaps each card with a card at a random position anywhere in the deck. Is it fair?</summary>

No. With n cards there are n^n equally likely sequences of swaps, and n^n isn't divisible by n!, so some orders come up more often than others. For three cards there are 27 sequences for 6 orders, and some orders appear 5 times while others appear 4. Fisher–Yates fixes this by choosing the swap position only from the cards not yet placed, which gives exactly n! equally likely outcomes.

</details>

<details>
<summary>How does the deck know which cards have been dealt, and how does `shuffle()` bring them back?</summary>

The deck keeps all of its cards in one list and a `deal_index` pointing at the next card to deal. Every card before the index has been dealt. `shuffle()` sets the index back to 0, which returns every card to the deck, and then shuffles the whole list.

</details>

<details>
<summary>An online casino uses `random.shuffle` with the default generator. What would you change, and why?</summary>

Use `random.SystemRandom` instead. The default generator is deterministic and Python's documentation says it isn't suitable for security purposes, so someone who works out its state from the cards they've seen could predict the next ones. `SystemRandom` draws from the operating system's randomness source, which doesn't have that weakness. With our design, that's one argument to `Deck.standard()`.

</details>

## Further reading

- [random: Generate pseudo-random numbers](https://docs.python.org/3/library/random.html): Python's documentation for `shuffle`, the Mersenne Twister's period, the note on long sequences, and `SystemRandom`.
- [CPython's `random.py`](https://github.com/python/cpython/blob/main/Lib/random.py): the source of `Random.shuffle`, a short Fisher–Yates loop worth reading.
- [Fisher–Yates shuffle (Wikipedia)](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle): the algorithm's history, its variants, the biased versions to avoid and the limits a random number generator puts on it.
- [Blackjack rules (Bicycle Cards)](https://bicyclecards.com/how-to-play/blackjack): card values, the blackjack payout and the dealer's drawing rule.
- [How to play blackjack (Duke University)](https://sites.math.duke.edu/~rtd/MEC/prob/blackjack.html): a short rules page from a Duke mathematics course, with a clear definition of a soft hand.
- [Hit soft 17 (PokerNews)](https://www.pokernews.com/casino/casino-terms/hit-soft-17.htm): the dealer rule that varies between casinos.
- [Rules of play: Blackjack (AGCO)](https://www.agco.ca/en/lottery-and-gaming/responsibilities-and-resources/fair-or-exhibition-event-licence-rules-play): the Alcohol and Gaming Commission of Ontario's rules for blackjack at fairs and exhibitions, including the six-deck shoe, the cutting card and when to reshuffle.
- [dataclasses](https://docs.python.org/3/library/dataclasses.html): how `@dataclass(frozen=True)` gives `Card` its constructor, equality, hashing and immutability.
