(() => {
  if (window.__sanctosWidgetBooted) {
    console.log("[SanctOS Widget] already booted, skipping re-init");
    return;
  }
  window.__sanctosWidgetBooted = true;


// ===== STORAGE PERSISTENCE =====
let tickers = JSON.parse(localStorage.getItem('hl_tickers') || '["BTC","ETH","SOL","ASTER","FARTCOIN"]');
let tokenTickers = JSON.parse(localStorage.getItem('hl_tokenTickers') || '[]'); 
let lastPrices = {}, tokenLastPrices = {};
let dayPrices = JSON.parse(localStorage.getItem('hl_dayPrices') || '{}');
let tokenDayPrices = JSON.parse(localStorage.getItem('hl_tokenDayPrices') || '{}');
let wallets = JSON.parse(localStorage.getItem('hl_wallets') || '[]');
let fetchingMain = false, fetchingTokens = false;

// ===== UTILS =====
const logoCache = {};
let lastLogoFetch = 0;

async function fetchLogoForSymbol(symbol) {
  if (!symbol) return null;
  const key = symbol.toUpperCase();
  if (logoCache[key]) return logoCache[key];

  // Use a shared queue instead of hard throttle
  if (!window._logoQueue) window._logoQueue = [];
  const now = Date.now();

  // If we fetched recently, queue this one for later
  if (window._lastLogoFetch && now - window._lastLogoFetch < 500) {
    return new Promise(resolve => {
      window._logoQueue.push({ symbol, resolve });
    });
  }

  // Process current request
  window._lastLogoFetch = now;
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`);
    if (res.status === 429) throw new Error("429 Too Many Requests");
    const data = await res.json();
    if (!data?.coins?.length) throw new Error("No coins found");
    const match = data.coins.find(c => c.symbol?.toUpperCase() === symbol.toUpperCase()) || data.coins[0];
    const url = match.large || match.thumb || null;
    if (url) logoCache[key] = url;

    // process queued requests every 0.5 s
    setTimeout(async () => {
      if (window._logoQueue?.length) {
        const next = window._logoQueue.shift();
        if (next) next.resolve(await fetchLogoForSymbol(next.symbol));
      }
    }, 500);

    return url;
  } catch (e) {
    console.warn("⚠️ fetchLogoForSymbol error:", e.message);
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
      const dexJson = await dexRes.json();
      const url = dexJson?.pairs?.[0]?.info?.imageUrl || null;
      if (url) {
        logoCache[key] = url;
        return url;
      }
    } catch {
      /* ignore */
    }
    return null;
  }
}

async function applyLogoToRow(row, symbol, fallbackUrl = null) {
  const logoEl = row.querySelector('.logo');
  if (!logoEl || logoEl.dataset.logoApplied) return;
  let url = fallbackUrl || await fetchLogoForSymbol(symbol);
  if (url) {
    logoEl.style.backgroundImage = `url(${url})`;
    logoEl.dataset.logoApplied = "true";
  }
}

function updateScale() {
  const root = document.documentElement;
  const widget = document.getElementById("widget");
  if (!widget) return;
  const scale = Math.max(0.6, Math.min(1.6, widget.offsetWidth / 340));
  root.style.setProperty('--scale', scale);
}

function attachHoverExpansion(row) {
  row.addEventListener("mouseenter", () => row.classList.add("expanded"));
  row.addEventListener("mouseleave", () => row.classList.remove("expanded"));
}

function formatPrice(price) {
  if (price === null || price === undefined) return "—";
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  let str = price.toFixed(12);
  let match = str.match(/^0\.(0+)(\d+)/);
  if (match) {
    let zeros = match[1].length;
    let digits = match[2].slice(0, 4).padEnd(4, '0');
    const superscripts = "⁰¹²³⁴⁵⁶⁷⁸⁹";
    let supStr = "";
    for (let d of String(zeros)) supStr += superscripts[parseInt(d)];
    return `$0.${supStr}${digits}`;
  }
  return `$${price.toFixed(4)}`;
}

function saveTickers() {
  localStorage.setItem('hl_tickers', JSON.stringify(tickers));
  localStorage.setItem('hl_tokenTickers', JSON.stringify(tokenTickers));
  localStorage.setItem('hl_wallets', JSON.stringify(wallets));
}

// ===== ROW CREATION =====
function createRow(symbol, container, isToken = false) {
  if (Array.from(container.querySelectorAll(".price"))
    .some(r => r.querySelector(".symbol")?.textContent === symbol)) return;

  const row = document.createElement("div");
  row.className = "price";
  row.innerHTML = `
    <span class="logo"></span>
    <span class="symbol">${symbol}</span>
    <span class="priceVal">—</span>
    <span class="diff"></span>
    <button class="remove-btn">✕</button>
  `;
  container.appendChild(row);
  attachHoverExpansion(row);

  row.querySelector(".remove-btn").addEventListener("click", () => {
    row.remove();
    if (isToken) {
      tokenTickers = tokenTickers.filter(t => t !== symbol);
      if (tokenDayPrices[symbol]) {
        delete tokenDayPrices[symbol];
        localStorage.setItem('hl_tokenDayPrices', JSON.stringify(tokenDayPrices));
      }
    } else {
      tickers = tickers.filter(t => t !== symbol);
      if (dayPrices[symbol]) {
        delete dayPrices[symbol];
        localStorage.setItem('hl_dayPrices', JSON.stringify(dayPrices));
      }
    }
    saveTickers();
  });

  return row;
}

// ===== FACTORY RESET =====
document.getElementById("reset-btn")?.addEventListener("click", () => {
  localStorage.clear();
  location.reload();
});

// ===== FETCH MAIN COIN PRICES =====
async function updatePricesMain() {
  if (fetchingMain) return;
  fetchingMain = true;
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" })
    });
    const data = await res.json();
    const mids = data.mids || data.result?.mids || data.result || data || {};
    const content = document.querySelector("#widget #content");
    if (!content) return;

    for (const symbol of tickers) {
      const raw = mids[symbol];
      const price = (raw === undefined || raw === null) ? undefined : parseFloat(raw);
      if (price === undefined || Number.isNaN(price)) continue;

      if (!dayPrices[symbol]) {
        dayPrices[symbol] = price;
        localStorage.setItem('hl_dayPrices', JSON.stringify(dayPrices));
      }
      const diff24h = ((price - dayPrices[symbol]) / dayPrices[symbol]) * 100;
      const colorClass = diff24h > 0 ? "green" : diff24h < 0 ? "red" : "yellow";
      lastPrices[symbol] = price;

      let row = Array.from(content.querySelectorAll(".price"))
        .find(r => r.querySelector(".symbol")?.textContent === symbol);
      if (!row) row = createRow(symbol, content);

      row.querySelector(".priceVal").textContent = formatPrice(price);
      const diffEl = row.querySelector(".diff");
      diffEl.textContent = `${diff24h.toFixed(2)}%`;
      diffEl.className = `diff ${colorClass}`;
      applyLogoToRow(row, symbol);
    }

    // ✅ Re-check alarms immediately after prices refresh (handles restarts)
    checkAlarms();
  } catch (err) {
    console.error("updatePricesMain error:", err);
  } finally {
    fetchingMain = false;
  }
}

// ===== FETCH TOKEN PRICES (manual tickers widget) =====
async function fetchTokenData(input) {
  try {
    let chain = null;
    if (/^0x[a-fA-F0-9]{40}$/.test(input)) { chain = ["ethereum", "bsc"]; }
    else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) { chain = ["solana"]; }

    if (chain) {
      let response = null;
      for (const ch of chain) {
        const url = `https://api.dexscreener.com/tokens/v1/${ch}/${input.toLowerCase()}`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (data?.pairs?.length) { response = data; break; }
      }
      if (!response) return { price: null, symbol: input, logo: null };
      const pair = response.pairs[0];
      return {
        price: parseFloat(pair.priceUsd) || null,
        symbol: pair.baseToken?.symbol || pair.quoteToken?.symbol || input,
        logo: pair.baseToken?.logo || pair.quoteToken?.logo || null
      };
    } else {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(input)}`;
      const res = await fetch(url);
      const data = await res.json();
      const pair = data.pairs?.[0];
      if (!pair) return { price: null, symbol: input, logo: null };
      return {
        price: parseFloat(pair.priceUsd) || null,
        symbol: pair.baseToken?.symbol || pair.quoteToken?.symbol || input,
        logo: pair.baseToken?.logo || pair.quoteToken?.logo || null
      };
    }
  } catch (err) {
    console.error("fetchTokenData error:", err);
    return { price: null, symbol: input, logo: null };
  }
}

async function updatePricesTokens() {
  if (fetchingTokens) return;
  fetchingTokens = true;
  try {
    const content = document.getElementById("token-content");
    if (!content) return;
    if (tokenTickers.length > 0) document.getElementById("token-empty")?.remove();

    for (const input of tokenTickers) {
      const { price, symbol, logo } = await fetchTokenData(input);
      if (price === null) continue;

      if (!tokenDayPrices[input] && price) {
        tokenDayPrices[input] = price;
        localStorage.setItem('hl_tokenDayPrices', JSON.stringify(tokenDayPrices));
      }
      const diff24h = price ? ((price - tokenDayPrices[input]) / tokenDayPrices[input]) * 100 : 0;
      const colorClass = diff24h > 0 ? "green" : diff24h < 0 ? "red" : "yellow";
      tokenLastPrices[input] = price;

      let row = Array.from(content.querySelectorAll(".price"))
        .find(r => r.querySelector(".symbol")?.textContent === symbol);
      if (!row) row = createRow(symbol, content, true);

      row.querySelector(".priceVal").textContent = formatPrice(price);
      const diffEl = row.querySelector(".diff");
      diffEl.textContent = `${diff24h.toFixed(2)}%`;
      diffEl.className = `diff ${colorClass}`;
      applyLogoToRow(row, symbol, logo);
    }

    // ✅ Re-check alarms after token prices refresh as well
    checkAlarms();
  } catch (err) {
    console.error("updatePricesTokens error:", err);
  } finally {
    fetchingTokens = false;
  }
}

// ===== INPUT HANDLERS =====
function toggleBothInputs() {
  const mainInput = document.getElementById("ticker-input");
  const tokenInput = document.getElementById("token-ticker-input");
  if (!mainInput || !tokenInput) return;
  const show = mainInput.style.display === "none" || mainInput.style.display === "";
  mainInput.style.display = show ? "block" : "none";
  tokenInput.style.display = show ? "block" : "none";
  if (show) mainInput.focus();
}

document.getElementById("add-btn")?.addEventListener("click", toggleBothInputs);
document.getElementById("token-add-btn")?.addEventListener("click", toggleBothInputs);

document.getElementById("ticker-input")?.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    const symbol = e.target.value.toUpperCase().trim();
    if (symbol && !tickers.includes(symbol)) {
      tickers.push(symbol); lastPrices[symbol] = null;
      saveTickers();
      updatePricesMain();
    }
    e.target.value = ""; e.target.style.display = "none";
  }
});

document.getElementById("token-ticker-input")?.addEventListener("keypress", async (e) => {
  if (e.key === "Enter") {
    const input = e.target.value.trim();
    if (input && !tokenTickers.includes(input)) {
      tokenTickers.push(input); tokenLastPrices[input] = null;
      saveTickers();
      updatePricesTokens();
    }
    e.target.value = ""; e.target.style.display = "none";
  }
});

// ===== CONTROL CIRCLES (ON/OFF) =====
function toggleWidget(widgetId, circleEl) {
  const widget = document.getElementById(widgetId);
  if (!widget) return;

  const isHidden = widget.classList.contains("hidden");
  if (isHidden) {
    widget.classList.remove("hidden");
  } else {
    widget.classList.add("hidden");
  }

  if (circleEl) {
    circleEl.classList.toggle("off", !isHidden);
  }
}

// ✅ Wire up the control circles
document.getElementById("ctrl-1")?.addEventListener("click", () =>
  toggleWidget("token-widget", document.getElementById("ctrl-1"))
);
document.getElementById("ctrl-2")?.addEventListener("click", () =>
  toggleWidget("wallet-manager", document.getElementById("ctrl-2"))
);
document.getElementById("ctrl-3")?.addEventListener("click", () =>
  toggleWidget("chat-widget", document.getElementById("ctrl-3"))
);

// =======================================================
// 🟣 TRADER MODE (chat-only ↔ chat+widgets)
//   - Alt+S to toggle
//   - Click header orb to toggle
//   - Persists in localStorage
// =======================================================
let traderMode = (localStorage.getItem("sanctos_trader_mode") === "1");

function setTraderMode(on) {
  traderMode = !!on;
  localStorage.setItem("sanctos_trader_mode", traderMode ? "1" : "0");

  const body = document.body;
  const traderCol = document.getElementById("trader-column");
  const mainWidget = document.getElementById("widget");
  const tokenWidget = document.getElementById("token-widget");
  const walletManager = document.getElementById("wallet-manager");

  const c1 = document.getElementById("ctrl-1");
  const c2 = document.getElementById("ctrl-2");
  const c3 = document.getElementById("ctrl-3");

  if (traderMode) {
    // 🌌 Layout morph ON
    body.classList.add("trader-active");
    // ensure column itself is never hidden
    traderCol?.classList.remove("hidden");

    // show all trader widgets
    mainWidget?.classList.remove("hidden");
    tokenWidget?.classList.remove("hidden");
    walletManager?.classList.remove("hidden");

    c1?.classList.remove("off");
    c2?.classList.remove("off");
    c3?.classList.remove("off"); // chat visible
  } else {
    // 🌌 Layout morph OFF → chat recenters & widens, column collapses via CSS
    body.classList.remove("trader-active");
    // do NOT add .hidden to traderCol; CSS handles collapse when trader-active is absent

    // hide trader widgets themselves, keep chat visible
    mainWidget?.classList.add("hidden");
    tokenWidget?.classList.add("hidden");
    walletManager?.classList.add("hidden");

    c1?.classList.add("off");
    c2?.classList.add("off");
    // chat stays, circle just marked off
    c3?.classList.add("off");
  }

  console.log("[SanctOS Widget] setTraderMode →", traderMode);
}

// --- Apply initial mode once DOM is ready
window.addEventListener("load", () => {
  console.log("[SanctOS Widget] Initializing Trader Mode; stored =", traderMode);
  setTraderMode(traderMode);
});

// --- Alt+S hotkey: toggle trader mode
window.addEventListener("keydown", (e) => {
  // Only when window is focused; allow Alt+S or Alt+Shift+S etc.
  if ((e.altKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    console.log("[SanctOS Widget] Alt+S detected");
    setTraderMode(!traderMode);
  }
});

// --- Header orb click → toggle trader mode
function tryAttachOrbToggle() {
  const orb = document.querySelector(".sanctos-header-orb");
  if (!orb) return false;
  orb.style.cursor = "pointer";
  orb.addEventListener("click", () => {
    console.log("[SanctOS Widget] Orb clicked → toggle Trader Mode");
    setTraderMode(!traderMode);
  }, { once: false });
  console.log("[SanctOS Widget] Orb toggle attached");
  return true;
}

// Retry loop because orb is created in chat.js (which loads after widget.js)
(function waitForOrb() {
  if (tryAttachOrbToggle()) return;
  setTimeout(waitForOrb, 300);
})();

// === INIT ===
setInterval(updatePricesMain, 4000);
setInterval(updatePricesTokens, 5000);
setInterval(updateScale, 500);
updatePricesMain();
updatePricesTokens();
updateScale();

// ✅ Export globals for wallet.js
window.renderWallets = window.renderWallets || function () {};
window.saveTickers = saveTickers;
window.wallets = wallets;

// === 🕊️ SanctOS Price Alarm System (multi-alarms + glow + responsive panel) ===

// Storage shape (new):
// ALARMS = { [SYMBOL]: [ { id, dir: "above"|"below", target: number, triggered: boolean } ] }
let ALARMS = JSON.parse(localStorage.getItem("hl_alarms") || "{}");

// --- migrate from old shape if needed (symbol -> {target}) ---
(function migrateAlarms() {
  let changed = false;
  for (const [sym, val] of Object.entries(ALARMS)) {
    if (!Array.isArray(val)) {
      const target = typeof val === "number" ? val : val?.target;
      if (typeof target === "number") {
        ALARMS[sym] = [{ id: crypto.randomUUID(), dir: "above", target, triggered: false }];
        changed = true;
      } else {
        ALARMS[sym] = [];
        changed = true;
      }
    }
  }
  if (changed) localStorage.setItem("hl_alarms", JSON.stringify(ALARMS));
})();

let alarmPanel = null;

// 🔔 Local gong sound, lives in your repo
let alarmGong = new Audio("/assets/sounds/gong.mp3");
alarmGong.volume = 0.9;       // tweak if too loud
alarmGong.preload = "auto";   // pre-load to avoid delay

// timeout for the toast visibility
let alarmToastTimeout = null;

// 🪫 Tiny SanctOS-style toast inside the widget when an alarm hits
function showAlarmToast(symbol, alarm) {
  const host = document.getElementById("widget");
  if (!host) return;

  let toast = host.querySelector("#alarm-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "alarm-toast";
    host.appendChild(toast);
  }

  const dirLabel = alarm.dir === "above" ? "crossed ↑" : "dipped ↓";

  const allPrices = { ...lastPrices, ...tokenLastPrices };
  const current = allPrices[symbol];
  const currentTxt =
    typeof current === "number" && !Number.isNaN(current)
      ? ` (now $${current.toFixed(4)})`
      : "";

  toast.innerHTML = `<strong>${symbol}</strong> ${dirLabel} $${alarm.target}${currentTxt}`;

  toast.classList.add("visible");
  clearTimeout(alarmToastTimeout);
  alarmToastTimeout = setTimeout(() => {
    toast.classList.remove("visible");
  }, 4500);
}


// ——— Bell glow when any active alarms exist
function countActiveAlarms() {
  return Object.values(ALARMS).reduce(
    (acc, arr) => acc + (Array.isArray(arr) ? arr.filter(a => !a.triggered).length : 0),
    0
  );
}
function updateBellGlow() {
  const btn = document.getElementById("alarm-btn");
  if (!btn) return;
  btn.classList.toggle("glow", countActiveAlarms() > 0);
}

// ——— Sync panel width to first widget (#widget)
function syncAlarmPanelWidth() {
  const widget = document.getElementById("widget");
  const w = widget ? widget.clientWidth : 320;
  document.documentElement.style.setProperty("--alarm-panel-width", `${w}px`);
}

// === Create Alarm Panel ===
function createAlarmPanel() {
  if (document.getElementById("alarm-panel")) {
    alarmPanel = document.getElementById("alarm-panel");
    return;
  }

  alarmPanel = document.createElement("div");
  alarmPanel.id = "alarm-panel";
  alarmPanel.innerHTML = `
    <div class="alarm-header">
      <span>🔔 Price Alarms</span>
      <button id="alarm-close">✕</button>
    </div>

    <div class="alarm-setup">
      <select id="alarm-symbol"></select>
      <select id="alarm-dir">
        <option value="above">↑ Above</option>
        <option value="below">↓ Below</option>
      </select>
      <input type="number" id="alarm-price" placeholder="Target price" step="0.0001">
      <button id="alarm-save">Set</button>
    </div>

    <div id="alarm-list"></div>
  `;

  // 🔗 Attach panel INSIDE the main price widget so it only overlays that card
  const host = document.getElementById("widget") || document.body;
  host.appendChild(alarmPanel);

  // 🔧 Panel base styles (SanctOS modal aesthetic)
  const style = document.createElement("style");
  style.textContent = `
    /* host widget becomes the local positioning context */
    #widget {
      position: relative;
    }

    /* 🕳 SanctOS-style floating sheet over the widget */
    #alarm-panel {
      position: absolute;
      top: 10px;
      right: 10px;

      width: var(--alarm-panel-width, 320px);
      max-width: calc(100% - 20px);
      max-height: calc(100% - 20px);

      background:
        radial-gradient(circle at top left,
          rgba(255,255,255,0.03) 0,
          transparent 40%),
        linear-gradient(145deg,
          #0c0b11,
          #07050b);
      backdrop-filter: blur(16px) saturate(1.35);

      color: #f5f2ff;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.10);
      box-shadow:
        0 22px 60px rgba(0,0,0,0.95),
        0 0 0 1px rgba(157,119,240,0.16);

      padding: 14px 16px;
      z-index: 50;
      font-family: 'Courier New', monospace;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;

      opacity: 0;
      transform: translateY(10px) scale(0.96);
      pointer-events: none;
      transition:
        opacity 0.18s ease-out,
        transform 0.18s ease-out;
    }

    #alarm-panel.open {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }

    /* Header – same hierarchy as Profile modal */
    #alarm-panel .alarm-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-weight: 600;
      color: #f7f1ff;
      font-size: 14px;
      margin-bottom: 10px;
      letter-spacing: 0.4px;
    }

    #alarm-panel .alarm-header span {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-shadow:
        0 0 8px rgba(157,119,240,0.7),
        0 0 16px rgba(237,172,244,0.55);
    }

    #alarm-panel .alarm-header button {
      background: transparent;
      border: none;
      color: rgba(255,255,255,0.55);
      font-size: 14px;
      cursor: pointer;
      border-radius: 999px;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.18s ease, color 0.18s ease, transform 0.15s ease;
    }
    #alarm-panel .alarm-header button:hover {
      background: rgba(255,255,255,0.10);
      color: #ff6b6b;
      transform: scale(1.08);
    }

    /* Form row – matches SanctOS field rows */
    #alarm-panel .alarm-setup {
      display: grid;
      grid-template-columns: 1.05fr 1.05fr auto;
      gap: 6px;
      margin: 6px 0 12px 0;
      width: 100%;
      box-sizing: border-box;
    }

    #alarm-panel select,
    #alarm-panel input {
      width: 100%;
      border-radius: 9px;
      background: #111018;
      color: #f5f2ff;
      border: 1px solid rgba(255,255,255,0.16);
      padding: 5px 7px;
      font-size: 11px;
      box-sizing: border-box;
      transition:
        border-color 0.18s ease,
        box-shadow 0.18s ease,
        background 0.18s ease;
    }

    #alarm-panel select:focus,
    #alarm-panel input:focus {
      border-color: rgba(157,119,240,0.95);
      background: #090712;
      box-shadow: 0 0 14px rgba(157,119,240,0.65);
      outline: none;
    }

    /* Set button – little “Confirm” pill */
    #alarm-panel #alarm-save {
      width: 56px;
      border-radius: 999px;
      background: radial-gradient(circle at 0 0,
        #ffe8ff 0,
        #f6bfff 24%,
        #d38bf8 55%,
        #9d77f0 100%);
      color: #16131f;
      font-weight: 700;
      font-size: 11px;
      cursor: pointer;
      border: 0;
      box-shadow:
        0 0 12px rgba(237,172,244,0.55),
        0 2px 8px rgba(0,0,0,0.75);
      transition:
        transform 0.2s ease,
        box-shadow 0.2s ease,
        filter 0.2s ease;
    }
    #alarm-panel #alarm-save:hover {
      transform: translateY(-1px);
      filter: brightness(1.05);
      box-shadow:
        0 0 16px rgba(237,172,244,0.8),
        0 4px 14px rgba(0,0,0,0.9);
    }
    #alarm-panel #alarm-save:active {
      transform: translateY(0);
      box-shadow:
        0 0 10px rgba(237,172,244,0.6),
        0 2px 8px rgba(0,0,0,0.85);
    }

    #alarm-list {
      flex: 1;
      overflow-y: auto;
      font-size: 12px;
      border-top: 1px solid rgba(255,255,255,0.08);
      padding-top: 8px;
    }

    .alarm-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      border-bottom: 1px dashed rgba(255,255,255,0.06);
      transition: background 0.16s ease;
    }
    .alarm-row:last-child {
      border-bottom: none;
    }
    .alarm-row:hover {
      background: rgba(255,255,255,0.03);
    }

    .alarm-row strong {
      font-size: 12px;
    }
    .alarm-row .tag {
      opacity: 0.8;
      font-size: 11px;
      color: #c8b5ff;
      margin-right: 8px;
    }

    .alarm-row .kill {
      background: transparent;
      border: none;
      color: #ff7777;
      cursor: pointer;
      font-size: 13px;
      width: 20px;
      height: 20px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.16s ease, transform 0.16s ease;
    }
    .alarm-row .kill:hover {
      background: rgba(255,0,0,0.12);
      transform: scale(1.1);
    }

    #alarm-btn.glow {
      box-shadow: 0 0 12px rgba(237,172,244,0.9);
      filter: brightness(1.18);
    }

    @media (max-width: 480px) {
      #alarm-panel {
        right: 8px;
        left: 8px;
        width: auto;
        max-width: none;
      }
    }
  `;
  document.head.appendChild(style);

  // 🔔 Toast style: tiny SanctOS sheet that appears over the widget
  const toastStyle = document.createElement("style");
  toastStyle.textContent = `
    #widget {
      position: relative;
    }

    #widget #alarm-toast {
      position: absolute;
      top: 10px;
      right: 10px;
      max-width: 260px;

      padding: 8px 11px;
      border-radius: 10px;

      font-family: 'Courier New', monospace;
      font-size: 11px;
      color: #f7f2ff;

      background:
        radial-gradient(circle at 0 0,
          rgba(255,255,255,0.08) 0,
          transparent 40%),
        linear-gradient(145deg,#120f1c,#080610);
      border: 1px solid rgba(255,255,255,0.12);
      box-shadow:
        0 16px 40px rgba(0,0,0,0.95),
        0 0 0 1px rgba(157,119,240,0.18);

      opacity: 0;
      transform: translateY(-6px) scale(0.94);
      pointer-events: none;
      transition:
        opacity .2s ease-out,
        transform .2s ease-out;
      z-index: 60;
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    #widget #alarm-toast strong {
      background: linear-gradient(90deg,#edacf4,#9d77f0);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    #widget #alarm-toast.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }
  `;
  document.head.appendChild(toastStyle);

  document.getElementById("alarm-close").onclick = toggleAlarmPanel;
  document.getElementById("alarm-save").onclick = saveNewAlarm;

  populateAlarmDropdown();
  updateAlarmList();
  syncAlarmPanelWidth();
}

// === Inline alarm editor for a specific symbol (no browser prompt) ===
function openRowAlarmPrompt(symbol) {
  if (!symbol) return;
  if (!alarmPanel) createAlarmPanel();

  // Ensure dropdown is populated and select this symbol
  populateAlarmDropdown();

  const symSelect = document.getElementById("alarm-symbol");
  if (symSelect) {
    // If symbol isn't in the list (edge case), add it
    if (![...symSelect.options].some(o => o.value === symbol)) {
      const opt = document.createElement("option");
      opt.value = symbol;
      opt.textContent = symbol;
      symSelect.appendChild(opt);
    }
    symSelect.value = symbol;
  }

  // Prefill price, if we know it
  const priceInput = document.getElementById("alarm-price");
  if (priceInput) {
    const p = lastPrices[symbol] ?? tokenLastPrices[symbol];
    if (typeof p === "number" && !Number.isNaN(p)) {
      priceInput.value = p.toFixed(4);
    } else {
      priceInput.value = "";
    }
    // Tiny delay so CSS open transition doesn't eat the focus
    setTimeout(() => {
      priceInput.focus();
      priceInput.select();
    }, 40);
  }

  // Open the sheet over the widget
  alarmPanel.classList.add("open");
  syncAlarmPanelWidth();
}


// === Toggle Alarm Panel ===
function toggleAlarmPanel() {
  if (!alarmPanel) createAlarmPanel();
  alarmPanel.classList.toggle("open");
  if (alarmPanel.classList.contains("open")) {
    populateAlarmDropdown();
    updateAlarmList();
    syncAlarmPanelWidth();
  }
}

// === Populate Symbol Dropdown ===
function populateAlarmDropdown() {
  const dropdown = document.getElementById("alarm-symbol");
  if (!dropdown) return;
  dropdown.innerHTML = "";
  const symbols = [...tickers, ...tokenTickers];
  if (symbols.length === 0) {
    dropdown.innerHTML = `<option disabled>No tokens</option>`;
    return;
  }
  for (const s of symbols) {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    dropdown.appendChild(opt);
  }
}

// === Save New Alarm (panel form) ===
function saveNewAlarm() {
  const sym = document.getElementById("alarm-symbol").value;
  const dir = document.getElementById("alarm-dir").value;
  const price = parseFloat(document.getElementById("alarm-price").value);
  if (!sym || !dir || isNaN(price)) {
    alert("Please pick a token, direction and a valid price.");
    return;
  }
  if (!ALARMS[sym]) ALARMS[sym] = [];
  ALARMS[sym].push({ id: crypto.randomUUID(), dir, target: price, triggered: false });
  saveAlarms();
  updateAlarmList();
  document.getElementById("alarm-price").value = "";
  updateBellGlow();
}

// === Render Alarm List (multi per token) ===
function updateAlarmList() {
  const list = document.getElementById("alarm-list");
  if (!list) return;
  list.innerHTML = "";

  const entries = Object.entries(ALARMS).filter(([, arr]) => Array.isArray(arr) && arr.length);
  if (!entries.length) {
    list.innerHTML = `<div style="opacity:0.6;padding:12px;">No alarms set</div>`;
    updateBellGlow();
    return;
  }

  for (const [symbol, arr] of entries) {
    arr.forEach(a => {
      const row = document.createElement("div");
      row.className = "alarm-row";
      row.innerHTML = `
        <div><strong>${symbol}</strong></div>
        <div class="tag">${a.dir === "above" ? "↑ Above" : "↓ Below"} • $${a.target}</div>
        <button class="kill" data-sym="${symbol}" data-id="${a.id}">✕</button>
      `;
      row.querySelector(".kill").onclick = (e) => {
        const sym = e.target.dataset.sym;
        const id = e.target.dataset.id;
        if (!ALARMS[sym]) return;
        ALARMS[sym] = ALARMS[sym].filter(x => x.id !== id);
        if (ALARMS[sym].length === 0) delete ALARMS[sym];
        saveAlarms();
        updateAlarmList();
        updateBellGlow();
      };
      list.appendChild(row);
    });
  }
  updateBellGlow();
}

// === Save helper ===
function saveAlarms() {
  localStorage.setItem("hl_alarms", JSON.stringify(ALARMS));
}

// === Quick Add by Clicking a row (opens SanctOS-style sheet) ===
document.addEventListener("click", (e) => {
  const row = e.target.closest(".price");
  if (!row) return;

  // don’t open sheet when clicking the delete ❌
  if (e.target.closest(".remove-btn")) return;

  const symbol = row.querySelector(".symbol")?.textContent;
  if (!symbol) return;

  // ensure panel exists + open it
  createAlarmPanel();
  alarmPanel.classList.add("open");

  // refresh dropdown + preselect this symbol
  populateAlarmDropdown();

  const dropdown = document.getElementById("alarm-symbol");
  if (dropdown) {
    // if symbol already exists, select it; otherwise inject it at top
    let found = false;
    [...dropdown.options].forEach((opt) => {
      if (opt.value === symbol) {
        opt.selected = true;
        found = true;
      }
    });
    if (!found) {
      const opt = document.createElement("option");
      opt.value = symbol;
      opt.textContent = symbol;
      dropdown.insertBefore(opt, dropdown.firstChild);
      opt.selected = true;
    }
  }

  // pre-fill target with current price if we have it
  const priceInput = document.getElementById("alarm-price");
  if (priceInput) {
    const current =
      lastPrices[symbol] ??
      tokenLastPrices[symbol] ??
      null;

    if (typeof current === "number" && !Number.isNaN(current)) {
      priceInput.value = current.toFixed(4);
    } else {
      priceInput.value = "";
    }
    priceInput.focus();
    priceInput.select();
  }

  // default direction = "above" on quick click
  const dirSel = document.getElementById("alarm-dir");
  if (dirSel) dirSel.value = "above";
});

// === Trigger Alert ===
function triggerAlarm(symbol, alarm) {
  // 🔊 Gong only
  try {
    alarmGong.currentTime = 0; // restart from beginning
    alarmGong.play();
  } catch {}

  const el = [...document.querySelectorAll(".price")].find(p =>
    p.querySelector(".symbol")?.textContent === symbol
  );
  if (el) {
    const color = alarm.dir === "above" ? "#3aff7a" : "#ff5555";
    el.style.transition = "box-shadow 0.5s ease";
    el.style.boxShadow = `0 0 18px ${color}`;
    setTimeout(() => {
      el.style.boxShadow = "";
    }, 10000); // glow lasts 10s
  }

  // toast panel
  try {
    typeof showAlarmToast === "function" && showAlarmToast(symbol, alarm);
  } catch {}

  console.log(`🚨 ${symbol} ${alarm.dir.toUpperCase()} hit: $${alarm.target.toFixed(4)}`);
}

// === Alarm Checker (multi, above/below, persistent) ===
function checkAlarms() {
  const allPrices = { ...lastPrices, ...tokenLastPrices };

  for (const [symbol, arr] of Object.entries(ALARMS)) {
    if (!Array.isArray(arr) || !arr.length) continue;

    const price = allPrices[symbol];
    if (typeof price !== "number" || Number.isNaN(price)) continue;

    arr.forEach(a => {
      if (a.triggered) return; // already fired once

      const hit = a.dir === "above"
        ? price >= a.target
        : price <= a.target;

      if (hit) {
        triggerAlarm(symbol, a);
        a.triggered = true;
      }
    });
  }

  saveAlarms();
  updateBellGlow();
}

// === Bind + init ===
document.getElementById("alarm-btn")?.addEventListener("click", toggleAlarmPanel);
setInterval(checkAlarms, 5000);
updateBellGlow();

window.addEventListener("resize", syncAlarmPanelWidth);
setTimeout(syncAlarmPanelWidth, 50);
})(); // end SanctOS widget IIFE