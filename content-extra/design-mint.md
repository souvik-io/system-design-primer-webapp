# Design a personal finance tracker like Mint

A personal finance tracker pulls every purchase from your bank and card accounts into one place. Say you link your checking account and two credit cards. The next morning the app shows that you spent $412 on food this month, that $1,800 went to rent, and that you are at 85% of your $500 food budget with ten days to go. You never typed in a single purchase.

Mint was the best-known app of this kind. It started in 2006 and Intuit bought it in 2009. In late 2023, Intuit announced that it would close Mint and moved its users to Credit Karma, another Intuit product. Mint shut down on March 23, 2024. Coverage at the time noted that Credit Karma did not offer Mint's monthly and per-category budgets. The design problem outlived the product, and apps like it still need the same parts.

It's a good interview question because the hard parts are unusual. Most of the data comes from thousands of banks outside your system. The system writes far more than it reads, since people buy things every day but open a budgeting app much less often. And it holds the keys to people's bank accounts.

This chapter follows the four steps from [The system design interview, step by step](/learn/system-design-interview): use cases and numbers, a high-level design, the core components in detail, and then scaling.

## Step 1: Outline use cases, constraints and assumptions

### Use cases

We'll scope the problem to these use cases:

- **The user connects a financial account**, such as a checking account or a credit card.
- **The service extracts transactions from the account.** A **transaction** is one movement of money, such as "$43.10 at Safeway on October 3".
  - It updates each account daily.
  - It assigns every transaction a category, such as Food or Gas.
  - The user can override the category of any transaction by hand.
  - The service never re-categorizes a transaction on its own once it has a category.
  - It analyzes monthly spending by category.
- **The service recommends a budget.** A **budget** here is a monthly limit per category, such as "Food: $500".
  - The user can set their own budget amounts instead.
  - The service notifies the user when they are approaching or have exceeded a budget.
- **The service is highly available.** People should be able to check their spending at any time.

### Out of scope

- Extra logging and analytics beyond what the use cases need.
- Moving money: paying bills, transfers and investing. The app only reads data.
- Credit scores, tax filing and investment advice.

### Assumptions

These are made-up inputs for the exercise. None of them come from Mint or any other real product.

- Traffic is not evenly distributed. Some hours are much busier than others.
- The automatic daily update applies only to users who were active in the past 30 days. There's no point refreshing accounts nobody looks at.
- Adding or removing a financial account is relatively rare.
- Budget notifications don't need to be instant. Arriving within a few hours is fine.
- 10 million users.
- Each user has 10 budget categories, so there are 10 million × 10 = 100 million budget items. Examples:
  - Housing: $1,000
  - Food: $200
  - Gas: $100
- The seller on a transaction decides its category. There are 50,000 distinct sellers.
- 30 million financial accounts, about three per user.
- 5 billion transactions a month.
- 500 million read requests a month.
- 10 writes for every read. The system is write-heavy: people make purchases every day, but few of them open the app every day.

### Calculate usage

First, how big is one transaction? Count only the fields we need to analyze spending:

- `user_id`: 8 bytes
- `created_at` (when the purchase happened): 5 bytes
- `seller`: 32 bytes
- `amount`: 5 bytes
- Total: about 50 bytes

A month has about 30 × 86,400 = 2,592,000 seconds, or roughly 2.6 million. Handy conversions:

- 1 request a second ≈ 2.6 million requests a month
- 40 requests a second ≈ 100 million requests a month
- 400 requests a second ≈ 1 billion requests a month

Now the numbers:

- **New transaction data:** 5,000,000,000 × 50 bytes = 250 GB a month. Over three years that's 250 GB × 36 = 9 TB. Assume almost all of these are new rows, with few updates to existing ones.
- **Real storage:** 50 bytes is just the payload. The table also needs a row ID, the account, the bank's own transaction ID, the category, row headers and indexes. Budgeting about three times the payload gives roughly 150 bytes a row, or about 27 TB over three years before replication. That number decides whether one database can hold the table.
- **Average write rate:** 5,000,000,000 ÷ 2,592,000 s ≈ 1,930 transactions a second, so about 2,000.
- **Average read rate:** 500,000,000 ÷ 2,592,000 s ≈ 193 reads a second, so about 200.
- **Peak write rate:** a day's transactions are 5,000,000,000 ÷ 30 ≈ 167 million. The daily update runs as a batch. If most of it happens in a 6-hour overnight window of 21,600 seconds, that's 167,000,000 ÷ 21,600 ≈ 7,700 writes a second, almost four times the average.
- **Extraction jobs:** at most 30 million accounts to refresh a day. In the same 6-hour window that's 30,000,000 ÷ 21,600 ≈ 1,390 jobs a second. Fetching from a bank is slow. If one fetch takes about 2 seconds, [Little's Law](/learn/performance-and-latency-101#littles-law) says about 1,390 × 2 ≈ 2,800 fetches are in flight at once.
- **Category map:** 50,000 sellers × up to 255 bytes per entry ≈ 12.75 MB. That fits in memory on every server.
- **Monthly spending table:** at most 10 million users × 10 categories = 100 million rows a month, about 50 times fewer than the 5 billion transactions they summarize.
- **Budget notifications:** if each budget item triggers at most two alerts a month ("at 80%" and "over"), that's at most 200 million a month, or 200,000,000 ÷ 2,592,000 ≈ 77 a second. The real number will be much lower.

**What these numbers tell us.** The system is write-heavy and bursty: most writes land during the nightly update. Reads are light, about 200 a second, and a cache can absorb most of them. The transactions table is the thing to plan for, because it grows by 250 GB of payload a month and will outgrow a single database within a few years. The seller map is tiny, so every worker can keep a copy in memory. And extraction spends most of its time waiting on banks, so it needs many concurrent workers more than it needs fast ones.

## Step 2: Create a high-level design

```diagram
title: High-level design. The extraction pipeline runs in the background, away from user requests.
[client:client] Client @ 0,0
[web] Web server\n(reverse proxy) @ 1,0
[acct] Accounts API @ 2,0
[q:queue] Extraction\nqueue @ 3,0
[bank] Banks via\naggregator @ 4,0
[db:store] SQL database @ 2,1.5
[ext] Transaction\nextractor @ 3,1.5
[obj:store] Object store\n(raw files) @ 4,1.5
[cat] Category\nservice @ 4,3
[bud] Budget\nservice @ 3,3
[notif] Notification\nservice @ 2,3
client -> web
web -> acct
acct -> db : accounts
acct --> q : job
q --> ext
ext -> bank : fetch
ext -> obj
ext -> cat
ext -> db
ext -> bud
bud --> notif : alerts
```

- **Client:** the web or mobile app the user sees.
- **Web server:** a [reverse proxy](/learn/reverse-proxy-and-api-gateway-101#what-a-reverse-proxy-is) that terminates HTTPS and forwards each request to the right API server.
- **Accounts API:** handles linking accounts and manual refreshes. It writes account records and puts extraction jobs on the queue.
- **Extraction queue:** holds one job per account to refresh. Fetching from a bank can take seconds, so nobody should wait on it inside a web request.
- **Transaction extractor:** pulls jobs off the queue, fetches new transactions, and runs them through the rest of the pipeline.
- **Banks via an aggregator:** the outside world. Most apps reach banks through an aggregator, a company that maintains the connections to thousands of banks.
- **Object store:** keeps the raw data from each fetch as files, so we can reprocess it later without asking the bank again.
- **Category service:** decides the category of each transaction from its seller.
- **Budget service:** keeps monthly spending per category up to date and compares it with each user's budget.
- **Notification service:** sends "you're close to your budget" alerts and "your accounts are updated" messages.
- **SQL database:** stores users, accounts, categorized transactions, monthly spending and budget overrides.

## Step 3: Design core components

### Use case: User connects to a financial account

We could store information about the 10 million users in a [relational database](/learn/relational-databases). Accounts belong to users, transactions belong to accounts, and budgets belong to users. These are clear relationships with foreign keys, and 30 million accounts is small. The [SQL or NoSQL](/learn/nosql-databases#sql-or-nosql-making-the-choice) question is worth raising, but relational is the natural start here.

The flow:

1. The **Client** sends a request to the **Web Server**, running as a reverse proxy.
2. The **Web Server** forwards the request to the **Accounts API** server.
3. The **Accounts API** server writes the new account to the `accounts` table in the **SQL Database**.

The interesting question is what "the new account" contains. There are two ways an app can get at someone's bank data.

**The old way: store the user's bank login.** The user types their online-banking username and password into the app. The app saves them, logs in to the bank's website as the user, and copies the transactions off the page. This is called **screen scraping**. A table for it looks like this:

```sql
CREATE TABLE accounts (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    user_id       BIGINT       NOT NULL,
    created_at    DATETIME     NOT NULL,
    last_update   DATETIME     NOT NULL,
    account_url   VARCHAR(255) NOT NULL,  -- the bank's login page
    account_login VARCHAR(32)  NOT NULL,
    account_password_encrypted VARBINARY(256) NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Notice the password column. For your *own* users' passwords you store a slow, salted hash, because you only ever need to check a password, never read it back (see [Storing passwords](/learn/security-101#storing-passwords)). A bank password is different. The extractor has to type it into the bank's login form every day, so the app must be able to recover it. A hash can't be reversed, so a design that stores `account_password_hash` cannot work. The password has to be stored encrypted, and that means anyone who gets both the database and the key gets millions of bank logins. Mint's early design worked this way, and in 2010 critics pointed out that it stored bank logins in a form that could be decrypted.

**The modern way: an aggregator and a token.** The user never gives the app their bank password. Instead:

1. The app opens the aggregator's connection screen. With Plaid, a widely used aggregator, this is called Link.
2. The user picks their bank. For banks that support **OAuth**, the user is sent to the bank's own site or app, logs in there, and approves read access. OAuth is a standard for letting one service act for a user without seeing the user's password ([more in Security 101](/learn/security-101#federated-identity-oauth-20-and-openid-connect)).
3. The aggregator hands the app's client a short-lived `public_token`.
4. The app's server exchanges it for a long-lived `access_token` that stands for this one bank login. Plaid calls a bank login an **Item**. One Item can cover several accounts, such as checking and savings at the same bank.
5. The app stores the access token, encrypted, and uses it to fetch transactions from then on.

Mint itself moved this way. In January 2017, Chase and Intuit announced a deal under which Intuit products such as Mint would get Chase data through a token, "without requiring customers to give Intuit their Chase user name and password". The US Consumer Financial Protection Bureau (CFPB) pushed the whole industry in the same direction. Its Personal Financial Data Rights rule, finalized in October 2024 under section 1033 of the Consumer Financial Protection Act of 2010, requires banks to share a customer's data with apps the customer authorizes, free of charge, and aims to move the industry away from screen scraping. It also limits third parties to using the data for the product the customer asked for. The rule's future is unsettled. The CFPB began reconsidering it in August 2025, and as of April 2026 a federal court in Kentucky had blocked its enforcement while that happens. Check the CFPB's page for the current status. Either way, tokens are the design to choose.

Our `accounts` table, using an aggregator:

```sql
CREATE TABLE accounts (
    id                 BIGINT       NOT NULL AUTO_INCREMENT,
    user_id            BIGINT       NOT NULL,
    created_at         DATETIME     NOT NULL,
    last_update        DATETIME     NULL,
    institution_name   VARCHAR(64)  NOT NULL,
    aggregator_item_id VARCHAR(64)  NOT NULL,
    access_token_enc   VARBINARY(512) NOT NULL, -- encrypted access token
    token_key_id       VARCHAR(64)  NOT NULL,   -- which data key encrypted it
    sync_cursor        VARCHAR(256) NULL,       -- where the last fetch stopped
    status             VARCHAR(16)  NOT NULL,   -- active, needs_reauth, revoked
    PRIMARY KEY (id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

We'll create an [index](/learn/relational-databases#use-good-indexes) on `id`, `user_id` and `created_at`. An index turns a lookup into a search through a sorted tree, which takes logarithmic time, instead of a scan of the whole table. A small, frequently used index also stays in memory. In the classic latency table, reading 1 MB sequentially from memory takes about 250 microseconds, from an SSD about 4 times longer, and from a spinning disk about 80 times longer.

The token is the most sensitive thing in the system, so protect it in layers:

- **Encrypt it at rest** with [envelope encryption](/learn/security-101#at-rest-envelope-encryption-with-a-kms): each token is encrypted with a data key, and the data key is encrypted by a master key that never leaves a key management service (KMS). `token_key_id` records which data key to ask the KMS to unwrap.
- **Give decryption to one service only.** Apply [least privilege](/learn/security-101#the-principle-of-least-privilege): only the extractor's identity may call the KMS to decrypt tokens. The read API, the budget service and the analysts' warehouse never see them.
- **Keep the aggregator's API secret out of code**, in a [secrets manager](/learn/security-101#secrets-management).
- **Make revocation easy.** When a user unlinks an account, call the aggregator to revoke the token, mark the row `revoked`, and delete the token.

We'll use a public [REST](/learn/protocols-and-apis#rest-resources-and-representations) API. Linking an account:

```http
POST /api/v1/accounts
Authorization: Bearer <session token>
Content-Type: application/json

{ "public_token": "public-production-3f2a..." }
```

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "account_id": 81234,
  "institution": "Example Bank",
  "status": "active",
  "first_sync": "queued"
}
```

The user's ID comes from the session, never from the request body, so nobody can link an account to someone else's profile. The old screen-scraping version of this call sent `account_url`, `account_login` and `account_password` in the body instead, which is exactly what we want to avoid.

Between our own services we could use [RPC](/learn/protocols-and-apis#rpc-calling-a-function-on-another-machine), such as gRPC. Internal calls are many, small and between services we control, which is where RPC is at its best. The [comparison of RPC and REST](/learn/protocols-and-apis#rpc-and-rest-side-by-side) covers the trade-off.

Once the account is saved, the service fetches its transactions.

### Use case: Service extracts transactions from the account

We extract transactions from an account in three cases:

- The user first links the account.
- The user manually refreshes the account.
- Automatically, once a day, for users who have been active in the past 30 days.

Data flow:

1. The **Client** sends a request to the **Web Server**. For the daily update, a scheduler takes the place of the client.
2. The **Web Server** forwards the request to the **Accounts API** server.
3. The **Accounts API** server places a job on a **Queue**, such as Amazon SQS or RabbitMQ, and returns `202 Accepted`. Extracting transactions can take a while, so we do it [asynchronously with a queue](/learn/queues-and-async#doing-work-outside-the-request). The cost is extra moving parts: a queue to run, retries, and jobs that may run twice.
4. The **Transaction Extraction Service**:
   1. Pulls a job from the **Queue** and fetches the account's new transactions from the bank, through the aggregator.
   2. Stores the raw response as a log file in the **Object Store**.
   3. Uses the **Category Service** to categorize each transaction.
   4. Updates the `transactions` table in the **SQL Database** with the categorized transactions.
   5. Uses the **Budget Service** to update monthly spending by category in the `monthly_spending` table. The Budget Service uses the **Notification Service** to tell users they are nearing or have exceeded a budget.
   6. Tells the user the update is done through the **Notification Service**. The Notification Service puts messages on its own queue and sends them [asynchronously](/learn/queues-and-async#telling-the-user-the-job-is-done).

A few details make this pipeline correct in practice:

- **Fetch only what's new.** Aggregators keep a cursor for you. Plaid's `/transactions/sync` endpoint returns a `next_cursor` with each page. You store it (our `sync_cursor` column) and pass it back next time to get only the changes since then: added, modified and removed transactions. Plaid also sends a `SYNC_UPDATES_AVAILABLE` webhook when new data is ready, and its documentation says it checks banks for updates one to four times a day depending on the institution. So "update daily" can be driven by webhooks, with the scheduler as a safety net.
- **Expect the same transaction twice.** Jobs get retried, and a pending card charge later shows up again as posted. Give each row the bank's own transaction ID and a unique constraint on `(account_id, external_id)`, then insert with "insert or update". Running a job twice then leaves the table the same, which is what [idempotent workers](/learn/queues-and-async#duplicates-are-normal-so-make-workers-idempotent) means.
- **Handle broken connections.** A token can stop working, for example when the user revokes access at the bank. Mark the account `needs_reauth`, stop retrying, and ask the user to reconnect. Send other failures through [retries and a dead-letter queue](/learn/queues-and-async#retries-and-dead-letter-queues).
- **Don't schedule a refresh twice.** If an account already has a job waiting, a manual refresh should not add a second one. Keep a "job pending" flag per account, or use a queue that deduplicates by key.

The `transactions` table:

```sql
CREATE TABLE transactions (
    id              BIGINT      NOT NULL AUTO_INCREMENT,
    user_id         BIGINT      NOT NULL,
    account_id      BIGINT      NOT NULL,
    external_id     VARCHAR(64) NOT NULL,   -- the bank's ID for this transaction
    created_at      DATETIME    NOT NULL,   -- when the purchase happened
    seller          VARCHAR(32) NOT NULL,
    amount          DECIMAL(12,2) NOT NULL,
    category        VARCHAR(32) NOT NULL,
    category_source VARCHAR(8)  NOT NULL,   -- seed, crowd, user or none
    PRIMARY KEY (id),
    UNIQUE (account_id, external_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Three choices here are worth saying out loud:

- **`id` is a `BIGINT`.** A 32-bit signed `INT` tops out at about 2.1 billion. At 5 billion new rows a month it would overflow in under two weeks.
- **`amount` has an explicit scale.** In MySQL, a bare `DECIMAL` means `DECIMAL(10,0)`, which has no digits after the decimal point and would silently round $43.10 to $43. Money needs `DECIMAL(12,2)`, or an integer count of cents. Never use floating point for money.
- **The category lives on the row.** That way a user's override sticks to that one transaction, and `category_source` records where the category came from.

We'll create an index on `id`, `user_id` and `created_at`. The most common query is "this user's transactions this month", so a composite index on `(user_id, created_at)` serves it best.

The `monthly_spending` table holds one total per user, month and category:

```sql
CREATE TABLE monthly_spending (
    user_id    BIGINT        NOT NULL,
    month_year DATE          NOT NULL,  -- first day of the month
    category   VARCHAR(32)   NOT NULL,
    amount     DECIMAL(12,2) NOT NULL,
    PRIMARY KEY (user_id, month_year, category),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

A surrogate `id` column with separate indexes on `id` and `user_id` would also work. The composite primary key is simpler: it's the exact lookup the app makes, it keeps one user's rows together on disk, and it makes "insert or update the total" a single statement.

#### Category service

The Category Service answers one question: given a seller, which category? The seller string on a transaction comes from the bank, and it's messy. The same coffee shop can show up as `SQ *BLUE BOTTLE 0423` one day and `BLUE BOTTLE COFFEE OAKLAND CA` the next. So the first step is to normalize it: uppercase it, strip payment-processor prefixes, store numbers and city names, and map the result to a canonical seller.

Then look the seller up, in this order:

1. **The user's own rule.** If this user has said "always put Costco under Food", use that.
2. **A seed map.** Before launch, build a dictionary from the most popular sellers to their categories: Exxon is Gas, Target is Shopping. With 50,000 sellers at under 255 bytes per entry, the whole map is about 12.75 MB, small enough to load into memory on every extractor.
3. **The crowd.** For sellers the seed map doesn't know, learn from users. Every time a user overrides a category, that's a vote: "this seller is Food". Once a seller has enough votes, the category with the most votes becomes its default.
4. **Otherwise, "Uncategorized"**, and the user can fix it.

The crowd count needs care. Keeping a heap per seller would let you peek at the top category in O(1), but every new vote changes a count inside the heap, and re-sorting it costs O(log n). There's a simpler structure. Votes only ever go up, so keep a counter per seller and remember the current leader. When a vote comes in, bump the count and compare it with the leader's count. Both the update and the lookup are O(1).

```python
from collections import Counter, defaultdict
from enum import Enum


class Category(Enum):
    HOUSING = "housing"
    FOOD = "food"
    GAS = "gas"
    SHOPPING = "shopping"
    UNCATEGORIZED = "uncategorized"


SEED = {
    "EXXON": Category.GAS,
    "SHELL": Category.GAS,
    "TARGET": Category.SHOPPING,
    "SAFEWAY": Category.FOOD,
    # ... the 50,000 most common sellers
}


class CrowdVotes:
    """Counts users' manual overrides per seller and tracks the leader."""

    def __init__(self, min_votes=25):
        self.min_votes = min_votes
        self.counts = defaultdict(Counter)  # seller -> Counter of categories
        self.leader = {}                    # seller -> category with most votes

    def record(self, seller, category):
        counts = self.counts[seller]
        counts[category] += 1
        current = self.leader.get(seller)
        if current is None or counts[category] > counts[current]:
            self.leader[seller] = category

    def top(self, seller):
        category = self.leader.get(seller)
        if category and self.counts[seller][category] >= self.min_votes:
            return category
        return None


class Categorizer:
    def __init__(self, seed, crowd, user_rules):
        self.seed = seed
        self.crowd = crowd
        self.user_rules = user_rules  # (user_id, seller) -> Category

    def categorize(self, user_id, raw_seller):
        """Return (category, source) for one transaction."""
        seller = normalize(raw_seller)
        if (user_id, seller) in self.user_rules:
            return self.user_rules[(user_id, seller)], "user"
        if seller in self.seed:
            return self.seed[seller], "seed"
        crowd_pick = self.crowd.top(seller)
        if crowd_pick:
            return crowd_pick, "crowd"
        return Category.UNCATEGORIZED, "none"


def normalize(raw_seller):
    """'SQ *SHELL OIL 5741' -> 'SHELL'. Real code uses a lookup of aliases."""
    ...
```

`min_votes` stops one user's odd choice from changing the category for everyone. The crowd's answer applies to *new* transactions only. Transactions that already have a category keep it, which matches the "no automatic re-categorization" use case: a user's past months should not shift under them because other users voted.

When a user changes a transaction's category, three things happen:

1. The API updates that row: `category = 'food'`, `category_source = 'user'`.
2. The Category Service records a crowd vote for the seller.
3. The Budget Service recomputes that user's `monthly_spending` for that month, since money just moved from one category to another.

```http
PATCH /api/v1/transactions/99812
Content-Type: application/json

{ "category": "food", "apply_to_seller": true }
```

`"apply_to_seller": true` also saves a rule for this user, so future purchases from the same seller land in Food too.

### Use case: Service recommends a budget

Start with a generic **budget template** that splits income across categories, with different splits for different income tiers. Someone earning $3,000 a month might get a template that puts more into housing and less into shopping than someone earning $12,000. The user's income can come from their profile or from the paychecks the app sees arriving.

The template saves storage. The budget is a function of income, so we don't need to store the 100 million budget items from step 1. We store only the categories a user has changed, in a `budget_overrides` table:

```sql
CREATE TABLE budget_overrides (
    user_id    BIGINT        NOT NULL,
    category   VARCHAR(32)   NOT NULL,
    amount     DECIMAL(12,2) NOT NULL,
    updated_at DATETIME      NOT NULL,
    PRIMARY KEY (user_id, category),
    FOREIGN KEY (user_id) REFERENCES users(id)
);
```

If one user in five overrides three categories, that's 2 million × 3 = 6 million rows instead of 100 million.

```python
from decimal import Decimal

# Share of monthly income per category, by income tier. Illustrative numbers.
TEMPLATES = [
    (Decimal("4000"),  {Category.HOUSING: Decimal("0.35"), Category.FOOD: Decimal("0.15"),
                        Category.GAS: Decimal("0.06"), Category.SHOPPING: Decimal("0.08")}),
    (Decimal("10000"), {Category.HOUSING: Decimal("0.30"), Category.FOOD: Decimal("0.12"),
                        Category.GAS: Decimal("0.05"), Category.SHOPPING: Decimal("0.10")}),
    (None,             {Category.HOUSING: Decimal("0.25"), Category.FOOD: Decimal("0.10"),
                        Category.GAS: Decimal("0.03"), Category.SHOPPING: Decimal("0.12")}),
]


def template_for(monthly_income):
    for upper_limit, shares in TEMPLATES:
        if upper_limit is None or monthly_income < upper_limit:
            return shares


def budget_for(monthly_income, overrides):
    """overrides: {Category: Decimal} loaded from budget_overrides."""
    budget = {
        category: (monthly_income * share).quantize(Decimal("1"))
        for category, share in template_for(monthly_income).items()
    }
    budget.update(overrides)  # the user's own numbers win
    return budget
```

Setting a budget by hand is one call:

```http
PUT /api/v1/budgets/food
Content-Type: application/json

{ "amount": "450.00" }
```

#### Computing monthly spending

The Budget Service keeps `monthly_spending` up to date. There are two ways to compute it.

**Option 1: SQL.** Run a query on the `transactions` table:

```sql
SELECT user_id, category, SUM(amount)
FROM transactions
WHERE created_at >= '2026-10-01' AND created_at < '2026-11-01'
GROUP BY user_id, category;
```

The result has far fewer rows than the input, since each user has many transactions a month. But at 5 billion rows a month, a query like this competes with the nightly writes on the same database. A cheaper variant is to update totals as each batch of transactions arrives: "add $43.10 to (user 42, October, Food)".

**Option 2: MapReduce on the raw files.** The extractor already writes raw transactions to the object store as log files. A **MapReduce** job reads those files in parallel across many machines. Its **map** step turns each line into a key and a value. A **shuffle** groups equal keys together. Its **reduce** step combines each group's values. (The [batch processing chapter](/learn/batch-processing#mapreduce-the-foundational-model) explains the model in depth.) Here, one job can:

- categorize each transaction, and
- add up spending per user, month and category.

Running this analysis on the files instead of the database takes a large load off the database. If a user changes a category, the Budget Service can re-run the analysis for that user and month.

The log file is tab-separated, one transaction per line. We add the transaction ID so the job can apply per-transaction overrides:

```
user_id   transaction_id   timestamp   seller   amount
```

A sketch of the job, with a tiny local driver that plays the part of the cluster:

```python
from collections import defaultdict
from decimal import Decimal


def mapper(line, categorizer, txn_overrides, month):
    """One log line in, at most one ((user, month, category), amount) pair out.

    '42\t9001\t2026-10-03T18:22:05\tSAFEWAY #1234\t43.10'
        -> (('42', '2026-10', 'food'), Decimal('43.10'))
    """
    user_id, txn_id, timestamp, seller, amount = line.rstrip("\n").split("\t")
    if timestamp[:7] != month:
        return  # only the month we're totalling
    category = txn_overrides.get(txn_id)  # the user's manual choice wins
    if category is None:
        category, _source = categorizer.categorize(user_id, seller)
    yield (user_id, month, category.value), Decimal(amount)


def reducer(key, amounts):
    """(('42', '2026-10', 'food'), [43.10, 12.50]) -> total 55.60"""
    yield key, sum(amounts, Decimal("0"))


def run_locally(lines, categorizer, txn_overrides, month):
    groups = defaultdict(list)  # the shuffle: collect values by key
    for line in lines:
        for key, amount in mapper(line, categorizer, txn_overrides, month):
            groups[key].append(amount)
    for key in sorted(groups):
        yield from reducer(key, groups[key])
```

Two details matter. The amounts are parsed as `Decimal`, because adding strings or floats gives wrong totals. And `txn_overrides` is the set of manual overrides for that month. It is small enough to send to every mapper, so a user's choice is respected even though the raw file still holds the bank's original data.

#### Budget notifications

After the totals are written, the Budget Service compares each one with the user's budget. If spending has crossed 80% or 100%, it asks the Notification Service to send an alert. A job may run several times a day and may be retried, so the service must not send the same alert twice. Record each alert sent with a key of `(user_id, month, category, threshold)` and send only if inserting that key succeeds.

```python
THRESHOLDS = (Decimal("0.8"), Decimal("1.0"))


def check_budget(user_id, month, category, spent, limit, alerts_sent, notify):
    for threshold in THRESHOLDS:
        key = (user_id, month, category, threshold)
        if spent >= limit * threshold and key not in alerts_sent:
            alerts_sent.add(key)  # in production: INSERT with a unique key
            notify(user_id, category, spent, limit, threshold)
```

Budget alerts don't need to be instant, so they go through the Notification Service's queue. That service handles delivery, retries and the user's channel preferences. [Design a notification system](/learn/design-notification-system) covers it in depth.

## Step 4: Scale the design

Don't jump straight from the first design to the final one. Scaling is a loop: **benchmark** with a load test, **profile** to find the bottleneck, fix it while weighing the alternatives, and repeat. [Design a system that scales to millions of users on AWS](/learn/design-scaling-aws) walks through that loop one step at a time. Here we look at what the step-1 numbers predict, and at what each added component costs. Internal load balancers between services are left out of the diagrams to reduce clutter.

The scaled system has two halves. The first serves users:

```diagram
title: Scaled design, part 1: serving users
[dns] DNS @ 0,0
[client:client] Client @ 0,1
[cdn] CDN @ 0,2
[static:store] Object store\n(static files) @ 1,2.6
[lb] Load balancer @ 1,1
[web] Web servers @ 2,1
[read] Read API @ 3,0
[acct] Accounts API @ 3,2
[cache:store] Memory cache @ 4,0
[replica:store] SQL read\nreplicas @ 4,1
[primary:store] SQL write\nprimary @ 4,2
[q:queue] Extraction\nqueue @ 3,3.2
client -> dns
client -> cdn
cdn -> static
client -> lb
lb -> web
web -> read
web -> acct
read -> cache
read -> replica
acct -> primary
primary --> replica : replicate
acct --> q
```

The second does the background work:

```diagram
title: Scaled design, part 2: the extraction and analysis pipeline
[q:queue] Extraction\nqueue @ 0,0
[ext] Extraction\nworkers @ 1,0
[bank] Aggregator\nand banks @ 2,0
[cat] Category\nservice @ 0,1.3
[raw:store] Object store\n(raw files) @ 1,1.3
[primary:store] SQL write\nprimary @ 2,1.3
[mr] MapReduce\njobs @ 1,2.6
[an:store] Analytics\ndatabase @ 2,2.6
[bud] Budget\nservice @ 1,3.9
[nq:queue] Notification\nqueue @ 2,3.9
[notif] Notification\nservice @ 3,3.9
q --> ext
ext -> bank : fetch
ext -> cat
ext -> raw
ext -> primary
raw -> mr
mr -> an : totals
bud -> mr : run
bud -> an
bud --> nq
nq --> notif
```

### Where the bottlenecks are

From step 1:

- **Writes:** about 2,000 transactions a second on average and about 7,700 a second during the nightly window. A single SQL primary can be tuned to take that many small inserts, but not with much room to spare, and indexes make each insert more expensive.
- **Storage:** 250 GB of payload a month, roughly 27 TB of real storage over three years. That's too much to keep in one SQL database comfortably.
- **Extraction:** around 2,800 bank fetches in flight at peak, each one mostly waiting on the network.
- **Reads:** about 200 a second on average, higher at peak. This is light, but reads compete with writes on the same database.

### DNS, CDN and an object store for static files

[DNS](/learn/dns-and-cdn-101#how-dns-works) points the app's domain at the load balancer. Static files, such as the app's JavaScript, CSS and images, are stored in an **object store** such as Amazon S3 and cached on a [CDN](/learn/dns-and-cdn-101#content-delivery-networks). The CDN serves them from servers near the user, so those requests never reach our web servers. The cost is another service to pay for and a delay before changed files reach every CDN location.

### Load balancer and horizontal scaling

A [load balancer](/learn/load-balancing#what-a-load-balancer-does) spreads requests across several **web servers**, and the web servers spread them across several **Read API** and **Accounts API** servers. If one server fails, the others carry on, which serves the high-availability use case. Keep the API servers stateless, with sessions in the shared memory cache, so any server can handle any request. The cost is that the load balancer itself must be redundant, usually as an active-passive pair, or it becomes the new single point of failure. [Load balancing](/learn/load-balancing#horizontal-scaling-and-what-it-costs) covers the trade-offs of scaling out.

### Use case: User accesses summaries and transactions

This use case is new in this step. When a user opens the app, they see their spending by category for this month and their recent transactions. Those are the hottest reads, and they change at most a few times a day, after each update. So we put user sessions, per-category totals and recent transactions in a **Memory Cache** such as Redis or Memcached.

1. The **Client** sends a read request to the **Web Server**.
2. The **Web Server** forwards it to the **Read API** server. Static content comes from the object store through the CDN instead.
3. The **Read API** server checks the **Memory Cache**.
   - If the data is in the cache, it returns it.
   - If not, it reads from the **SQL Database** (a read replica), writes the result to the cache, and returns it.

This is [cache-aside](/learn/cache-101#cache-aside). It suits this workload: reads are uneven, with spikes on the first of the month and after payday, and the cache absorbs them. The cost is staleness. When the extractor writes new transactions for a user, it should delete that user's cached summary, so the next read rebuilds it. [When to update the cache](/learn/cache-101#when-to-update-the-cache) compares cache-aside with write-through, write-behind and refresh-ahead.

### Read replicas and a write primary with failover

Add [read replicas](/learn/relational-databases#primary-replica-replication): copies of the database that receive every write from the primary and serve reads. With most reads answered by the cache, a couple of replicas should handle the cache misses, as long as replicating the heavy nightly writes doesn't leave them far behind. The primary has a standby that takes over if it fails ([fail-over](/learn/availability-101#fail-over-active-passive)).

The cost of replicas is **replication lag**. A user who changes a category and immediately reloads might see the old category if the read goes to a replica that hasn't caught up. For a few seconds after a user's own write, send that user's reads to the primary ([reading your own writes](/learn/relational-databases#replication-lag-and-reading-your-own-writes)).

### An analytics database for the aggregates

The MapReduce jobs and monthly totals are analytical work: they scan many rows and add them up. That workload differs from the app's small reads and writes (the batch chapter explains [OLTP versus OLAP](/learn/batch-processing#oltp-vs-olap-two-different-workloads)). Instead of keeping `monthly_spending` in the main SQL database, we could keep it in a separate **Analytics Database** built on a [data warehouse](/learn/batch-processing#data-warehouses-snowflake-google-bigquery-amazon-redshift) such as Amazon Redshift or Google BigQuery. The cost is another system and a copy of the data that's a little behind. The read API can still serve a user's totals from the cache.

### Keep only recent transactions in SQL

Most reads are about the current month. So we might keep only the most recent month or few months of `transactions` in the SQL database, and keep older ones in the data warehouse or the **Object Store**. An object store such as Amazon S3 handles 250 GB of new data a month easily, and it costs far less per gigabyte than database storage. The cost: a user who scrolls back a year now hits a slower path, and the app needs a clear rule about which store holds which months.

### Scaling the writes

2,000 writes a second on average, and several times that at peak, might be too much for a single SQL primary. Several SQL scaling patterns help:

- **[Federation](/learn/relational-databases#federation-one-database-per-feature):** split the database by function. Users and accounts in one, transactions in another, budgets in a third. Each database takes a share of the load, but you lose joins across them.
- **[Sharding](/learn/relational-databases#sharding-splitting-one-table-across-databases):** split the `transactions` table across several databases by `user_id`. Every query in this app is about one user, so each query goes to one shard, and one user's rows stay together. Sharding by date would send all of tonight's writes to the same shard. Watch for a few users with huge volumes, and split [hot shards](/learn/relational-databases#choosing-a-shard-key) when they appear.
- **[Denormalization](/learn/relational-databases#denormalization):** store copies of data to avoid joins. `user_id` on each transaction is already a small example: it saves joining through `accounts` for every "my transactions" query.
- **[SQL tuning](/learn/relational-databases#sql-tuning):** batch inserts (one statement per job, not per transaction), keep indexes to the ones queries need, and [partition the table by month](/learn/relational-databases#partition-tables) so dropping old months is cheap.

We should also consider moving `transactions` to a **NoSQL database**. A wide-column store such as Cassandra, keyed by `user_id` and sorted by `created_at`, is built for a heavy, steady stream of writes and for "this user's recent rows" queries. The cost is weaker transactions and no ad hoc joins, which this table rarely needs anyway. See [NoSQL databases](/learn/nosql-databases#wide-column-stores).

### Scaling extraction

The extraction workers are the other big consumer of capacity. They spend most of their time waiting on banks, so they scale by adding more workers or more concurrent fetches per worker. [Sizing workers with Little's Law](/learn/queues-and-async#sizing-workers-with-littles-law) gives the method: about 2,800 fetches in flight at peak.

- **Spread the schedule.** Don't enqueue all 30 million accounts at midnight. Give each account a fixed time slot through the night, or rely on the aggregator's webhooks, which arrive spread out on their own.
- **Respect rate limits.** Aggregators and banks limit how fast you may call them. Limit concurrency per institution so one slow bank doesn't tie up every worker.
- **Watch the queue.** If jobs pile up faster than workers finish them, apply [back pressure](/learn/queues-and-async#back-pressure-when-the-queue-keeps-growing): process manual refreshes first and let the scheduled daily refresh slip a few hours.

### Keep measuring

Each of these changes fixes one bottleneck and moves the pressure somewhere else. Keep benchmarking, profiling and fixing. Scaling is an iterative process.

## Trade-offs and follow-up questions

**Storing bank credentials or using tokens.** Screen scraping with stored passwords works with any bank that has a website, but it makes your database a vault of bank logins, it breaks whenever a bank redesigns its login page, and it's the practice the CFPB's rule aims to end. An aggregator with OAuth tokens means the user logs in at the bank, access can be revoked without changing the bank password, and you never see the password. The cost is a dependency on the aggregator, and paying for it. Pick tokens, and protect them with [encryption at rest and least privilege](/learn/security-101#encrypt-data-in-transit-and-at-rest).

**Precomputing totals or computing them on read.** Computing "spending by category" on each page view would mean summing a user's month of transactions every time. That's 5 billion ÷ 10 million = 500 rows for an average user by the end of the month, read on every page view, during spikes too. Precomputing into `monthly_spending` makes reads trivial, at the cost of keeping the totals correct when categories change. Since reads are rare and writes are frequent, it's tempting to compute on read. The deciding factor is the budget alerts: they need the totals after every update anyway, so precompute.

**SQL aggregation, MapReduce or running totals.** A SQL `GROUP BY` is simplest and fine at small scale. MapReduce on the raw files moves the work off the database and can recompute any month from scratch. Updating running totals as each batch lands is the cheapest but drifts if any update is lost or applied twice. A good answer combines them: running totals for freshness, plus a nightly batch recompute that corrects any drift. The batch job has to be [idempotent](/learn/batch-processing#idempotence-and-exactly-once-output), overwriting totals instead of adding to them.

**A budget template or stored budgets.** Storing all 100 million budget items is simple and makes every budget a row you can query. The template stores only overrides, about 6 million rows under our guess, but every budget lookup has to compute the template first. Since the computation is a few multiplications, the template wins.

**How categories are learned.** A seed map plus crowd votes is easy to explain and to debug. A machine-learning classifier on seller names, amounts and times would handle sellers with no votes, but it's harder to explain when it's wrong. Aggregators also return their own categories: Plaid's `personal_finance_category` field is filled for a typical 95% of transactions. You might start with that and let users and crowd votes refine it. Whichever you choose, keep the rule that a category, once set, doesn't change on its own.

**Daily batch or real time.** Daily updates and slow alerts let us batch work and skip inactive users. For "alert within a minute of the purchase", you'd feed aggregator webhooks into a [streaming pipeline](/learn/event-streaming) that updates running totals, which costs more to run.

## Check yourself

<details>
<summary>The product team wants to refresh every one of the 30 million accounts, not only active users', and to finish within 4 hours. Each fetch takes about 2 seconds. How many fetches must be in flight at once?</summary>

Four hours is 4 × 3,600 = 14,400 seconds. 30,000,000 ÷ 14,400 ≈ 2,080 jobs a second. By Little's Law, the number in flight is the arrival rate times the time each one takes: 2,080 × 2 s ≈ 4,200 concurrent fetches.

That's mostly waiting on the network, so it's a job for many lightweight concurrent requests. But 4,200 concurrent calls may exceed what the aggregator allows. Check the rate limits before committing, and point out that refreshing inactive users costs money for data nobody looks at.

</details>

<details>
<summary>A user moves a $60 Shell purchase from Gas to Food. Walk through everything that changes.</summary>

The transaction row gets `category = 'food'` and `category_source = 'user'`. The Category Service records a vote that Shell is Food. One vote is far below `min_votes`, so Shell stays Gas for everyone else, and nobody's past transactions change. The Budget Service recomputes this user's totals for that month: Gas goes down by $60 and Food goes up by $60. It may then send a Food alert if that pushed Food over 80%. Finally, the cached summary for this user is deleted, so the next page load shows the new numbers. If the read goes to a replica, it should go to the primary for a few seconds so the user sees their own change.

</details>

<details>
<summary>An early design stores `account_password_hash` for each linked bank account. What's wrong with it?</summary>

A hash is one-way. It's the right way to store your own users' passwords, because you only need to check them. The extractor needs the bank password itself, to log in to the bank every day, so a hash is useless. The only way to make screen scraping work is to store the password encrypted, and then a breach of the database and the key leaks bank logins for millions of people.

The better fix is to avoid holding the password at all. Connect through an aggregator with OAuth, store only the access token, encrypt it with keys held in a KMS, and let only the extractor decrypt it.

</details>

<details>
<summary>The nightly job crashed and was retried. Some users now see each transaction twice. What went wrong, and how do you prevent it?</summary>

The extractor inserted rows without any way to tell that it had already inserted them. A retried job fetched the same transactions and inserted them again. The fix is to store the bank's own transaction ID with a unique constraint on `(account_id, external_id)`, and to write with "insert or update". Then a repeated job changes nothing.

The monthly totals need the same care. If the Budget Service adds each batch to a running total, a retry adds it twice. Either recompute the month's total from the transactions, which gives the same answer however many times it runs, or record which batches were already applied.

</details>

<details>
<summary>Users complain that they got the "Food budget at 80%" alert three times in one day. Why might that happen, and what's the fix?</summary>

The budget check probably runs after every update, and maybe again on retries. Each run sees spending above 80% and sends an alert. The check needs memory of what it already sent. Record each alert with a unique key of `(user_id, month, category, threshold)`, and send only when inserting that key succeeds. The insert and the send can still be split by a crash, so the Notification Service should also drop duplicates by the same key.

</details>

## Further reading

- [Intuit Mint (Wikipedia)](https://en.wikipedia.org/wiki/Intuit_Mint): Mint's history from 2006 to its closure on March 23, 2024, including its early use of Yodlee and the 2010 criticism of how it stored bank logins.
- [The popular Mint budgeting tool is shutting down (PCWorld)](https://www.pcworld.com/article/2125596/the-popular-mint-budgeting-tool-is-shutting-down.html): the November 2023 report of the closure and the move to Credit Karma, which lacked Mint's category budgets.
- [Mint budgeting platform shutting down (Doctor of Credit)](https://doctorofcredit.com/mint-budgeting-platform-shutting-down-after-2023/): notes the shutdown date moving from January 1 to March 23, 2024.
- [Chase, Intuit to give customers greater control of their information](https://media.chase.com/news/chase-intuit-to-give-customers-greater-control-of-their-information): the January 2017 press release on replacing shared passwords with tokens for Mint and other Intuit products.
- [CFPB: Personal Financial Data Rights](https://www.consumerfinance.gov/personal-financial-data-rights/): the rule under section 1033, its final rule and the 2025 reconsideration.
- [CFPB finalizes the Personal Financial Data Rights rule](https://www.consumerfinance.gov/about-us/newsroom/cfpb-finalizes-personal-financial-data-rights-rule-to-boost-competition-protect-privacy-and-give-families-more-choice-in-financial-services/): the October 2024 announcement, with the rule's stance on screen scraping, data-use limits and compliance dates.
- [Section 1033 compliance date: open banking rule enjoined and under reconsideration (Cozen O'Connor)](https://www.cozen.com/news-resources/publications/2026/section-1033-compliance-date-open-banking-rule-enjoined-and-under-reconsideration): an April 2026 law-firm alert on the court order blocking enforcement.
- [Plaid: OAuth guide](https://plaid.com/docs/link/oauth/) and [Plaid quickstart](https://plaid.com/docs/quickstart/): how a user connects a bank without sharing credentials, and how the public token is exchanged for an access token.
- [Plaid: Transactions](https://plaid.com/docs/transactions/): incremental sync with cursors, webhooks, how often banks are checked, and built-in categories.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): the classic table behind the memory, SSD and disk comparison.
- [MySQL: fixed-point types](https://dev.mysql.com/doc/refman/8.0/en/fixed-point-types.html): why a bare `DECIMAL` has no digits after the decimal point.
