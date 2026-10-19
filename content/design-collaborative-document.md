# Design a collaborative document editor (like Google Docs or Figma)

A collaborative editor lets several people change the same document at the same time and see each other's changes within a fraction of a second. There is no save button and no "someone else is editing this file" lock. Each person's keystrokes appear on their own screen at once, other people's edits stream in, and colored cursors show who is working where.

The hard part is concurrency. When two people edit the same sentence at nearly the same moment, each one's edit was made against a version of the text that didn't include the other's. The system has to merge both edits so that every screen ends up showing the same text, without locking the document and without throwing either edit away.

"Design Google Docs" is a classic interview question. This chapter covers how these editors work: the two main merge techniques, **Operational Transformation (OT)** and **Conflict-free Replicated Data Types (CRDTs)**; the WebSocket pipeline that carries edits; live cursors and presence; and how the document is stored. It builds on the chapters on [relational databases](/learn/relational-databases), [network protocols and APIs](/learn/protocols-and-apis), [real-time updates](/learn/realtime), [consensus](/learn/consensus) and [reliability patterns](/learn/reliability-patterns).

## The core concurrency problem

To see why this is hard, treat the text as an array of characters and have each client broadcast its edits as raw index operations.

Alice and Bob both start with `"CAT"`. At about the same moment:

- Alice types `H` at index 1, making `"CHAT"`. Her operation is `insert('H', 1)`.
- Bob deletes the character at index 2 (the `T`), making `"CA"`. His operation is `delete(2)`.

Each client applies its own edit at once, then receives the other's and applies it as is.

```diagram
title: Applying concurrent index operations as they arrive
[start:note] Start: "CAT" @ 1.5,0
[a1:note] Alice: insert\n('H', 1) → "CHAT" @ 0,1
[b1:note] Bob: delete(2)\n→ "CA" @ 3,1
[a2:note] Alice applies\ndelete(2) → "CHT" @ 0,2
[b2:note] Bob applies insert\n('H', 1) → "CHA" @ 3,2
start -> a1
start -> b1
a1 -> a2 : gets Bob's op
b1 -> b2 : gets Alice's op
```

- Alice ends with **`"CHT"`**. Her insert shifted `A` into index 2, so Bob's `delete(2)` removed the `A` instead of the `T`.
- Bob ends with **`"CHA"`**, which is what both of them meant.

The two copies have **diverged**, and nothing will bring them back together. An index only means something relative to the exact text it was computed against, and the two clients applied the operations in different orders. OT and CRDTs are two ways to fix this.

## Solution 1: Operational Transformation (OT)

Operational Transformation was introduced by Clarence Ellis and Simon Gibbs in 1989, for the GROVE group editor. The client-server form most products use comes from the Jupiter system at Xerox PARC (1995). Google Wave was built on it, and Google Docs uses OT with a central server.

In OT, edits stay as index operations such as `insert(char, pos)` and `delete(pos)`. A client applies its own edit locally at once, so typing never waits for the network. It then sends the operation to the server, tagged with the revision number of the document it was made against.

If the server has accepted other operations since that revision, it **transforms** the incoming operation against each of them before applying it. A transformation function takes two concurrent operations and returns a version of each that can be applied after the other:

```text
transform(a, b) → (a′, b′)    such that    apply(apply(doc, a), b′) = apply(apply(doc, b), a′)
```

For text, the rules mostly shift positions. An insert before your position moves you right by one; a delete before your position moves you left by one. When two inserts land at the same position, a fixed tie-break (for example, the lower client ID goes first) decides which comes first, so every replica makes the same choice.

### How OT resolves the example

1. The server receives Alice's `insert('H', 1)` first, against revision 0. Nothing has happened since, so it applies it as revision 1. The server's text is `"CHAT"`.
2. The server receives Bob's `delete(2)`, also against revision 0. Revision 1 has happened since.
3. Revision 1 inserted a character at index 1, before Bob's index 2, so the server shifts Bob's operation right by one: `delete(2)` becomes `delete(3)`.
4. `delete(3)` removes the `T`. The server's text is `"CHA"`, as revision 2.
5. The server sends `delete(3)` to Alice, whose text is `"CHAT"`, and she ends with `"CHA"`. It sends `insert('H', 1)` to Bob. Bob's client transforms it against his own `delete(2)`: the insert is at index 1, before the deleted position, so it stays `insert('H', 1)`, and Bob also ends with `"CHA"`.

Both clients converge on `"CHA"`.

On the client side, the usual protocol (from Jupiter, and used by Google Wave) keeps at most one operation in flight. While waiting for the server's ack, the client buffers further keystrokes into a pending operation. Each operation the server sends is transformed against the in-flight and pending operations before it is applied locally. This keeps the client's bookkeeping small: it only ever has to reconcile against one server history.

### Strengths and weaknesses of OT

- **Strengths:** the document is just text plus a revision log, with no extra data per character. With a central server that puts every operation in one order, the transformation functions only have to satisfy the simpler of OT's two correctness conditions. That combination is well understood and runs some of the largest editors in production.
- **Weaknesses:** transformation functions are easy to get subtly wrong, and the number of cases grows with every new operation type (formatting, tables, lists, comments). Several OT algorithms published for fully peer-to-peer use were later shown not to converge in some cases, because without a central order the functions must also satisfy a second, much harder condition. In practice that's why OT systems almost always route every edit through a server, which then becomes required for collaboration: two clients can't merge with each other directly.

## Solution 2: Conflict-free Replicated Data Types (CRDTs)

A CRDT avoids transformation by never using positions that shift. Instead of "insert at index 1", an insert says "insert this character, which has this permanent ID, right after the character with that ID". IDs never change, so an operation means the same thing no matter what else has happened to the document. Libraries such as **Yjs** and **Automerge** implement CRDTs for text and JSON-like documents.

There are two main ways to give characters stable identities:

- **Dense position identifiers** (Logoot, LSEQ). Each character's ID is a position that sorts between its neighbours. To insert between positions 1 and 2, a client picks something in between, like 1.5. Real implementations use variable-length lists of digits, not floating-point numbers, because repeated halving runs out of float precision after about 50 inserts in the same spot. The client's ID is appended to break ties.
- **Unique ID plus left neighbour** (RGA, and YATA, the algorithm behind Yjs). Each character gets an ID made of `(client ID, counter)` and records the ID of the character it was inserted after. Concurrent inserts after the same character are ordered by a deterministic rule on their IDs.

```diagram
title: Each character has a permanent position ID
[c:note] 'C'\nid 1 @ 0,0
[h:note] 'H'\nid 1.5 @ 1,0
[a:note] 'A'\nid 2 @ 2,0
[t:note] 'T'\nid 3 @ 3,0
c -> h
h -> a
a -> t
```

### How a CRDT resolves the example

Start with `C` = 1, `A` = 2, `T` = 3.

1. Alice inserts `H` between IDs 1 and 2, giving it ID 1.5 (tagged with her client ID). She sends "insert `H` at 1.5".
2. Bob deletes the `T`. He sends "delete ID 3".
3. Alice receives "delete ID 3" and hides the `T`: `"CHA"`.
4. Bob receives "insert `H` at 1.5" and places it between 1 and 2: `"CHA"`.

Neither operation had to be rewritten, and the order they arrived in didn't matter.

### The mechanics

1. **Deterministic tie-breaking.** If Bob also inserts a letter between 1 and 2 at the same moment and happens to pick the same position, the two IDs compare as `(1.5, alice)` and `(1.5, bob)`. Every replica sorts them the same way.
2. **Deletes leave tombstones.** A deleted character is marked deleted and hidden, but its ID stays in the structure. Another client may concurrently insert "after ID 3", and that insert still needs ID 3 to find its place. Tombstones accumulate over time, so implementations compact them once every replica is known to have seen the delete, or store deleted runs very compactly.
3. **Order-independent merging.** Concurrent operations commute: applying them in any order gives the same result. Operation-based CRDTs still expect each client's own operations in causal order (you can't delete a character before you've received its insert), which a sync protocol provides by buffering an operation until what it depends on has arrived. The guarantee is called **strong eventual consistency**: any two replicas that have received the same set of operations are in the same state.
4. **Metadata cost.** Each character carries an ID and a neighbour reference, many times the size of the character itself. Yjs keeps this manageable by storing a run of characters typed in sequence by one client as a single item.

Converging is not the same as preserving intent. If Alice types "Hello" and Bob types "World" at the same spot, some CRDT algorithms can interleave the letters into something like "HWeolrllod". Newer algorithms are designed to keep each run of typing together, and Martin Kleppmann's work on interleaving anomalies covers which ones do.

### Who uses what

Google Docs uses OT with a central server. Figma's multiplayer system is a useful middle case: its engineers describe it as inspired by CRDTs but not a true CRDT. Figma's server is the central authority, which lets it drop some of the overhead a fully decentralized CRDT needs. Many CRDT-based products also run a server per document, for authentication, persistence and fan-out. The CRDT then isn't avoiding a server; it's making offline editing and merging much simpler.

## System requirements and estimates

### Functional requirements

1. **Multiplayer editing:** several users edit the same document at once and see each other's changes in real time.
2. **Presence and cursors:** users see who else is in the document, with their cursors and selections.
3. **Revision history:** users can browse earlier versions and restore one.
4. **Offline support:** edits made while disconnected are merged when the client reconnects.

### Non-functional requirements

1. **Typing latency:** a keystroke shows on the typist's screen in the same frame, with no network round trip. Remote edits should show up for collaborators within about 100 ms in the same region, and within a few hundred milliseconds worldwide.
2. **Convergence:** once every client has received every edit, all copies are identical.
3. **Durability:** once the server acknowledges an edit, it must survive a browser crash or a server restart.

### Capacity estimates

These numbers are assumptions for a large product, not figures from any real one:

- **Documents:** 5 million documents edited per day.
- **Concurrent sessions:** at peak, 100,000 documents are open for editing, with an average of 3 people each. That's 100,000 × 3 = **300,000 open WebSocket connections**.
- **Edit rate:** people mostly read, pause and think. Assume that at any moment one person per open document is typing, at 5 characters a second. That's 100,000 × 5 = **500,000 operations a second** coming in at peak.
- **Fan-out:** each operation goes to the 2 other people in the document, so the servers send about 1,000,000 messages a second.
- **Bandwidth:** at roughly 100 bytes per message including framing, that's 500,000 × 100 B = 50 MB/s in and 1,000,000 × 100 B = 100 MB/s out, about 0.8 Gbit/s outbound. That is modest for a whole fleet.
- **Gateways:** if one gateway holds 50,000 connections, 300,000 ÷ 50,000 = 6 gateways. Run 10 or more, for headroom and so that one failure doesn't overload the rest.
- **Operation log:** if the daily average is a quarter of peak, that's 125,000 ops/s × 86,400 s ≈ 10.8 billion operations a day, or about 2,200 per edited document. At 100 bytes each, that's about **1.1 TB a day** before compression. That growth is why the log is regularly compacted into snapshots.

Network and connections are not the bottleneck. Each document's edits have to be put in order by one owner, so the design is shaped by routing every document to one coordinator and keeping the operation log durable.

## End-to-end architecture

```diagram
title: Collaborative editor architecture
[a:client] Alice @ 0,0
[b:client] Bob @ 0,2
[gw] WebSocket\ngateways @ 1,1
[redis:store] Redis\n(presence) @ 2,0
[collab] Collab worker\n(one per doc) @ 2,2
[log:queue] Operation log @ 3,2
[snap] Snapshot worker @ 4,2
[db:store] Snapshots\n(S3 + Postgres) @ 4,3
a <-> gw : WebSocket
b <-> gw : WebSocket
gw <-> redis : presence
gw <-> collab : edits
collab -> log : append
log --> snap
snap -> db : snapshot
```

### Component breakdown

1. **WebSocket gateways.** They hold long-lived connections to browsers, terminate TLS, answer heartbeats, and route each incoming message to the collaboration worker that owns its document. They keep no document state, so a dead gateway only costs its clients a reconnect.
2. **Collaboration worker.** Every open document has exactly one owning worker, chosen with [consistent hashing](/learn/consistent-hashing) or recorded in a registry with a lease. Only one owner may exist at a time: two workers each ordering edits for the same document would recreate the divergence problem, so ownership changes go through a lease or a [consensus](/learn/consensus)-backed lock. The owner:
   - loads the latest snapshot plus any later operations when the document is first opened;
   - holds the live document in memory (the OT revision history or the CRDT structure);
   - assigns each edit the next revision number, transforms it if needed (OT) or integrates it (CRDT), and appends it to the log;
   - broadcasts the accepted edit to the gateways serving the document's other users.
3. **Operation log.** An append-only log of accepted operations per document, in Kafka or a database table keyed by `(doc_id, revision)`. The worker acknowledges an edit to its sender only **after** the append is durable. Snapshots alone would lose the last 30 seconds of work on a crash; the log is what makes an acknowledged edit safe.
4. **Snapshot worker.** It reads the log and periodically writes a compressed snapshot of each document (for example every few hundred operations, or every 30 seconds while the document is being edited) to object storage, with its revision number and location in PostgreSQL. Opening a document loads the latest snapshot and replays the operations after it.
5. **Redis for presence.** Who is in the document, their color, and where their cursor is. This state is ephemeral and never goes into the log; see the presence section below.

### Revision history

Revision history falls out of the log and the snapshots. Version N is the nearest snapshot at or before N plus the operations up to N. Products don't show every keystroke as a version: they group operations into named or time-based checkpoints, such as "Alice, 10:42–10:51". Restoring an old version is done as a new edit that changes the current text to match the old one. It is not a rollback of the log, because other people may be editing at that moment.

## The typing and sync lifecycle

What happens between Alice typing a letter and Bob seeing it, with OT:

1. **Local render.** Alice types `k`. Her editor applies it at once. Nothing waits for the network.
2. **Send.** If no earlier operation is waiting for an ack, the client sends this one at once over the WebSocket, tagged with its base revision: `{op: insert('k', 41), rev: 4}`. If one is in flight, the keystroke joins the pending buffer, which goes out as one operation when the ack arrives. Fast typing is batched this way without a fixed timer.
3. **Order and transform.** The collab worker checks for operations after revision 4, transforms Alice's edit against them, and assigns it revision 5.
4. **Persist.** The worker appends revision 5 to the operation log.
5. **Broadcast and ack.** The worker sends the transformed operation to everyone else in the document, and sends Alice an ack for revision 5. Her client now sends its pending buffer, if there is one.
6. **Remote render.** Bob's client transforms the incoming operation against any of his own unacknowledged edits, applies it, and redraws.

Within one region, steps 2 to 6 take roughly one network round trip plus a durable append: tens of milliseconds.

With a CRDT the flow is the same apart from step 3. The worker doesn't need to transform anything; it integrates the operation into its copy and assigns a sequence number for the log.

### When a collab worker dies

Clients notice the dropped connection or a timeout. The document is assigned to a new worker, which loads the latest snapshot and replays the log to the last durable revision. Clients reconnect and resend every operation that was never acknowledged, each tagged with a client ID and client sequence number so that the new worker can drop any it already has. Because the old worker only acknowledged durable operations, nothing acknowledged is lost.

## Live presence: cursors and selections

Colored cursors and selections make collaboration feel live, but they are a different kind of data from the text:

- **Ephemeral.** If a cursor update is lost, the next one corrects it. Cursor updates never go into the operation log or the database. They go through Redis pub/sub (or directly through the collab worker) to the other users of the document, and Redis holds the last known position with a short TTL so a newcomer sees everyone at once.
- **Anchored to the text, not the screen.** A cursor is sent as a position in the document, not as `(x, y)` pixels, because each user's window width, font and zoom lay the text out differently. With OT it's an index transformed like any other position. With a CRDT it's a character ID, so it stays attached to the same character as text is inserted before it.
- **Throttled.** Selection changes and mouse movement can fire far more often than anyone needs to see. Clients send at most around 20 cursor updates a second (one per 50 ms), and only when something changed. Without throttling, cursor traffic can easily exceed edit traffic.
- **Smoothed.** The receiving client animates a remote cursor between updates, for example with a short CSS transition, so it glides instead of jumping.

## Offline editing and reconnection

Suppose someone edits on a plane and reconnects after making 200 edits while others made 1,000.

- **With OT,** the client sends its 200 operations, based on an old revision. Each one is transformed against the 1,000 server operations it missed: about 200 × 1,000 = 200,000 transform calls, a few milliseconds of CPU. That works, and Google Docs supports offline editing. The costs are that the server must keep enough history to transform against, and that the transformation rules for rich content (tables, lists, formatting) must be correct for every combination that can happen in a long divergence.
- **With a CRDT,** the client and server exchange **state vectors**: for each client ID, the highest counter each side has seen. Each side then sends the operations the other is missing, and both merge them. No history has to be transformed, and the merge would work the same way peer to peer.

Either way the documents converge, but neither technique knows what the user meant. If two people rewrote the same paragraph separately for an hour, the merged result contains both sets of changes woven together and may read badly. Products handle this in the interface: after a long offline session they can highlight what changed, or offer the offline edits as suggestions for someone to accept.

## Check yourself

<details>
<summary>Why can't a collaborative editor simply broadcast index operations like insert('H', 1) and apply them as they arrive?</summary>

An index only means something relative to the exact text it was computed against. If Alice inserts at index 1 while Bob deletes at index 2, Alice's insert shifts every later character right by one. When Bob's `delete(2)` reaches Alice, index 2 now holds a different character, so she deletes the wrong one. Bob applies Alice's insert to text without the `T`, which happens to be fine. The two copies end up different, and nothing later brings them back together.

</details>

<details>
<summary>What is the main difference between OT and CRDTs, and why do both kinds of product usually still run a server?</summary>

OT keeps edits as index operations and rewrites (transforms) each incoming operation against the concurrent ones it missed. Getting the transformation functions right is far easier when one server puts every operation in a single order, so OT systems route all edits through a server.

A CRDT gives every character a permanent ID, so operations refer to IDs that never shift. Concurrent operations commute and can be applied in any order, with no transformation, and replicas can merge peer to peer. The price is per-character metadata and tombstones.

Products using either one usually still run a server per document, for access control, durable storage, revision history and fanning edits out to everyone. With a CRDT the server is a convenience. With OT it's what makes the ordering correct.

</details>

<details>
<summary>When may the collab worker acknowledge an edit to the client, and why does the order matter?</summary>

Only after the edit has been appended durably to the operation log. The acknowledgement tells the client it can forget the edit. If the worker acknowledged first and crashed before the append, or relied only on snapshots taken every 30 seconds, the edit would be gone and the client would never resend it. With the append first, a crash before the ack just means the client resends the edit to the new worker, and its client sequence number lets the worker drop a duplicate.

</details>

<details>
<summary>Why are cursor positions handled separately from document edits?</summary>

They have different requirements. Edits are the document: they must be ordered, never lost, and stored. Cursor positions are ephemeral: a lost update is corrected by the next one, and nobody needs a cursor's history. Sending cursor movement through the operation log would add a large number of durable writes for data nobody reads again. So cursors go through an in-memory channel (Redis pub/sub or the collab worker), are throttled on the client, and are anchored to positions in the text, not to screen coordinates.

</details>

<details>
<summary>Two users offline for an hour both rewrite the same paragraph. Does a CRDT give a good result?</summary>

It gives a consistent result: once both sets of edits are merged, both users see the same text. It doesn't give a meaningful one. Both rewrites are kept and woven together by position, which may read as nonsense. Convergence is about replicas agreeing, not about understanding intent. That gap is handled in the product, for example by highlighting large merged changes or turning offline edits into suggestions someone reviews.

</details>

## Further reading

- [Operational transformation in real-time group editors: issues, algorithms, and achievements (Sun and Ellis, CSCW 1998)](https://dl.acm.org/doi/10.1145/289444.289469): transformation functions, the correctness conditions, and where earlier algorithms went wrong.
- [Conflict-free Replicated Data Types (Shapiro, Preguiça, Baquero and Zawirski, 2011)](https://hal.inria.fr/inria-00609399/document): the paper that defines state-based and operation-based CRDTs and strong eventual consistency.
- [CRDTs: The Hard Parts (Martin Kleppmann, 2020)](https://martin.kleppmann.com/2020/07/06/crdt-hard-parts-hydra.html): a talk on interleaving anomalies, moving items in lists, and metadata overhead.
- [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/): Figma's account of a central-server design inspired by CRDTs, with one process per document.
- [Yjs](https://github.com/yjs/yjs): an open-source CRDT library for text and structured documents, with WebSocket and peer-to-peer providers.
- [Google Wave operational transformation whitepaper (archived)](https://web.archive.org/web/20100724185208/http://waveprotocol.org/whitepapers/operational-transform): the client-server OT protocol Google Wave used, including the one-operation-in-flight rule.
- Clarence Ellis and Simon Gibbs, "Concurrency control in groupware systems", SIGMOD 1989: the paper that introduced operational transformation.
