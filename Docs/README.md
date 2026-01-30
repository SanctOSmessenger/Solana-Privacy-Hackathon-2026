# SanctOS SDK (Browser)

This repo exposes a **browser SDK facade** on top of the SanctOS Messenger runtime (**chat.js + sanctos.bundle.js**).

It’s designed for hackathon-speed integrations: other web apps can **discover peers**, **sync & decrypt messages**, and **send messages** on Solana using a self-sovereign, key-based identity model.

**SDK entrypoint:** `window.sanctos.api`  
**Current SDK version:** `0.2.0`

---

## Run locally

### Requirements
- Phantom Wallet (browser extension)
- Any static HTTP server (no backend required)

### Start
```bash
python3 -m http.server 8091
```

Open:
- http://localhost:8091

Then open **DevTools → Console** and run:

```js
await sanctos.api.ready()
await sanctos.api.getMe()
await sanctos.api.health()

const peer = await __sanctosPickPeer()
peer

await sanctos.api.send(peer, "WALLET path ✅")
await sanctos.api.send(peer, "DELEGATE path ✅", { delegate: true })

await sanctos.api.fetch(peer, { limit: 10 })
await sanctos.api.sync(peer, { limit: 25 })
sanctos.api.getMessages(peer).slice(-6)
```

> If this works, the SDK + runtime are correctly wired.

---

## What you get (today)

Integrators can:

- ✅ Wait for SanctOS to boot: `sanctos.api.ready()`
- ✅ Inspect identity + delegate state: `sanctos.api.getMe()`
- ✅ Trigger identity UI (import/create device key): `sanctos.api.ensureIdentity({ interactive: true })`
- ✅ Discover peers from on-chain memo history: `sanctos.api.listPeers()`
- ✅ Fetch + decrypt messages with an SDK-managed per-peer store:
  - `sanctos.api.sync(peer)`
  - `sanctos.api.getMessages(peer)`
  - `sanctos.api.fetch(peer, { onMessage })`
- ✅ Send messages:
  - Wallet-signed: `sanctos.api.send(peer, text)`
  - Delegate autosign: `sanctos.api.send(peer, text, { delegate: true })`
- ✅ Subscribe to events:
  - `sanctos.api.on("message" | "error" | "peers" | "identity" | "messages" | "delegate", fn)`
- ✅ Poll automatically:
  - `sanctos.api.startPolling(peer, intervalMs)`
  - `sanctos.api.stopPolling(peer)`
- ✅ Diagnostics: `sanctos.api.health()`

---

## Compatibility / required runtime hooks

The SDK requires the SanctOS runtime to expose:

- `window.sanctos.getAnchorProvider()`
- `window.sanctos.fetchMessages(peer58, opts)`

If these are present, `sanctos.api.ready()` will succeed.

Everything else is optional and feature-gated.

---

## Sending requirements

Wallet-signed send uses one of:
- `sanctos.postSanctosMsg()`
- `sanctos.postMessage()`
- `window.postSanctosMsg()`

Delegate send additionally requires:
- `sanctos.postMessageDelegated(peer58, text)` (or a global equivalent)

---

## Load order (script tags)

Runtime first, SDK last.

```html
<script>
  // Feature flags / globals set BEFORE any app code loads
  window.sanctosAutoHandshake = true;

  // Lock RPC + network
  window.__SANCTOS_RPC = "https://sanctos-rpc-node.sanctos.workers.dev";
  window.__SANCTOS_NET = "mainnet";

  // Program id
  window.SANCTOS_PROGRAM_ID_STR =
    "EBEQdAwgXmyLrj5npwmX63cEZwzrSKgEHy297Nfxrjhw";
</script>

<!-- deps -->
<script src="https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js"></script>
<script src="anchor-build/anchor.browser.js"></script>
<script src="https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.11/dist/browsers/sodium.js"></script>

<!-- SanctOS runtime (may be obfuscated) -->
<script src="sanctos.wallet.js"></script>
<script src="chat.js"></script>
<script src="sanctos.bundle.js"></script>
<script src="widget.js"></script>
<script src="wallet.js"></script>
<script src="patches.js"></script>

<!-- SDK LAST -->
<script src="sanctos-sdk.js"></script>
```

---

## Delegate notes

The SDK exposes a thin delegate helper:

- `sanctos.api.delegate.getStatus()`
- `sanctos.api.delegate.enable()`
- `sanctos.api.delegate.disable()`

These **do not implement delegation** — they proxy runtime hooks if present.

Delegated sending is performed by the runtime hook:

- `sanctos.postMessageDelegated(peer58, text)`

Any one-time on-chain authorization (e.g. DelegateAuth PDA creation, expiry, revocation)
is handled by the SanctOS program + runtime, not the SDK.

---

## Docs
- 📄 Quickstart: `Docs/QUICKSTART.md`
- 📄 API Reference: `Docs/API.md`