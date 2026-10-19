# Design a file sync service (like Dropbox or Google Drive)

A file sync service keeps a folder identical across a user's laptop, desktop and phone, and across everyone it's shared with. Save a file on one machine and, a few seconds later, it appears on the others. Users also expect older versions to be recoverable, edits made offline to sync when they reconnect, and nothing to be silently overwritten.

The question is a favorite because it separates two kinds of data with very different needs: small, constantly changing **metadata** (which files exist, where, at which version) that must be strongly consistent, and large, immutable **content** that just needs to be stored durably and moved efficiently. Most of the good ideas in the design come from keeping those two apart. It draws on the chapters on [relational databases](/learn/relational-databases) and [consistency](/learn/cap-and-consistency#the-consistency-spectrum).

## Requirements and estimates

Scope:

- **Functional:** upload, download and sync files and folders across a user's devices; work offline and reconcile later; share folders with other users with view or edit rights; keep previous versions for a fixed period; restore deleted files.
- **Non-functional:** never lose or corrupt a file once its upload is acknowledged; changes reach other online devices within seconds; sync works over slow, metered and unreliable connections; files can be many gigabytes.
- **Out of scope:** real-time collaborative editing inside documents (that's an operational transform or CRDT problem), full-text search, previews.

These numbers are assumptions, rounded for easy arithmetic:

- 200 million registered users, 30 million daily active, 1.5 devices each.
- **Content:** 8 GB stored per registered user on average. 200M × 8 GB = 1.6 × 10⁹ GB = **1.6 EB** of logical data. Deduplication and compression reduce that, but plan as if they don't.
- **Metadata:** 2,000 files per user and about 300 bytes per file entry (path, block list reference, revision, timestamps). 200M × 2,000 = 4 × 10¹¹ entries × 300 B = 1.2 × 10¹⁴ B ≈ **120 TB**. That doesn't fit on one database server; it will be sharded.
- **Change rate:** each daily user changes 15 files a day. 30M × 15 = 450M commits a day. 450 × 10⁶ ÷ 86,400 s ≈ 5,200 a second on average; at a 3× peak, about **15,600 metadata writes a second**.
- **Upload bandwidth:** if a change uploads 1 MB of new data on average after deduplication, that's 450M × 1 MB = 450 TB a day, or 450 TB ÷ 86,400 s ≈ 5.2 GB/s ≈ **42 Gbps** of ingress. Downloads to other devices are a multiple of that.
- **Waiting clients:** 30M × 1.5 = 45M devices. If 40% are online at peak, that's **18 million** connections waiting for change notifications.

The estimate shows the shape: an exabyte-scale blob store with modest write rates, plus a metadata store that is far smaller but takes every commit and must never disagree with itself. [Estimation](/learn/estimation) has more on this kind of sizing.

## API and data model

### Namespaces and journals

Group files into **namespaces**. Each user's home folder is one namespace. Each shared folder is its own namespace, mounted into every member's tree at a path they choose. A namespace has an append-only **journal**: every change (create, modify, rename, delete) gets the next journal ID within that namespace.

| Table | Key | Holds |
|---|---|---|
| `journal` | `(ns_id, journal_id)` | path, block list, size, `rev`, mtime, deleted flag |
| `files_latest` | `(ns_id, path)` | the current entry for each path, for fast listing |
| `mounts` | `(user_id, ns_id)` | where a shared namespace appears in the user's tree |
| `acl` | `(ns_id, user_id)` | role: owner, editor or viewer |
| `blocks` | `hash` | location in the block store, size, reference count |

A file's content is described by its **block list**: the ordered list of hashes of the blocks that make it up. The metadata never holds file bytes.

### The API

```http
POST /commit          {ns_id, path, block_list, base_rev}
                      -> {rev} | {missing: [hashes]} | 409 {current_rev}
PUT  /blocks/{hash}   <bytes>
GET  /blocks/{hash}   -> bytes
POST /changes         {cursor} -> {entries[], cursor, has_more}
POST /changes/wait    {cursor, timeout: 60} -> {changes: true|false}
POST /share           {ns_id, user, role}
GET  /revisions       {ns_id, path} -> [{rev, block_list, mtime}]
```

`base_rev` is the revision the client's edit started from; it's how the server detects conflicts. The cursor is opaque to the client. Internally it records the last journal ID the client has seen in each namespace it can access.

## High-level design

```diagram
title: Metadata and content travel separately
[mdb:store] Metadata DB\n(journals) @ 2,0
[ms] Metadata\nservice @ 2,1
[bs] Block service @ 2,2
[blk:store] Block store @ 2,3
[a:client] Device A @ 0,1.5
[b:client] Device B @ 4,1.5
a -> ms : commit
a -> bs : put blocks
b -> ms : wait, list changes
b -> bs : get blocks
ms -> mdb
bs -> blk
```

Saving a file on device A:

1. The client splits the file into blocks and hashes each one.
2. It calls `commit` with the block list and the `base_rev` it edited from.
3. The metadata service checks permissions and asks the block index which hashes it doesn't have yet. If any are missing, it replies with the list.
4. The client uploads only those blocks to the block service, then repeats the commit.
5. Now every block exists, so the metadata service checks `base_rev` against the current revision, appends a journal entry, and updates `files_latest` in one transaction. It returns the new `rev`.
6. The commit wakes everyone waiting on that namespace.

On device B, a `changes/wait` request has been open for up to 60 seconds. It returns `changes: true`; B calls `changes` with its cursor, gets the new entry, compares the block list with blocks it already has locally, downloads only the missing ones, writes the file to a temporary path, and renames it into place so no program ever sees a half-written file. Then it saves the new cursor.

This is the main design choice: **metadata goes through a small, strongly consistent service; bytes go straight to a big, simple block store.** They scale independently, and the block store never needs to understand files.

## Chunking, deduplication and bandwidth

### Blocks and content hashes

Files are split into blocks, and each block is stored under the hash of its contents, such as SHA-256. That's **content addressing**, and several properties fall out of it:

- **Deduplication.** Two identical blocks have the same hash and are stored once. Copying or moving a file uploads nothing; the new entry just points at the same hashes.
- **Immutability.** A block's content can never change under its name, because a different content would have a different hash. That makes blocks trivial to cache and replicate.
- **Integrity.** The client verifies each downloaded block against its hash, which catches corruption anywhere along the path.
- **Resumability.** An interrupted upload resumes block by block; blocks already stored are skipped automatically.

A sketch of the client side of a commit, with fixed-size blocks (it keeps the file in memory for clarity):

```python
import hashlib

BLOCK = 4 * 1024 * 1024  # 4 MiB fixed-size blocks

def commit_file(path, ns_id, base_rev, server):
    hashes, data = [], {}
    with open(path, "rb") as f:
        while chunk := f.read(BLOCK):
            h = hashlib.sha256(chunk).hexdigest()
            hashes.append(h)
            data[h] = chunk
    while True:
        r = server.commit(ns_id, path, block_list=hashes, base_rev=base_rev)
        if r.status == "missing":
            for h in r.missing:
                server.put_block(h, data[h])
        elif r.status == "conflict":
            return save_conflicted_copy(path, hashes)
        else:
            return r.rev
```

### Fixed-size vs content-defined chunks

Fixed-size blocks are simple and fast, and Dropbox has described using 4 MB blocks. Their weakness is insertions: add one byte at the start of a file and every block boundary shifts, so every hash changes and the whole file uploads again.

**Content-defined chunking** sets boundaries where a rolling hash of the last few dozen bytes matches a pattern, so boundaries move with the content. An insertion changes only the chunk it lands in. The Low-Bandwidth File System paper is the classic description of this approach.

| | Fixed-size blocks | Content-defined chunks |
|---|---|---|
| Boundary rule | Every N bytes | Where a rolling hash matches a pattern |
| Insert near the start | Every later block changes | Only nearby chunks change |
| CPU cost | Low | Higher (rolling hash over every byte) |
| Chunk sizes | Uniform | Variable, within min and max limits |

### Saving bandwidth

Dedup handles files that are copied, moved or restored. Other techniques cover edits:

- **Delta sync within a block.** The rsync algorithm lets one side send cheap rolling checksums of the old version, so the other side can send only the byte ranges that differ. It saves the most on large files with small edits, at the cost of more CPU and a more complex protocol.
- **Compression** before upload, skipping formats that are already compressed (JPEG, MP4, ZIP), where it wastes CPU for no gain.
- **Streaming between devices.** Dropbox has described letting other devices start downloading a file's blocks before the uploader's commit has finished, which overlaps upload and download for large files.
- **LAN sync.** Devices on the same local network can fetch blocks from each other instead of the internet.

### Versions come cheap

A version is just an old journal entry with its block list. Because blocks are immutable and shared, keeping 30 days of history costs metadata rows plus only the blocks that actually changed. Restoring an old version is a new commit that points at the old block list.

Deleting blocks needs care. A block can be freed only when no current file, no retained version and no in-progress upload references it. Reference counting is fast but easy to get wrong under failures; a periodic mark-and-sweep over the metadata is slower but self-correcting. Either way, add a grace period before physically deleting anything.

## Sync, conflicts and sharing

### The change journal and cursors

The journal is what makes sync incremental. A client never asks "what does the whole tree look like?" except on first sync. It asks "what changed since my cursor?", and the answer is a range scan of journal IDs in each namespace it can see.

Notification works on top of that:

- **Long polling** (`changes/wait`) for desktop clients. The request blocks on the server until a namespace it covers changes or the timeout passes, then the client lists changes. The notification itself carries no data, so a missed or duplicated wake-up is harmless: the cursor is the source of truth. Dropbox's public API has the same shape with its `list_folder/longpoll` endpoint.
- **Push notifications** for phones, where holding a connection open drains the battery.
- **Webhooks** for server-side integrations. Google Drive's API, for example, pairs a changes feed and page tokens with optional push notifications to a webhook.

The notification tier holds those 18 million waiting requests. Each server keeps a map from namespace to waiting connections and subscribes to commit events for those namespaces from a pub/sub system. See [real-time communication](/learn/realtime) for the trade-offs between long polling and persistent connections.

### Conflicts

Two devices edit the same file while one is offline. Both started from rev 7.

- Device A reconnects first and commits with `base_rev = 7`. That matches the current revision, so it becomes rev 8.
- Device B commits with `base_rev = 7`, but the current revision is now 8. The server rejects it with `409`.
- Device B keeps its version under a new name, something like `report (Device B's conflicted copy 2026-10-12).docx`, commits that as a new file, and downloads rev 8 under the original name.

This is optimistic concurrency, a compare-and-set on `rev`. The service can't merge the two edits, because it doesn't understand the file format, so it never picks a loser silently. Both versions survive and a human decides. Folder operations have their own cases (one device renames a folder while another adds a file inside it, or deletes it), and sync engines handle each one explicitly. Dropbox's write-up of rewriting its sync engine is a good account of how hard these cases are.

### Sharing and permissions

Sharing a folder makes it its own namespace with an ACL, mounted in each member's tree. Every metadata call checks that the user has the right role on the namespace. Viewers get `changes` and `GET /blocks`; editors also get `commit`.

Two subtleties are worth raising:

- **A hash must not be a password.** If `GET /blocks/{hash}` served any block to anyone who knew its hash, a leaked block list would leak the file. Check that the requester can read some file that references the block. With cross-user dedup, that check alone isn't enough: a client could commit a block list of hashes it never had, the server would find no blocks missing, and the client would then own a file that references them. So a commit must not reference a block the client hasn't uploaded or otherwise proved it holds.
- **Cross-user dedup leaks information.** If the server says "I already have that block" when you upload, you've learned that someone else stored that exact content. Services that care limit deduplication to one user or one team, or require the upload anyway.

For very large sharing graphs, permission checks become a system of their own. Google's Zanzibar paper describes one built for exactly this kind of workload.

### Consistency: metadata vs blocks

The two halves of the system need different guarantees, and that's what lets them use different stores:

- **Metadata needs [strong consistency](/learn/cap-and-consistency#the-consistency-spectrum)** within a namespace. The journal order must be the same for every reader, and the `base_rev` check has to be an atomic compare-and-set, or two devices could both believe they wrote rev 8. A sharded relational database, sharded by `ns_id` so each namespace's journal lives on one shard, gives you transactions where you need them. Cross-namespace moves become the hard case, because they touch two shards.
- **Blocks can live with weaker guarantees**, because they're immutable and named by content. There's no "latest version" of a block to disagree about. Replication can be asynchronous across regions, caches never need invalidating, and any replica that has a block has the right one.
- **The ordering rule connecting them:** a commit is accepted only after all of its blocks are durably stored. Write blocks first, metadata second. Then a reader that sees a journal entry can always fetch its blocks. The reverse order would let other devices see files whose content doesn't exist yet.

## Scaling and bottlenecks

- **Metadata DB.** Shard by namespace ([sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases)). A huge shared folder for a large company can be a hot shard on its own; very large namespaces may need splitting by path or a dedicated shard. Read replicas serve listings, while commits go to the primary ([master-slave replication](/learn/relational-databases#primary-replica-replication)).
- **Block store.** At exabyte scale, store blocks in object storage, or build your own as Dropbox did with Magic Pocket. Use erasure coding for cold blocks to cut storage overhead compared with keeping three full copies.
- **Block index lookups.** Every commit checks which hashes exist. Keep the index in a sharded key-value store, partitioned by hash; hashes are uniformly distributed, so shards stay balanced on their own.
- **Notification fan-out.** One commit to a folder shared with 10,000 people wakes 10,000 or more waiting clients, who all list changes and download the same blocks. Cache popular blocks in a CDN or regional cache, and add a little random delay so they don't all hit at once.
- **First sync of a new device** downloads the whole account. Rate limit it and run it at lower priority than incremental sync.
- **Client bugs.** A buggy client can loop on commits or re-upload everything. Server-side [rate limits](/learn/rate-limiting) and per-device quotas contain the damage.

## Trade-offs to discuss

- **Fixed vs content-defined chunking:** simplicity and speed vs much better dedup and delta behavior for edited files.
- **Block size:** bigger blocks mean fewer hashes and less metadata; smaller blocks mean less to re-upload per edit and better dedup.
- **Conflicted copies vs automatic merging:** copies are safe and format-agnostic but push work onto users; merging only works for formats the service understands.
- **Long polling vs persistent connections:** long polling works through any proxy and is simple to scale; WebSockets cut latency and overhead but are more to operate.
- **Cross-user dedup vs privacy:** global dedup saves the most storage and leaks that a given file exists somewhere.
- **Version retention:** longer history helps users recover from mistakes and ransomware, and costs storage plus a slower garbage collector.

## Check yourself

<details>
<summary>A user renames a 20 GB folder of videos. How much data does each of their other devices download, and why?</summary>

Almost nothing. A rename creates journal entries with new paths but the same block lists. Each other device sees the entries, checks which hashes it already has locally, finds all of them, and moves the files on disk. Only metadata travels.

</details>

<details>
<summary>Why must the server reject a commit whose blocks aren't all uploaded yet, instead of accepting it and waiting for the blocks?</summary>

As soon as the journal entry exists, other devices can see it and try to download the file. If some blocks don't exist yet, those devices would fail or, worse, write an incomplete file. Requiring every block to be durable before the metadata commit means anything visible in the journal is always fully readable. It also keeps the block store free of any notion of "pending" files.

</details>

<details>
<summary>Two people edit the same spreadsheet in a shared folder while both are offline, and both reconnect. What does each of them end up with?</summary>

Whoever commits first wins the revision check and becomes the current version. The second commit fails because its `base_rev` is stale, so that client saves its version as a conflicted copy beside the original and downloads the winner. Both see both files after the next sync. Nobody's work is lost, but someone has to merge by hand, which is why this approach suits arbitrary files and not real-time documents.

</details>

<details>
<summary>A user inserts one paragraph near the start of a 200 MB text file. Compare what fixed 4 MB blocks and content-defined chunking would upload.</summary>

With fixed blocks, the insertion shifts every following byte, so every block from the edit to the end of the file gets a new hash: nearly 200 MB to upload. With content-defined chunking, boundaries are set by content, so they re-synchronize shortly after the insertion; only the one or two chunks around the new paragraph change and get uploaded. Delta sync with rsync-style checksums would be another way to recover most of the savings with fixed blocks.

</details>

<details>
<summary>Your block store replicates across regions asynchronously. Does that break sync between a laptop in Europe and a phone in Asia?</summary>

Not if the ordering rule holds: a commit is accepted only once the blocks are durable, and a device that can't find a block in its local region falls back to the region that has it. Because blocks are immutable and named by hash, a replica either has exactly the right bytes or doesn't have the block at all; there's never a stale version. Only the metadata journal needs a single, strongly consistent order.

</details>

## Further reading

- [Streaming file synchronization](https://dropbox.tech/infrastructure/streaming-file-synchronization) (Dropbox): blocks, hashes and overlapping upload with download.
- [Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine) (Dropbox): why sync correctness is hard and how they tested it.
- [Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket) (Dropbox): an exabyte-scale block store.
- [The rsync algorithm](https://rsync.samba.org/tech_report/): rolling checksums for delta transfer.
- [A low-bandwidth network file system](https://pdos.csail.mit.edu/papers/lbfs:sosp01/lbfs.pdf) (SOSP 2001): content-defined chunking for deduplication.
- [Retrieve changes](https://developers.google.com/drive/api/guides/manage-changes) (Google Drive API): a production changes feed with page tokens.
- [Zanzibar: Google's consistent, global authorization system](https://www.usenix.org/conference/atc19/presentation/pang) (USENIX ATC 2019): permissions at scale.
- Alex Xu, *System Design Interview – An Insider's Guide* (2020), "Design Google Drive".
- [System Design School primer](https://systemdesignschool.io/primer): "Object Storage" and "Consistency Models".
