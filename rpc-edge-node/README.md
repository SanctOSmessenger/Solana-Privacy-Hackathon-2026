# 🛰️ SanctOS RPC Edge Node (Cloudflare Worker)

A production **Solana JSON-RPC edge proxy** used by SanctOS to make the app **faster, cheaper, and more reliable**.

## Features

- ⚡ **Edge caching** for safe read-only RPC methods (Cache API)
- 🧠 **Per-isolate inflight dedupe** (collapses identical RPC calls in-flight)
- 📊 **Durable Object stats** (persistent counters across isolates)
- ✅ **Health endpoint** for monitoring
- 🧩 **Optional indexer proxy** (`/indexer/*`) with strict forwarding + timeouts
- 🖥️ **Live dashboard** at `/dash` for observability

> **Worker name:** `sanctos-rpc-node`  
> **Entry:** `worker.js`  
> **Durable Object:** `SANCTOS_STATS → SanctosStatsDO`

---

## Why this exists

Solana applications are extremely **read-heavy** (slots, balances, signatures, transactions).

SanctOS runs its own RPC edge node to:

1. **Reduce latency** by caching hot reads at the edge
2. **Reduce upstream RPC cost** via caching + inflight dedupe
3. **Increase reliability** using multi-upstream failover + stale fallback
4. **Expose real metrics** via Durable Objects, `/health`, and `/dash`

---

## High-level architecture

```text
SanctOS (browser / app)
        |
        |  POST JSON-RPC
        v
Cloudflare Worker (this repo)
        ├─ cache safe reads (Cache API)
        ├─ bypass writes & sensitive methods
        ├─ inflight request deduplication
        ├─ metrics → Durable Object
        └─ optional /indexer/* proxy
        |
        v
Upstream RPCs (QuickNode / Helius / etc)
```

---

## Endpoints

| Route | Method | Purpose |
|------|--------|---------|
| `/` | POST | Solana JSON-RPC proxy (cache + dedupe + failover) |
| `/` | GET | Friendly debug response |
| `/__sanctos_health` / `/health` | GET | JSON health + stats |
| `/dash` | GET | HTML dashboard (auto-refresh) |
| `/__sanctos_do_ping` | GET | Confirms Durable Object binding |
| `/indexer/*` | GET / POST | Optional indexer proxy |

---

## Caching policy

### Never cached (always bypassed)

Writes or sensitive reads:

- `sendTransaction`
- `sendRawTransaction`
- `simulateTransaction`
- `requestAirdrop`
- `getLatestBlockhash`
- `getSignatureStatuses`

### Cached (safe reads)

Short-TTL edge caching:

- `getSignaturesForAddress`
- `getSlot`, `getBlockHeight`
- `getBalance`
- `getAccountInfo`
- `getMultipleAccounts`
- `getProgramAccounts`
- `getTokenAccountsByOwner`
- `getTransaction`# 🛰️ SanctOS RPC Edge Node (Cloudflare Worker)

A production **Solana JSON-RPC edge proxy** used by SanctOS to make the app **faster, cheaper, and more reliable**.

## Features

- ⚡ **Edge caching** for safe read-only RPC methods (Cache API)
- 🧠 **Per-isolate inflight dedupe** (collapses identical RPC calls in-flight)
- 📊 **Durable Object stats** (persistent counters across isolates)
- ✅ **Health endpoint** for monitoring
- 🧩 **Optional indexer proxy** (`/indexer/*`) with strict forwarding + timeouts
- 🖥️ **Live dashboard** at `/dash` for observability

> **Worker name:** `sanctos-rpc-node`  
> **Entry:** `worker.js`  
> **Durable Object:** `SANCTOS_STATS → SanctosStatsDO`

---

## Why this exists

Solana applications are extremely **read-heavy** (slots, balances, signatures, transactions).

SanctOS runs its own RPC edge node to:

1. **Reduce latency** by caching hot reads at the edge
2. **Reduce upstream RPC cost** via caching + inflight dedupe
3. **Increase reliability** using multi-upstream failover + stale fallback
4. **Expose real metrics** via Durable Objects, `/health`, and `/dash`

---

## High-level architecture

SanctOS (browser / app)
        |
        |  POST JSON-RPC
        v
Cloudflare Worker (this repo)
        ├─ cache safe reads (Cache API)
        ├─ bypass writes & sensitive methods
        ├─ inflight request deduplication
        ├─ metrics → Durable Object
        └─ optional /indexer/* proxy
        |
        v
Upstream RPCs (QuickNode / Helius / etc)

### Endpoints

| Route                        | Method     | Purpose                                           |
|------------------------------|------------|---------------------------------------------------|
| `/`                          | POST       | Solana JSON-RPC proxy (cache + dedupe + failover) |
| `/`                          | GET        | Friendly debug response                           |
| `/__sanctos_health` or `/health` | GET    | JSON health + stats                               |
| `/dash`                      | GET        | HTML dashboard (auto-refresh)                     |
| `/__sanctos_do_ping`         | GET        | Confirms Durable Object binding                   |
| `/indexer/*`                 | GET / POST | Optional indexer proxy                            |

### Caching policy

**Never cached (always bypassed)** — writes or sensitive reads:

- `sendTransaction`
- `sendRawTransaction`
- `simulateTransaction`
- `requestAirdrop`
- `getLatestBlockhash`
- `getSignatureStatuses`

**Cached** (safe reads) — short TTL edge caching:

- `getSignaturesForAddress`
- `getSlot`, `getBlockHeight`
- `getBalance`
- `getAccountInfo`
- `getMultipleAccounts`
- `getProgramAccounts`
- `getTokenAccountsByOwner`
- `getTransaction`
- `getParsedTransaction`  
  (with special handling for incomplete/null results)

**🧊 Stale-while-revalidate + fallback behavior**

- If cached data is stale but within `SANCTOS_STALE_WINDOW`:  
  → serve **STALE** + revalidate in background
- If upstream fails **and** `SANCTOS_STALE_FALLBACK_ON_ERROR=1`:  
  → serve **STALE-FALLBACK**

**Debug headers you’ll see:**

- `x-sanctos-cache`: HIT | MISS | STALE | BYPASS | …
- `x-sanctos-upstream-name`
- `x-sanctos-upstream-status`
- `x-sanctos-worker-build`
- `x-sanctos-instance`

---

## Observability (Durable Object stats)

`SanctosStatsDO` tracks:

- Total request counts
- Cache hits / misses / bypasses
- Inflight dedupe metrics
- Last upstream status + error
- RPC method counts (today + all-time)
- Traffic lanes: `rpc`, `indexer`, `dash`, `health`, `other`
- Rolling last-60-seconds rate series

**Live views:**

- `GET /__sanctos_health`
- `GET /dash`

---

## Configuration

Configured via **Wrangler vars** and **secrets**.

### wrangler.toml example

```toml
name = "sanctos-rpc-node"
main = "worker.js"
compatibility_date = "2025-11-25"

[vars]
SANCTOS_CACHE_ALL              = "0"
SANCTOS_DEFAULT_TTL            = "3"
SANCTOS_STALE_WINDOW           = "60"
SANCTOS_STALE_FALLBACK_ON_ERROR = "1"
SANCTOS_CACHE_SYNC_WRITE       = "1"

ALLOW_ORIGINS = "https://messenger.sanctos.app,http://localhost:8091,http://localhost:3000"

EXPOSE_HEADERS = "x-sanctos-cache,x-sanctos-upstream-name,x-sanctos-upstream-status,x-sanctos-upstream,x-sanctos-worker-build,x-sanctos-instance,x-sanctos-indexer,x-sanctos-indexer-status"

UPSTREAM_ALIASES      = "quicknode 1,helius 1"
UPSTREAM_SECRET_KEYS  = "UPSTREAM_QUICKNODE_1_URL,UPSTREAM_HELIUS_1_URL"

INDEXER_URL           = "https://indexer.sanctos.app"
INDEXER_ENABLED       = "true"
INDEXER_TIMEOUT_MS    = "2500"

[[durable_objects.bindings]]
name      = "SANCTOS_STATS"
class_name = "SanctosStatsDO"

[[migrations]]
tag        = "sanctos-stats-v1"
new_classes = ["SanctosStatsDO"]

Secrets (never commit)bash

npx wrangler secret put UPSTREAM_QUICKNODE_1_URL
npx wrangler secret put UPSTREAM_HELIUS_1_URL

Run & DeployLocal developmentbash

npx wrangler dev

Then open:http://127.0.0.1:8787/__sanctos_health
http://127.0.0.1:8787/dash

Deploybash

npx wrangler deploy

Validate:bash

curl https://<your-worker-domain>/__sanctos_health

CORSAllowed origins → ALLOW_ORIGINS variable
Exposed headers  → EXPOSE_HEADERS variable

Example allowed origins:https://messenger.sanctos.app
http://localhost:8091
http://localhost:3000

Indexer proxy modeWhen INDEXER_ENABLED=true:/indexer/* → forwarded to INDEXER_URL
Strict proxy:Preflight handled
Minimal headers forwarded
No cookies forwarded
Timeout = INDEXER_TIMEOUT_MS

Disable for demos / testing:toml

INDEXER_ENABLED = "false"

Security postureUpstream URLs redacted in headers
Secrets never committed
Indexer proxy avoids forwarding auth/cookies
No user data stored in the worker


- `getParsedTransaction` (with special handling for incomplete/null results)

### 🧊 Stale-while-revalidate & fallback

- If cached data is stale but within `SANCTOS_STALE_WINDOW` → **STALE** + background revalidate
- If upstream fails and `SANCTOS_STALE_FALLBACK_ON_ERROR=1` → **STALE-FALLBACK**

**Debug headers:**

- `x-sanctos-cache` (HIT | MISS | STALE | BYPASS | …)
- `x-sanctos-upstream-name`
- `x-sanctos-upstream-status`
- `x-sanctos-worker-build`
- `x-sanctos-instance`

---

## Observability (Durable Object stats)

`SanctosStatsDO` tracks:

- Total request counts
- Cache hits / misses / bypasses
- Inflight dedupe metrics
- Last upstream status + error
- RPC method counts (today + all-time)
- Traffic lanes: `rpc`, `indexer`, `dash`, `health`, `other`
- Rolling last-60-seconds rate series

**Live views:**

- `GET /__sanctos_health`
- `GET /dash`

---

## Configuration

Configured via **Wrangler vars** and **secrets**.

### `wrangler.toml` example

```toml
name = "sanctos-rpc-node"
main = "worker.js"
compatibility_date = "2025-11-25"

[vars]
SANCTOS_CACHE_ALL               = "0"
SANCTOS_DEFAULT_TTL             = "3"
SANCTOS_STALE_WINDOW            = "60"
SANCTOS_STALE_FALLBACK_ON_ERROR = "1"
SANCTOS_CACHE_SYNC_WRITE        = "1"

ALLOW_ORIGINS = "https://messenger.sanctos.app,http://localhost:8091,http://localhost:3000"

EXPOSE_HEADERS = "x-sanctos-cache,x-sanctos-upstream-name,x-sanctos-upstream-status,x-sanctos-upstream,x-sanctos-worker-build,x-sanctos-instance,x-sanctos-indexer,x-sanctos-indexer-status"

UPSTREAM_ALIASES     = "quicknode 1,helius 1"
UPSTREAM_SECRET_KEYS = "UPSTREAM_QUICKNODE_1_URL,UPSTREAM_HELIUS_1_URL"

INDEXER_URL        = "https://indexer.sanctos.app"
INDEXER_ENABLED    = "true"
INDEXER_TIMEOUT_MS = "2500"

[[durable_objects.bindings]]
name       = "SANCTOS_STATS"
class_name = "SanctosStatsDO"

[[migrations]]
tag         = "sanctos-stats-v1"
new_classes = ["SanctosStatsDO"]
```

---

## Secrets (never commit)

```bash
npx wrangler secret put UPSTREAM_QUICKNODE_1_URL
npx wrangler secret put UPSTREAM_HELIUS_1_URL
```

---

## Run & deploy

### Local development

```bash
npx wrangler dev
```

Open:

- http://127.0.0.1:8787/__sanctos_health
- http://127.0.0.1:8787/dash

### Deploy

```bash
npx wrangler deploy
```

Validate:

```bash
curl https://<your-worker-domain>/__sanctos_health
```

---

## CORS

- Allowed origins → `ALLOW_ORIGINS`
- Exposed headers → `EXPOSE_HEADERS`

Example allowed origins:

- https://messenger.sanctos.app
- http://localhost:8091
- http://localhost:3000

---

## Indexer proxy mode

When `INDEXER_ENABLED=true`:

- `/indexer/*` → forwarded to `INDEXER_URL`
- Strict proxy:
  - Preflight handled
  - Minimal headers forwarded
  - No cookies forwarded
  - Timeout enforced (`INDEXER_TIMEOUT_MS`)

Disable for demos/testing:

```toml
INDEXER_ENABLED = "false"
```

---

## Security posture

- Upstream URLs redacted in headers
- Secrets never committed
- Indexer proxy avoids forwarding auth/cookies
- No user data stored in the worker