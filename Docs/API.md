# API — SanctOS SDK (Browser)

All calls are under:

- `window.sanctos.api`

This SDK is **IDL-free** and expects an existing SanctOS runtime to already be loaded.

---

## Required runtime hooks

`sanctos.api.ready()` succeeds only if these exist:

- `window.sanctos.getAnchorProvider()`
- `window.sanctos.fetchMessages(peer58, opts)`

Everything else is optional (SDK will fall back or throw a clear error).

---

## Types

### `SanctosMsg`

```ts
type SanctosMsg = {
  sig: string;
  from: string;
  at: number;     // ms timestamp
  ok: boolean;
  text?: string;
  raw?: string;
};
```

### Events

```ts
type MessageEvent = { peer: string; msg: SanctosMsg };

type ErrorEvent = {
  kind: "ensureIdentity" | "identityGate" | "poll";
  peer?: string;
  error: unknown;
};

type PeersEvent = { me: string; peers: string[] };

type IdentityEvent = {
  wallet58: string;
  hasDeviceKey: boolean;
  delegateEnabled: boolean;
  delegate58: string;
};

type DelegateStatus = {
  enabled: boolean;
  delegate58: string;
  hasKeypair: boolean;
  expiresAt: number | null;
};
```

---

## Core

### `version: string`

Current SDK version string (e.g. `"0.2.1"`).

### `ready(timeoutMs = 12000): Promise<boolean>`

Waits until required runtime hooks exist.

Throws on timeout with a message indicating missing hooks.

### `getMe(): Promise<{ wallet58, hasDeviceKey, delegateEnabled, delegate58 }>`

Returns wallet + device identity presence + delegate status.

Notes:
- `hasDeviceKey` is detected from localStorage (via `deviceStoreKey(me58)` if present, else a heuristic).
- `delegate58` reads from `window.__sanctosDelegateKeypair?.publicKey`.

### `ensureIdentity(opts?: { interactive?: boolean }): Promise<IdentityEvent>`

Best-effort identity ensure:
- calls `sanctos.ensureDeviceIdentityOnConnect(provider)` if present
- if `interactive:true`, attempts to open identity UI via:
  - `sanctos.openIdentityGate()` / `sanctos.showIdentityGate()` (or global equivalents)

Emits:
- `"identity"` with latest identity state
- `"error"` if identity hooks throw

### `exportIdentity(): Promise<any>`

Passthrough to runtime if available:
- `sanctos.exportIdentity()` / `sanctos.exportBundle()` (or `window.exportIdentity()`)

Throws if not present in the current runtime build.

### `importIdentity(blob: any): Promise<any>`

Passthrough to runtime if available:
- `sanctos.importIdentity()` / `sanctos.importBundle()` (or `window.importIdentity()`)

Emits `"identity"` after import (best-effort).

---

## Peers

### `discoverPeers(opts?: { limit?: number; cacheMs?: number }): Promise<string[]>`

Discovers peers via runtime:
- tries `sanctos.discoverPeers(...)` (or `window.discoverPeers(...)`)

Caches per-wallet for `cacheMs` (default 20s).

Emits `"peers"`: `{ me, peers }`

### `listPeers(opts?: { limit?: number; cacheMs?: number }): Promise<string[]>`

Returns cached peers if available, otherwise calls `discoverPeers()`.

---

## Messages

### `fetch(peer58: string, opts?: { limit?: number; onMessage?: (m: SanctosMsg) => void; [k: string]: any }): Promise<any>`

Calls runtime `sanctos.fetchMessages(peer58, opts)` and injects an `onMessage` handler that:
- upserts messages into the SDK store
- emits `"message"` events: `{ peer, msg }`
- forwards to `opts.onMessage` if provided

### `sync(peer58: string, opts?: { limit?: number; [k: string]: any }): Promise<any>`

Preferred “sync + store update” operation.

If runtime has `sanctos.syncPair(peer58, opts)`:
- SDK calls it and upserts `res.messages` into SDK store
- emits `"messages"`: `{ peer, ...res }`

Else fallback:
- SDK calls `fetch(peer58, { limit })`
- returns a snapshot `{ peer, added, updated, lastAt, messages }` (added/updated may be 0)

### `getMessages(peer58: string): SanctosMsg[]`

Returns messages using this priority:
1) runtime cache if `sanctos.getCachedMessages()` exists
2) SDK store
3) optional “vault fallback” from localStorage (if your runtime uses `sanctos.vault.*`)

### `getKnownSigs(peer58: string): Set<string>`

If runtime exposes `sanctos.getKnownSigs()`, returns it.
Otherwise returns an empty Set.

### `send(peer58: string, text: string, opts?: { delegate?: boolean; [k: string]: any }): Promise<string>`

- Default: wallet-signed send via one of:
  - `sanctos.postSanctosMsg()`
  - `sanctos.postMessage()`
  - `window.postSanctosMsg()`

- Delegate send (`opts.delegate === true`):
  - calls `sanctos.postMessageDelegated(peer58, text)` (or global)

Throws if the required function isn’t present.

---

## Polling

### `startPolling(peer58: string, intervalMs = 250, opts?: object): Promise<{ stop: () => void }>`

Starts a loop:
- calls `fetch(peer58, opts)`
- waits `intervalMs` (min 50ms)
- repeats until stopped

Emits `"error"` with `{ kind:"poll", peer, error }` on failures.

### `stopPolling(peer58: string): void`

Stops the poller for that peer.

---

## Events

### `on(evt, handler): () => void`

Supported events:
- `"message"` — `{ peer, msg }`
- `"messages"` — `{ peer, ...syncPayload }`
- `"peers"` — `{ me, peers }`
- `"identity"` — identity payload
- `"delegate"` — delegate status payload
- `"error"` — `{ kind, peer?, error }`

Returns an unsubscribe function.

---

## Delegate helper

### `delegate.getStatus(): Promise<DelegateStatus>`

Returns:
- enabled flag (based on `window.__sanctosDelegateEnabled` and/or presence of keypair)
- `delegate58`
- `hasKeypair`
- `expiresAt` (from `window.__sanctosDelegateExpiresAt` if set)

### `delegate.enable(opts?: any): Promise<any>`

Calls a runtime hook if present:
- `sanctos.enableDelegate()` / `sanctos.setDelegateEnabled()` (or global)

Sets `window.__sanctosDelegateEnabled = true` and emits `"delegate"`.

Throws if no enable hook exists.

### `delegate.disable(): Promise<any>`

Calls a runtime hook if present:
- `sanctos.disableDelegate()` / `sanctos.setDelegateDisabled()` (or global)

If missing, “soft-disables” by setting `window.__sanctosDelegateEnabled = false`.

Emits `"delegate"`.

---

## Diagnostics / utilities

### `health(): Promise<{ me58, delegate58, rpc, lastFetchMs, lastError }>`

Basic health snapshot.

### `__debugStore(): Record<string, { count, seen, lastAt }>`
SDK-only store inspection.

### `getLastSync(peer58: string): any | null`
Returns last sync payload stored by `sync()` for that peer.

### `raw: any`
Escape hatch to the underlying `window.sanctos` runtime.
