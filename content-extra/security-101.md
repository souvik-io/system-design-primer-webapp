# Security 101

Security is hard to add to a system after it's built. It decides how every request is authenticated, what each caller is allowed to do, how data is protected on the wire and on disk, and what happens when one of those defenses fails. A fast, scalable system that leaks user data, or falls over under the first denial-of-service attack, has still failed.

The primer's security section is a short list of concepts with links to checklists. This chapter covers the pieces that show up in system design: how users and services prove who they are (sessions, JWTs, OAuth 2.0, OpenID Connect, mTLS), how access is decided (RBAC and ABAC), what the edge and the API gateway defend against, how data is encrypted with keys held in a KMS, and the common application bugs that undo all of it.

It builds on the primer's [security](/learn/security), [application layer](/learn/application-layer), [reverse proxy](/learn/reverse-proxy-web-server) and [communication](/learn/communication) chapters, and on [reverse proxy and API gateway 101](/learn/reverse-proxy-and-api-gateway-101).

## Authentication and identity

Authentication answers *who is making this request?* In a distributed system there are two kinds of caller: people using a browser or mobile app, and services calling other services. They are usually handled differently.

### Sessions vs tokens

When a user logs in, the system checks their credentials, such as a password plus a second factor. HTTP doesn't remember anything between requests, so the system then gives the client something to send with every later request that proves it already logged in. There are two common designs.

| | Server-side session | Self-contained token (JWT) |
|---|---|---|
| **What the client holds** | An opaque random session ID, usually in a cookie. | A signed token that carries the user's ID, expiry and other claims. |
| **What the server stores** | The session record (user ID, expiry, etc.) in Redis or a database. | Nothing per user. It needs only the key to check signatures. |
| **Checking a request** | Look the session ID up in the store. | Verify the signature with a public key or shared secret, then check the expiry. |
| **Logging someone out** | Delete the session record. It takes effect on the next request. | Hard. The token stays valid until it expires, unless servers check a revocation list, which brings back a lookup. |
| **Size** | Small: a random ID of about 32 characters. | Hundreds of bytes or more, since claims are base64url-encoded JSON. |
| **Good fit** | First-party web apps, where instant logout and account bans matter. | APIs called by many services or across domains, where a shared session store is awkward. |

A **JWT** (JSON Web Token) has three base64url-encoded parts separated by dots: a header saying which algorithm signed it, a payload of claims (`sub` for the user ID, `exp` for expiry, `aud` for the intended audience, and so on), and the signature. The payload is only encoded, not encrypted, so anyone holding the token can read it. Never put secrets in it.

Most production systems combine the two. They use a **short-lived access token** (valid 5 to 15 minutes) that APIs check without any lookup, and a **long-lived refresh token** (days to weeks) that is stored and checked server-side. When the access token expires, the client sends the refresh token to the authorization server. That server checks that the account is still active and the refresh token hasn't been revoked, then issues a new access token. Many servers also **rotate** the refresh token on each use and treat reuse of an old one as a sign of theft.

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

So a banned account keeps access for at most one access-token lifetime, a few minutes, while ordinary requests never touch the token store.

### Federated identity: OAuth 2.0 and OpenID Connect

Most systems don't want every component handling passwords. They hand that job to a dedicated identity provider, using two standards that are often confused:

- **OAuth 2.0** is a framework for **delegated authorization**. It lets an application get limited access to a user's data on another service without ever seeing the user's password. For example, a photo-printing site can read your photos from a cloud photo service. The user approves the request at the provider, and the application gets an **access token** limited to certain **scopes** (such as "read photos") to call the provider's API with. OAuth 2.0 on its own says nothing about who the user is.
- **OpenID Connect (OIDC)** is an identity layer on top of OAuth 2.0 that adds **authentication**. Besides the access token, the provider returns an **ID token**: a signed JWT with claims about the login, including `iss` (who issued it), `sub` (a stable user ID), `aud` (which application it's for), `exp`, and optionally profile claims like `email`. "Sign in with Google" is OIDC. The ID token is meant for the application that requested it, to learn who logged in. It is not meant to be sent to APIs, which take access tokens.

For browser and mobile apps, the recommended flow is the **authorization code flow with PKCE** (Proof Key for Code Exchange, RFC 7636). The steps:

1. The app generates a random secret, the `code_verifier`, and computes `code_challenge = BASE64URL(SHA-256(code_verifier))`.
2. It sends the user to the provider's login page with the `code_challenge`.
3. After the user logs in and approves, the provider redirects back to the app with a short-lived **authorization code**.
4. The app exchanges the code for tokens, sending the original `code_verifier`. The provider hashes it and checks it matches the challenge from step 2.

Someone who intercepts the code in step 3 can't use it, because they don't have the verifier. The current OAuth security best practice (RFC 9700) recommends PKCE for every client and says not to use the old implicit flow, which returned tokens directly in the redirect URL.

### Service-to-service identity: mutual TLS

Inside a private network or Kubernetes cluster, services also need to know who is calling them. Trusting a request because it comes from an internal IP address is weak: an attacker who takes over one container can then call anything, and IP addresses change constantly anyway.

In ordinary TLS only the server proves its identity. With **mutual TLS (mTLS)**, both sides do, during the TLS handshake:

1. Service A connects to service B. B sends its X.509 certificate, as in normal TLS.
2. B asks for a client certificate, and A sends its own.
3. Each side checks that the other's certificate is signed by a trusted internal certificate authority (CA) and hasn't expired. Each also proves it holds the private key matching its certificate, by signing part of the handshake.
4. Both derive fresh session keys, and the rest of the connection is encrypted.

Now B knows exactly which service is calling, and can apply rules like "only the checkout service may call payments". Managing certificates by hand for hundreds of services doesn't work, so in practice a **service mesh** does it. Each service's sidecar proxy gets a short-lived certificate encoding the service's identity (often a SPIFFE ID such as `spiffe://cluster.local/ns/shop/sa/checkout`), renews it automatically, and handles the handshake. The application itself speaks plain HTTP to its local sidecar. See [reverse proxy and API gateway 101](/learn/reverse-proxy-and-api-gateway-101#the-service-mesh-and-sidecar-proxies).

## Authorization: access control models

Once you know who the caller is, authorization answers *may this caller do this action on this resource?*

### Role-based access control (RBAC)

RBAC grants permissions to named **roles** and gives roles to users. A user with the `editor` role gets `documents:read` and `documents:write`, for example.

RBAC is simple to build and easy to audit ("who can delete invoices?" is a lookup), but it struggles once rules depend on context:

- An editor can edit documents, but should they be able to edit another department's documents?
- What about only during working hours, or only from a managed laptop?

Encoding each of these as a role leads to **role explosion**: hundreds of roles like `editor_finance_us_readonly_weekend` that nobody can keep track of.

### Attribute-based access control (ABAC)

ABAC decides using **policies** over attributes, usually in four groups:

- **Subject:** who is asking (user ID, department, role, clearance).
- **Action:** what they want to do (read, write, delete, approve).
- **Resource:** what they want to do it to (document ID, owner, department, classification).
- **Environment:** the context (time, network, device posture).

A policy might say: *allow users in the Finance department to edit Budget documents whose region matches the user's region, from a managed device.* One rule like that replaces dozens of roles. The cost is that "who can access this?" is harder to answer, because the answer depends on attributes at request time.

In practice the two mix: roles are just one attribute among many. For "users can edit documents shared with them" style rules, many systems use **relationship-based access control (ReBAC)**, which checks a graph of who owns or was shared what. Google's Zanzibar paper describes the best-known example.

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

Larger systems split the work in two (the terms come from the XACML standard):

- The **policy enforcement point (PEP)** sits in the request path, at the gateway, a sidecar, or inside the service. It collects the attributes, asks for a decision, and then allows or blocks the request.
- The **policy decision point (PDP)** evaluates policies and returns a decision, typically allow or deny, sometimes with extra conditions. Open Policy Agent (OPA) is a common general-purpose PDP. Its policies are written in a language called Rego and kept in version control like code.

Keeping policy in one engine means rules are written once, tested, and changed without redeploying every service. PDPs are usually run next to the PEP (as a sidecar or library) so a decision doesn't add a network round trip to every request.

## Network and boundary security

The guiding principle is **defense in depth**: put independent controls at each layer (the edge, the network, the application, the data), so that one control failing doesn't expose everything. The WAF misses an injection, but the query is parameterized. An attacker gets a database backup, but it's encrypted with a key they can't reach.

### Edge, WAF and API gateway

Before traffic reaches application servers, it passes through several layers, each stopping a different kind of attack:

1. **DDoS protection at the edge.** CDN and edge providers (Cloudflare, Amazon CloudFront with AWS Shield, Fastly, Akamai) absorb volumetric attacks at layers 3 and 4, such as UDP floods and SYN floods. Their capacity is spread across many locations by Anycast, so the flood is split up long before it reaches you. See [DNS and CDN 101](/learn/dns-and-cdn-101#anycast-routing-one-address-many-places).
2. **Web application firewall (WAF).** Inspects HTTP requests at layer 7 and blocks known attack patterns: SQL injection strings, cross-site scripting payloads, exploit signatures such as Log4Shell, and malformed requests. A WAF is a filter for known patterns, not a fix. The application still has to be safe on its own.
3. **API gateway.** Enforces [rate limits](/learn/rate-limiting) per IP address, API key or user, authenticates callers, rejects requests that don't match the API's schema, caps body sizes, and strips headers that clients aren't allowed to set, such as internal identity headers.

### Zero trust

The older model was **castle and moat**: everything outside the firewall is untrusted, everything inside is trusted. Its weakness is that one compromised laptop or container puts the attacker inside, with access to everything.

**Zero trust** (described in NIST SP 800-207) assumes the attacker may already be inside:

- Being on the internal network grants nothing. Every request is authenticated and authorized, service-to-service calls included, which is where mTLS comes in.
- Access follows **least privilege**: each user and service gets only the permissions its job needs, so one compromised credential has a small blast radius.
- Decisions can use context such as device health, and are made per request, not once per login.

## Data protection: encryption and key management

Data needs protection in two states: moving across a network (**in transit**) and stored on disk (**at rest**).

### In transit: TLS 1.3

TLS gives confidentiality, integrity and server authentication between two endpoints. **TLS 1.3** (RFC 8446, 2018) is the current version. Compared with TLS 1.2 it brings:

- **A faster handshake.** A full handshake takes one round trip before application data can flow, instead of two in TLS 1.2. A client resuming a recent session can send data in its very first flight (**0-RTT**). That early data can be **replayed** by an attacker, though, so servers should accept it only for requests that are safe to repeat, such as a GET.
- **Only modern cryptography.** It removed RSA key transport, CBC-mode ciphers, compression and renegotiation. Every handshake uses an ephemeral Diffie-Hellman exchange, which gives **forward secrecy**: if the server's long-term private key is stolen later, previously recorded traffic still can't be decrypted, because the session keys were never derivable from it.

Terminate TLS at the edge for internet traffic, and use TLS or mTLS again on internal hops. Leaving traffic unencrypted inside the network is what zero trust tells you not to do.

### At rest: envelope encryption with a KMS

Encrypting data with a key stored on the same disk, or in the app's config file, protects very little: whoever gets the data probably gets the key too. Production systems use **envelope encryption**, which separates two kinds of key:

1. **Data encryption key (DEK).** A key, typically 256-bit AES, used to encrypt the actual data: a file, a database record, a disk volume. Each piece of data, or each tenant, can have its own.
2. **Key encryption key (KEK).** A master key that lives inside a **key management service (KMS)**, such as AWS KMS, Google Cloud KMS, Azure Key Vault or HashiCorp Vault's transit engine, usually backed by hardware security modules (HSMs). The KEK never leaves the KMS. Its only job is encrypting and decrypting DEKs.

```diagram
title: Envelope encryption with a key management service
[app] Application @ 0,0.5
[kms:store] Key management\nservice (KMS) @ 2,0
[disk:store] Database or\nobject storage @ 2,1
app <-> kms : new data key
app -> disk : ciphertext + wrapped DEK
```

Writing data:

1. The application asks the KMS for a new data key under a named master key. In AWS KMS this call is `GenerateDataKey`.
2. The KMS returns the DEK twice: in **plaintext**, and **wrapped** (encrypted under the KEK).
3. The application encrypts the data locally with the plaintext DEK, stores the ciphertext together with the wrapped DEK, and discards the plaintext DEK from memory.

Reading it back:

4. The application sends the wrapped DEK to the KMS (`Decrypt`). The KMS checks the caller's permissions, unwraps it with the KEK, and returns the plaintext DEK.
5. The application decrypts the data locally.

Why this design:

- **Bulk encryption stays local.** The KMS only ever handles 32-byte keys, not your gigabytes. AWS KMS won't even encrypt more than 4 KB directly. Your data never leaves your servers, and KMS request rates stay manageable. Applications often cache plaintext DEKs briefly to cut KMS calls further.
- **Access is controlled and logged in one place.** Every unwrap is a KMS call, checked against IAM policy and recorded in an audit log, so you can see and revoke who can decrypt what.
- **Rotation is cheap.** Managed KMS rotation keeps old versions of the master key, so existing wrapped DEKs still decrypt and nothing has to be re-encrypted. If you move to a completely new master key, you re-wrap the small DEKs (AWS has a `ReEncrypt` call for this), not the data.

### Secrets management

Database passwords, API keys and private keys committed to source code or baked into container images are a common cause of breaches: they end up in git history, CI logs and image registries. Keep them in a secrets manager instead (HashiCorp Vault, AWS Secrets Manager, Google Secret Manager). Kubernetes Secrets are only base64-encoded unless you turn on encryption at rest, ideally with a KMS provider.

- **Dynamic secrets.** Instead of one database password shared by every instance, Vault can create a separate database login for each instance, with a lease that expires after a set time. A leaked credential stops working on its own, and the logs show which instance it belonged to.
- **Rotation.** Long-lived secrets are rotated on a schedule. Applications should fetch secrets at runtime and reload them when they change, so rotation doesn't need a redeploy.
- **Auditing.** Every read is logged with the identity of the caller.

## Common application vulnerabilities and mitigations

Strong architecture is undone by a single injectable query. These are the bugs that keep appearing in the [OWASP Top 10](https://owasp.org/www-project-top-ten/), and the standard defenses.

### Injection (SQL, command)

Injection happens when untrusted input is pasted into a query or command, so the input can change what the query means.

- **The bug:** building SQL by string concatenation, as in `"SELECT * FROM users WHERE email = '" + input + "'"`. An input of `' OR '1'='1` turns it into a query that matches every user.
- **The fix:** **parameterized queries** (prepared statements), or an ORM or query builder that uses them. The query's structure is fixed first and the input is sent separately as data, so it can't change the structure. Table and column names can't be parameters, so if they come from users, check them against a fixed allowlist. For shell commands, pass arguments as an array instead of building a command string.

### Cross-site scripting (XSS)

XSS happens when an app puts untrusted data into a page without escaping it, letting an attacker run JavaScript in other users' browsers.

- **Impact:** the script runs as the victim on your site. It can read anything on the page, make requests with the victim's session, and steal tokens it can reach.
- **Mitigations:**
  - Escape output for its context (HTML body, attribute, URL, JavaScript). Modern templating frameworks do this by default. The danger is in the escape hatches, like raw-HTML helpers.
  - Keep session tokens in `HttpOnly` cookies so scripts can't read them through `document.cookie`. This limits the damage, though injected script can still act as the user while the page is open.
  - Send a strict **Content Security Policy (CSP)** header. A policy that allows scripts only from your own origin, or only with a per-response nonce, and doesn't include `'unsafe-inline'`, stops most injected scripts from running.

### Cross-site request forgery (CSRF)

CSRF tricks a logged-in user's browser into sending a request to your site from another site, for example a hidden form that posts a money transfer. The browser attaches the user's cookies, so the request looks genuine.

- **Mitigations:**
  - Set `SameSite` on session cookies. With `SameSite=Lax`, the browser doesn't send the cookie on cross-site POSTs or on requests embedded in another site (images, iframes, fetch). It still sends it when the user follows a plain link to your site, so GET requests must never change state. `SameSite=Strict` doesn't send it on any cross-site request, which is safer but means users arriving from a link appear logged out. Most browsers now treat cookies without a `SameSite` attribute as `Lax`.
  - Use **anti-CSRF tokens**: a random value tied to the session, put in each form or sent in a custom header like `X-CSRF-Token`, and checked by the server on every state-changing request. Another site can't read the token, so it can't forge the request.
  - APIs that authenticate with a bearer token in the `Authorization` header aren't exposed to CSRF in the first place, because browsers don't attach that header automatically.

### Server-side request forgery (SSRF)

SSRF happens when a server fetches a URL supplied by a user, such as a link preview or an image import, and doesn't restrict where it can go.

- **Impact:** the attacker makes your server call things only it can reach, like `http://127.0.0.1:8080/admin` or the cloud metadata service at `http://169.254.169.254/`, which on a misconfigured instance hands out temporary cloud credentials. This was the core of the 2019 Capital One breach.
- **Mitigations:**
  - Run URL fetching in an isolated service whose network egress is limited to the public internet.
  - Resolve the hostname, then refuse private and special addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, loopback `127.0.0.0/8`, link-local `169.254.0.0/16`, and their IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`). Connect to the IP address you checked, not the name, so a DNS answer that changes between your check and your request (**DNS rebinding**) can't get around the filter. Apply the same check to every redirect.
  - Protect the metadata endpoint itself. On AWS, require **IMDSv2**, which only hands out credentials after a `PUT` request that returns a session token, and by default allows only one network hop, so a simple GET forwarded through a vulnerable app can't reach it.

## Check yourself

<details>
<summary>Why is it risky to use long-lived JWTs alone for user authentication, and what's the usual fix?</summary>

A JWT is checked by its signature and expiry alone, so it can't be revoked. If one is stolen, or you ban the account, it keeps working until it expires. Make tokens last 7 days and that's a 7-day exposure. Make them last 10 minutes with nothing else, and users have to log in every 10 minutes.

The usual fix pairs a short-lived access token (5–15 minutes) with a refresh token that is stored server-side, kept in an `HttpOnly` cookie on the web, and often rotated on each use. Normal API calls stay lookup-free. Every few minutes, the refresh gives the authorization server a checkpoint where it can refuse a banned account or a revoked token. The worst case after a ban drops to one access-token lifetime.

</details>

<details>
<summary>What is the difference between OAuth 2.0 and OpenID Connect, and which token should an API accept?</summary>

OAuth 2.0 is for delegated authorization: it gives an application an access token to call an API on the user's behalf, limited by scopes. It doesn't define how to learn who the user is. OpenID Connect adds authentication on top: an ID token, a signed JWT that tells the application who logged in (`sub`, `iss`, `aud`, `exp`).

An API should accept access tokens, checking that the token is meant for it (the audience) and carries the needed scopes. ID tokens are meant only for the client application that requested them.

</details>

<details>
<summary>An attacker gets a copy of your database backup. How does envelope encryption protect the data, and what would they need to get anything out of it?</summary>

The backup holds only ciphertext and wrapped DEKs. The plaintext DEKs were never written to disk. To unwrap a DEK, you have to call the KMS, which holds the master key in its hardware and never releases it. The KMS allows the call only for identities its policy permits, and logs every request.

So the attacker would also need credentials that let them call `Decrypt` on that key: for example by compromising the application's own cloud identity. That's still possible, which is why KMS permissions are kept narrow and its audit logs are monitored. But a stolen backup by itself is useless.

</details>

<details>
<summary>How does mutual TLS differ from ordinary TLS, and why is it used between internal services?</summary>

In ordinary TLS, only the server presents a certificate, which the client checks. The client is anonymous at the transport level and proves who it is later with a password, cookie or token. In mTLS, the server also asks for a client certificate, and both sides check the other's certificate against a trusted CA and prove they hold the matching private key. All of this happens in the TLS handshake, after the TCP connection is set up and before any HTTP data is sent. If either check fails, the connection is closed.

Between services it gives each call a verified caller identity that doesn't depend on IP addresses, and encrypts internal traffic. Both are central to zero trust. A service mesh usually issues and rotates the certificates, so applications don't handle them.

</details>

<details>
<summary>When would you choose ABAC over RBAC, and what does the PEP/PDP split add?</summary>

RBAC is enough when permissions follow job function and don't depend on the specific resource or context, for example "support agents can view orders". Once rules depend on resource ownership, department, region, time or device, expressing them as roles leads to role explosion. ABAC states them directly as policies over attributes of the subject, action, resource and environment.

The PEP/PDP split puts those policies in one engine (the PDP, such as OPA) that every enforcement point (gateways, sidecars, services) asks. Rules are written, tested and changed in one place instead of being copied into each service, and decisions are consistent across the system.

</details>

## Further reading

- [RFC 6749: The OAuth 2.0 Authorization Framework](https://www.rfc-editor.org/rfc/rfc6749): the core OAuth 2.0 specification.
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://www.rfc-editor.org/rfc/rfc9700): today's guidance, including PKCE for every client and dropping the implicit flow.
- [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html): the ID token and the authentication flows built on OAuth 2.0.
- [RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc8446): the handshake, forward secrecy, and the replay caveats of 0-RTT data.
- [AWS KMS concepts](https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html): KMS keys, data keys and envelope encryption as one provider implements them.
- [NIST SP 800-207: Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final): the reference description of zero trust.
- [OWASP Top Ten](https://owasp.org/www-project-top-ten/) and the [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/): the most common web application risks, and practical guidance on preventing each.
