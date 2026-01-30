// patches.js
window.__sanctosMemoInflight = window.__sanctosMemoInflight || new Set();

// ✅ Ensure sanctos base exists early (prevents "Cannot set properties of undefined" in sanctos.ts)
window.sanctos = window.sanctos || {};


// ============================================================
// 💸 Boot-time defaults (must exist BEFORE sanctos.bundle.js runs)
// ============================================================
window.SANCTOS_DELEGATE_TREASURY =
  window.SANCTOS_DELEGATE_TREASURY ||
  "FhUFtN9MngoRj7YW1eYw57TxsYsTJ5xyMwMmdifxmwBi";

// 0.0001 SOL = 100,000 lamports
if (!Number.isFinite(window.SANCTOS_ACCOUNT_CREATION_FEE_LAMPORTS)) {
  window.SANCTOS_ACCOUNT_CREATION_FEE_LAMPORTS = 100000;
}

// ============================================================
// 🌐 Mainnet RPC defaults + 429/503 failover (SanctOS worker primary)
// + Canonical indexer routing (force indexer.sanctos.app; strip /indexer/* prefix)
//
// Fixes in this version:
// - DO NOT accidentally rewrite the WORKER’s own /health, /dash, etc. to the indexer
// - Preserve upstream URL paths (QuickNode/Helius style URLs with a path token)
// - Treat POSTs to the worker as JSON-RPC even if Request body is a stream (content-type missing)
// - Only rewrite "indexer-ish" routes when they are:
//   (a) already targeting indexer.sanctos.app, OR
//   (b) /indexer/* on any host, OR
//   (c) same-origin relative calls to known indexer endpoints
// ============================================================
(() => {
  // Primary (your worker)
  window.__SANCTOS_RPC_URL =
    window.__SANCTOS_RPC_URL || "https://sanctos-rpc-node.sanctos.workers.dev";

  // (Optional) some builds use RPC_URL directly — pin it to worker.
  // ✅ FIX: prevents stray codepaths from defaulting to public mainnet
  window.RPC_URL = window.RPC_URL || window.__SANCTOS_RPC_URL;

  // Fallbacks (public mainnet). Replace/add Helius/QuickNode later.
  window.__SANCTOS_RPC_FALLBACKS =
    window.__SANCTOS_RPC_FALLBACKS || [
      "https://api.mainnet-beta.solana.com",
      "https://solana-api.projectserum.com",
    ];

  const PRIMARY_HOST = "sanctos-rpc-node.sanctos.workers.dev";
  const CANON_INDEXER = "https://indexer.sanctos.app";

  // ----------------------------
  // Idempotency + base fetch
  // ----------------------------
  if (window.__SANCTOS_PATCHES_RPC_INSTALLED__) return;
  window.__SANCTOS_PATCHES_RPC_INSTALLED__ = true;

  const ogFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!ogFetch) return;

  // ✅ FIX: browser-hostile public RPCs (commonly 403/CORS). Never use as failover.
  const BLOCKED_BROWSER_FALLBACKS = new Set([
    "https://api.mainnet-beta.solana.com",
    "https://solana-api.projectserum.com",
  ]);

  let endpoints = [
    window.__SANCTOS_RPC_URL,
    ...(window.__SANCTOS_RPC_FALLBACKS || []),
  ]
    .filter(Boolean)
    .map((u) => String(u).trim())
    .filter(Boolean);

  // ✅ FIX: strip blocked fallbacks (but keep your worker primary)
  endpoints = endpoints.filter((u, idx) => idx === 0 || !BLOCKED_BROWSER_FALLBACKS.has(u));

  // Helpful log if we stripped anything
  try {
    const rawFallbacks = (window.__SANCTOS_RPC_FALLBACKS || []).map((u) => String(u).trim());
    const stripped = rawFallbacks.filter((u) => BLOCKED_BROWSER_FALLBACKS.has(u));
    if (stripped.length) {
      console.warn("[SanctOS] ⚠️ Stripped browser-hostile RPC fallbacks (403/CORS):", stripped);
    }
  } catch {}

  // circuit breaker for the primary worker
  let primaryCooldownUntil = 0;

  // ============================================================
  // 🧭 Canonical Indexer default (stabilize across reloads)
  // - Prefers explicit runtime overrides
  // - If localStorage has a stale trycloudflare URL, revert to canonical
  // - If base is indexer.sanctos.app, force DIRECT mode (no /indexer/health probe)
  // ============================================================
  (() => {
    try {
      const canon = CANON_INDEXER.replace(/\/+$/, "");

      // Hard overrides (explicit dev intent)
      const hardOverride =
        (window.__SANCTOS_INDEXER_BASE__ && String(window.__SANCTOS_INDEXER_BASE__).trim()) ||
        (window.SANCTOS_INDEXER_URL && String(window.SANCTOS_INDEXER_URL).trim()) ||
        "";

      let finalBase = "";

      if (hardOverride) {
        finalBase = hardOverride.replace(/\/+$/, "");
      } else {
        const persisted = (localStorage.getItem("sanctos.indexerUrl") || "")
          .trim()
          .replace(/\/+$/, "");

        const isEphemeralTunnel =
          persisted.includes("trycloudflare.com") ||
          persisted.includes("ngrok") ||
          persisted.includes("localhost") ||
          persisted.includes("127.0.0.1");

        finalBase = (!persisted || isEphemeralTunnel) ? canon : persisted;

        // If it was ephemeral, force re-probe
        if (isEphemeralTunnel) window.__sanctosIndexerMode = null;
      }

      // Persist + expose
      try { localStorage.setItem("sanctos.indexerUrl", finalBase); } catch {}
      window.SANCTOS_INDEXER_URL = finalBase;

      // ✅ If canonical indexer host, pre-seed DIRECT mode so chat.js won't probe /indexer/health
      try {
        const u = new URL(finalBase);
        if (u.host === "indexer.sanctos.app") {
          window.__sanctosIndexerMode = "direct";
          window.__SANCTOS_INDEXER_FORCE_DIRECT__ = true; // optional hint
        }
      } catch {}

      console.log("[SanctOS] ✅ Indexer base:", finalBase, "mode:", window.__sanctosIndexerMode || "(probe)");
    } catch {}
  })();
// ============================================================
// 💸 SanctOS Fee Enforcer (wallet boundary)
// - Adds fee ix to any tx that contains SANCTOS_MSG memo
// - Works even if chat.js uses Phantom signAndSendTx pipeline
// ============================================================
(() => {
  const g = window;
  if (g.__SANCTOS_FEE_ENFORCER_INSTALLED) return;
  g.__SANCTOS_FEE_ENFORCER_INSTALLED = true;

  const MEMO_PID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

  function getSol() {
    return g.sanctos?.__web3 || g.solanaWeb3 || g.web3 || (g.anchor && g.anchor.web3);
  }

  function hasSanctosMemo(tx) {
    try {
      const sol = getSol();
      const keys = tx?.instructions || tx?._instructions || [];
      if (!keys?.length) return false;

      // quick check: memo program present + data contains "SANCTOS_MSG:"
      for (const ix of keys) {
        const pid = ix?.programId?.toBase58?.() || String(ix?.programId || "");
        if (pid !== MEMO_PID) continue;

        const data = ix?.data;
        if (!data) continue;

        // data may be Uint8Array or Buffer
        if (data instanceof Uint8Array) {
          const s = new TextDecoder().decode(data);
          if (s.includes("SANCTOS_MSG:")) return true;
        } else if (typeof data === "string") {
          // some environments store memo as string
          if (data.includes("SANCTOS_MSG:")) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  function addFeeIfNeeded(tx, fromPk) {
    try {
      if (!hasSanctosMemo(tx)) return;

      const sol = getSol();
      if (!sol) return;

      if (typeof g.__sanctosMaybeAddMsgFeeIx !== "function") {
        console.warn("[SanctOS💸] fee helper missing");
        return;
      }

      // Avoid double-add if wallet signs same tx twice
      if (tx.__sanctosFeeEnforced) return;
      tx.__sanctosFeeEnforced = true;

      g.__sanctosMaybeAddMsgFeeIx(sol, tx, fromPk);

      // optional log
      // console.log("[SanctOS💸] fee enforced; ix count now", tx.instructions?.length);
    } catch (e) {
      console.warn("[SanctOS💸] fee enforcer skipped:", e);
    }
  }

  // Wrap common wallet entrypoints used by various adapters
  function wrap(obj, fnName, getFromPk) {
    if (!obj || typeof obj[fnName] !== "function") return;
    const key = `__SANCTOS_WRAP_${fnName}`;
    if (obj[key]) return;
    obj[key] = true;

    const orig = obj[fnName].bind(obj);
    obj[fnName] = async (...args) => {
      const tx = args[0];
      try {
        const fromPk = getFromPk?.() || tx?.feePayer || null;
        if (tx && typeof tx === "object") addFeeIfNeeded(tx, fromPk);
      } catch {}
      return await orig(...args);
    };
  }

  // Phantom provider (window.solana)
  wrap(g.solana, "signTransaction", () => g.solana?.publicKey);
  wrap(g.solana, "signAllTransactions", () => g.solana?.publicKey);
  wrap(g.solana, "signAndSendTransaction", () => g.solana?.publicKey);

  // Your normalized wallet object (chat.js style)
  wrap(g.wallet, "signTransaction", () => g.wallet?.publicKey);
  wrap(g.wallet, "signAllTransactions", () => g.wallet?.publicKey);
  wrap(g.wallet, "signAndSendTransaction", () => g.wallet?.publicKey);

  console.log("[SanctOS💸] ✅ Fee enforcer installed (wallet boundary)");
})();

  // ============================================================
  // 🔒 Force Solana web3.js Connection to use SanctOS Worker RPC
  // - Ensures your app traffic shows up in /dash (RPC POST, cache, methods)
  // ============================================================
  (() => {
    if (window.__SANCTOS_FORCE_CONN_INSTALLED__) return;
    window.__SANCTOS_FORCE_CONN_INSTALLED__ = true;

    const WORKER_RPC = () =>
      window.__SANCTOS_RPC_URL || "https://sanctos-rpc-node.sanctos.workers.dev";

    function shouldRewrite(endpoint) {
      try {
        const s = String(endpoint || "");
        if (!s) return false;
        // already using our worker
        if (s.includes("sanctos-rpc-node.sanctos.workers.dev")) return false;

        // rewrite common public endpoints + any quicknode/helius direct usage
        return (
          s.includes("api.mainnet-beta.solana.com") ||
          s.includes("solana-api.projectserum.com") ||
          s.includes("quicknode") ||
          s.includes("helius") ||
          s.includes("rpc.")
        );
      } catch {
        return false;
      }
    }

    async function install() {
      for (let i = 0; i < 80; i++) {
        if (window.solanaWeb3 && window.solanaWeb3.Connection) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const sol = window.solanaWeb3;
      if (!sol?.Connection) return;

      const OriginalConnection = sol.Connection;

      sol.Connection = function PatchedConnection(endpoint, ...rest) {
        const ep = shouldRewrite(endpoint) ? WORKER_RPC() : endpoint;
        return new OriginalConnection(ep, ...rest);
      };

      // preserve static props/methods
      Object.setPrototypeOf(sol.Connection, OriginalConnection);
      sol.Connection.prototype = OriginalConnection.prototype;

      console.log("[SanctOS] ✅ Forced web3.Connection endpoint →", WORKER_RPC());
    }

    install();
  })();

  function rawUrlOf(input) {
    return typeof input === "string" ? input : (input && input.url) || "";
  }

  function safeUrl(urlLike) {
    try {
      return new URL(String(urlLike || ""), location.origin);
    } catch {
      // Last resort: try same-origin
      try {
        return new URL(location.origin + String(urlLike || ""));
      } catch {
        return null;
      }
    }
  }

  function isPrimaryUrl(input) {
    try {
      const u = safeUrl(rawUrlOf(input));
      return !!u && u.host === PRIMARY_HOST;
    } catch {
      return false;
    }
  }

  // Preserve provider path tokens (e.g., QuickNode URLs like /<token>/)
  // - If endpointBase has a non-root pathname, use it (and ignore original pathname)
  // - Preserve endpointBase search (if any). If base has no search, keep original search.
  function rewriteRpcUrl(originalUrl, endpointBase) {
    const orig = safeUrl(originalUrl);
    const base = safeUrl(endpointBase);
    if (!orig || !base) return endpointBase;

    const basePath = base.pathname && base.pathname !== "/" ? base.pathname : orig.pathname;
    const baseSearch = base.search && base.search !== "?" ? base.search : orig.search;

    return base.origin + basePath + (baseSearch || "");
  }

  function isIndexerRequest(urlLike) {
    const u = safeUrl(rawUrlOf(urlLike));
    if (!u) return false;

    const host = u.host || "";
    const p = u.pathname || "/";

    if (isUsingDevTunnel()) {
      if (p === "/indexer" || p.startsWith("/indexer/")) return true;
      const isSameOrigin = host === location.host;
      if (
        isSameOrigin &&
        (p === "/health" ||
          p === "/whoami" ||
          p === "/watch" ||
          p === "/threads" ||
          p === "/tunnel" ||
          p.startsWith("/thread/"))
      ) {
        return true;
      }
      return false;
    }

    if (host === "indexer.sanctos.app") return true;
    if (p === "/indexer" || p.startsWith("/indexer/")) return true;

    const isSameOrigin = host === location.host;
    if (!isSameOrigin) return false;

    if (
      p === "/health" ||
      p === "/whoami" ||
      p === "/watch" ||
      p === "/threads" ||
      p === "/tunnel" ||
      p.startsWith("/thread/")
    ) {
      return true;
    }

    return false;
  }

  function rewriteIndexerToCanon(urlLike) {
    const u = safeUrl(rawUrlOf(urlLike));
    const base = currentIndexerBase(); // ✅ tunnel-aware
    if (!u) return base;

    let p = u.pathname || "/";

    if (p === "/indexer") p = "/";
    else if (p.startsWith("/indexer/")) p = p.slice("/indexer".length);

    return base + p + (u.search || "");
  }

  function currentIndexerBase() {
    try {
      return (
        (window.__SANCTOS_INDEXER_BASE__ && String(window.__SANCTOS_INDEXER_BASE__).trim()) ||
        (window.SANCTOS_INDEXER_URL && String(window.SANCTOS_INDEXER_URL).trim()) ||
        (localStorage.getItem("sanctos.indexerUrl") || "").trim() ||
        CANON_INDEXER
      ).replace(/\/+$/, "");
    } catch {
      return CANON_INDEXER;
    }
  }

  function isUsingDevTunnel() {
    const b = currentIndexerBase();
    return b.includes("trycloudflare.com");
  }

  async function fetchAttempt(input, init, attemptUrl) {
    if (input instanceof Request) {
      const req = input.clone();
      return ogFetch(new Request(attemptUrl, req));
    }
    return ogFetch(attemptUrl, init);
  }

  function isJsonRpcCall(input, init) {
    try {
      const method =
        (init && init.method) ||
        (input instanceof Request ? input.method : "GET") ||
        "GET";
      if (String(method).toUpperCase() !== "POST") return false;

      const urlStr = rawUrlOf(input);
      const u = safeUrl(urlStr);

      const headers =
        (init && init.headers) || (input instanceof Request ? input.headers : null);

      const ct =
        (headers &&
          (headers.get
            ? headers.get("content-type")
            : headers["content-type"] || headers["Content-Type"])) ||
        "";

      if (init && typeof init.body === "string") {
        return init.body.includes('"jsonrpc"');
      }

      if (u && u.host === PRIMARY_HOST) return true;

      if (ct && !String(ct).toLowerCase().includes("application/json")) return false;

      return true;
    } catch {
      return false;
    }
  }

  window.sanctosUseTunnel = function sanctosUseTunnel(url) {
    try {
      const clean = String(url || "").trim().replace(/\/+$/, "");
      if (!clean) throw new Error("missing_url");

      window.__SANCTOS_INDEXER_BASE__ = clean;
      try { localStorage.setItem("sanctos.indexerUrl", clean); } catch {}
      window.SANCTOS_INDEXER_URL = clean;

      window.__sanctosIndexerMode = null; // force re-detect in chat.js client
      console.log("[SanctOS] ✅ Using indexer tunnel:", clean);
      return clean;
    } catch (e) {
      console.warn("[SanctOS] ❌ sanctosUseTunnel failed:", e);
      return null;
    }
  };

  // ----------------------------------------------------------------------------
  // 🚦 Unified fetch patch (RPC failover ONLY):
  //   - Only intercept calls to the primary worker (RPC) AND only JSON-RPC POSTs
  //   - Never rewrite indexer HTTP requests here (chat.js owns indexer base)
  // ----------------------------------------------------------------------------
  window.fetch = async function sanctosFetchPatched(input, init) {
    try {
      if (!isPrimaryUrl(input)) return ogFetch(input, init);
      if (!isJsonRpcCall(input, init)) return ogFetch(input, init);

      const origUrl = rawUrlOf(input);
      const now = Date.now();
      const startIdx = now < primaryCooldownUntil ? 1 : 0;

      for (let i = startIdx; i < endpoints.length; i++) {
        const ep = endpoints[i];
        const url = rewriteRpcUrl(origUrl, ep);

        let res;
        try {
          res = await fetchAttempt(input, init, url);
        } catch {
          continue;
        }

        // ✅ FIX: never “return” a browser-hostile 401/403 from a fallback.
        // If primary is down/throttled and fallback gives 403, just skip it.
        if (res && (res.status === 401 || res.status === 403) && i !== 0) {
          console.warn("[SanctOS] ⚠️ RPC fallback forbidden (skip):", ep, "HTTP", res.status);
          continue;
        }

        if (res && (res.status === 429 || res.status === 503)) {
          if (i === 0) {
            primaryCooldownUntil = Date.now() + 30_000;
            console.warn("[SanctOS] ⚠️ RPC primary throttled; failing over for 30s");
          }
          continue;
        }

        if (i !== 0) console.warn("[SanctOS] 🛟 RPC failover used:", ep);
        return res;
      }

      return ogFetch(input, init);
    } catch {
      return ogFetch(input, init);
    }
  };

  console.log("[SanctOS] 🧩 RPC failover installed (429/503 → fallback mainnet). Indexer routing handled by chat.js.");

  // ============================================================
  // 🧱 SanctOS WS-SILENCER + RPC-ONLY CONFIRMATIONS
  // ============================================================
  (() => {
    console.log("[SanctOS] 🧩 Installing WS-silencer + RPC-poll confirmations...");

    class FakeSocket {
      constructor(url) {
        this.url = url;
        this.readyState = WebSocket.CLOSED;
      }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
      dispatchEvent() {
        return true;
      }
    }

    if (!window.__SANCTOS_WS_SANDBOX__) {
      window.__SANCTOS_WS_SANDBOX__ = true;

      const OG_WS = window.WebSocket;
      const loggedHosts = new Set();

      window.WebSocket = class extends OG_WS {
        constructor(...args) {
          const url = String(args?.[0] || "");
          let host = "";
          try {
            host = new URL(url).hostname || "";
          } catch {
            return new OG_WS(...args);
          }

          const isWSS = url.startsWith("ws://") || url.startsWith("wss://");

          const isRpcHost =
            /solana\.com|helius|quicknode|ankr|alchemy|chainstack|rpc/i.test(host + url) ||
            host.includes("sanctos-rpc-node") ||
            (host.endsWith("workers.dev") && url.includes("sanctos"));

          if (isWSS && isRpcHost) {
            const key = host || url;
            if (!loggedHosts.has(key)) {
              console.info("[SanctOS] 🧩 Silencing RPC WebSocket:", key);
              loggedHosts.add(key);
            }
            return new FakeSocket(url);
          }

          return new OG_WS(...args);
        }
      };
    }

    const patchConnection = () => {
      const w3 = window.solanaWeb3;
      if (!w3?.Connection?.prototype) return setTimeout(patchConnection, 50);

      const proto = w3.Connection.prototype;
      if (proto.__SANCTOS_WS_OFF__) return;
      proto.__SANCTOS_WS_OFF__ = true;

      try {
        proto._rpcWebSocketFactory = () => new FakeSocket("disabled");
        console.log("[SanctOS] 🌐 Connection._rpcWebSocketFactory → FakeSocket");
      } catch (err) {
        console.warn("[SanctOS] ⚠️ Failed to patch _rpcWebSocketFactory:", err);
      }

      proto.confirmTransaction = async function (sig, commitment = "confirmed") {
        const signature =
          typeof sig === "string"
            ? sig
            : sig?.signature || sig?.sig || sig?.toString?.();

        if (!signature) throw new Error("confirmTransaction: missing signature");

        const conn = this;
        console.log("[SanctOS] 🧠 RPC-only confirmTransaction:", signature);

        for (let i = 0; i < 50; i++) {
          let st;
          try {
            st = (await conn.getSignatureStatuses([signature]))?.value?.[0];
          } catch (err) {
            console.warn("[SanctOS] ⚠️ RPC confirm poll failed:", err);
          }

          if (
            st &&
            (st.confirmationStatus === "confirmed" ||
              st.confirmationStatus === "finalized" ||
              st.confirmations === null)
          ) {
            console.log("[SanctOS] ✅ Tx confirmed (RPC poll):", signature);
            return { value: st };
          }

          await new Promise((r) => setTimeout(r, 900));
        }

        console.error("[SanctOS] ⏱️ Tx confirmation timeout:", signature);
        throw new Error("Tx not confirmed after polling: " + signature);
      };

      proto.confirmTransactionUsingLegacyTimeoutStrategy = proto.confirmTransaction;
      proto.confirmTransactionUsingBlockHeightExceedanceStrategy = proto.confirmTransaction;

      console.log("[SanctOS] ✅ WS-OFF mode active (RPC-only confirmations, RPC WS silenced)");
    };

    patchConnection();
  })();

  // ============================================================
  // 🚫 Prevent MetaMask from hijacking window.web3
  // ============================================================
  (() => {
    try {
      Object.defineProperty(window, "web3", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: undefined,
      });
      console.log("[SanctOS] 🧱 Blocked MetaMask window.web3 shim injection");
    } catch (e) {
      console.warn("[SanctOS] ⚠️ Failed to lock window.web3:", e);
    }
  })();

  // ============================================================
  // 🌐 Indexer URL setter (dev tunnels change) — guarded
  // ============================================================
  if (typeof window.sanctosSetIndexerUrl !== "function") {
    window.sanctosSetIndexerUrl = function sanctosSetIndexerUrl(url) {
      try {
        const clean = String(url || "").trim().replace(/\/+$/, "");
        if (!clean) throw new Error("missing_url");
        localStorage.setItem("sanctos.indexerUrl", clean);
        window.SANCTOS_INDEXER_URL = clean;

        window.__sanctosIndexerMode = clean.includes("indexer.sanctos.app") ? "direct" : null;

        console.log("[SanctOS] ✅ Indexer URL set:", clean);
        return clean;
      } catch (e) {
        console.warn("[SanctOS] ❌ Failed to set indexer URL:", e);
        return null;
      }
    };
  }

  // ============================================================
  // ✅ Load bs58 early (dynamic import)
  // ============================================================
  (() => {
    if (window.__sanctosBs58ReadyPromise) return;

    window.__sanctosBs58ReadyPromise = (async () => {
      try {
        if (!window.bs58) {
          const bs58mod = await import("https://esm.sh/bs58@5.0.0");
          window.bs58 = bs58mod.default || bs58mod;
          console.log("[SanctOS] ✅ Loaded bs58 via esm.sh");
        }
      } catch (err) {
        console.error("[SanctOS] ❌ Failed to load bs58:", err);
      }
    })();
  })();

  // ============================================================
  // ✅ Force-delayed SanctOS core boot (dev/prod switch + cachebust)
  // ============================================================
  (() => {
    window.__forceSanctosAutoSign = true;

    const SCRIPT_ID = "sanctos-core-script";
    const FLAG_INFLIGHT = "__SANCTOS_CORE_SCRIPT_INFLIGHT__";
    const FLAG_LOADED = "__SANCTOS_CORE_SCRIPT_LOADED__";

    function alreadyHaveScript() {
      return !!document.getElementById(SCRIPT_ID);
    }

    function wantsDev() {
      try {
        const qs = new URLSearchParams(location.search);
        if (qs.get("dev") === "1") return true;
      } catch {}
      try {
        if (localStorage.getItem("sanctos.dev") === "1") return true;
      } catch {}
      if (window.__SANCTOS_DEV_BUNDLE__ === true) return true;
      return false;
    }

    function pickCoreSrc() {
      if (
        typeof window.__SANCTOS_CORE_SRC === "string" &&
        window.__SANCTOS_CORE_SRC.trim()
      ) {
        return window.__SANCTOS_CORE_SRC.trim();
      }

      if (wantsDev()) return "/client/sanctos.dev.js?v=" + Date.now();
      return "sanctos.bundle.js";
    }

    function loadSanctosOnce() {
      if (window[FLAG_LOADED]) return;
      if (window[FLAG_INFLIGHT]) return;
      if (alreadyHaveScript()) return;

      window[FLAG_INFLIGHT] = true;

      const dev = wantsDev();
      const src = pickCoreSrc();
      console.log("[SanctOS⚙️] Core select:", { dev, src });

      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src = src;

      s.onload = () => {
        window[FLAG_LOADED] = true;
        window[FLAG_INFLIGHT] = false;
        console.log("[SanctOS⚙️] Core loaded:", src);
        try {
          window.dispatchEvent(new Event("sanctos:core-loaded"));
        } catch {}
      };

      s.onerror = (e) => {
        window[FLAG_INFLIGHT] = false;
        console.warn("[SanctOS⚙️] Core failed to load:", src, e);
      };

      document.head.appendChild(s);
    }

    window.addEventListener("load", async () => {
      console.log("[SanctOS⚙️] Delaying core until Web3 + bs58 ready...");

      try {
        await (window.__sanctosBs58ReadyPromise || Promise.resolve());
      } catch {}

      for (let i = 0; i < 60; i++) {
        if (window.solanaWeb3?.Connection && window.bs58?.decode) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      loadSanctosOnce();
    });
  })();

  // ============================================================
  // 🧩 Minimal Node Buffer polyfill (safe)
  // ============================================================
  (() => {
    if (typeof window.Buffer === "undefined") {
      window.Buffer = {
        from: (data, encoding) => {
          if (typeof data === "string") {
            if (encoding === "base58" && window.bs58)
              return Uint8Array.from(window.bs58.decode(data));
            return new TextEncoder().encode(data);
          }
          if (data instanceof Uint8Array) return data;
          return new Uint8Array(data);
        },
        alloc: (len) => new Uint8Array(len),
        concat: (arrs) => {
          const total = arrs.reduce((a, b) => a + b.length, 0);
          const out = new Uint8Array(total);
          let off = 0;
          for (const a of arrs) {
            out.set(a, off);
            off += a.length;
          }
          return out;
        },
      };
      console.log("[SanctOS] 🧬 Injected minimal Buffer polyfill");
    }
  })();

  // ============================================================
  // 🪐 Anchor ESM fallback if local Anchor missing (dynamic import)
  // ============================================================
  (async () => {
    try {
      if (!window.anchor) {
        const a = await import("https://esm.sh/@coral-xyz/anchor@0.30.1");
        window.anchor = a;
        console.log("[SanctOS] 🪐 Loaded Anchor via esm.sh fallback");
      }
    } catch (err) {
      console.error("[SanctOS] ❌ Failed to load Anchor via esm.sh:", err);
    }
  })();

  // ============================================================
  // 🧩 Fallback reconstruction helpers (ensureAnchorGlobalExport)
  // ============================================================
  (function ensureAnchorGlobalExport() {
    try {
      const root = typeof window !== "undefined" ? window : globalThis;
      if (!root.anchor || Object.keys(root.anchor).length < 3) {
        console.warn("[SanctOS] ⚠️ Attempting to reconstruct Anchor from exports");
        const ex = typeof exports !== "undefined" ? exports : null;
        const possible = ex || root.anchor || {};
        const keys = Object.keys(possible);
        const program = keys.find((k) => /Program/i.test(k));
        const provider = keys.find((k) => /AnchorProvider|Provider/i.test(k));
        if (program && provider) {
          root.anchor = {
            Program: possible[program],
            AnchorProvider: possible[provider],
            utils: possible.utils || {},
          };
          console.log("[SanctOS] 🧩 Reconstructed anchor from exports keys:", keys);
        }
      }
    } catch (err) {
      console.error("[SanctOS] ❌ ensureAnchorGlobalExport failed:", err);
    }
  })();

  // ============================================================
  // ✅ Inject fallback classes (Provider + Program)
  // ============================================================
  (() => {
    const root = typeof window !== "undefined" ? window : globalThis;
    root.anchor = root.anchor || {};
    const web3 = root.anchor.web3 || root.solanaWeb3;

    if (!root.anchor.AnchorProvider && web3) {
      class FallbackAnchorProvider {
        constructor(connection, wallet, opts = {}) {
          this.connection = connection;
          this.wallet = wallet;
          this.opts = {
            preflightCommitment: opts.preflightCommitment || "confirmed",
            commitment: opts.commitment || "confirmed",
          };
        }
        static local(
          url = (window.__SANCTOS_RPC_URL || "https://api.mainnet-beta.solana.com"),
          opts = {}
        ) {
          const conn = new web3.Connection(url, opts.commitment || "confirmed");
          const dummyWallet = {
            publicKey: web3.Keypair.generate().publicKey,
            signTransaction: async (tx) => tx,
            signAllTransactions: async (txs) => txs,
          };
          return new FallbackAnchorProvider(conn, dummyWallet, opts);
        }
      }
      root.anchor.AnchorProvider = FallbackAnchorProvider;
      console.log("[SanctOS] 🧬 Injected fallback AnchorProvider class");
    }

    if (!root.anchor.Program && web3) {
      class FallbackProgram {
        constructor(idl, programId, provider) {
          this.idl = idl;
          this.programId = new web3.PublicKey(programId);
          this.provider = provider;
          this.methods = new Proxy(
            {},
            {
              get: (_, name) => () => ({
                accounts: (accs) => ({
                  rpc: async () => {
                    console.log(
                      `[SanctOS] ⚙️ Simulated RPC call ${name} on ${this.programId.toBase58()}`
                    );
                    return "ok";
                  },
                }),
              }),
            }
          );
        }
      }
      root.anchor.Program = FallbackProgram;
      console.log("[SanctOS] 🧬 Injected fallback Program class");
    }
  })();

  // ============================================================
  // ✅ Normalize translateAddress
  // ============================================================
  window.addEventListener("load", () => {
    setTimeout(() => {
      const a = window.anchor;
      if (!a?.Program) return;
      const AnchorPK = a?.utils?.publicKey?.PublicKey || a?.web3?.PublicKey;
      if (!AnchorPK) return;
      a.Program.prototype.translateAddress = function (addr) {
        if (addr instanceof AnchorPK) return addr;
        try {
          return new AnchorPK(addr);
        } catch {
          return new AnchorPK(addr?.toString?.());
        }
      };
      console.log("[SanctOS] 🔒 translateAddress normalized");
    }, 800);
  });

// ============================================================
// 🩹 Final-Final SanctOS Repair Hotfix (20s retry, full coverage)
// ============================================================
(async function ensureRepairHelpers() {
  const g = window;

  // 🕓 Wait for sanctos base to appear
  for (let i = 0; i < 200; i++) {
    if (g.sanctos && typeof g.sanctos.getAnchorProvider === "function") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!g.sanctos) {
    console.warn("[SanctOS] ⚠️ Hotfix: sanctos not found at all.");
    return;
  }

  // 🧩 Wait up to 20s for publish/findPeer
  let publish = null,
    findPeer = null;
  for (let i = 0; i < 200; i++) {
    publish =
      g.sanctos?.publishDevicePubkeyIfNeeded ||
      g.publishDevicePubkeyIfNeeded ||
      g.__sanctosRepair?.publishDevicePubkeyIfNeeded;

    findPeer =
      g.sanctos?.findPeerDevicePubkey ||
      g.findPeerDevicePubkey ||
      g.__sanctosRepair?.findPeerDevicePubkey ||
      (g.sanctos?.__proto__?.findPeerDevicePubkey ?? null);

    if (publish && findPeer) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (findPeer && typeof findPeer === "object") {
    const maybeFn =
      findPeer.default ||
      findPeer.findPeerDevicePubkey ||
      Object.values(findPeer).find((v) => typeof v === "function");
    if (maybeFn) {
      console.log("[SanctOS] 🧠 Normalized findPeerDevicePubkey from object");
      findPeer = maybeFn;
    }
  }

  const getProvider =
    g.sanctos?.getAnchorProvider ||
    g.getAnchorProvider ||
    g.__sanctosRepair?.getAnchorProvider;

  if (!publish || !findPeer) {
    console.warn(
      "[SanctOS] ⚠️ Hotfix: still missing publish/findPeer after 20s — continuing fallback"
    );
  }

  // ✅ Attach repairPeerKey
  g.sanctos.repairPeerKey = async (provider, meStr, peerStr) => {
    try {
      const w3 = g.solanaWeb3 || (g.anchor && g.anchor.web3);
      const me = new w3.PublicKey(meStr);
      const peer = new w3.PublicKey(peerStr);
      const prov = provider || (await getProvider());
      console.log(
        `[SanctOS] 🔄 repairPeerKey (hotfix): ${me.toBase58()} <-> ${peer.toBase58()}`
      );

      if (!publish || !findPeer) throw new Error("Missing publish or findPeer");

      await publish(prov, me, peer);
      await new Promise((r) => setTimeout(r, 1500));
      const peerDev = await findPeer(prov, me, peer, me, peer);
      if (peerDev) console.log("[SanctOS] 🧠 Peer device key synced (hotfix)");
      else
        console.warn(
          "[SanctOS] ⚠️ Peer device key not found after repair"
        );
    } catch (err) {
      console.error("[SanctOS] ❌ Hotfix repairPeerKey failed:", err);
    }
  };

  // ✅ Attach autoRepairPeerKey
  g.sanctos.autoRepairPeerKey = async (provider, me, peer) => {
    try {
      const prov = provider || (await getProvider());
      const tag = `sanctos:lastRepair:${me.toBase58()}->${peer.toBase58()}`;
      const last = sessionStorage.getItem(tag);
      if (last && Date.now() - parseInt(last) < 60_000) return;

      const peerDev = await findPeer(prov, me, peer, me, peer);
      if (!peerDev) {
        console.log(
          "[SanctOS] 🩹 Auto-repair: publishing my device pubkey"
        );
        await publish(prov, me, peer);
        await new Promise((r) => setTimeout(r, 1500));
        sessionStorage.setItem(tag, Date.now().toString());
      }
    } catch (err) {
      console.warn("[SanctOS] ⚠️ Hotfix autoRepairPeerKey failed:", err);
    }
  };

  console.log("[SanctOS] 🧩 Hotfix fully attached ✅", {
    repairPeerKey: typeof g.sanctos.repairPeerKey,
    autoRepairPeerKey: typeof g.sanctos.autoRepairPeerKey,
    publish: typeof publish,
    findPeer: typeof findPeer,
  });
})();

// ============================================================
// 🔍 Attach check on load
// ============================================================
window.addEventListener("load", () =>
  console.log("[SanctOS] 🔍 Attach check:", {
    repairPeerKey: typeof window.sanctos?.repairPeerKey,
    autoRepairPeerKey: typeof window.sanctos?.autoRepairPeerKey,
  })
);

// ============================================================
// ✅ Force attach sanctos presence check
// ============================================================
(async () => {
  console.log("[SanctOS] 🕓 Waiting for sanctos to expose...");
  for (let i = 0; i < 40; i++) {
    const s = window.sanctos || globalThis.sanctos;
    if (s && Object.keys(s).length > 0) {
      console.log("[SanctOS] ✅ Found sanctos on window:", Object.keys(s));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn(
    "[SanctOS] ⚠️ sanctos not found after retries — bundle may not have exported correctly"
  );
})();

// ============================================================
// ✅ Ready check
// ============================================================
(() => {
  console.log("[SanctOS] ✅ Ready check:", {
    anchor: typeof window.anchor,
    web3: typeof window.solanaWeb3,
    Program: window.anchor?.Program ? "OK" : "missing",
  });
})();

// ============================================================
// 🧩 Global Decoder Patch — override sanctos.ts internal utf8.dec
// ============================================================
(() => {
  console.log("[SanctOS] 🩹 Applying global TextDecoder guard patch...");

  // Monkey-patch TextDecoder.decode to auto-wrap all bad inputs
  const NativeDecoder = window.TextDecoder;
  class SafeTextDecoder extends NativeDecoder {
    decode(input, opts) {
      try {
        if (input instanceof Uint8Array || ArrayBuffer.isView(input)) {
          return super.decode(input, opts);
        }
        if (input instanceof ArrayBuffer) {
          return super.decode(new Uint8Array(input), opts);
        }
        if (Array.isArray(input)) {
          return super.decode(new Uint8Array(input), opts);
        }
        if (input?.data && Array.isArray(input.data)) {
          return super.decode(new Uint8Array(input.data), opts);
        }
        if (typeof input === "string") {
          // handle accidental string -> bytes
          return input;
        }
        console.warn(
          "[SanctOS] ⚠️ TextDecoder.decode received weird type:",
          input
        );
        return String(input ?? "");
      } catch (err) {
        console.warn("[SanctOS] ⚠️ SafeTextDecoder fallback:", err, input);
        return "";
      }
    }
  }

  // Replace global TextDecoder safely
  window.TextDecoder = SafeTextDecoder;
  console.log("[SanctOS] ✅ SafeTextDecoder installed globally");
})();

// ============================================================
// ✅ Final findPeerDevicePubkey (universal memo decoder)
// + Final Guaranteed patchConnectionGuard attach
// ============================================================
(() => {
  const g = window;
  g.sanctos = g.sanctos || {};

  const safeDecode = (data) => {
    try {
      if (!data) return "";
      if (typeof data === "string") return data;
      if (data instanceof ArrayBuffer)
        return new TextDecoder().decode(new Uint8Array(data));
      if (data instanceof Uint8Array) return new TextDecoder().decode(data);
      if (ArrayBuffer.isView(data))
        return new TextDecoder().decode(new Uint8Array(data.buffer));
      if (data?.data && Array.isArray(data.data))
        return new TextDecoder().decode(new Uint8Array(data.data));
      return String(data);
    } catch (e) {
      console.warn("[SanctOS] ⚠️ safeDecode fallback triggered:", e, data);
      return "";
    }
  };

  const safeDecodeB64 = (b64) => {
    try {
      return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch (e) {
      console.warn("[SanctOS] ⚠️ Invalid base64 in memo:", e);
      return new Uint8Array();
    }
  };

  g.sanctos.findPeerDevicePubkey = async function findPeerDevicePubkey(
    provider,
    lower,
    higher,
    me,
    peerPk
  ) {
    console.log("[SanctOS] 🧠 scanning memos for peerDevicePubkey…");
    const MEMO_PROGRAM_ID = new solanaWeb3.PublicKey(
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
    );
    const addresses = [me, peerPk];

    for (const addr of addresses) {
      const sigs = await provider.connection.getSignaturesForAddress(
        addr,
        { limit: 50 }
      );
      for (const s of sigs) {
        const tx = await provider.connection.getTransaction(
          s.signature,
          { maxSupportedTransactionVersion: 0 }
        );
        if (!tx) continue;

        const ixs = tx.transaction.message.instructions || [];
        for (const ix of ixs) {
          const prog =
            tx.transaction.message.staticAccountKeys[ix.programIdIndex];
          if (prog?.toBase58?.() !== MEMO_PROGRAM_ID.toBase58()) continue;

          let memoText = "";
          try {
            const bytes = bs58.decode(ix.data);
            memoText = safeDecode(bytes);
          } catch {
            if (typeof ix.data === "string") memoText = ix.data;
          }

          if (memoText && memoText.includes("SANCTOS_PUBKEY:")) {
            const parts = memoText.split(":");
            if (parts.length === 3 && parts[1] === peerPk.toBase58()) {
              const pub = safeDecodeB64(parts[2]);
              if (pub.length === 32) {
                console.log("[SanctOS] ✅ Peer device pubkey found!");
                return pub;
              }
            }
          }
        }
      }
    }

    console.warn("[SanctOS] ⚠️ No SANCTOS_PUBKEY memos found for peer.");
    return null;
  };

  // --- patchConnectionGuard ---
  const root = typeof window !== "undefined" ? window : globalThis;

  function patchConnectionGuard(conn, PublicKey) {
    try {
      if (!conn || !PublicKey) {
        console.warn(
          "[SanctOS] ⚠️ patchConnectionGuard: missing conn/PublicKey"
        );
        return;
      }
      if (conn.__sanctos_guarded__) return;

      const orig = conn.getSignaturesForAddress?.bind(conn);
      if (typeof orig !== "function") {
        console.warn(
          "[SanctOS] ⚠️ patchConnectionGuard: no getSignaturesForAddress on conn"
        );
        return;
      }

      conn.getSignaturesForAddress = async function (addr, opts = {}) {
        try {
          let pk;
          if (!addr) throw new Error("Missing address");
          if (addr instanceof PublicKey) pk = addr;
          else if (addr?.toBase58) pk = new PublicKey(addr.toBase58());
          else pk = new PublicKey(String(addr));
          return await orig(pk, opts);
        } catch (err) {
          console.warn(
            "[SanctOS] ⚠️ instance getSignaturesForAddress error:",
            err
          );
          return [];
        }
      };

      conn.__sanctos_guarded__ = true;
      console.log(
        "[SanctOS] 🧩 Patched conn.getSignaturesForAddress() (instance-safe)"
      );
    } catch (e) {
      console.warn("[SanctOS] ⚠️ patchConnectionGuard failed:", e);
    }
  }

  // 🔁 Ensure sanctos exists and persistently attach patchConnectionGuard
  const attachPatch = () => {
    root.sanctos = root.sanctos || {};
    root.sanctos.patchConnectionGuard = patchConnectionGuard;
    console.log("[SanctOS] ✅ patchConnectionGuard attached globally");
  };

  attachPatch();

  // Watch for redefinitions of window.sanctos (some builds recreate it)
  const handler = {
    set(obj, prop, value) {
      const res = Reflect.set(obj, prop, value);
      if (prop === "sanctos" && typeof value === "object") {
        value.patchConnectionGuard = patchConnectionGuard;
        console.log(
          "[SanctOS] ♻️ Reattached patchConnectionGuard after sanctos reset"
        );
      }
      return res;
    },
  };

  try {
    // eslint-disable-next-line no-global-assign
    window = new Proxy(root, handler);
  } catch {
    // ignore if cannot proxy (browser restriction)
  }

  // Extra delayed reinforcement
  setTimeout(attachPatch, 1000);
  setTimeout(attachPatch, 2500);
  if (root.addEventListener)
    root.addEventListener("load", attachPatch, { once: true });
})();

// ============================================================
// 🚨 FINAL PROGRAM_ID OVERRIDE — JS must match on-chain program
// ============================================================
(function enforceSanctosProgramId() {
  try {
    const g = typeof window !== "undefined" ? window : globalThis;

    // Make sure solanaWeb3 is wired
    if (!g.solanaWeb3 && g.anchor && g.anchor.web3) {
      g.solanaWeb3 = g.anchor.web3;
    }
    const PublicKey = g.solanaWeb3 && g.solanaWeb3.PublicKey;
    if (!PublicKey) {
      console.warn("[SanctOS🚨] No PublicKey for PROGRAM_ID override");
      return;
    }

    const pk = new PublicKey("EBEQdAwgXmyLrj5npwmX63cEZwzrSKgEHy297Nfxrjhw");

    g.sanctos = g.sanctos || {};
    g.sanctos.PROGRAM_ID = pk;
    g.sanctos.PROGRAM_ID_STR = pk.toBase58();

    console.log("[SanctOS🚨] PROGRAM_ID hard-set to", pk.toBase58());
  } catch (e) {
    console.warn("[SanctOS🚨] Failed to override PROGRAM_ID:", e);
  }
})();
})();
