/* ============================================================
 * 🌐 SanctOS Public SDK (Browser) — v0.2.0
 * - External, open-source facade
 * - IDL-free
 * - Delegate send (Option 1): fee + memo ONLY
 * ============================================================ */

(() => {
  const g = window;
  g.sanctos = g.sanctos || {};

  if (g.__SANCTOS_SDK_INSTALLED) return;
  g.__SANCTOS_SDK_INSTALLED = true;

  // facade only
  g.sanctos.api = g.sanctos.api || {};
  g.sanctos.api.version = "0.2.x";

})();

(() => {
  const g = typeof window !== "undefined" ? window : globalThis;
  g.sanctos = g.sanctos || {};

  // ------------------------------------------------------------
  // Small event emitter (no deps)
  // ------------------------------------------------------------
  function createEmitter() {
    const map = new Map();
    return {
      on(evt, fn) {
        if (!map.has(evt)) map.set(evt, new Set());
        map.get(evt).add(fn);
        return () => map.get(evt)?.delete(fn);
      },
      emit(evt, payload) {
        const set = map.get(evt);
        if (!set || !set.size) return;
        for (const fn of set) {
          try { fn(payload); }
          catch (e) { console.warn("[SanctOS API] listener error:", e); }
        }
      },
    };
  }

  const emitter = (g.__sanctosApiEmitter ||= createEmitter());

  // ------------------------------------------------------------
  // SDK-only stores (do not affect core)
  // ------------------------------------------------------------
  const __msgStore = (g.__sanctosApiMsgStore ||= new Map());      // peer58 -> msgs[]
  const __seenByPeer = (g.__sanctosApiMsgSeen ||= new Map());     // peer58 -> Set(sig)
  const __lastSyncByPeer = (g.__sanctosApiLastSync ||= new Map()); // peer58 -> last payload
  const __peersCache = (g.__sanctosPeersCache ||= new Map());     // me58 -> {ts, peers}

  function __normPeer(p) { return String(p || "").trim(); }

  function __msgSig(m) {
    return String(m?.sig || m?.signature || m?.txid || m?.id || "") || "";
  }

  function __storeUpsert(peer58, msgs, mode = "append") {
    const peer = __normPeer(peer58);
    if (!peer) return;

    const arr = __msgStore.get(peer) || [];
    const seen = __seenByPeer.get(peer) || new Set();
    if (!__seenByPeer.has(peer)) __seenByPeer.set(peer, seen);

    if (mode === "replace") {
      arr.length = 0;
      seen.clear();
    }

    for (const m of (msgs || [])) {
      if (!m) continue;
      const s = __msgSig(m);
      if (s) {
        if (seen.has(s)) continue;
        seen.add(s);
      }
      arr.push(m);
    }

    __msgStore.set(peer, arr);
  }

  function __debugStore() {
    try {
      const out = {};
      for (const [peer, arr] of __msgStore.entries()) {
        const seen = __seenByPeer.get(peer);
        const lastAt = arr?.at?.(-1)?.at;
        out[peer] = { count: arr?.length || 0, seen: seen?.size || 0, lastAt };
      }
      return out;
    } catch {
      return {};
    }
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------
  function pickFn(...candidates) {
    for (const fn of candidates) if (typeof fn === "function") return fn;
    return null;
  }

  function tryGetWallet58(provider) {
    try {
      const pk = provider?.wallet?.publicKey;
      return pk?.toBase58?.() || "";
    } catch { return ""; }
  }

  function hasLocalDeviceKey(me58) {
    try {
      const cluster =
        String(g.SANCTOS_CLUSTER_STORAGE || g.SANCTOS_CLUSTER || "mainnet").trim();
      const k = `sanctos:x25519:${cluster}:${me58}`;
      if (localStorage.getItem(k)) return true;
    } catch {}
  
    // If runtime exposes deviceStoreKey, use it too
    try {
      const f = g.deviceStoreKey;
      if (typeof f === "function") {
        const k2 = f(me58);
        if (k2 && localStorage.getItem(k2)) return true;
      }
    } catch {}
  
    return false;
  }
  
  function getDelegatePubkey58() {
    try {
      const kp = g.__sanctosDelegateKeypair;
      return kp?.publicKey?.toBase58?.() || "";
    } catch { return ""; }
  }

  // ------------------------------------------------------------
  // Ready gate
  // ------------------------------------------------------------
  async function ready(timeoutMs = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = g.sanctos;
      if (s && typeof s.getAnchorProvider === "function" && typeof s.fetchMessages === "function") {
        return true;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("[SanctOS API] ready() timeout: core hooks missing (need sanctos.getAnchorProvider + sanctos.fetchMessages)");
  }

  async function getProvider() {
    await ready();
    const s = g.sanctos;
    const fn = pickFn(s.getAnchorProvider);
    if (!fn) throw new Error("[SanctOS API] getAnchorProvider missing on sanctos");
    return await fn();
  }

  // ------------------------------------------------------------
  // Identity API
  // ------------------------------------------------------------
  async function getMe() {
    const provider = await getProvider();
    const wallet58 = tryGetWallet58(provider);
    const delegate58 = getDelegatePubkey58();
    const hasDeviceKey = wallet58 ? hasLocalDeviceKey(wallet58) : false;

    const delegateEnabled =
      !!g.__sanctosDelegateEnabled ||
      (!!delegate58 && g.__sanctosDelegateEnabled !== false);

    return { wallet58, hasDeviceKey, delegateEnabled, delegate58 };
  }

  async function ensureIdentity(opts = {}) {
    const provider = await getProvider();
    const wallet58 = tryGetWallet58(provider);
    if (!wallet58) throw new Error("[SanctOS API] ensureIdentity: wallet not ready");

    const s = g.sanctos;

    const fnEnsure = pickFn(
      s.ensureDeviceIdentityOnConnect,
      g.ensureDeviceIdentityOnConnect
    );

    if (fnEnsure) {
      try { await fnEnsure(provider); }
      catch (e) { emitter.emit("error", { kind: "ensureIdentity", error: e }); }
    }

    if (opts.interactive) {
      const fnGate = pickFn(
        s.openIdentityGate, s.showIdentityGate,
        g.openIdentityGate, g.showIdentityGate
      );
      if (fnGate) {
        try { await fnGate(); }
        catch (e) { emitter.emit("error", { kind: "identityGate", error: e }); }
      }
    }

    const me = await getMe();
    emitter.emit("identity", me);
    return me;
  }

  async function exportIdentity() {
    await ready();
    const s = g.sanctos;
    const fn = pickFn(s.exportIdentity, s.exportBundle, g.exportIdentity);
    if (!fn) throw new Error("[SanctOS API] exportIdentity: not available in this build");
    return await fn();
  }

  async function importIdentity(blob) {
    await ready();
    const s = g.sanctos;
    const fn = pickFn(s.importIdentity, s.importBundle, g.importIdentity);
    if (!fn) throw new Error("[SanctOS API] importIdentity: not available in this build");
    const res = await fn(blob);
    try { emitter.emit("identity", await getMe()); } catch {}
    return res;
  }

  // ------------------------------------------------------------
// Messaging (HARD ROUTE)
// ------------------------------------------------------------
async function send(peer58, text, opts = {}) {
  await ready();
  const s = g.sanctos;

  const p = String(peer58 || "").trim();
  const t = String(text ?? "");
  if (!p) throw new Error("[SanctOS API] send: peer58 missing");

  // ✅ Option 1: delegate send = fee + memo only
  if (opts?.delegate === true) {
    const fnDel = pickFn(s.postMessageDelegated, g.postMessageDelegated);
    if (!fnDel) throw new Error("[SanctOS API] send(delegate): sanctos.postMessageDelegated missing");
    return await fnDel(p, t);
  }

  // wallet send
  const fn = pickFn(s.postSanctosMsg, s.postMessage, g.postSanctosMsg);
  if (!fn) throw new Error("[SanctOS API] send: no wallet send function found (need sanctos.postSanctosMsg or sanctos.postMessage)");

  // HARD GUARD: prevent any downstream "delegate present => use delegate" logic
  const prevKp = g.__sanctosDelegateKeypair;
  const prevEnabled = g.__sanctosDelegateEnabled;

  try {
    g.__sanctosDelegateKeypair = null;
    g.__sanctosDelegateEnabled = false;
    return await fn(p, t, opts);
  } finally {
    g.__sanctosDelegateKeypair = prevKp;
    g.__sanctosDelegateEnabled = prevEnabled;
  }
}


  async function fetch(peer58, opts = {}) {
    await ready();
    const s = g.sanctos;

    const out = await s.fetchMessages(String(peer58 || "").trim(), {
      ...opts,
      onMessage: (m) => {
        try { __storeUpsert(peer58, [m], "append"); } catch {}
        try { if (typeof opts.onMessage === "function") opts.onMessage(m); } catch {}
        emitter.emit("message", { peer: peer58, msg: m });
      },
    });

    return out;
  }

  function getMessages(peer58) {
    const peer = __normPeer(peer58);
    const s = g.sanctos;

    // 1) core cache (if exists)
    const fn = pickFn(s.getCachedMessages);
    if (fn) {
      try {
        const one = fn(peer);
        if (Array.isArray(one) && one.length) return one;
      } catch {}
      try {
        const me58 = g.__sanctosLastMe58 || "";
        const two = fn(me58, peer);
        if (Array.isArray(two) && two.length) return two;
      } catch {}
    }

    // 2) SDK store
    try {
      const arr = __msgStore.get(peer);
      if (Array.isArray(arr) && arr.length) return arr;
    } catch {}

    // 3) vault fallback (optional)
    try {
      const me58 = (g.__sanctosLastMe58 || g.wallet?.address || "");
      if (!me58) return [];
      const idx =
        (typeof g.loadConvoIndex === "function" ? g.loadConvoIndex() : null) ||
        (() => {
          try {
            const raw = localStorage.getItem(`sanctos.convoIndex.${me58}`);
            return raw ? JSON.parse(raw) : [];
          } catch { return []; }
        })();

      const row = (idx || []).find((r) => r && (r.peer === peer || r.peerAddr === peer || r.peerAddress === peer));
      const id = String(row?.id || "");
      if (!id) return [];

      const vaultKey = `sanctos.vault.${me58}.convo.${id}`;
      const raw = localStorage.getItem(vaultKey);
      if (!raw) return [];
      const convo = JSON.parse(raw);
      const msgs = convo?.messages;
      return Array.isArray(msgs) ? msgs : [];
    } catch {
      return [];
    }
  }

  function getKnownSigs(peer58) {
    const s = g.sanctos;
    const fn = pickFn(s.getKnownSigs);
    if (!fn) return new Set();
    try {
      const one = fn(peer58);
      if (one instanceof Set) return one;
    } catch {}
    try {
      const me58 = g.__sanctosLastMe58 || "";
      const two = fn(me58, peer58);
      if (two instanceof Set) return two;
    } catch {}
    return new Set();
  }

  async function sync(peer58, opts = {}) {
    await ready();
    const s = g.sanctos;
    const provider = await getProvider();
    const me58 = tryGetWallet58(provider);
    if (me58) g.__sanctosLastMe58 = me58;

    const fnSyncPair = pickFn(s.syncPair);
    if (fnSyncPair) {
      const res = await fnSyncPair(peer58, opts);
      try {
        if (Array.isArray(res?.messages) && res.messages.length) {
          __storeUpsert(peer58, res.messages, "append");
        }
        __lastSyncByPeer.set(__normPeer(peer58), res);
      } catch {}
      emitter.emit("messages", { peer: peer58, ...res });
      return res;
    }

    // fallback: fetch then snapshot
    await fetch(peer58, { limit: opts.limit });
    const messages = getMessages(peer58);
    const payload = {
      peer: peer58,
      added: 0,
      updated: 0,
      lastAt: messages?.at?.(-1)?.at || 0,
      messages,
    };
    __lastSyncByPeer.set(__normPeer(peer58), payload);
    emitter.emit("messages", payload);
    return payload;
  }

  // ------------------------------------------------------------
  // Peer discovery
  // ------------------------------------------------------------
  async function discoverPeers(opts = {}) {
    await ready();
    const provider = await getProvider();
    const me58 = tryGetWallet58(provider);
    if (!me58) throw new Error("[SanctOS API] discoverPeers: wallet not ready");

    const cacheMs = Math.max(0, opts.cacheMs ?? 20_000);
    const cached = __peersCache.get(me58);
    const now = Date.now();
    if (cached && now - cached.ts < cacheMs) return cached.peers;

    const s = g.sanctos;
    const fn = pickFn(s.discoverPeers, g.discoverPeers);
    if (!fn) throw new Error("[SanctOS API] discoverPeers: sanctos.discoverPeers not available");

    let peers = [];
    try {
      // some runtimes use (provider, mePk, limit)
      peers = await fn(provider, provider.wallet.publicKey, opts.limit ?? 80);
    } catch {
      // others use (limit) or ()
      peers = await fn(opts.limit ?? 80);
    }

    const uniq = Array.from(new Set((peers || []).filter(Boolean)));
    __peersCache.set(me58, { ts: now, peers: uniq });
    emitter.emit("peers", { me: me58, peers: uniq });
    return uniq;
  }

  async function listPeers(opts = {}) {
    const provider = await getProvider();
    const me58 = tryGetWallet58(provider);
    const cached = __peersCache.get(me58);
    if (cached?.peers?.length) return cached.peers;
    return await discoverPeers(opts);
  }

  // ------------------------------------------------------------
  // Delegate surface (status + passthrough enable/disable if present)
  // ------------------------------------------------------------
  const delegate = {
    async getStatus() {
      const me = await getMe();
      const expiresAt = (g.__sanctosDelegateExpiresAt && Number(g.__sanctosDelegateExpiresAt)) || null;
      const hasKeypair = !!getDelegatePubkey58();
      return { enabled: me.delegateEnabled, delegate58: me.delegate58, hasKeypair, expiresAt };
    },
    async enable(opts = {}) {
      await ready();
      const s = g.sanctos;
      const fn = pickFn(s.enableDelegate, s.setDelegateEnabled, g.enableDelegate);
      if (!fn) throw new Error("[SanctOS API] delegate.enable: not implemented in this build");
      const res = await fn(opts);
      try { g.__sanctosDelegateEnabled = true; } catch {}
      emitter.emit("delegate", await delegate.getStatus());
      return res;
    },
    async disable() {
      await ready();
      const s = g.sanctos;
      const fn = pickFn(s.disableDelegate, s.setDelegateDisabled, g.disableDelegate);
      if (!fn) {
        try { g.__sanctosDelegateEnabled = false; } catch {}
        emitter.emit("delegate", await delegate.getStatus());
        return { ok: true, soft: true };
      }
      const res = await fn();
      try { g.__sanctosDelegateEnabled = false; } catch {}
      emitter.emit("delegate", await delegate.getStatus());
      return res;
    },
  };

  // ------------------------------------------------------------
  // Polling helper
  // ------------------------------------------------------------
  const pollers = (g.__sanctosApiPollers ||= new Map());

  async function startPolling(peer58, intervalMs = 250, opts = {}) {
    await ready();
    stopPolling(peer58);

    let killed = false;
    const key = String(peer58 || "");
    if (!key) throw new Error("[SanctOS API] startPolling: missing peer58");

    const run = async () => {
      while (!killed) {
        try { await fetch(peer58, opts); }
        catch (e) { emitter.emit("error", { kind: "poll", peer: peer58, error: e }); }
        await new Promise((r) => setTimeout(r, Math.max(50, intervalMs | 0)));
      }
    };

    const handle = { stop: () => (killed = true) };
    pollers.set(key, handle);
    run();
    return handle;
  }

  function stopPolling(peer58) {
    const key = String(peer58 || "");
    const h = pollers.get(key);
    if (h?.stop) h.stop();
    pollers.delete(key);
  }

  // ------------------------------------------------------------
  // Diagnostics
  // ------------------------------------------------------------
  async function health() {
    const provider = await getProvider();
    const me58 = tryGetWallet58(provider);
    const delegate58 = getDelegatePubkey58();

    const lastFetch = Number(g.__sanctosLastFetchMs || 0) || 0;
    const lastErr = g.__sanctosLastErr || null;

    return {
      me58,
      delegate58,
      rpc: provider?.connection?._rpcEndpoint || provider?.connection?.rpcEndpoint || null,
      lastFetchMs: lastFetch,
      lastError: lastErr,
    };
  }

  // ------------------------------------------------------------
  // Attach API
  // ------------------------------------------------------------
  g.sanctos.api = g.sanctos.api || {};
  Object.assign(g.sanctos.api, {
    version: "0.2.1",
    ready,

    // identity
    getMe,
    ensureIdentity,
    exportIdentity,
    importIdentity,

    // peers
    discoverPeers,
    listPeers,

    // messages
    fetch,
    sync,
    getMessages,
    getKnownSigs,
    send,

    // delegate
    delegate,

    // events
    on: emitter.on,

    // polling
    startPolling,
    stopPolling,

    // diagnostics
    health,

    // sdk-only store inspection
    __debugStore,
    getLastSync(peer58) {
      try { return __lastSyncByPeer.get(__normPeer(peer58)) || null; }
      catch { return null; }
    },

    // raw escape hatch
    raw: g.sanctos,
  });

  console.log("[SanctOS API] ✅ sanctos.api attached:", g.sanctos.api.version);
})();
