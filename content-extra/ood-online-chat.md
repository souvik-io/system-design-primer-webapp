# Design a chat server

Ana wants to message her friend Ben. First she has to find him and send a friend request, and Ben has to accept it. Then the two of them can talk in a private chat. Later Ben starts a group chat called "Weekend hike" and invites Ana and another friend, Cy. Every message in every chat has to land in the right place, in order, and only people who belong in a chat may post in it.

"Design a chat server" here is an **object-oriented design** question: model this small world in code, without servers or databases. A good answer has four parts. Clarify the scope with a few questions, name the classes and what each one is responsible for, write the code, and then discuss extensions. The interviewer is listening for clean responsibilities, state that can't get out of step, and sensible trade-offs. Building the real, distributed service is a different question, covered in [Design a chat system](/learn/design-chat-system).

## Constraints and assumptions

Ask these questions first. We'll focus on the workflows below.

- **What kind of conversations?** Text conversations only. *Why it matters:* a message is just text plus a sender and a time, so there are no attachments, media types or uploads to model.
- **What can we do with users?** Add a user, remove a user and update a user. *Why it matters:* removing a user has knock-on effects on friends, pending requests and group chats, so some class must own the clean-up.
- **How do friendships work?** A user adds someone to their friends list by sending a friend request. The other user approves or rejects it. A user can also remove someone from their friends list. *Why it matters:* a request has a life of its own, with states and a timestamp, so it deserves a class and a status enum.
- **What can we do with group chats?** Create a group chat, invite friends to it, and post a message to it. *Why it matters:* membership changes over time, so the group needs to add and remove members, and posting must check membership.
- **What can we do with private chats?** Invite a friend to a private one-to-one chat, and post a message to it. *Why it matters:* a private chat has exactly two members, fixed at creation, which is a different rule from a group. Two kinds of chat with shared behaviour and different rules is a hint to use a base class.
- **How big does this need to be?** No need to worry about scaling initially. *Why it matters:* everything can live in memory in one process, so we can focus on the model.

We add a few assumptions of our own and say them out loud:

- You can only chat privately with friends, and you can only invite your own friends to a group.
- There is at most one private chat per pair of users. Opening it again returns the same chat, with its history.
- If two people unfriend each other, their private chat keeps its history but nobody can post in it.
- A user's password is stored only as a hash (see [storing passwords](/learn/security-101#storing-passwords)). Logging in is out of scope.
- Delivering messages to devices, read receipts and presence are out of scope at first. They're extensions.

## Class design

```diagram
title: The service owns users and chats. Users hold friendships and requests; chats hold members and messages.
[svc] UserService @ 0,0
[user] User @ 2,0
[req] FriendRequest @ 4,0
[status:note] RequestStatus\nenum @ 4,1
[chat] Chat\n(abstract) @ 2,1.5
[msg] Message @ 4,2.2
[priv] PrivateChat\n2 members @ 1,3
[group] GroupChat\nmany members @ 3,3
svc -> user : users_by_id
svc -> chat : chats_by_id
user -> req : sent / received
req -> status
user -> chat : member of
chat -> msg : has many
priv -> chat
group -> chat
```

Each class has one job:

- **`UserService`** is the entry point. It owns every user and every chat, hands out ids, and performs every operation that touches two users at once: sending and answering friend requests, unfriending, opening chats, inviting, posting and removing a user. Putting those operations in one place means both sides of a friendship are always updated together.
- **`User`** holds one person's state: id, name, password hash, friends, their private chats keyed by friend id, their group chats keyed by chat id, and the friend requests they've sent and received. It answers simple questions about itself, such as `is_friend` and `pending_requests`.
- **`FriendRequest`** records who asked whom, when, and where the request stands.
- **`RequestStatus`** is an **enum**, a fixed set of named values: `UNREAD`, `READ`, `ACCEPTED` and `REJECTED`. The first two are "pending": the request is waiting for an answer. The last two are final.
- **`Chat`** is an **abstract base class**, a class that defines shared behaviour but can't be created on its own. It holds the members and the messages and implements `post`. It leaves two **abstract methods** for each kind of chat to fill in: `can_post` (who may post) and `title_for` (what the chat is called in a given user's list).
- **`PrivateChat`** and **`GroupChat`** are subclasses. A private chat has two fixed members, lets either post only while they're still friends, and is titled with the other person's name. A group chat has a name and a changing set of members, and lets any current member post. This is **polymorphism**: `Chat.post` calls `self.can_post(sender)` and gets the right rule for whichever kind of chat it is.
- **`Message`** is a simple record: an id, the sender's id, the text and a timestamp.

The relationships are **composition** (the service owns users and chats, a chat owns its messages) plus references between users and chats in both directions, so you can go from a chat to its members and from a user to their chats.

## Solution

```python
from __future__ import annotations

import itertools
import time
from abc import ABC, abstractmethod
from enum import Enum
from typing import Callable


class RequestStatus(Enum):
    UNREAD = "unread"      # sent, recipient hasn't looked yet
    READ = "read"          # recipient has seen it, no decision yet
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class FriendRequest:
    def __init__(self, from_user_id: int, to_user_id: int, timestamp: float) -> None:
        self.from_user_id = from_user_id
        self.to_user_id = to_user_id
        self.status = RequestStatus.UNREAD
        self.timestamp = timestamp

    def is_pending(self) -> bool:
        return self.status in (RequestStatus.UNREAD, RequestStatus.READ)


class Message:
    def __init__(self, message_id: int, sender_id: int, text: str, timestamp: float) -> None:
        self.message_id = message_id
        self.sender_id = sender_id
        self.text = text
        self.timestamp = timestamp


class User:
    def __init__(self, user_id: int, name: str, pass_hash: str) -> None:
        self.user_id = user_id
        self.name = name
        self.pass_hash = pass_hash  # a hash, never the password itself
        self.friends_by_id: dict[int, User] = {}
        self.private_chats_by_friend_id: dict[int, PrivateChat] = {}
        self.group_chats_by_id: dict[int, GroupChat] = {}
        self.received_requests: dict[int, FriendRequest] = {}  # key: sender id
        self.sent_requests: dict[int, FriendRequest] = {}      # key: recipient id

    def is_friend(self, other: User) -> bool:
        return other.user_id in self.friends_by_id

    def pending_requests(self) -> list[FriendRequest]:
        """What the user sees in their inbox. Viewing marks UNREAD as READ."""
        pending = [r for r in self.received_requests.values() if r.is_pending()]
        for request in pending:
            request.status = RequestStatus.READ
        return pending


class Chat(ABC):
    def __init__(self, chat_id: int) -> None:
        self.chat_id = chat_id
        self.members: dict[int, User] = {}
        self.messages: list[Message] = []

    @abstractmethod
    def can_post(self, user: User) -> bool:
        """Each kind of chat decides who may post."""

    @abstractmethod
    def title_for(self, user: User) -> str:
        """What this chat is called in the given user's chat list."""

    def post(self, message: Message) -> None:
        sender = self.members.get(message.sender_id)
        if sender is None or not self.can_post(sender):
            raise PermissionError(f"user {message.sender_id} can't post in chat {self.chat_id}")
        self.messages.append(message)


class PrivateChat(Chat):
    def __init__(self, chat_id: int, first: User, second: User) -> None:
        super().__init__(chat_id)
        self.members = {first.user_id: first, second.user_id: second}

    def other(self, user: User) -> User:
        return next(u for u in self.members.values() if u is not user)

    def can_post(self, user: User) -> bool:
        return user.is_friend(self.other(user))  # unfriending closes the chat

    def title_for(self, user: User) -> str:
        return self.other(user).name


class GroupChat(Chat):
    def __init__(self, chat_id: int, name: str, creator: User) -> None:
        super().__init__(chat_id)
        self.name = name
        self.add_member(creator)

    def add_member(self, user: User) -> None:
        self.members[user.user_id] = user
        user.group_chats_by_id[self.chat_id] = self

    def remove_member(self, user: User) -> None:
        self.members.pop(user.user_id, None)
        user.group_chats_by_id.pop(self.chat_id, None)

    def can_post(self, user: User) -> bool:
        return user.user_id in self.members

    def title_for(self, user: User) -> str:
        return self.name


class UserService:
    """Owns all users and chats, and every operation that touches two users."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self.users_by_id: dict[int, User] = {}
        self.chats_by_id: dict[int, Chat] = {}
        self._clock = clock
        self._next_user_id = itertools.count(1)
        self._next_chat_id = itertools.count(1)
        self._next_message_id = itertools.count(1)

    # --- users ---
    def add_user(self, name: str, pass_hash: str) -> User:
        user = User(next(self._next_user_id), name, pass_hash)
        self.users_by_id[user.user_id] = user
        return user

    def update_user(self, user_id: int, name: str | None = None,
                    pass_hash: str | None = None) -> User:
        user = self.users_by_id[user_id]
        if name is not None:
            user.name = name
        if pass_hash is not None:
            user.pass_hash = pass_hash
        return user

    def remove_user(self, user_id: int) -> None:
        user = self.users_by_id[user_id]
        for friend in list(user.friends_by_id.values()):
            self.remove_friend(user_id, friend.user_id)
        for other_id in list(user.sent_requests):
            self.users_by_id[other_id].received_requests.pop(user_id, None)
        for other_id in list(user.received_requests):
            self.users_by_id[other_id].sent_requests.pop(user_id, None)
        for group in list(user.group_chats_by_id.values()):
            group.remove_member(user)
        del self.users_by_id[user_id]

    # --- friends ---
    def send_friend_request(self, from_id: int, to_id: int) -> FriendRequest:
        sender, recipient = self.users_by_id[from_id], self.users_by_id[to_id]
        if from_id == to_id or sender.is_friend(recipient):
            raise ValueError("already friends, or the same user")
        if from_id in recipient.sent_requests and recipient.sent_requests[from_id].is_pending():
            # They already asked us: treat our request as accepting theirs.
            self.approve_friend_request(to_id, from_id)
            return recipient.sent_requests[from_id]
        request = FriendRequest(from_id, to_id, self._clock())
        sender.sent_requests[to_id] = request
        recipient.received_requests[from_id] = request
        return request

    def _pending_request(self, from_id: int, to_id: int) -> FriendRequest:
        request = self.users_by_id[to_id].received_requests.get(from_id)
        if request is None or not request.is_pending():
            raise ValueError(f"no pending request from {from_id} to {to_id}")
        return request

    def approve_friend_request(self, from_id: int, to_id: int) -> None:
        request = self._pending_request(from_id, to_id)
        request.status = RequestStatus.ACCEPTED
        sender, recipient = self.users_by_id[from_id], self.users_by_id[to_id]
        sender.friends_by_id[to_id] = recipient
        recipient.friends_by_id[from_id] = sender

    def reject_friend_request(self, from_id: int, to_id: int) -> None:
        self._pending_request(from_id, to_id).status = RequestStatus.REJECTED

    def remove_friend(self, user_id: int, friend_id: int) -> None:
        self.users_by_id[user_id].friends_by_id.pop(friend_id, None)
        self.users_by_id[friend_id].friends_by_id.pop(user_id, None)

    # --- chats ---
    def open_private_chat(self, user_id: int, friend_id: int) -> PrivateChat:
        user, friend = self.users_by_id[user_id], self.users_by_id[friend_id]
        if not user.is_friend(friend):
            raise PermissionError("you can only chat privately with friends")
        chat = user.private_chats_by_friend_id.get(friend_id)
        if chat is None:  # one private chat per pair, reused after that
            chat = PrivateChat(next(self._next_chat_id), user, friend)
            user.private_chats_by_friend_id[friend_id] = chat
            friend.private_chats_by_friend_id[user_id] = chat
            self.chats_by_id[chat.chat_id] = chat
        return chat

    def create_group_chat(self, creator_id: int, name: str) -> GroupChat:
        chat = GroupChat(next(self._next_chat_id), name, self.users_by_id[creator_id])
        self.chats_by_id[chat.chat_id] = chat
        return chat

    def invite_to_group(self, chat_id: int, inviter_id: int, friend_id: int) -> None:
        chat = self.chats_by_id[chat_id]
        inviter, friend = self.users_by_id[inviter_id], self.users_by_id[friend_id]
        if not isinstance(chat, GroupChat) or inviter_id not in chat.members:
            raise PermissionError("only members of a group chat can invite")
        if not inviter.is_friend(friend):
            raise PermissionError("you can only invite your friends")
        chat.add_member(friend)

    def leave_group(self, chat_id: int, user_id: int) -> None:
        chat = self.chats_by_id[chat_id]
        if isinstance(chat, GroupChat):
            chat.remove_member(self.users_by_id[user_id])

    def post_message(self, chat_id: int, sender_id: int, text: str) -> Message:
        message = Message(next(self._next_message_id), sender_id, text, self._clock())
        self.chats_by_id[chat_id].post(message)
        return message

    def message_user(self, sender_id: int, friend_id: int, text: str) -> Message:
        chat = self.open_private_chat(sender_id, friend_id)
        return self.post_message(chat.chat_id, sender_id, text)
```

The key parts:

- **One owner for two-sided changes.** A friendship is stored on both users, and a private chat is filed under both users. If `User` methods changed only their own side, it would be easy to end up with Ana listing Ben as a friend while Ben doesn't list Ana. `UserService.approve_friend_request` and `remove_friend` change both sides in the same call, so they can't drift apart.
- **The request lifecycle.** `send_friend_request` creates a request with status `UNREAD` and files it under the sender's `sent_requests` and the recipient's `received_requests`. When the recipient views their inbox, `pending_requests` moves `UNREAD` requests to `READ`, which is how a client would show a "new" badge. Approving or rejecting is allowed only while the request is pending, so a rejected request can't be approved later by accident. The old request object stays, so the history is kept.
- **Crossing requests.** If Ben asks Cy while Cy's request to Ben is still pending, `send_friend_request` treats Ben's request as accepting Cy's. Without this rule, they'd have two pending requests and would both wait for the other.
- **Inviting to a private chat.** `open_private_chat` checks the two users are friends, then returns their existing chat or creates one and files it under both users. `message_user` is a convenience that opens the chat and posts in one step.
- **Inviting to a group.** `invite_to_group` checks that the inviter is a member and that the invitee is the inviter's friend. `GroupChat.add_member` also files the group under the new member's `group_chats_by_id`, so the reference goes both ways.
- **Posting.** `post_message` builds a `Message` with the next id and the current time, then `Chat.post` checks the sender is a member and that `can_post` allows it. A post that fails raises `PermissionError`, so the caller can show an error.
- **Removing a user.** `remove_user` unfriends everyone, deletes pending requests from both sides, leaves every group, and only then drops the user. Old messages keep the removed user's id, so the history still makes sense.
- **Testable time and ids.** The service takes a `clock` function, `time.time` by default, and counts ids with `itertools.count`. A test can pass a fake clock and get predictable timestamps.

## Walking through an example

```python
from online_chat import *

svc = UserService()
ana = svc.add_user("Ana", "pbkdf2$...a")
ben = svc.add_user("Ben", "pbkdf2$...b")
cy = svc.add_user("Cy", "pbkdf2$...c")

request = svc.send_friend_request(ana.user_id, ben.user_id)
print(request.status)                       # RequestStatus.UNREAD
ben.pending_requests()                      # Ben opens his inbox
print(request.status)                       # RequestStatus.READ
svc.approve_friend_request(ana.user_id, ben.user_id)
print(request.status, ana.is_friend(ben))   # RequestStatus.ACCEPTED True

svc.message_user(ana.user_id, ben.user_id, "Lunch?")
svc.message_user(ben.user_id, ana.user_id, "Yes, 1pm")
chat = ana.private_chats_by_friend_id[ben.user_id]
print(chat.title_for(ana), [m.text for m in chat.messages])

svc.send_friend_request(cy.user_id, ana.user_id)
svc.reject_friend_request(cy.user_id, ana.user_id)
svc.send_friend_request(ben.user_id, cy.user_id)
svc.approve_friend_request(ben.user_id, cy.user_id)

group = svc.create_group_chat(ben.user_id, "Weekend hike")
svc.invite_to_group(group.chat_id, ben.user_id, ana.user_id)
svc.invite_to_group(group.chat_id, ben.user_id, cy.user_id)
svc.post_message(group.chat_id, cy.user_id, "Saturday at 8?")
print(sorted(u.name for u in group.members.values()))
```

What happens, step by step:

1. **Three users join.** The service gives them ids 1, 2 and 3 and stores their password hashes (the hash strings here are placeholders).
2. **Ana sends Ben a friend request.** The request starts as `UNREAD`. It's stored in Ana's `sent_requests` under Ben's id and in Ben's `received_requests` under Ana's id.
3. **Ben opens his inbox.** `pending_requests` returns the request and marks it `READ`.
4. **Ben approves.** The request becomes `ACCEPTED`, and each user is added to the other's `friends_by_id`.
5. **They message each other.** The first `message_user` call finds no private chat, so it creates one, files it under both users and posts "Lunch?". Ben's reply reuses the same chat. Ana sees the chat titled "Ben", with both messages in order.
6. **Cy asks Ana, and Ana rejects.** The request becomes `REJECTED`, and they aren't friends, so neither could open a private chat with the other.
7. **Ben and Cy become friends, and Ben creates "Weekend hike".** Ben is its first member. He invites Ana and Cy, which works because both are his friends. Ana couldn't have invited Cy, because they aren't friends.
8. **Cy posts "Saturday at 8?".** Cy is a member, so the post succeeds. The group now has Ana, Ben and Cy.

The tests for this chapter also check the failure cases: messaging someone who isn't a friend, approving a request that was already rejected, posting after leaving a group, posting in a private chat after unfriending, and removing a user who still has a pending request.

## Design choices and trade-offs

**Logic in the service or in the user?** We keep `User` mostly as data and put the two-sided operations in `UserService`. The alternative puts methods like `send_friend_request` on `User`, which reads more naturally ("Ana sends a request") but means a user must reach into another user's state. The service also maps well to the real system later, where it becomes an API backed by a database.

**References or ids?** We store `User` objects in `friends_by_id` and chat members. That's convenient in memory: `chat.title_for(ben)` can read Ana's name directly, and a rename shows up everywhere at once. Once the data moves to a database, these become ids that you look up, and caching a name means accepting it can be briefly out of date.

**Two request states before the answer.** Keeping both `UNREAD` and `READ` costs an extra write when the inbox is viewed, but lets the client show which requests are new. If nobody needs that badge, one `PENDING` state is simpler.

**Unfriending and history.** We keep the private chat's messages and block new posts. Deleting the chat instead would be simpler and more private, but surprising if the two later become friends again. Either is defensible. What matters is that you choose and say so.

**Group membership rules.** We let any member invite their own friends. Real products often add roles: an owner who can remove people, admins, and a cap on group size. Those fit as fields on `GroupChat` and checks in `invite_to_group`, without changing `Chat`.

**Ordering by arrival.** Messages are appended to a list in the order `post` runs, and ids come from one counter. In one process that order is exact. Across many servers there's no single counter, which is one of the first problems the distributed design has to solve.

## Extensions and follow-up questions

**Delivery and read receipts.** Add a state to each message for each recipient: sent (the server stored it), delivered (a device received it) and read (the user saw it). Storing a receipt per message per reader gets expensive in groups. A cheaper model keeps one number per member per chat: "Ben has read up to message 1,042". Reading message 1,042 implies reading everything before it. XMPP, an open chat protocol, works the same way: its delivery receipts say only that a message reached a client, and its separate "displayed" marker means every message up to that one has been shown. See [delivery and read receipts](/learn/design-chat-system#delivery-and-read-receipts) for the full design.

**Presence.** Presence is the "online" dot. Add `last_seen` to `User`, updated by a heartbeat (a small "still here" message the client sends every half minute or so). A user counts as online if their last heartbeat is recent. The interesting question is who gets told when someone goes online, because telling every friend about every change gets expensive. See [presence](/learn/design-chat-system#presence).

**Persistence.** Everything above lives in memory and is lost on restart. The natural tables are `users`, `friend_requests`, `friendships` (one row per pair), `chats`, `chat_members` and `messages`. Messages are by far the largest and are always read "latest first, within one chat", so they're usually stored by `(chat_id, message_id)`. Message ids that sort by time need a scheme that works across machines. See [unique IDs](/learn/unique-ids).

**Growing into a distributed system.** Once there are millions of users, the classes split into services: a user and friendship service, a chat service that stores messages, and connection servers that hold an open connection to each online device and push new messages down it. Pushing needs a long-lived connection such as a WebSocket, covered in [real-time updates](/learn/realtime). When the sender's server and the recipient's server are different machines, a message has to be routed between them, which [getting a message to the right server](/learn/realtime#getting-a-message-to-the-right-server) explains. Users who are offline get a push notification instead (see [Design a notification system](/learn/design-notification-system)). The whole design is in [Design a chat system](/learn/design-chat-system).

**Other follow-ups worth a sentence each.** Editing and deleting messages (an `edited_at` field and a soft-delete flag). Blocking a user (a set of blocked ids checked in `send_friend_request` and `can_post`). Searching message history (an index, see [Design a search engine](/learn/design-search-engine)). Media messages (store the file elsewhere and put a link in the message).

## Check yourself

<details>
<summary>Why is approving a friend request a method on `UserService` instead of on `User`?</summary>

Because it changes two users at once. Ben must be added to Ana's friends and Ana to Ben's, and the request's status must change. If each user updated only their own side, a bug or a crash in between could leave a one-sided friendship. Putting the whole change in one service method keeps both sides in step, and it's the method that would later wrap a database transaction.

</details>

<details>
<summary>What are the four request states, and which transitions are allowed?</summary>

`UNREAD` when the request is sent, `READ` once the recipient has seen it, and then `ACCEPTED` or `REJECTED`. `UNREAD` can move to `READ`, and either of those can move to `ACCEPTED` or `REJECTED`. The last two are final: the code refuses to approve or reject a request that isn't pending.

</details>

<details>
<summary>`Chat` is abstract. What would go wrong if `PrivateChat` and `GroupChat` were one class with a `kind` field?</summary>

Every method that behaves differently would need an `if kind == "private"` branch: who may post, what the chat is called, whether members can be added. Adding a third kind, such as a broadcast channel where only the owner posts, would mean editing each of those branches. With an abstract base class, each kind supplies its own `can_post` and `title_for`, and a new kind is one new subclass.

</details>

<details>
<summary>Ana and Ben stop being friends. What happens to their private chat, and why?</summary>

The chat and its messages stay, filed under both users, but `PrivateChat.can_post` checks the friendship, so neither can post. That keeps the history if they become friends again, and it puts the rule in one place: nothing has to remember to close the chat when the friendship ends.

</details>

<details>
<summary>Ben sends Cy a friend request while Cy's request to Ben is still waiting. What should happen?</summary>

They clearly both want to be friends, so the second request should accept the first. Without that rule, each would have a pending request from the other, and both would wait. `send_friend_request` checks for a pending request in the other direction and approves it.

</details>

<details>
<summary>Which parts of this design change first when the chat has millions of users across many servers?</summary>

Message ids and ordering, because one in-memory counter no longer exists. Storage, because messages must survive restarts and outgrow one machine. Delivery, because the recipient may be connected to a different server, or offline. The classes survive as the data model and the service API, while the in-memory dictionaries become database tables and the method calls become network requests.

</details>

## Further reading

- [Design a chat system](/learn/design-chat-system): the same problem at scale, with connection servers, message storage, receipts, presence and group fan-out.
- [Real-time updates](/learn/realtime): polling, server-sent events and WebSockets, and how to route a message to the server that holds the recipient's connection.
- [RFC 6121: XMPP Instant Messaging and Presence](https://www.rfc-editor.org/rfc/rfc6121): the 2011 standard behind XMPP chat. Its presence subscriptions are friend requests by another name: a user asks, and the contact approves or denies.
- [XEP-0184: Message Delivery Receipts](https://xmpp.org/extensions/xep-0184.html): XMPP's delivery receipts, and a careful list of what a receipt does not prove.
- [XEP-0333: Displayed Markers](https://xmpp.org/extensions/xep-0333.html): XMPP's read markers, where marking one message as displayed covers every message before it.
- [abc: Abstract Base Classes](https://docs.python.org/3/library/abc.html): Python's documentation for `ABC` and `abstractmethod`, used here for `Chat`.
- [Design a parking lot](/learn/ood-parking-lot): the other object-oriented design question in the handbook, with vehicles, levels and runs of spots.
