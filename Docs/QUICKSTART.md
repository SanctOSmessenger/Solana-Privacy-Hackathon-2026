# QUICKSTART — SanctOS SDK (Browser)

Everything here is meant to be copied directly into DevTools.

> SDK attaches to: `window.sanctos.api` (version **0.2.1**)

---

## 0) Verify it loaded

Open DevTools console:

```js
window.sanctos && window.sanctos.api
```

Expected shape:

```js
{ version: "0.2.1", ready: f, getMe: f, send: f, ... }
```

---

## 1) Ready gate (required)

```js
await sanctos.api.ready()
```

If this throws a timeout, your runtime is missing required hooks:
- `sanctos.getAnchorProvider`
- `sanctos.fetchMessages`

---

## 2) Identity + delegate status

```js
await sanctos.api.getMe()
```

Returns:

```js
{
  wallet58: string,
  hasDeviceKey: boolean,
  delegateEnabled: boolean,
  delegate58: string
}
```

If device identity is missing, trigger identity flow:

```js
await sanctos.api.ensureIdentity({ interactive: true })
```

---

## 3) Pick a peer

If your wallet has peers already:

```js
const peers = await sanctos.api.listPeers()
peers
```

If you have a helper in the runtime, easiest is:

```js
const peer = await __sanctosPickPeer()
peer
```

---

## 4) Send (wallet + delegate)

```js
await sanctos.api.send(peer, "WALLET path ✅")
await sanctos.api.send(peer, "DELEGATE path ✅", { delegate: true })
```

---

## 5) Read + sync messages

```js
await sanctos.api.fetch(peer, { limit: 10 })
await sanctos.api.sync(peer, { limit: 25 })
sanctos.api.getMessages(peer).slice(-6)
```

---

## 6) Subscribe to events

The SDK emits:
- `"message"` — `{ peer, msg }` for new messages seen by `fetch()`/polling
- `"messages"` — `{ peer, ...syncPayload }` from `sync()`
- `"peers"` — `{ me, peers }` from peer discovery
- `"identity"` — emitted after `ensureIdentity()`
- `"delegate"` — emitted after `delegate.enable()` / `delegate.disable()`
- `"error"` — `{ kind, peer?, error }`

Example:

```js
const offMsg = sanctos.api.on("message", ({ peer, msg }) => {
  if (msg?.ok) console.log("NEW", peer, msg.text)
})

const offErr = sanctos.api.on("error", (e) => console.warn("SDK error:", e))
```

Unsubscribe:

```js
offMsg(); offErr();
```

---

## 7) Polling (near-real-time)

```js
sanctos.api.startPolling(peer, 150, { limit: 25 })
```

Stop:

```js
sanctos.api.stopPolling(peer)
```

---

## 8) Diagnostics

```js
await sanctos.api.health()
```

---

## 9) Debugging the SDK store

```js
sanctos.api.__debugStore()
sanctos.api.getLastSync(peer)
```
