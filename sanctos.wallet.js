/* ===========================================================
   SanctOS Wallet Module — Embedded + Phantom Dual Mode
   File: sanctos.wallet.js
   =========================================================== */

   (() => {
    const g = typeof window !== "undefined" ? window : globalThis;
  
    // Early guard
    if (g.sanctos && g.sanctos.wallet) {
      console.warn("[SanctOSWallet] wallet module already attached.");
      return;
    }
  
    const STORAGE_KEY = "sanctosEmbeddedWalletV1";
    const MODE_KEY    = "sanctosSignMode"; // "embedded" | "phantom"
    const DEFAULT_MODE = "embedded";
  
    // Soft dependency: solanaWeb3
    function getWeb3() {
      const w = g.solanaWeb3 || g.solana?.web3 || g.solanaWeb3JS || null;
      if (!w) console.warn("[SanctOSWallet] solanaWeb3 not found yet.");
      return w;
    }
  
    // === Local helpers =======================================================
  
    function u8ToBase64(u8) {
      let s = "";
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    }
  
    function base64ToU8(b64) {
      const s = atob(b64);
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
      return out;
    }
  
    function getStoredMode() {
      const m = localStorage.getItem(MODE_KEY);
      if (m === "embedded" || m === "phantom") return m;
      return DEFAULT_MODE;
    }
  
    function setStoredMode(mode) {
      if (mode !== "embedded" && mode !== "phantom") {
        console.warn("[SanctOSWallet] Invalid mode:", mode);
        return;
      }
      localStorage.setItem(MODE_KEY, mode);
      console.log("[SanctOSWallet] Mode set →", mode);
      window.dispatchEvent(new CustomEvent("sanctos:walletModeChanged", { detail: { mode } }));
    }
  
    // === Embedded wallet storage ============================================
  
    function hasEmbeddedWallet() {
      return !!localStorage.getItem(STORAGE_KEY);
    }
  
    function clearEmbeddedWallet() {
      localStorage.removeItem(STORAGE_KEY);
      console.log("[SanctOSWallet] Embedded wallet cleared.");
      window.dispatchEvent(new CustomEvent("sanctos:embeddedCleared"));
    }
  
    function createEmbeddedWallet() {
      const web3 = getWeb3();
      if (!web3) throw new Error("solanaWeb3 not ready");
  
      const kp = web3.Keypair.generate();
      const b64 = u8ToBase64(kp.secretKey);
      localStorage.setItem(STORAGE_KEY, b64);
  
      console.log("[SanctOSWallet] New embedded wallet created:", kp.publicKey.toBase58());
      window.dispatchEvent(new CustomEvent("sanctos:embeddedCreated", {
        detail: { pubkey: kp.publicKey.toBase58() }
      }));
  
      return kp;
    }
  
    function getEmbeddedKeypair() {
      const web3 = getWeb3();
      if (!web3) throw new Error("solanaWeb3 not ready");
  
      const b64 = localStorage.getItem(STORAGE_KEY);
      if (!b64) return null;
      try {
        const secret = base64ToU8(b64);
        const kp = web3.Keypair.fromSecretKey(secret);
        return kp;
      } catch (e) {
        console.error("[SanctOSWallet] Failed to restore embedded wallet:", e);
        return null;
      }
    }
  
    function getEmbeddedPubkey() {
      const kp = getEmbeddedKeypair();
      return kp ? kp.publicKey : null;
    }
  
    // === Phantom helpers =====================================================
  
    function getPhantomProvider() {
      // very simple, we assume Phantom injected window.solana
      const provider = g.solana;
      if (!provider || !provider.isPhantom) return null;
      return provider;
    }
  
    async function ensurePhantomConnected() {
      const provider = getPhantomProvider();
      if (!provider) throw new Error("Phantom provider not found.");
      try {
        const res = await provider.connect();
        return res.publicKey;
      } catch (e) {
        console.error("[SanctOSWallet] Phantom connect failed:", e);
        throw e;
      }
    }
  
    // === Mode + signer selection ============================================
  
    function getMode() {
      return getStoredMode();
    }
  
    function setMode(mode) {
      setStoredMode(mode);
    }
  
    function getActiveType() {
      const mode = getMode();
      if (mode === "embedded" && hasEmbeddedWallet()) return "embedded";
      if (getPhantomProvider()) return "phantom";
      return "none";
    }
  
    async function getActivePublicKey() {
      const type = getActiveType();
      if (type === "embedded") {
        const kp = getEmbeddedKeypair();
        return kp ? kp.publicKey : null;
      }
      if (type === "phantom") {
        const provider = getPhantomProvider();
        if (!provider) return null;
        if (provider.publicKey) return provider.publicKey;
        return await ensurePhantomConnected();
      }
      return null;
    }
  
    // === Funding & balance checks ============================================
  
    async function getBalance(connection) {
      const pub = await getActivePublicKey();
      if (!pub) return null;
      const lamports = await connection.getBalance(pub);
      return { pubkey: pub, lamports };
    }
  
    async function ensureMinBalance(connection, minLamports) {
      const info = await getBalance(connection);
      if (!info) return { ok: false, reason: "no-active-wallet" };
      if (info.lamports >= minLamports) {
        return { ok: true, balance: info.lamports };
      }
      window.dispatchEvent(new CustomEvent("sanctos:walletNeedsFunding", {
        detail: { pubkey: info.pubkey.toBase58(), balance: info.lamports, minLamports }
      }));
      return { ok: false, balance: info.lamports, reason: "insufficient" };
    }
  
    // === Signing & sending ===================================================
  
    /**
     * signAndSendTx
     * - Uses embedded wallet when mode=embedded and exists
     * - Otherwise falls back to Phantom signAndSendTransaction
     *
     * @param {Connection} connection solanaWeb3.Connection
     * @param {Transaction} tx solanaWeb3.Transaction
     * @param {object} opts { commitment?, skipPreflight?, maxRetries? }
     */
        // === Signing & sending ===================================================
        async function signAndSendTx(connection, tx, opts = {}) {
            const web3 = getWeb3();
            if (!web3) throw new Error("solanaWeb3 not ready");
            const { commitment = "confirmed", skipPreflight = false, maxRetries } = opts;
      
            const type = getActiveType();
            console.log("[SanctOSWallet] signAndSendTx via", type);
      
            if (!tx.recentBlockhash) {
              const { blockhash } = await connection.getLatestBlockhash("finalized");
              tx.recentBlockhash = blockhash;
            }
      
            if (type === "embedded") {
              const kp = getEmbeddedKeypair();
              if (!kp) throw new Error("Embedded wallet missing.");
              if (!tx.feePayer) tx.feePayer = kp.publicKey;
      
              tx.sign(kp);
      
              const raw = tx.serialize();
              const sig = await connection.sendRawTransaction(raw, {
                skipPreflight,
                maxRetries,
              });
      
              await connection.confirmTransaction(
                { signature: sig, ...(await connection.getLatestBlockhash()) },
                commitment
              );
      
              return { signature: sig, type: "embedded" };
            }
      
            if (type === "phantom") {
              const provider = getPhantomProvider();
              if (!provider) throw new Error("Phantom provider not found.");
      
              if (!tx.feePayer) {
                const pk = provider.publicKey || (await ensurePhantomConnected());
                tx.feePayer = pk;
              }
      
              const { signature } = await provider.signAndSendTransaction(tx, {
                preflightCommitment: commitment,
              });
      
              await connection.confirmTransaction(
                { signature, ...(await connection.getLatestBlockhash()) },
                commitment
              );
      
              return { signature, type: "phantom" };
            }
      
            throw new Error("No active wallet (embedded or Phantom).");
          }
      
          // === Anchor-Compatible Provider for EMBEDDED mode =========================
          function getEmbeddedProvider() {
            const web3 = getWeb3();
            if (!web3) throw new Error("solanaWeb3 not ready");
      
            const kp = getEmbeddedKeypair();
            if (!kp) throw new Error("Embedded wallet not found");
      
            const connection = new web3.Connection(
              "https://api.devnet.solana.com",
              "confirmed"
            );
      
            console.log("[SanctOSWallet] Using embedded provider for:", kp.publicKey.toBase58());
      
            return {
              connection,
              wallet: {
                publicKey: kp.publicKey,
                signTransaction: async (tx) => {
                  tx.feePayer = kp.publicKey;
                  if (!tx.recentBlockhash) {
                    const { blockhash } = await connection.getLatestBlockhash();
                    tx.recentBlockhash = blockhash;
                  }
                  tx.sign(kp);
                  return tx;
                },
                signAllTransactions: async (txs) => {
                  for (const tx of txs) {
                    tx.feePayer = kp.publicKey;
                    if (!tx.recentBlockhash) {
                      const { blockhash } = await connection.getLatestBlockhash();
                      tx.recentBlockhash = blockhash;
                    }
                    tx.sign(kp);
                  }
                  return txs;
                },
              },
              publicKey: kp.publicKey,
            };
          }
      
          // === Public API ==========================================================
          const api = {
            // mode
            getMode,
            setMode,
      
            // embedded
            hasEmbeddedWallet,
            createEmbeddedWallet,
            getEmbeddedKeypair,
            getEmbeddedPubkey,
            clearEmbeddedWallet,
            getEmbeddedProvider,     // ✅ here
      
            // phantom
            getPhantomProvider,
            ensurePhantomConnected,
      
            // active
            getActiveType,
            getActivePublicKey,
      
            // balance
            getBalance,
            ensureMinBalance,
      
            // signing
            signAndSendTx,
          };
      
          // Attach into SanctOS namespace
          g.sanctos = g.sanctos || {};
          g.sanctos.wallet = api;
      
          console.log("[SanctOSWallet] module attached ✅");
        })();
      