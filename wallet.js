// ====================================================================
// 🔮 SanctOS Wallet Manager — Stable Production Version (v3.4)
// Integrates: Solana (Helius v0 + Jupiter v2) + EVM (Etherscan v2)
// Caching, async parallel updates, logo recovery, Coingecko/Dex fallback
// ====================================================================

// === Constants ===
const HELIUS_API_KEY = "36a03d8a-6670-432b-8cf2-bf20a03620a2";
const HELIUS_V0_URL = "https://api.helius.xyz/v0/addresses";

const NODEREAL_API_KEY = "64a9df0874fb4a93b9d0a3849de012d3";
const ETHERSCAN_API_KEY = "K15MB6W7XFGM336BSB9IFYXZAI3Y1FF28P";

const RPC_ENDPOINTS = {
  sol: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  eth: `https://eth-mainnet.nodereal.io/v1/${NODEREAL_API_KEY}`,
  bsc: `https://bsc-mainnet.nodereal.io/v1/${NODEREAL_API_KEY}`,
};

const COINGECKO_NATIVE_IDS = { sol: "solana", eth: "ethereum", bsc: "binancecoin" };
const COINGECKO_PLATFORM_IDS = { eth: "ethereum", bsc: "binance-smart-chain" };

// === Caches ===
const PRICE_CACHE = {};
const TOKEN_META_CACHE = new Map(); // contract → meta
let JUP_TOKEN_MAP = null;

// === Helpers ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...args) { console.log("[SanctOS]", ...args); }

function getTokenLogo(chain, contract) {
  const base = chain === "bsc" ? "smartchain" : "ethereum";
  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${base}/assets/${contract}/logo.png`;
}

// === Local Storage ===
(function ensureWalletArray() {
  if (!window.wallets) {
    try { window.wallets = JSON.parse(localStorage.getItem("hl_wallets") || "[]"); }
    catch { window.wallets = []; }
  }
})();
function persistWallets() { try { localStorage.setItem("hl_wallets", JSON.stringify(wallets)); } catch {} }
function safeSave() { if (typeof saveTickers === "function") saveTickers(); else persistWallets(); }

// === Cached native price ===
async function fetchCachedPrice(chain) {
  const now = Date.now();
  const cached = PRICE_CACHE[chain];
  if (cached && now - cached.time < 60000) return cached.price;

  const id = COINGECKO_NATIVE_IDS[chain];
  if (!id) return 0;

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    const data = await res.json();
    const price = data?.[id]?.usd || 0;
    PRICE_CACHE[chain] = { price, time: now };
    log(`💰 ${chain.toUpperCase()} = $${price}`);
    return price;
  } catch (e) {
    log(`fetchCachedPrice(${chain}) error:`, e);
    return 0;
  }
}

// === Native balance (Solana + EVM unified) ===
async function fetchNativeBalance(chain, addr) {
  const rpc = RPC_ENDPOINTS[chain];
  if (!rpc) return 0;

  const payload =
    chain === "sol"
      ? { jsonrpc: "2.0", id: 1, method: "getBalance", params: [addr] }
      : { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [addr, "latest"] };

  try {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const value =
      chain === "sol"
        ? (data?.result?.value || 0) / 1e9
        : parseInt(data?.result || "0x0", 16) / 1e18;
    log(`✅ ${chain.toUpperCase()} balance for ${addr.slice(0, 6)}…: ${value}`);
    return value;
  } catch (e) {
    log(`⚠️ ${chain.toUpperCase()} RPC error`, e);
    return 0;
  }
}

// =============================================================
// ========== EVM TOKEN DISCOVERY (Etherscan v2 + Cached Meta) ==========
// =============================================================
async function fetchEvmTokens(chain, address) {
  log(`🔍 Fetching ${chain.toUpperCase()} tokens for ${address} using Etherscan v2`);

  const chainId =
    chain === "eth" ? 1 :
    chain === "bsc" ? 56 :
    null;

  if (!chainId) {
    log(`⚠️ Unsupported EVM chain: ${chain}`);
    return [];
  }

  const tokens = [];
  try {
    // --- 1️⃣ Query Etherscan v2 ---
    const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=tokentx&address=${address}&page=1&offset=100&startblock=0&endblock=99999999&sort=desc&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const json = await res.json();

    if (!json?.result?.length) {
      log(`⚠️ No ERC20/BEP20 transfers found for ${chain.toUpperCase()} wallet`);
      return [];
    }

    log(`🧩 ${chain.toUpperCase()} found ${json.result.length} token transfers`);
    const seen = new Map();

    for (const tx of json.result) {
      const contract = tx.contractAddress?.toLowerCase();
      if (!contract) continue;

      const decimals = parseInt(tx.tokenDecimal || 18);
      const symbol = tx.tokenSymbol || `UNK-${contract.slice(0, 4)}`;
      const value = parseFloat(tx.value || 0) / Math.pow(10, decimals);
      const from = tx.from?.toLowerCase();
      const to = tx.to?.toLowerCase();

      const isSender = from === address.toLowerCase();
      const isReceiver = to === address.toLowerCase();

      const prev = seen.get(contract) || { amount: 0, symbol, decimals };
      if (isReceiver) prev.amount += value;
      if (isSender) prev.amount -= value;
      seen.set(contract, prev);
    }

    const tokenBalances = Array.from(seen.entries())
      .map(([contract, t]) => ({ contract, ...t }))
      .filter((t) => t.amount > 0);

    if (!tokenBalances.length) {
      log(`⚠️ ${chain.toUpperCase()} wallet has no positive token balances`);
      return [];
    }

    // --- 2️⃣ Fetch metadata & prices (cached) ---
    for (const t of tokenBalances.slice(0, 25)) {
      const contract = t.contract;
      const cache = TOKEN_META_CACHE.get(contract);
      const now = Date.now();
      const isFresh = cache && now - cache.lastFetch < 5 * 60 * 1000;

      let meta = cache;
      if (!isFresh) {
        meta = await fetchTokenMeta(chain, contract, t.symbol);
        TOKEN_META_CACHE.set(contract, { ...meta, lastFetch: now });
      }

      const { priceUsd = 0, name = t.symbol, logo } = meta;
      const valueUsd = t.amount * priceUsd;

      tokens.push({ contract, symbol: t.symbol, name, amount: t.amount, decimals: t.decimals, priceUsd, valueUsd, logo });
      await sleep(75);
    }

    tokens.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    log(`✅ ${chain.toUpperCase()} token scan complete — ${tokens.length} tokens found`);
    return tokens;
  } catch (err) {
    log(`❌ fetchEvmTokens(${chain}) error:`, err);
    return [];
  }
}
// =============================================================
// 🔮 Token Metadata Fetcher — Corrected Logo Priority
// =============================================================
async function fetchTokenMeta(chain, contract, symbol) {
  const platform = COINGECKO_PLATFORM_IDS[chain];
  let priceUsd = 0,
      name = symbol,
      logo = null;

  // 🪙 1️⃣ Coingecko for price (with rate limit guard)
  try {
    const cgUrl = `https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${contract}&vs_currencies=usd`;
    const cgRes = await fetch(cgUrl);
    if (cgRes.status === 429) {
      log(`⚠️ Coingecko 429 — waiting before retry (${contract.slice(0, 6)})`);
      await sleep(1000 + Math.random() * 500);
      const retry = await fetch(cgUrl);
      if (retry.ok) {
        const data = await retry.json();
        const tokenData = Object.values(data)?.[0];
        if (tokenData?.usd) priceUsd = parseFloat(tokenData.usd);
      }
    } else if (cgRes.ok) {
      const data = await cgRes.json();
      const tokenData = Object.values(data)?.[0];
      if (tokenData?.usd) priceUsd = parseFloat(tokenData.usd);
    }
  } catch (err) {
    log("⚠️ Coingecko fetch failed:", err);
  }

  // 🔄 2️⃣ DexScreener fallback for price, name, and logo
  if (!priceUsd || !logo) {
    try {
      const dsUrl = `https://api.dexscreener.com/latest/dex/search?q=${contract}`;
      const dsRes = await fetch(dsUrl);
      const dsJson = await dsRes.json();
      const pair = dsJson?.pairs?.[0];
      if (pair) {
        if (!priceUsd) priceUsd = parseFloat(pair.priceUsd || 0);
        if (!name || name === symbol)
          name = pair.baseToken?.name || pair.baseToken?.symbol || name;
        if (!logo)
          logo =
            pair.info?.imageUrl ||
            pair.baseToken?.icon ||
            pair.baseToken?.logoURI ||
            null;
      }
    } catch (err) {
      log("⚠️ DexScreener fallback failed:", err);
    }
  }

  // 🎨 3️⃣ TrustWallet logo (only if not already found)
  if (!logo) {
    const base = chain === "bsc" ? "smartchain" : "ethereum";
    const trustUrl = `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${base}/assets/${contract}/logo.png`;
    try {
      const res = await fetch(trustUrl, { method: "HEAD" });
      if (res.ok) logo = trustUrl;
    } catch {
      // ignore silently
    }
  }

  // 🪩 4️⃣ Only now — generate a fallback orb if nothing else exists
  if (!logo) {
    const hue = Math.abs(
      contract.split("").reduce((a, c) => a + c.charCodeAt(0), 0)
    ) % 360;
    logo = `data:image/svg+xml;base64,${btoa(`
      <svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>
        <circle cx='32' cy='32' r='32' fill='hsl(${hue},70%,60%)'/>
        <text x='50%' y='55%' font-size='28' font-family='Arial' font-weight='bold'
              text-anchor='middle' fill='white'>${(symbol[0] || "?").toUpperCase()}</text>
      </svg>
    `)}`;
  }

  return { priceUsd, name, logo };
}


// =============================================================
// =============== Solana Token Discovery (Jupiter v2) ===============
// =============================================================
async function fetchSolTokens(address) {
  try {
    const url = `${HELIUS_V0_URL}/${address}/balances?api-key=${HELIUS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const list = Array.isArray(data?.tokens) ? data.tokens : [];
    log(`🧩 Helius v0 returned ${list.length} tokens for ${address}`);

    if (!list.length) return [];
    const tokens = [];

    const mints = list.map(t => t.mint || t.tokenAddress || t.address).filter(Boolean).slice(0, 100);
    const metaUrl = `https://lite-api.jup.ag/tokens/v2/search?query=${mints.join(',')}`;
    const metaRes = await fetch(metaUrl);
    const metaJson = await metaRes.json();
    const metaMap = {};
    for (const m of metaJson) metaMap[m.id.toLowerCase()] = m;

    for (const t of list) {
      const mint = (t.mint || t.tokenAddress || t.address || "").toLowerCase();
      if (!mint) continue;

      const meta = metaMap[mint] || {};
      const decimals = t?.tokenAmount?.decimals ?? meta.decimals ?? 9;
      const amount = t?.tokenAmount?.uiAmount ?? parseFloat(t.amount || 0) / Math.pow(10, decimals);
      if (!amount || amount <= 0) continue;

      const symbol = meta.symbol || `UNK-${mint.slice(0, 4)}`;
      const name = meta.name || "Unknown Token";
      const logo = meta.icon || `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${mint}/logo.png`;
      const priceUsd = parseFloat(meta.usdPrice || 0);
      const valueUsd = amount * priceUsd;

      tokens.push({ mint, symbol, name, amount, decimals, priceUsd, valueUsd, logo, marketCap: meta.mcap || meta.fdv || 0, priceChange24h: meta.stats24h?.priceChange || 0 });
    }

    tokens.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    const priced = tokens.filter(t => t.priceUsd > 0).length;
    log(`✅ Solana token scan complete — ${tokens.length} tokens found (${priced} priced)`);
    return tokens;
  } catch (err) {
    log("❌ fetchSolTokens error:", err);
    return [];
  }
}

// =============================================================
// =============== Unified Fetch & Updates ======================
// =============================================================
async function fetchTokenBalances(w) {
  log(`🔍 Fetching token balances for ${w.chain.toUpperCase()} wallet: ${w.addr}`);
  try {
    if (w.chain === "sol") return await fetchSolTokens(w.addr);
    if (["eth", "bsc"].includes(w.chain)) return await fetchEvmTokens(w.chain, w.addr);
    return [];
  } catch (e) {
    log("❌ fetchTokenBalances error:", e);
    return [];
  }
}

let updating = false;
let lastUpdate = 0;

async function updateBalances() {
  const now = Date.now();
  if (updating || now - lastUpdate < 15000) return;
  updating = true;
  lastUpdate = now;
  log("⏳ Updating all wallet balances…");

  renderWallets(true);

  await Promise.all(wallets.map(async (w) => {
    try {
      const [nativeBal, tokenData, price] = await Promise.all([
        fetchNativeBalance(w.chain, w.addr),
        fetchTokenBalances(w),
        fetchCachedPrice(w.chain),
      ]);

      const nativeValue = (nativeBal || 0) * (price || 0);
      const tokenValue = tokenData.reduce((acc, t) => acc + (t.valueUsd || 0), 0);
      w.native = nativeBal;
      w.nativeUsd = nativeValue;
      w.tokens = tokenData;
      w.balance = nativeValue + tokenValue;
      w.lastUpdate = new Date().toLocaleTimeString();

      safeSave();
    } catch (e) {
      log("updateBalances error:", e);
    }
  }));

  renderWallets(false);
  updating = false;
  log("✅ Wallet balances updated successfully");
}

// Run every 30s
setInterval(updateBalances, 30000);
renderWallets();
updateBalances();

// =============================================================
// =============== Wallet Management & Rendering =================
// =============================================================

function addWallet(addr, privKey = null, chain = null) {
  if (!addr) return;
  if (!chain) chain = detectChain(addr);
  if (wallets.some((w) => w.addr === addr && w.chain === chain)) return;
  wallets.push({ addr, privKey, chain, balance: 0, native: 0, nativeUsd: 0, tokens: [] });
  safeSave();
  renderWallets();
  updateBalances();
}

function removeWallet(index) {
  wallets.splice(index, 1);
  safeSave();
  renderWallets();
}

function detectChain(addr) {
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return "sol";
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    const choice = prompt("This address could be Ethereum or BSC.\nType 'eth' or 'bsc'");
    return choice && choice.toLowerCase().includes("bsc") ? "bsc" : "eth";
  }
  return "bsc";
}

// === Render Wallets ===
function renderWallets(isLoading = false) {
  const list = document.getElementById("wallet-list");
  if (!list) return;
  list.innerHTML = "";

  // --- Loader state ---
  if (isLoading) {
    const loader = document.createElement("div");
    loader.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;gap:8px;opacity:0.7">
        <div style="width:12px;height:12px;border:2px solid #edacf4;border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
        Fetching balances…
      </div>`;
    list.appendChild(loader);
    return;
  }

  // --- Empty state ---
  if (!wallets.length) {
    const empty = document.createElement("div");
    empty.className = "empty-placeholder";
    empty.textContent = "No wallets added";
    empty.style.opacity = "0.6";
    empty.style.textAlign = "center";
    list.appendChild(empty);
    updateTotal();
    return;
  }

  // --- Wallets ---
  wallets.forEach((w, i) => {
    const item = document.createElement("div");
    item.className = "wallet-item";
    item.style.position = "relative";
    item.style.padding = "8px";
    item.style.marginBottom = "6px";
    item.style.background = "rgba(255,255,255,0.03)";
    item.style.borderRadius = "6px";
    item.style.transition = "background 0.2s";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.cursor = "pointer";

    // --- Left side (chain + address) ---
    const left = document.createElement("span");
    left.textContent = `${w.chain.toUpperCase()}: ${w.addr.slice(0, 6)}...${w.addr.slice(-4)}`;
    left.style.opacity = "0.9";

    // --- Right side (balance + toggle/remove) ---
    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";
    right.style.gap = "8px";

    const bal = document.createElement("span");
    bal.textContent = `$${(w.balance || 0).toFixed(2)}`;
    bal.style.opacity = "0.8";

    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "▸ Tokens";
    toggleBtn.style.background = "transparent";
    toggleBtn.style.border = "none";
    toggleBtn.style.color = "#edacf4";
    toggleBtn.style.cursor = "pointer";
    toggleBtn.style.fontSize = "12px";
    toggleBtn.style.padding = "0";

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.style.background = "transparent";
    removeBtn.style.border = "none";
    removeBtn.style.color = "#ff6666";
    removeBtn.style.cursor = "pointer";
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      removeWallet(i);
    };

    right.appendChild(toggleBtn);
    right.appendChild(bal);
    right.appendChild(removeBtn);
    header.appendChild(left);
    header.appendChild(right);
    item.appendChild(header);

    // --- Expandable token list container ---
    const tokenContainer = document.createElement("div");
    tokenContainer.style.display = "none";
    tokenContainer.style.marginTop = "6px";
    tokenContainer.style.padding = "6px";
    tokenContainer.style.background = "rgba(255,255,255,0.04)";
    tokenContainer.style.borderRadius = "6px";

    const tokenList = document.createElement("ul");
    tokenList.className = "token-list";
    tokenList.style.listStyle = "none";
    tokenList.style.margin = "0";
    tokenList.style.padding = "0";
    tokenContainer.appendChild(tokenList);
    item.appendChild(tokenContainer);

    // --- Hover summary popup ---
    const summaryPopup = document.createElement("div");
    summaryPopup.className = "wallet-hover-popup";
    summaryPopup.style.position = "fixed";
    summaryPopup.style.background = "rgba(0,0,0,0.9)";
    summaryPopup.style.color = "#ddd";
    summaryPopup.style.padding = "8px 10px";
    summaryPopup.style.borderRadius = "6px";
    summaryPopup.style.fontSize = "12px";
    summaryPopup.style.display = "none";
    summaryPopup.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
    document.body.appendChild(summaryPopup);

    let hoverActive = true;

    // Hover preview (wallet summary)
    item.addEventListener("mouseenter", () => {
      if (!hoverActive || tokenContainer.style.display !== "none") return;

      const rect = header.getBoundingClientRect();
      const lines = [];

      if (w.native && w.nativeUsd)
        lines.push(`${w.chain === "sol" ? "SOL" : w.chain === "bsc" ? "BNB" : "ETH"}: ${w.native.toFixed(4)} · $${w.nativeUsd.toFixed(2)}`);

      for (const t of w.tokens || []) {
        const changeTxt = t.priceChange24h
          ? `<span style="color:${t.priceChange24h > 0 ? '#3aff7a' : '#ff5555'};">${t.priceChange24h.toFixed(2)}%</span>`
          : "";
        lines.push(`${t.symbol}: ${t.amount.toFixed(3)} · $${t.valueUsd.toFixed(2)} ${changeTxt}`);
      }

      summaryPopup.innerHTML = lines.length ? lines.join("<br>") : "<i>No tokens</i>";
      summaryPopup.style.left = rect.left + "px";
      summaryPopup.style.top = rect.bottom + 8 + "px";
      summaryPopup.style.display = "block";
    });

    item.addEventListener("mouseleave", () => (summaryPopup.style.display = "none"));

    // --- Populate token list (expanded mode) ---
    const populateTokens = () => {
      tokenList.innerHTML = "";

      if (w.native && w.nativeUsd) {
        const li = document.createElement("li");
        li.innerHTML = `<span>${w.chain === "bsc" ? "BNB" : w.chain === "eth" ? "ETH" : "SOL"}</span><span>${w.native.toFixed(4)} · $${w.nativeUsd.toFixed(2)}</span>`;
        li.style.display = "flex";
        li.style.justifyContent = "space-between";
        tokenList.appendChild(li);
      }

      if (!w.tokens.length) {
        const li = document.createElement("li");
        li.innerHTML = "<span style='opacity:0.7'>No tokens</span>";
        tokenList.appendChild(li);
      } else {
        for (const t of w.tokens) {
          const li = document.createElement("li");
          li.style.display = "flex";
          li.style.justifyContent = "space-between";
          li.style.alignItems = "center";
          li.style.fontSize = "12px";
          li.style.padding = "2px 0";

          const leftSide = document.createElement("span");
          leftSide.style.display = "flex";
          leftSide.style.alignItems = "center";
          leftSide.style.gap = "6px";
          const img = document.createElement("img");
          img.src = t.logo || "";
          img.onerror = () => (img.style.display = "none");
          img.style.width = "14px";
          img.style.height = "14px";
          img.style.borderRadius = "50%";
          leftSide.appendChild(img);
          leftSide.appendChild(document.createTextNode(t.symbol));

          const rightSide = document.createElement("span");
          rightSide.textContent = `${t.amount.toFixed(4)} · $${t.valueUsd.toFixed(2)}`;

          li.appendChild(leftSide);
          li.appendChild(rightSide);

          // Tooltip
          const tooltip = document.createElement("div");
          tooltip.className = "token-tooltip";
          tooltip.innerHTML = `
            <div class="marquee"><span>
              ${t.name || t.symbol} · 
              ${t.marketCap ? `$${(t.marketCap / 1e6).toFixed(1)}M` : "n/a"} · 
              <span style="color:${t.priceChange24h > 0 ? '#3aff7a' : '#ff5555'}">
                ${t.priceChange24h ? `${t.priceChange24h > 0 ? "+" : ""}${t.priceChange24h.toFixed(2)}%` : ""}
              </span>
            </span></div>`;
          tooltip.style.position = "fixed";
          tooltip.style.background = "rgba(0,0,0,0.9)";
          tooltip.style.color = "#ddd";
          tooltip.style.padding = "4px 8px";
          tooltip.style.borderRadius = "4px";
          tooltip.style.fontSize = "11px";
          tooltip.style.display = "none";
          tooltip.style.zIndex = "1000";
          document.body.appendChild(tooltip);

          li.addEventListener("mouseenter", (e) => {
            const rect = li.getBoundingClientRect();
            tooltip.style.left = rect.left + "px";
            tooltip.style.top = rect.top - tooltip.offsetHeight - 6 + "px";
            tooltip.style.display = "block";
          });
          li.addEventListener("mouseleave", () => (tooltip.style.display = "none"));

          tokenList.appendChild(li);
        }
      }
    };

    // --- Toggle expand ---
    toggleBtn.onclick = () => {
      const isOpen = tokenContainer.style.display !== "none";
      tokenContainer.style.display = isOpen ? "none" : "block";
      toggleBtn.textContent = isOpen ? "▸ Tokens" : "▾ Tokens";
      hoverActive = isOpen; // disable hover when expanded
      summaryPopup.style.display = "none";
      if (!isOpen) populateTokens();
    };

    list.appendChild(item);
    populateTokens();
  });

  updateTotal();
}


// === Total ===
function updateTotal() {
  const totalEl = document.getElementById("total-usd");
  if (!totalEl) return;
  const total = wallets.reduce((acc, w) => acc + (w.balance || 0), 0);
  totalEl.textContent = `$${isNaN(total) ? "0.00" : total.toFixed(2)}`;
}

// === Add wallet button ===
(function wireAddWallet() {
  const btn = document.getElementById("add-wallet");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const addrEl = document.getElementById("wallet-address");
    if (!addrEl) return;
    const addr = addrEl.value.trim();
    if (!addr) return;
    const chainSel = document.getElementById("network-select");
    const chain = chainSel ? chainSel.value : null;
    addWallet(addr, null, chain);
    addrEl.value = "";
  });
})();

// === Spinner animation (idempotent) ===
(function injectSpinnerKeyframesOnce() {
  if (document.getElementById("sanctos-spinner-style")) return;
  const style = document.createElement("style");
  style.id = "sanctos-spinner-style";
  style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
})();

// === Kickoff ===
setInterval(updateBalances, 20000);
renderWallets();
updateBalances();
