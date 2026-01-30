// client/sanctos.warmup.js
(() => {
  const g = typeof window !== "undefined" ? window : globalThis;
  if (g.__SANCTOS_API_WARMUP_INSTALLED) return;
  g.__SANCTOS_API_WARMUP_INSTALLED = true;

  const enabled =
    g.SANCTOS_API_AUTOWARMUP !== false &&
    String(g.SANCTOS_API_AUTOWARMUP ?? "1") !== "0";
  if (!enabled) return;

  // NEW: warmup mode
  // - "rpc"  (default): warms RPC only (NO message sync/decrypt)
  // - "sync": does rpc warm + small sync over peers (can affect UI if decrypt hooks are sensitive)
  const warmMode = String(g.SANCTOS_API_WARMUP_MODE ?? "rpc").toLowerCase();

  const intervalMs = Math.max(
    10_000,
    Math.min(5 * 60_000, Number(g.SANCTOS_API_WARMUP_INTERVAL_MS ?? 30_000))
  );
  const peersN = Math.max(0, Math.min(10, Number(g.SANCTOS_API_WARMUP_PEERS ?? 3)));
  const syncLimit = Math.max(1, Math.min(25, Number(g.SANCTOS_API_WARMUP_SYNC_LIMIT ?? 6)));

  const state = (g.__sanctosApiWarmupState ||= { ts: 0, inflight: null });

  async function waitForApi(timeoutMs = 12_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const api = g.sanctos?.api;
      if (
        api &&
        typeof api.ready === "function" &&
        typeof api.listPeers === "function" &&
        typeof api.sync === "function"
      ) {
        return api;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    return null;
  }

  async function warmup(reason = "auto") {
    try {
      const now = Date.now();
      if (state.inflight) return await state.inflight;
      if (now - (state.ts || 0) < 4_000) return true; // throttle

      state.inflight = (async () => {
        const api = await waitForApi(12_000);
        if (!api) return false;

        try { await api.ready(8_000); } catch {}

        // provider might not exist if wallet not connected yet
        let provider = null;
        try { provider = await g.sanctos?.getAnchorProvider?.(); } catch {}
        if (!provider?.wallet?.publicKey) {
          state.ts = Date.now();
          if (g.__SANCTOS_DEBUG_WARMUP__) {
            console.log("[SanctOS🔥] warmup skipped (no wallet)", { reason, mode: warmMode });
          }
          return false;
        }

        // prime light stuff (harmless)
        try { g.__sanctosTD ||= new TextDecoder(); } catch {}

        // =========================================================
        // ✅ MODE: RPC-ONLY (default) — avoids decrypt/render issues
        // =========================================================
        if (warmMode !== "sync") {
          try { await provider.connection.getLatestBlockhash(); } catch {}
          try { await provider.connection.getSlot(); } catch {}
          try { await provider.connection.getVersion?.(); } catch {}

          state.ts = Date.now();
          if (g.__SANCTOS_DEBUG_WARMUP__) {
            console.log("[SanctOS🔥] warmup rpc-only done", { reason });
          }
          return true;
        }

        // =========================================================
        // MODE: SYNC — old behavior (can touch decrypt/render paths)
        // =========================================================
        let peers = [];
        try { peers = await api.listPeers({ limit: 60 }); } catch {}

        if (peersN > 0 && Array.isArray(peers) && peers.length) {
          for (const peer58 of peers.slice(0, peersN)) {
            try { await api.sync(peer58, { limit: syncLimit }); } catch {}
          }
        }

        state.ts = Date.now();
        if (g.__SANCTOS_DEBUG_WARMUP__) {
          console.log("[SanctOS🔥] warmup sync done", { reason, peers: peers?.length || 0 });
        }
        return true;
      })();

      const ok = await state.inflight;
      state.inflight = null;
      return ok;
    } catch (e) {
      state.inflight = null;
      if (g.__SANCTOS_DEBUG_WARMUP__) console.warn("[SanctOS🔥] warmup error", e);
      return false;
    }
  }

  // ✅ ALWAYS expose a global proof function
  g.__sanctosWarmupNow = async (opts = {}) => warmup(opts.reason || "manual-proof");

  // ✅ LATE-ATTACH: keep trying until sanctos.api exists, then attach api.warmup
  (function lateAttach() {
    const t0 = Date.now();
    const timer = setInterval(() => {
      try {
        const api = g.sanctos?.api;
        if (api && typeof api.warmup !== "function") {
          api.warmup = warmup;
          if (g.__SANCTOS_DEBUG_WARMUP__) console.log("[SanctOS🔥] attached api.warmup");
          clearInterval(timer);
        }
        // stop trying after 20s
        if (Date.now() - t0 > 20_000) clearInterval(timer);
      } catch {}
    }, 100);
  })();

  // kick once after load (non-blocking)
  warmup("boot").catch(() => {});

  // periodic warmup while visible
  g.__SANCTOS_API_WARMUP_TIMER ||= setInterval(() => {
    try {
      if (typeof document !== "undefined" && document.hidden) return;
      warmup("interval").catch(() => {});
    } catch {}
  }, intervalMs);

  try {
    document.addEventListener("visibilitychange", () => {
      try {
        if (!document.hidden) warmup("visible").catch(() => {});
      } catch {}
    });
  } catch {}
})();
