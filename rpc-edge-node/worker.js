/**
 * SanctOS RPC Edge Node — DO-backed stats + health + dash
 *
 * - Proxies Solana JSON-RPC POSTs to upstream RPC(s)
 * - Caches safe read methods at the edge (Cache API)
 * - BYPASS writes + sensitive reads
 *
 * Adds:
 * - Durable Object SanctosStatsDO to persist counters across isolates
 * - GET /__sanctos_health for JSON health
 * - GET /dash for HTML dashboard
 * - GET /__sanctos_do_ping to confirm DO binding
 */

const DEFAULT_UPSTREAMS = ["https://api.mainnet-beta.solana.com"];
const WORKER_BUILD = "idx-tuned-v8-2025-12-27";

// -------------------------
// Instance identity (debug)
// -------------------------
let INSTANCE_ID = "";
function getInstanceId() {
  if (INSTANCE_ID) return INSTANCE_ID;
  try {
    INSTANCE_ID =
      (globalThis.crypto?.randomUUID && globalThis.crypto.randomUUID()) ||
      (Math.random().toString(36).slice(2) + Date.now().toString(36));
  } catch {
    INSTANCE_ID = "no-uuid";
  }
  return INSTANCE_ID;
}

// -------------------------
// RPC method policy
// -------------------------
const WRITE_METHODS = new Set([
  "sendTransaction",
  "sendRawTransaction",
  "simulateTransaction",
  "requestAirdrop",
]);

const SENSITIVE_METHODS = new Set(["getLatestBlockhash", "getSignatureStatuses"]);
const BYPASS_METHODS = new Set([...WRITE_METHODS, ...SENSITIVE_METHODS]);
const TTL = {
  getBlockHeight: 8,
  getSlot: 8,
  getSignaturesForAddress: 2,
  getTransaction: 60 * 60 * 24 * 3,
  getParsedTransaction: 60 * 60 * 24 * 3,
  getAccountInfo: 2,
  getMultipleAccounts: 6,
  getProgramAccounts: 5,
  getBalance: 6,
  getTokenAccountsByOwner: 10,
};


// inflightKey -> Promise<Payload>
const INFLIGHT = new Map();


// ✅ per-isolate inflight telemetry (dashboard expects these)
let INFLIGHT_CREATED = 0;
let INFLIGHT_JOINED = 0;
let INFLIGHT_MAX = 0;

// ============================================================================
// Durable Object: SanctosStatsDO
// Stores: totals, last60 buckets, method counts, last upstream info.
// ============================================================================
export class SanctosStatsDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.mem = null;
  }

  _dayKey(ts = Date.now()) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  _makeRateBuckets() {
    return { buckets: new Array(60).fill(0), stamps: new Array(60).fill(0) };
  }

  _bumpRate(rb, nowSec, inc = 1) {
    const i = nowSec % 60;
    if (rb.stamps[i] !== nowSec) {
      rb.stamps[i] = nowSec;
      rb.buckets[i] = 0;
    }
    rb.buckets[i] += inc;
  }

  _sumLast60(rb, nowSec) {
    let s = 0;
    for (let i = 0; i < 60; i++) {
      if (nowSec - rb.stamps[i] < 60) s += rb.buckets[i];
    }
    return s;
  }

  _seriesLast60(rb, nowSec) {
    const out = new Array(60).fill(0);
    for (let k = 0; k < 60; k++) {
      const sec = nowSec - (59 - k);
      const i = sec % 60;
      out[k] = rb.stamps[i] === sec ? rb.buckets[i] : 0;
    }
    return out;
  }

  async _load() {
    if (this.mem) return this.mem;
    const s = (await this.state.storage.get("stats")) || null;

    if (s) {
      this.mem = s;
      return this.mem;
    }

    // init
    this.mem = {
      startTime: Date.now(),

      totalRequests: 0,
      totalPostRequests: 0,

      cacheHits: 0,
      cacheMisses: 0,
      cacheBypass: 0,

      lastUpstreamOkAt: 0,
      lastUpstreamUrl: "",
      lastUpstreamName: "",
      lastUpstreamStatus: 0,
      lastUpstreamErrorAt: 0,
      lastUpstreamError: "",

      methodsAllTime: {},
      methodsByDay: {},

      traffic: {
        totals: { dashGet:0, healthGet:0, indexerGet:0, indexerPost:0, rpcPost:0, otherGet:0, otherPost:0 },
        rates: {
          dashGet: this._makeRateBuckets(),
          healthGet: this._makeRateBuckets(),
          indexerGet: this._makeRateBuckets(),
          indexerPost: this._makeRateBuckets(),
          rpcPost: this._makeRateBuckets(),
          otherGet: this._makeRateBuckets(),
          otherPost: this._makeRateBuckets(),
        },
      },
    };

    await this.state.storage.put("stats", this.mem);
    return this.mem;
  }

  async _save() {
    if (!this.mem) return;
    await this.state.storage.put("stats", this.mem);
  }

  _bump(obj, key, n = 1) {
    obj[key] = (obj[key] || 0) + n;
  }

  _pruneDays(daysObj, keep = 7) {
    const keys = Object.keys(daysObj).sort();
    if (keys.length <= keep) return;
    const drop = keys.slice(0, keys.length - keep);
    for (const k of drop) delete daysObj[k];
  }

  _ensureDay(s, day) {
    if (!s.methodsByDay[day]) s.methodsByDay[day] = {};
    return s.methodsByDay[day];
  }

  _buildTrafficViews(s, nowSec) {
    const rates = s.traffic?.rates || {};
    const totals = s.traffic?.totals || {};

    const lanes = [
      "dashGet",
      "healthGet",
      "indexerGet",
      "indexerPost",
      "rpcPost",
      "otherGet",
      "otherPost",
    ];

    const last60 = {};
    const series60 = {};

    for (const lane of lanes) {
      const rb = rates[lane] || this._makeRateBuckets();
      rates[lane] = rb;

      last60[lane] = this._sumLast60(rb, nowSec);
      series60[lane] = this._seriesLast60(rb, nowSec);
      totals[lane] = totals[lane] || 0;
    }

    s.traffic.totals = totals;
    s.traffic.rates = rates;

    return { totals, last60, series60 };
  }

  async _handleBump(req) {
    const s = await this._load();
    const body = await req.json().catch(() => ({}));
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // traffic
    if (body && body.type === "traffic") {
      this._bump(s, "totalRequests", 1);
      if (String(body.httpMethod || "").toUpperCase() === "POST") {
        this._bump(s, "totalPostRequests", 1);
      }

      const lane = String(body.lane || "otherGet");
      if (!s.traffic) s.traffic = { totals: {}, rates: {} };
      if (!s.traffic.totals) s.traffic.totals = {};
      if (!s.traffic.rates) s.traffic.rates = {};

      this._bump(s.traffic.totals, lane, 1);
      if (!s.traffic.rates[lane]) s.traffic.rates[lane] = this._makeRateBuckets();
      this._bumpRate(s.traffic.rates[lane], nowSec, 1);
    }

    // cache
    if (body && body.type === "cache") {
      const lane = String(body.lane || "");
      const n = Number(body.n || 1) || 1;
      if (lane === "hit") this._bump(s, "cacheHits", n);
      else if (lane === "miss") this._bump(s, "cacheMisses", n);
      else if (lane === "bypass") this._bump(s, "cacheBypass", n);
    }

    // methods
    if (body && body.type === "methods") {
      const methods = Array.isArray(body.methods) ? body.methods : [];
      const day = this._dayKey(body.ts || now);
      const perDay = this._ensureDay(s, day);

      for (const m of methods) {
        const k = String(m || "").trim();
        if (!k) continue;
        this._bump(s.methodsAllTime, k, 1);
        this._bump(perDay, k, 1);
      }

      this._pruneDays(s.methodsByDay, 10);
    }

    // upstream
    if (body && body.type === "upstream") {
      const ok = !!body.ok;
      const url = String(body.url || "");
      const status = Number(body.status || 0) || 0;
      const err = String(body.err || "");

      s.lastUpstreamUrl = url;
      s.lastUpstreamStatus = status;
      s.lastUpstreamName = String(body.name || "") || s.lastUpstreamName;

      if (ok) {
        s.lastUpstreamOkAt = body.ts || now;
        s.lastUpstreamError = "";
      } else {
        s.lastUpstreamErrorAt = body.ts || now;
        s.lastUpstreamError = err || `HTTP ${status || 0}`;
      }
    }

    await this._save();
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  async _handleGet() {
    const s = await this._load();
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const day = this._dayKey(now);

    const trafficView = this._buildTrafficViews(s, nowSec);

    const todayCounts = s.methodsByDay?.[day] || {};
    return new Response(
      JSON.stringify({
        startTime: s.startTime,

        totalRequests: s.totalRequests,
        totalPostRequests: s.totalPostRequests,

        cacheHits: s.cacheHits,
        cacheMisses: s.cacheMisses,
        cacheBypass: s.cacheBypass,

        lastUpstreamOkAt: s.lastUpstreamOkAt,
        lastUpstreamUrl: s.lastUpstreamUrl,
        lastUpstreamName: s.lastUpstreamName,
        lastUpstreamStatus: s.lastUpstreamStatus,
        lastUpstreamErrorAt: s.lastUpstreamErrorAt,
        lastUpstreamError: s.lastUpstreamError,

        traffic: {
          totals: trafficView.totals,
          last60: trafficView.last60,
          series60: trafficView.series60,
        },

        today: day,
        todayCounts,
        allTimeCounts: s.methodsAllTime || {},
        byDay: s.methodsByDay || {},
      }),
      { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();

    if (method === "GET" && path === "/ping") {
      const s = await this._load();
      return new Response(
        JSON.stringify({
          ok: true,
          class: "SanctosStatsDO",
          hasState: !!s,
          startTime: s.startTime,
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }
      );
    }

    if (method === "POST" && path === "/bump") return this._handleBump(request);
    if (method === "GET" && path === "/get") return this._handleGet();

    return new Response("Not Found", { status: 404 });
  }
}

function staleWindowSec(env) {
  const n = Number(env.SANCTOS_STALE_WINDOW || "60") || 60;
  return Math.max(0, n);
}
function staleFallbackEnabled(env) {
  return String(env.SANCTOS_STALE_FALLBACK_ON_ERROR || "1") === "1";
}
function numHeader(h, key) {
  const v = h.get(key);
  const n = v == null ? 0 : Number(v);
  return Number.isFinite(n) ? n : 0;
}


// -------------------------
// DO helpers
// -------------------------
function getStatsStub(env) {
  const id = env.SANCTOS_STATS.idFromName("global");
  return env.SANCTOS_STATS.get(id);
}



async function doBump(env, ctx, payload) {
  try {
    const stub = getStatsStub(env);
    ctx.waitUntil(
      stub.fetch("https://do/bump", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  } catch {}
}


async function doGet(env) {
  try {
    const stub = getStatsStub(env);
    const r = await stub.fetch("https://do/get", { method: "GET" });
    if (!r.ok) throw new Error(`DO /get HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    // ✅ fallback object so health still returns something useful
    return {
      startTime: Date.now(),
      totalRequests: 0,
      totalPostRequests: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheBypass: 0,
      lastUpstreamOkAt: 0,
      lastUpstreamUrl: "",
      lastUpstreamName: "",
      lastUpstreamStatus: 0,
      lastUpstreamErrorAt: Date.now(),
      lastUpstreamError: `doGet_failed: ${String(e?.message || e)}`,
      traffic: { totals: {}, last60: {}, series60: {} },
      today: "",
      todayCounts: {},
      allTimeCounts: {},
      byDay: {},
    };
  }
}

// -------------------------
// Redaction (do not leak keys)
// -------------------------
function redactUrl(u) {
  try {
    const url = new URL(u);
    ["api-key", "apikey", "key", "token"].forEach((k) => {
      if (url.searchParams.has(k)) url.searchParams.set(k, "REDACTED");
    });
    const parts = url.pathname.split("/").filter(Boolean);
    const redactedParts = parts.map((seg) => {
      if (/^[A-Za-z0-9_-]{16,}$/.test(seg)) return "REDACTED";
      if (/^[a-f0-9]{16,}$/i.test(seg)) return "REDACTED";
      return seg;
    });
    url.pathname = "/" + redactedParts.join("/");
    return url.toString();
  } catch {
    return String(u || "").replace(/(api-?key=)[^&]+/gi, "$1REDACTED");
  }
}

// -------------------------
// Upstream naming
// -------------------------
function detectProviderNameFromUrl(u) {
  try {
    const url = new URL(u);
    const h = (url.hostname || "").toLowerCase();
    if (h.includes("helius")) return "helius";
    if (h.includes("quicknode")) return "quicknode";
    if (h.includes("ankr")) return "ankr";
    if (h.includes("alchemy")) return "alchemy";
    if (h.includes("syndica")) return "syndica";
    if (h.includes("chainstack")) return "chainstack";
    return url.hostname || "upstream";
  } catch {
    return "upstream";
  }
}

function parseAliases(env) {
  const s = String(env.UPSTREAM_ALIASES || "").trim();
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function normalizeUpstreamUrl(u) {
  u = String(u || "").trim();
  if (!u || u === "quicknode" || u === "helius") return null;
  u = u.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
  if (u.startsWith("//")) u = "https:" + u;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try {
    return new URL(u).toString();
  } catch {
    return null;
  }
}

function getUpstreamList(env) {
  // preferred: UPSTREAM_SECRET_KEYS pointing to secrets
  const keyNames = String(env.UPSTREAM_SECRET_KEYS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const fromSecretKeys = keyNames.map((k) => normalizeUpstreamUrl(env[k])).filter(Boolean);
  if (fromSecretKeys.length) return fromSecretKeys;

  // back-compat
  const upstreams = String(env.UPSTREAMS || "")
    .split(",")
    .map((s) => normalizeUpstreamUrl(s))
    .filter(Boolean);

  return upstreams.length ? upstreams : DEFAULT_UPSTREAMS;
}

function computeUpstreamLabels(list, env) {
  const aliases = parseAliases(env);
  if (aliases.length) return list.map((u, i) => aliases[i] || `upstream ${i + 1}`);

  const counts = Object.create(null);
  return list.map((u) => {
    const base = detectProviderNameFromUrl(u);
    counts[base] = (counts[base] || 0) + 1;
    const n = counts[base];
    if (base === "upstream") return `upstream ${n}`;
    return `${base} ${n}`;
  });
}

function labelForUpstream(url, env) {
  const list = getUpstreamList(env);
  const labels = computeUpstreamLabels(list, env);
  const idx = list.indexOf(url);
  if (idx >= 0) return labels[idx];
  return detectProviderNameFromUrl(url);
}
// -------------------------
// CORS
// -------------------------
const DEFAULT_EXPOSE_HEADERS =
  "x-sanctos-cache," +
  "x-sanctos-upstream-name," +
  "x-sanctos-upstream-status," +
  "x-sanctos-upstream," +
  "x-sanctos-worker-build," +
  "x-sanctos-instance," +
  "x-sanctos-indexer," +
  "x-sanctos-indexer-status," +
  "x-sanctos-cached-at," +
  "x-sanctos-cache-ttl";

function parseAllowList(env) {
  return String(env.ALLOW_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickOrigin(request, env) {
  const allow = parseAllowList(env);
  const origin = request.headers.get("origin") || "";

  if (!origin) return "";
  if (allow.includes("*")) return origin;
  if (allow.includes(origin)) return origin;

  return "";
}

function parseExposeHeaders(env) {
  const raw = String(env.EXPOSE_HEADERS || "").trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = pickOrigin(request, env);
  if (!origin) return {};

  const reqHdrs =
    request.headers.get("access-control-request-headers") ||
    "content-type,accept,solana-client";

  const expose = parseExposeHeaders(env);
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": reqHdrs,
    "access-control-max-age": "86400",
    "access-control-expose-headers": expose.length ? expose.join(", ") : DEFAULT_EXPOSE_HEADERS,
    "vary": "Origin",
  };
}

function applyCors(res, request, env) {
  const h = corsHeaders(request, env);
  for (const [k, v] of Object.entries(h)) res.headers.set(k, v);

  if (!res.headers.get("access-control-expose-headers")) {
    const expose = String(env.EXPOSE_HEADERS || DEFAULT_EXPOSE_HEADERS).trim();
    if (expose) res.headers.set("access-control-expose-headers", expose);
  }

  res.headers.set("x-sanctos-instance", getInstanceId());
  return res;
}


function withSecurityHeaders(res, { isHtml = false } = {}) {
  const h = new Headers(res.headers);

  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");

  // Only safe if you're always on HTTPS with a real domain.
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

  if (isHtml) {
    // Your /dash uses inline <script>, so this CSP allows inline scripts.
    // If you later move JS to external files, remove 'unsafe-inline'.
    h.set(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    );
  }

  return new Response(res.body, { status: res.status, headers: h });
}


function json(request, env, obj, status = 200, extraHeaders = {}) {
  const res = new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
  return applyCors(res, request, env);
}

function stripUpstreamCorsHeaders(headers) {
  const out = new Headers(headers);
  const del = [];
  for (const [k] of out.entries()) {
    if (k.toLowerCase().startsWith("access-control-")) del.push(k);
  }
  for (const k of del) out.delete(k);
  out.delete("set-cookie");
  return out;
}

// -------------------------
// hashing helpers
// -------------------------
async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stableStringify(x) {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return "[" + x.map(stableStringify).join(",") + "]";
  const keys = Object.keys(x).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(x[k])).join(",") + "}";
}

function normalizedCalls(parsed) {
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  return calls.map((c) => ({ method: c?.method, params: c?.params ?? [] }));
}

function isRpcOkNoError(parsedResp) {
  const arr = Array.isArray(parsedResp) ? parsedResp : [parsedResp];
  return arr.every((x) => x && !x.error);
}

function isNullish(v) {
  return v === null || v === undefined;
}

function decideRpcCachePolicy(methods, parsedReq, parsedResp, baseTtl) {
  const reqCalls = Array.isArray(parsedReq) ? parsedReq : [parsedReq];
  const resCalls = Array.isArray(parsedResp) ? parsedResp : [parsedResp];
  const n = Math.min(reqCalls.length, resCalls.length);

  let ttl = Math.max(1, Number(baseTtl || 1) || 1);
  let reason = "ok";

  for (let i = 0; i < n; i++) {
    const m = String(methods[i] || reqCalls[i]?.method || "");
    const res = resCalls[i];

    if (res && res.error) return { cache: false, ttl: 0, reason: "rpc_error" };

    if ((m === "getTransaction" || m === "getParsedTransaction") && (isNullish(res?.result) || isNullish(res))) {
      ttl = Math.min(ttl, 1);
      reason = "incomplete_tx";
    }
  }

  return { cache: true, ttl, reason };
}

// ============================================================================
// Indexer proxy — optional. (You can keep your existing handleIndexer here.)
// For now: pass-through stub (routes exist but disabled unless configured).
// ============================================================================
function truthy(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
function getIndexerBase(env) {
  const u = String(env.INDEXER_URL || "").trim();
  return u ? u.replace(/\/+$/, "") : "";
}
function isIndexerEnabled(env) {
  if (String(env.INDEXER_ENABLED ?? "").trim() !== "") return truthy(env.INDEXER_ENABLED);
  return !!getIndexerBase(env);
}


function parseCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isMethodAllowed(method, env) {
  const allowed = parseCsv(env.INDEXER_ALLOWED_METHODS || "GET,HEAD,OPTIONS").map((m) =>
    m.toUpperCase()
  );
  return allowed.includes(String(method || "").toUpperCase());
}

function pickIndexerForwardHeaders(request) {
  // Strict forward: do NOT forward cookies/auth by default.
  const out = new Headers();
  const allow = new Set(["accept", "content-type", "user-agent"]);
  for (const [k, v] of request.headers.entries()) {
    const key = k.toLowerCase();
    if (allow.has(key)) out.set(key, v);
  }
  return out;
}
async function handleIndexer(request, env) {
  // Preflight
  if (request.method === "OPTIONS") {
    return applyCors(new Response(null, { status: 204 }), request, env);
  }

  if (!isIndexerEnabled(env)) {
    return json(request, env, { ok: false, error: "indexer_disabled" }, 503, {
      "x-sanctos-indexer": "disabled",
      "x-sanctos-worker-build": WORKER_BUILD,
    });
  }

  if (!isMethodAllowed(request.method, env)) {
    const res = new Response("Method not allowed", { status: 405 });
    res.headers.set("x-sanctos-worker-build", WORKER_BUILD);
    return applyCors(res, request, env);
  }

  const base = getIndexerBase(env);
  if (!base) {
    return json(request, env, { ok: false, error: "indexer_url_missing" }, 503, {
      "x-sanctos-indexer": "misconfigured",
      "x-sanctos-worker-build": WORKER_BUILD,
    });
  }

  // Optional strict path allowlist:
  // If you add env.INDEXER_ALLOWED_PATHS="/whoami,/threads", enforce it here
  const url = new URL(request.url);
  const rest = url.pathname.replace(/^\/indexer\b/, "") || "/";
  const allowedPaths = parseCsv(env.INDEXER_ALLOWED_PATHS || "");
  if (allowedPaths.length && !allowedPaths.includes(rest)) {
    const res = new Response("Not Found", { status: 404 });
    res.headers.set("x-sanctos-worker-build", WORKER_BUILD);
    return applyCors(res, request, env);
  }

  const target = base + rest + (url.search || "");

  // Timeout enforcement
  const timeoutMs = Math.max(250, Number(env.INDEXER_TIMEOUT_MS || 2500) || 2500);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort("indexer_timeout"), timeoutMs);

  try {
    const init = {
      method: request.method,
      headers: pickIndexerForwardHeaders(request),
      body:
        request.method === "POST" || request.method === "PUT" || request.method === "PATCH"
          ? await request.text()
          : undefined,
      signal: ac.signal,
    };

    const upstream = await fetch(target, init);

    const headers = stripUpstreamCorsHeaders(upstream.headers);

    // Tagging (avoid leaking full target if you don’t want to)
    headers.set("x-sanctos-indexer", base);
    headers.set("x-sanctos-indexer-status", String(upstream.status));
    headers.set("x-sanctos-worker-build", WORKER_BUILD);

    // Optional: do not cache indexer proxy at edge
    // headers.set("cache-control", "no-store");

    const out = new Response(upstream.body, { status: upstream.status, headers });
    return applyCors(out, request, env);
  } catch (e) {
    const res = new Response("Indexer upstream error", { status: 504 });
    res.headers.set("x-sanctos-indexer", base);
    res.headers.set("x-sanctos-indexer-status", "timeout_or_error");
    res.headers.set("x-sanctos-worker-build", WORKER_BUILD);
    return applyCors(res, request, env);
  } finally {
    clearTimeout(t);
  }
}

// ============================================================================
// Upstream fetch
// ============================================================================
async function fetchUpstream(env, bodyText, ctx) {
  const list = getUpstreamList(env);
  const headers = { "content-type": "application/json" };

  let lastRes = null;
  let lastUrl = "";

  for (const url of list) {
    lastUrl = url;
    try {
      const res = await fetch(url, { method: "POST", headers, body: bodyText });

      // record upstream to DO
      doBump(env, ctx, {
        type: "upstream",
        ok: res.ok,
        ts: Date.now(),
        url,
        name: labelForUpstream(url, env),
        status: res.status,
        err: res.ok ? "" : `HTTP ${res.status}`,
      });

      if (res.ok) return { res, url, ok: true };
      lastRes = res;
      continue;
    } catch (e) {
      doBump(env, ctx, {
        type: "upstream",
        ok: false,
        ts: Date.now(),
        url,
        name: labelForUpstream(url, env),
        status: 0,
        err: String(e?.message || e),
      });
      continue;
    }
  }

  if (lastRes) return { res: lastRes, url: lastUrl, ok: false };
  throw new Error("No upstream available");
}

function makeResponseFromText({
  status,
  bodyText,
  contentType,
  cacheControl,
  cacheTag,
  upstreamUrl,
  upstreamStatus,
  upstreamName,
}) {
  const headers = new Headers();
  headers.set("content-type", contentType || "application/json; charset=utf-8");
  if (cacheControl) headers.set("cache-control", cacheControl);
  if (cacheTag) headers.set("x-sanctos-cache", cacheTag);

  if (upstreamUrl) headers.set("x-sanctos-upstream", redactUrl(upstreamUrl));
  if (upstreamName) headers.set("x-sanctos-upstream-name", upstreamName);
  if (upstreamStatus != null) headers.set("x-sanctos-upstream-status", String(upstreamStatus));

  headers.set("x-sanctos-worker-build", WORKER_BUILD);
  return new Response(bodyText, { status, headers });
}

// ============================================================================
// Dashboard HTML (includes DIRECT indexer panel)
// ============================================================================
function dashHtml(origin) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SanctOS RPC Node — Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body {
      margin: 0;
      padding: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at 20% 0%, #18182a, #050510);
      color: #f7f4ff;
    }
    .page {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px 16px 40px;
      box-sizing: border-box;
    }
    .card {
      width: 100%;
      max-width: 980px;
      background: rgba(8, 8, 20, 0.92);
      border-radius: 18px;
      border: 1px solid rgba(237,172,244,0.35);
      box-shadow: 0 0 30px rgba(157,119,240,0.45);
      padding: 18px 20px 20px;
      box-sizing: border-box;
      backdrop-filter: blur(14px);
    }
    h1 {
      font-size: 20px;
      margin: 0 0 4px;
      letter-spacing: 0.03em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      border: 1px solid rgba(237,172,244,0.45);
      background: rgba(10,10,24,0.95);
    }
    .pill-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #22c55e;
    }
    .pill-dot.bad { background: #f97373; }
    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      font-size: 11px;
      opacity: 0.82;
      margin-bottom: 12px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .metric {
      padding: 12px 12px;
      border-radius: 14px;
      background: radial-gradient(circle at 0% 0%, rgba(237,172,244,0.18), rgba(6,6,16,0.95));
      border: 1px solid rgba(118,96,194,0.6);
      font-size: 12px;
    }
    .metric-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.7;
      margin-bottom: 6px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:8px;
    }
    .metric-value { font-size: 18px; font-weight: 700; line-height: 1.05; }
    .metric-sub { font-size: 11px; opacity: 0.75; margin-top: 6px; }
    .mono { font-family: "Courier New", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }

    .section {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(61,56,130,0.7);
    }
    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      opacity: 0.7;
      margin-bottom: 10px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:10px;
    }

    .bar {
      width: 100%;
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid rgba(237,172,244,0.25);
      background: rgba(10,10,24,0.65);
      display:flex;
    }
    .bar > div { height: 100%; }
    .legend {
      display:flex;
      flex-wrap:wrap;
      gap:8px;
      margin-top: 8px;
      font-size: 11px;
      opacity: 0.85;
    }
    .key {
      display:flex;
      align-items:center;
      gap:6px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid rgba(237,172,244,0.22);
      background: rgba(10,10,24,0.55);
    }
    .swatch {
      width: 10px; height: 10px; border-radius: 999px;
      background: #9d77f0;
      box-shadow: 0 0 10px rgba(157,119,240,0.35);
    }

    .sparkgrid {
      display:grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
      margin-top: 10px;
    }
    canvas.spark {
      width: 100%;
      height: 54px;
      border-radius: 12px;
      border: 1px solid rgba(118,96,194,0.55);
      background: rgba(10,10,24,0.55);
      display:block;
    }

    .upstream {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid rgba(61,56,130,0.7);
      font-size: 12px;
    }
    .upstream span.label {
      font-size: 11px;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .upstream-url {
      font-family: "Courier New", monospace;
      font-size: 11px;
      word-break: break-all;
      opacity: 0.92;
    }
    .error {
      color: #fecaca;
      font-size: 12px;
      margin-top: 6px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      margin-top: 8px;
    }
    th, td {
      padding: 8px 8px;
      border-bottom: 1px solid rgba(118,96,194,0.28);
      vertical-align: top;
    }
    th {
      text-align: left;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      opacity: 0.75;
    }
    tr:hover td { background: rgba(157,119,240,0.07); }

    .footer {
      margin-top: 10px;
      font-size: 11px;
      opacity: 0.6;
      text-align: right;
    }
    .orb {
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: radial-gradient(circle at 30% 20%, #edadf4, #9d77f0, #5de4ff);
      box-shadow: 0 0 14px rgba(157,119,240,0.9);
      flex-shrink: 0;
    }
    .smallmuted { opacity: 0.72; font-size: 11px; }
  </style>
</head>
<body>
<div class="page">
<div id="fatal"
     style="display:none; width:100%; max-width:980px; margin:0 auto 10px;
            padding:10px 12px; border-radius:12px;
            border:1px solid rgba(254,202,202,0.35);
            background: rgba(60, 10, 15, 0.55);
            color:#fecaca; font-size:12px;">
</div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
      <div>
        <h1><span class="orb"></span> SanctOS RPC Node</h1>
        <div class="meta-row">
          <span id="status-pill" class="pill">
            <span id="status-dot" class="pill-dot"></span>
            <span id="status-text">Loading…</span>
          </span>
          <span id="uptime" class="pill">Uptime: –</span>
          <span id="env-cache" class="pill">Cache: –</span>
          <span id="sticky" class="pill">Failover: –</span>
          <span id="instance" class="pill">Instance: –</span>
          <span id="build" class="pill">Build: –</span>
        </div>
      </div>
      <div style="font-size:11px; text-align:right; opacity:0.7;">
        <div>Endpoint:</div>
        <div class="mono" style="font-size:11px; word-break:break-all;">
          ${origin}
        </div>
      </div>
    </div>

    <div class="grid" style="margin-top:10px;">
      <div class="metric">
        <div class="metric-label">
          <span>HTTP Requests</span>
          <span class="smallmuted" id="m-http-rate">–/min</span>
        </div>
        <div class="metric-value" id="m-total">–</div>
        <div class="metric-sub" id="m-post">POST: –</div>
      </div>

      <div class="metric">
        <div class="metric-label">
          <span>RPC POST</span>
          <span class="smallmuted" id="m-rpc-rate">–/min</span>
        </div>
        <div class="metric-value" id="m-rpc">–</div>
        <div class="metric-sub" id="m-rpc-last60">Last 60s: –</div>
      </div>

      <div class="metric">
        <div class="metric-label">
          <span>Indexer (worker /indexer/*)</span>
          <span class="smallmuted" id="m-idx-rate">–/min</span>
        </div>
        <div class="metric-value" id="m-idx">–</div>
        <div class="metric-sub" id="m-idx-break">GET: – · POST: –</div>
      </div>

      <div class="metric">
        <div class="metric-label">
          <span>Self traffic</span>
          <span class="smallmuted" id="m-self-rate">–/min</span>
        </div>
        <div class="metric-value" id="m-self">–</div>
        <div class="metric-sub" id="m-self-break">/dash: – · /health: –</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        <span>Traffic composition</span>
        <span class="smallmuted">All-time totals</span>
      </div>

      <div class="bar" aria-label="traffic composition bar">
        <div id="bar-rpc" style="background: rgba(93,228,255,0.85);"></div>
        <div id="bar-indexer" style="background: rgba(157,119,240,0.85);"></div>
        <div id="bar-self" style="background: rgba(237,172,244,0.78);"></div>
        <div id="bar-other" style="background: rgba(148,163,184,0.70);"></div>
      </div>

      <div class="legend">
        <span class="key"><span class="swatch" style="background: rgba(93,228,255,0.95);"></span> RPC</span>
        <span class="key"><span class="swatch" style="background: rgba(157,119,240,0.95);"></span> Indexer</span>
        <span class="key"><span class="swatch" style="background: rgba(237,172,244,0.90);"></span> Self</span>
        <span class="key"><span class="swatch" style="background: rgba(148,163,184,0.90);"></span> Other</span>
      </div>

      <div class="sparkgrid">
        <div class="metric">
          <div class="metric-label"><span>RPC rate (last 60s)</span><span class="smallmuted" id="s-rpc-max">max –/s</span></div>
          <canvas class="spark" id="spark-rpc" width="800" height="120"></canvas>
          <div class="metric-sub" id="s-rpc-sum">Total last 60s: –</div>
        </div>
        <div class="metric">
          <div class="metric-label"><span>Indexer rate (last 60s)</span><span class="smallmuted" id="s-idx-max">max –/s</span></div>
          <canvas class="spark" id="spark-idx" width="800" height="120"></canvas>
          <div class="metric-sub" id="s-idx-sum">Total last 60s: –</div>
        </div>
        <div class="metric">
          <div class="metric-label"><span>Self rate (last 60s)</span><span class="smallmuted" id="s-self-max">max –/s</span></div>
          <canvas class="spark" id="spark-self" width="800" height="120"></canvas>
          <div class="metric-sub" id="s-self-sum">Total last 60s: –</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        <span>Cache + inflight</span>
        <span class="smallmuted">RPC caching only</span>
      </div>
      <div class="grid" style="margin-top:0;">
        <div class="metric">
          <div class="metric-label"><span>Cache hits</span></div>
          <div class="metric-value" id="m-cache-hits">–</div>
          <div class="metric-sub" id="m-cache-ratio">Hit ratio: –</div>
        </div>
        <div class="metric">
          <div class="metric-label"><span>Cache misses</span></div>
          <div class="metric-value" id="m-cache-miss">–</div>
          <div class="metric-sub" id="m-cache-bypass">Bypass: –</div>
        </div>
        <div class="metric">
          <div class="metric-label"><span>Inflight</span></div>
          <div class="metric-value" id="m-inflight">–</div>
          <div class="metric-sub" id="m-inflight-sub">Deduped RPC in flight</div>
        </div>
        <div class="metric">
          <div class="metric-label"><span>Last refresh</span></div>
          <div class="metric-value" id="last-refresh">–</div>
          <div class="metric-sub">Auto-refresh every <span id="refresh-interval">5</span>s</div>
        </div>
      </div>
    </div>

    <!-- ✅ NEW: Direct indexer status (polled from browser) -->
    <div class="section">
      <div class="section-title">
        <span>Indexer status (direct)</span>
        <span class="smallmuted" id="idx-last">–</span>
      </div>

      <div class="grid" style="margin-top:0;">
        <div class="metric">
          <div class="metric-label"><span>Endpoint</span></div>
          <div class="metric-value" style="font-size:12px; font-weight:700;">
            <span class="mono" id="idx-url">–</span>
          </div>
          <div class="metric-sub" id="idx-note">Direct (not via worker)</div>
        </div>

        <div class="metric">
          <div class="metric-label">
            <span>/whoami</span>
            <span class="smallmuted" id="idx-whoami-ms">–</span>
          </div>
          <div class="metric-value" id="idx-whoami-status">–</div>
          <div class="metric-sub mono" id="idx-whoami-meta">–</div>
        </div>

        <div class="metric">
          <div class="metric-label">
            <span>/threads</span>
            <span class="smallmuted" id="idx-threads-ms">–</span>
          </div>
          <div class="metric-value" id="idx-threads-status">–</div>
          <div class="metric-sub" id="idx-threads-meta">–</div>
        </div>

        <div class="metric">
          <div class="metric-label"><span>Errors</span></div>
          <div class="metric-value" id="idx-err-status">OK</div>
          <div class="metric-sub" id="idx-err-detail" style="color:#fecaca; display:none;"></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        <span>RPC Methods</span>
        <span class="smallmuted">Top talkers</span>
      </div>

      <div class="grid" style="margin-top:0;">
        <div class="metric">
          <div class="metric-label"><span>Today</span><span class="smallmuted" id="methods-today-date">–</span></div>
          <div class="smallmuted">Top 12</div>
          <table id="tbl-today">
            <thead><tr><th>Method</th><th style="text-align:right;">Count</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>

        <div class="metric">
          <div class="metric-label"><span>All-time</span><span class="smallmuted">Top 12</span></div>
          <table id="tbl-all">
            <thead><tr><th>Method</th><th style="text-align:right;">Count</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="upstream">
      <div><span class="label">Last upstream</span></div>
      <div id="upstream-status">–</div>
      <div id="upstream-name" style="margin-top:4px; font-weight:700;">–</div>
      <div id="upstream-url" class="upstream-url">–</div>
      <div id="upstream-error" class="error" style="display:none;"></div>
    </div>

    <div class="footer">
      If “Self traffic” is high, it’s your dashboard polling health. Close /dash to stop it.
    </div>
  </div>
</div>

<script>
(function() {
  const REFRESH_MS = 5000;

  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  const uptimeEl = document.getElementById("uptime");
  const envCacheEl = document.getElementById("env-cache");
  const stickyEl = document.getElementById("sticky");
  const instanceEl = document.getElementById("instance");
  const buildEl = document.getElementById("build");

  const mTotal = document.getElementById("m-total");
  const mPost = document.getElementById("m-post");

  const mRpc = document.getElementById("m-rpc");
  const mRpcLast60 = document.getElementById("m-rpc-last60");

  const mIdx = document.getElementById("m-idx");
  const mIdxBreak = document.getElementById("m-idx-break");

  const mSelf = document.getElementById("m-self");
  const mSelfBreak = document.getElementById("m-self-break");

  const mCacheHits = document.getElementById("m-cache-hits");
  const mCacheMiss = document.getElementById("m-cache-miss");
  const mCacheBypass = document.getElementById("m-cache-bypass");
  const mInflight = document.getElementById("m-inflight");
  const mInflightSub = document.getElementById("m-inflight-sub");
  const mCacheRatio = document.getElementById("m-cache-ratio");
  const lastRefreshEl = document.getElementById("last-refresh");

  const upstreamStatusEl = document.getElementById("upstream-status");
  const upstreamNameEl = document.getElementById("upstream-name");
  const upstreamUrlEl = document.getElementById("upstream-url");
  const upstreamErrorEl = document.getElementById("upstream-error");

  const barRpc = document.getElementById("bar-rpc");
  const barIndexer = document.getElementById("bar-indexer");
  const barSelf = document.getElementById("bar-self");
  const barOther = document.getElementById("bar-other");

  const sparkRpc = document.getElementById("spark-rpc");
  const sparkIdx = document.getElementById("spark-idx");
  const sparkSelf = document.getElementById("spark-self");

  const sRpcMax = document.getElementById("s-rpc-max");
  const sIdxMax = document.getElementById("s-idx-max");
  const sSelfMax = document.getElementById("s-self-max");
  const sRpcSum = document.getElementById("s-rpc-sum");
  const sIdxSum = document.getElementById("s-idx-sum");
  const sSelfSum = document.getElementById("s-self-sum");

  const mHttpRate = document.getElementById("m-http-rate");
  const mRpcRate = document.getElementById("m-rpc-rate");
  const mIdxRate = document.getElementById("m-idx-rate");
  const mSelfRate = document.getElementById("m-self-rate");

  const tblTodayBody = document.querySelector("#tbl-today tbody");
  const tblAllBody = document.querySelector("#tbl-all tbody");
  const methodsTodayDate = document.getElementById("methods-today-date");

  // Direct indexer panel
  const idxUrlEl = document.getElementById("idx-url");
  const idxLastEl = document.getElementById("idx-last");
  const idxWhoamiStatusEl = document.getElementById("idx-whoami-status");
  const idxWhoamiMsEl = document.getElementById("idx-whoami-ms");
  const idxWhoamiMetaEl = document.getElementById("idx-whoami-meta");
  const idxThreadsStatusEl = document.getElementById("idx-threads-status");
  const idxThreadsMsEl = document.getElementById("idx-threads-ms");
  const idxThreadsMetaEl = document.getElementById("idx-threads-meta");
  const idxErrStatusEl = document.getElementById("idx-err-status");
  const idxErrDetailEl = document.getElementById("idx-err-detail");

  function fmtSec(sec) {
    sec = sec || 0;
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m < 60) return m + "m " + s + "s";
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + "h " + mm + "m";
  }

  function topN(obj, n) {
    const arr = Object.entries(obj || {});
    arr.sort((a,b) => (b[1]||0) - (a[1]||0));
    return arr.slice(0, n);
  }

  function renderTable(tbody, rows) {
    tbody.innerHTML = "";
    for (const [k,v] of rows) {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      const td2 = document.createElement("td");
      td2.style.textAlign = "right";
      td1.textContent = k;
      td2.textContent = String(v);
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);
    }
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 2;
      td.className = "smallmuted";
      td.textContent = "No RPC methods seen yet.";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  function drawSpark(canvas, series) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0,0,w,h);

    let max = 0;
    for (const x of series) if (x > max) max = x;
    if (max < 1) max = 1;

    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "rgba(157,119,240,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 24);
    ctx.lineTo(w, h - 24);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.strokeStyle = "rgba(93,228,255,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < series.length; i++) {
      const x = (i / (series.length - 1)) * (w - 2) + 1;
      const y = h - 12 - (series[i] / max) * (h - 28);
      if (i === 0) ctx.moveTo(x,y);
      else ctx.lineTo(x,y);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.16;
    ctx.fillStyle = "rgba(93,228,255,1)";
    ctx.lineTo(w - 1, h - 12);
    ctx.lineTo(1, h - 12);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    return max;
  }

  function setBarWidths(rpc, idx, self, other) {
    const total = Math.max(1, rpc + idx + self + other);
    barRpc.style.width = (rpc / total * 100).toFixed(2) + "%";
    barIndexer.style.width = (idx / total * 100).toFixed(2) + "%";
    barSelf.style.width = (self / total * 100).toFixed(2) + "%";
    barOther.style.width = (other / total * 100).toFixed(2) + "%";
  }

  function nowTime() {
    return new Date().toLocaleTimeString();
  }

  async function timedJson(url) {
    const t0 = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    const ms = Math.round(performance.now() - t0);
    let json = null;
    try { json = await res.json(); } catch {}
    return { res, ms, json };
  }

  function showIdxError(msg) {
    idxErrStatusEl.textContent = "ERROR";
    idxErrDetailEl.style.display = "block";
    idxErrDetailEl.textContent = msg;
  }

  function clearIdxError() {
    idxErrStatusEl.textContent = "OK";
    idxErrDetailEl.style.display = "none";
    idxErrDetailEl.textContent = "";
  }

  async function refreshIndexer(idxBase) {
    try {
      clearIdxError();
      idxUrlEl.textContent = idxBase;

      const base = idxBase.replace(/\\/+$/, "");

      const who = await timedJson(base + "/whoami");
      idxWhoamiMsEl.textContent = who.ms + "ms";
      idxWhoamiStatusEl.textContent = "HTTP " + who.res.status;

      if (who.json) {
        const meta = [];
        if (who.json.service) meta.push("service=" + who.json.service);
        if (who.json.build) meta.push("build=" + who.json.build);
        if (who.json.buildTag) meta.push("buildTag=" + who.json.buildTag);
        if (who.json.instance) meta.push("instance=" + who.json.instance);
        if (who.json.ok === false) meta.push("ok=false");
        idxWhoamiMetaEl.textContent = meta.length ? meta.join(" · ") : JSON.stringify(who.json).slice(0, 140);
      } else {
        idxWhoamiMetaEl.textContent = "No JSON body";
      }

      const thr = await timedJson(base + "/threads");
      idxThreadsMsEl.textContent = thr.ms + "ms";
      idxThreadsStatusEl.textContent = "HTTP " + thr.res.status;

      if (thr.json) {
        const list = Array.isArray(thr.json) ? thr.json :
                     Array.isArray(thr.json.threads) ? thr.json.threads :
                     Array.isArray(thr.json.items) ? thr.json.items : null;
        const n = list ? list.length : null;
        idxThreadsMetaEl.textContent =
          (n != null ? ("threads=" + n) : "shape=unknown") +
          (thr.json.ok === false ? " · ok=false" : "");
      } else {
        idxThreadsMetaEl.textContent = "No JSON body";
      }

      idxLastEl.textContent = nowTime();
    } catch (e) {
      showIdxError(String(e && e.message ? e.message : e));
      idxLastEl.textContent = nowTime();
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/__sanctos_health", { cache: "no-store", headers: { "x-sanctos-internal": "dash" } });

      const data = await res.json();

      const inst = res.headers.get("x-sanctos-instance") || "n/a";
      const build = res.headers.get("x-sanctos-worker-build") || data?.env?.workerBuild || "n/a";
      instanceEl.textContent = "Instance: " + inst;
      buildEl.textContent = "Build: " + build;

      const ok = data && data.status === "ok";
      statusDot.classList.toggle("bad", !ok);
      statusText.textContent = ok ? "Healthy" : "Degraded";

      const uptimeSec = data?.uptimeSec ?? 0;
      uptimeEl.textContent = "Uptime: " + fmtSec(uptimeSec);

      const cacheAll = data?.env?.cacheAll;
      const defaultTTL = data?.env?.defaultTTL;
      envCacheEl.textContent = "Cache: " + (cacheAll ? "Aggressive" : "Selective") + " · TTL " + defaultTTL + "s";

      const sticky = data?.stats?.sticky;
      stickyEl.textContent = sticky?.active ? "Failover: ON" : "Failover: OFF";

      const stats = data.stats || {};
      const total = stats.totalRequests || 0;
      const post = stats.totalPostRequests || 0;

      mTotal.textContent = total;
      mPost.textContent = "POST: " + post;

      const t = stats?.traffic?.totals || {};
      const dashGet = t.dashGet || 0;
      const healthGet = t.healthGet || 0;
      const idxGet = t.indexerGet || 0;
      const idxPost = t.indexerPost || 0;
      const rpcPost = t.rpcPost || 0;
      const otherGet = t.otherGet || 0;
      const otherPost = t.otherPost || 0;

      const self = dashGet + healthGet;
      const idx = idxGet + idxPost;
      const other = otherGet + otherPost;

      mRpc.textContent = rpcPost;
      mIdx.textContent = idx;
      mIdxBreak.textContent = "GET: " + idxGet + " · POST: " + idxPost;

      mSelf.textContent = self;
      mSelfBreak.textContent = "/dash: " + dashGet + " · /health: " + healthGet;

      setBarWidths(rpcPost, idx, self, other);

      const last60 = stats?.traffic?.last60 || {};
      const rpc60 = last60.rpcPost || 0;
      const idx60 = (last60.indexerGet || 0) + (last60.indexerPost || 0);
      const self60 = (last60.dashGet || 0) + (last60.healthGet || 0);
      const http60 = rpc60 + idx60 + self60 + (last60.otherGet || 0) + (last60.otherPost || 0);

      mRpcLast60.textContent = "Last 60s: " + rpc60;

      mHttpRate.textContent = http60 + "/min";
      mRpcRate.textContent = rpc60 + "/min";
      mIdxRate.textContent = idx60 + "/min";
      mSelfRate.textContent = self60 + "/min";

      const series = stats?.traffic?.series60 || {};
      const rpcSer = series.rpcPost || [];
      const idxSer = (series.indexerGet || []).map((v,i) => v + ((series.indexerPost||[])[i]||0));
      const selfSer = (series.dashGet || []).map((v,i) => v + ((series.healthGet||[])[i]||0));

      const rpcMax = drawSpark(sparkRpc, rpcSer.length ? rpcSer : new Array(60).fill(0));
      const idxMax = drawSpark(sparkIdx, idxSer.length ? idxSer : new Array(60).fill(0));
      const selfMax = drawSpark(sparkSelf, selfSer.length ? selfSer : new Array(60).fill(0));

      sRpcMax.textContent = "max " + rpcMax + "/s";
      sIdxMax.textContent = "max " + idxMax + "/s";
      sSelfMax.textContent = "max " + selfMax + "/s";

      sRpcSum.textContent = "Total last 60s: " + rpc60;
      sIdxSum.textContent = "Total last 60s: " + idx60;
      sSelfSum.textContent = "Total last 60s: " + self60;

      const hits = stats.cacheHits || 0;
      const miss = stats.cacheMisses || 0;
      const bypass = stats.cacheBypass || 0;
      const inflight = stats.inflightEntries || 0;

      mCacheHits.textContent = hits;
      mCacheMiss.textContent = miss;
      mCacheBypass.textContent = "Bypass: " + bypass;
      mInflight.textContent = inflight;

      const joined = stats.inflightJoined || 0;
      const created = stats.inflightCreated || 0;
      const max = stats.inflightMax || 0;
      if (mInflightSub) {
        mInflightSub.textContent = "Joined: " + joined + " · Created: " + created + " · Max: " + max;
      }

      const denom = hits + miss || 1;
      const ratio = (hits / denom) * 100;
      mCacheRatio.textContent = "Hit ratio: " + ratio.toFixed(1) + "%";

      const lastUrl = stats.lastUpstreamUrl || "–";
      const lastName = stats.lastUpstreamName || "–";
      const lastStatus = stats.lastUpstreamStatus || 0;
      const lastErr = stats.lastUpstreamError || "";

      upstreamStatusEl.textContent = "Status: " + (lastStatus || "n/a");
      upstreamNameEl.textContent = lastName;
      upstreamUrlEl.textContent = lastUrl;

      if (lastErr) {
        upstreamErrorEl.style.display = "block";
        upstreamErrorEl.textContent = "Last upstream error: " + lastErr;
      } else {
        upstreamErrorEl.style.display = "none";
      }

      const methods = data.methods || {};
      const today = methods.today || "–";
      methodsTodayDate.textContent = today;

      renderTable(tblTodayBody, topN(methods.todayCounts || {}, 12));
      renderTable(tblAllBody, topN(methods.allTimeCounts || {}, 12));

      // ✅ Poll indexer directly (requires indexer CORS allowing this origin)
      const idxBase = (data && data.env && data.env.indexerUrl) ? data.env.indexerUrl : "https://indexer.sanctos.app";
      await refreshIndexer(idxBase);

      lastRefreshEl.textContent = new Date().toLocaleTimeString();
    } catch (e) {
      statusDot.classList.add("bad");
      statusText.textContent = "Health fetch failed";
      upstreamErrorEl.style.display = "block";
      upstreamErrorEl.textContent = "Health fetch error: " + String(e);
      lastRefreshEl.textContent = new Date().toLocaleTimeString();
    }
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
})();
</script>
</body>
</html>`;
}
// ============================================================================
// JSON-RPC handler
// ============================================================================
async function handleRpc(request, env, ctx) {
  if (request.method === "OPTIONS") {
    return applyCors(new Response(null, { status: 204 }), request, env);
  }

  if (request.method !== "POST") {
    const res = new Response("SanctOS RPC Edge Node. POST JSON-RPC only.\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    return applyCors(res, request, env);
  }

  let bodyText = "";
  try {
    bodyText = await request.text();
  } catch {
    return json(request, env, { error: "Unable to read request body" }, 400);
  }
  if (!bodyText) return json(request, env, { error: "Empty body" }, 400);

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return json(request, env, { error: "Invalid JSON" }, 400);
  }

  const calls = Array.isArray(parsed) ? parsed : [parsed];
  const methods = calls.map((c) => c && c.method).filter(Boolean);

  // record methods to DO
  if (methods.length) {
    doBump(env, ctx, { type: "methods", ts: Date.now(), methods });
  }

  const aggressive = env.SANCTOS_CACHE_ALL === "1";
  const defaultTTL = Number(env.SANCTOS_DEFAULT_TTL || "2") || 2;

  function isCacheableMethod(method) {
    if (!method || typeof method !== "string") return false;
    if (BYPASS_METHODS.has(method)) return false;
    if (Object.prototype.hasOwnProperty.call(TTL, method)) return true;
    return aggressive;
  }

  const cacheable = methods.length && methods.every(isCacheableMethod);

  if (!cacheable) {
    doBump(env, ctx, { type: "cache", lane: "bypass", n: 1 });

    try {
      const { res: upstreamRes, url } = await fetchUpstream(env, bodyText, ctx);
      const headers = stripUpstreamCorsHeaders(upstreamRes.headers);

      headers.set("x-sanctos-cache", "BYPASS");
      headers.set("x-sanctos-upstream", redactUrl(url));
      headers.set("x-sanctos-upstream-name", labelForUpstream(url, env));
      headers.set("x-sanctos-upstream-status", String(upstreamRes.status));
      headers.set("x-sanctos-worker-build", WORKER_BUILD);

      if (!headers.get("content-type")) headers.set("content-type", "application/json; charset=utf-8");

      const out = new Response(upstreamRes.body, { status: upstreamRes.status, headers });
      return applyCors(out, request, env);
    } catch (e) {
      return json(request, env, { error: String(e?.message || e) }, 502, {
        "x-sanctos-cache": "BYPASS-UPSTREAM-FAIL",
        "x-sanctos-worker-build": WORKER_BUILD,
      });
    }
  }

  // --------------------------------------------------------------------------
  // cache key: stable across different caller "id"/"jsonrpc"; normalize params
  // --------------------------------------------------------------------------
  function normalizeForCacheKey(p) {
    const arr = Array.isArray(p) ? p : [p];
    return arr.map((c) => {
      const method = (c && typeof c.method === "string") ? c.method : "";
      const params = (c && Object.prototype.hasOwnProperty.call(c, "params")) ? c.params : [];
      return { method, params };
    });
  }

  let keyHash;
  try {
    const keyObj = normalizeForCacheKey(parsed);
    keyHash = await sha256Hex(stableStringify(keyObj));
  } catch {
    doBump(env, ctx, { type: "cache", lane: "bypass", n: 1 });
    const { res: upstreamRes, url } = await fetchUpstream(env, bodyText, ctx);
    const headers = stripUpstreamCorsHeaders(upstreamRes.headers);
    headers.set("x-sanctos-cache", "BYPASS-HASHFAIL");
    headers.set("x-sanctos-upstream", redactUrl(url));
    headers.set("x-sanctos-upstream-name", labelForUpstream(url, env));
    headers.set("x-sanctos-upstream-status", String(upstreamRes.status));
    headers.set("x-sanctos-worker-build", WORKER_BUILD);
    const out = new Response(upstreamRes.body, { status: upstreamRes.status, headers });
    return applyCors(out, request, env);
  }

  const cacheKeyUrl = new URL(request.url);
  cacheKeyUrl.pathname = "/__cache__v8";
  cacheKeyUrl.searchParams.set("k", keyHash);
  const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });

  const inflightKey = cacheKey.url;
  const cache = caches.default;

  // HIT (with stale-while-revalidate)
  const cached = await cache.match(cacheKey);
  let staleFallback = null;

  if (cached) {
    const cachedClone = cached.clone();

    const cachedAt = numHeader(cachedClone.headers, "x-sanctos-cached-at");   // ms
    const cachedTtl = numHeader(cachedClone.headers, "x-sanctos-cache-ttl");  // seconds

    const ageSec = cachedAt ? (Date.now() - cachedAt) / 1000 : 0;
    const swr = staleWindowSec(env);
    const hasMeta = !!(cachedAt && cachedTtl);

    // Fresh HIT (or old entries missing meta)
    if (!hasMeta || ageSec <= cachedTtl) {
      doBump(env, ctx, { type: "cache", lane: "hit", n: 1 });

      const headers = new Headers(cachedClone.headers);
      headers.set("x-sanctos-cache", "HIT");
      headers.set("x-sanctos-worker-build", WORKER_BUILD);

      const out = new Response(cachedClone.body, { status: cachedClone.status, headers });
      return applyCors(out, request, env);
    }

    // Stale but within SWR window: serve stale + background revalidate
    if (ageSec <= cachedTtl + swr) {
      doBump(env, ctx, { type: "cache", lane: "hit", n: 1 });

      const revalKey = "reval:" + inflightKey;
      if (!INFLIGHT.has(revalKey)) {
        const reval = (async () => {
          try {
            const { res: upstreamRes, url } = await fetchUpstream(env, bodyText, ctx);

            const upstreamStatus = upstreamRes.status;
            const contentType =
              upstreamRes.headers.get("content-type") || "application/json; charset=utf-8";
            const body = await upstreamRes.text();

            // Recompute ttl same as MISS path
            const ttls = methods
              .map((m) => {
                if (BYPASS_METHODS.has(m)) return 0;
                if (Object.prototype.hasOwnProperty.call(TTL, m)) return TTL[m];
                return aggressive ? defaultTTL : 0;
              })
              .filter((n) => n > 0);

            const ttl = ttls.length ? Math.min(...ttls) : 1;

            if (upstreamStatus === 200) {
              try {
                const parsedResp = JSON.parse(body);
                if (isRpcOkNoError(parsedResp)) {
                  const policy = decideRpcCachePolicy(methods, parsed, parsedResp, ttl);
                  if (policy.cache) {
                    const swrWin = staleWindowSec(env);
                    const storeTtl = Math.max(1, Math.min(3600, policy.ttl + swrWin));

                    const cacheResp = makeResponseFromText({
                      status: upstreamStatus,
                      bodyText: body,
                      contentType,
                      cacheControl: `public, max-age=${storeTtl}`,
                    });

                    cacheResp.headers.set("x-sanctos-cached-at", String(Date.now()));
                    cacheResp.headers.set("x-sanctos-cache-ttl", String(policy.ttl));

                    await cachePutWithDebug(env, ctx, cache, cacheKey, cacheResp);
                  }
                }
              } catch {
                // ignore reval parse/cache failures
              }
            }
          } catch {
            // ignore reval failures
          }
        })();

        INFLIGHT.set(revalKey, reval);
        reval.finally(() => {
          if (INFLIGHT.get(revalKey) === reval) INFLIGHT.delete(revalKey);
        });

        ctx.waitUntil(reval);
      }

      const headers = new Headers(cachedClone.headers);
      headers.set("x-sanctos-cache", "STALE");
      headers.set("x-sanctos-worker-build", WORKER_BUILD);

      const out = new Response(cachedClone.body, { status: cachedClone.status, headers });
      return applyCors(out, request, env);
    }

    // Too old to serve as SWR; keep as fallback if upstream fails
    if (staleFallbackEnabled(env)) {
      staleFallback = cachedClone;
    }
  }

  // MISS (inflight dedupe)
  if (!INFLIGHT.has(inflightKey)) {
    INFLIGHT_CREATED += 1;

    const afterSize = INFLIGHT.size + 1;
    if (afterSize > INFLIGHT_MAX) INFLIGHT_MAX = afterSize;

    doBump(env, ctx, { type: "cache", lane: "miss", n: 1 });

    const prom = (async () => {
      const { res: upstreamRes, url } = await fetchUpstream(env, bodyText, ctx);

      const upstreamStatus = upstreamRes.status;
      const contentType =
        upstreamRes.headers.get("content-type") || "application/json; charset=utf-8";
      const body = await upstreamRes.text();

      const ttls = methods
        .map((m) => {
          if (BYPASS_METHODS.has(m)) return 0;
          if (Object.prototype.hasOwnProperty.call(TTL, m)) return TTL[m];
          return aggressive ? defaultTTL : 0;
        })
        .filter((n) => n > 0);

      const ttl = ttls.length ? Math.min(...ttls) : 1;

      return {
        upstreamUrl: url,
        upstreamName: labelForUpstream(url, env),
        upstreamStatus,
        status: upstreamStatus,
        contentType,
        ttl,
        bodyText: body,
      };
    })();

    INFLIGHT.set(inflightKey, prom);
    prom.finally(() => {
      if (INFLIGHT.get(inflightKey) === prom) INFLIGHT.delete(inflightKey);
    });
  } else {
    INFLIGHT_JOINED += 1;
  }

  let payload;
  try {
    payload = await INFLIGHT.get(inflightKey);
  } catch (e) {
    if (staleFallback) {
      const headers = new Headers(staleFallback.headers);
      headers.set("x-sanctos-cache", "STALE-FALLBACK");
      headers.set("x-sanctos-worker-build", WORKER_BUILD);
      const out = new Response(staleFallback.body, { status: staleFallback.status, headers });
      return applyCors(out, request, env);
    }

    return json(request, env, { error: String(e?.message || e) }, 502, {
      "x-sanctos-cache": "MISS-UPSTREAM-FAIL",
      "x-sanctos-worker-build": WORKER_BUILD,
    });
  }

  const resp = makeResponseFromText({
    status: payload.status,
    bodyText: payload.bodyText,
    contentType: payload.contentType,
    cacheControl: `public, max-age=${payload.ttl}`, // client-facing freshness
    cacheTag: "MISS",
    upstreamUrl: payload.upstreamUrl,
    upstreamName: payload.upstreamName,
    upstreamStatus: payload.upstreamStatus,
  });

  if (payload.status === 200) {
    try {
      const parsedResp = JSON.parse(payload.bodyText);

      if (!isRpcOkNoError(parsedResp)) {
        resp.headers.set("x-sanctos-cache", "MISS-NOCACHE-RPCERROR");
      } else {
        const policy = decideRpcCachePolicy(methods, parsed, parsedResp, payload.ttl);

        if (!policy.cache) {
          resp.headers.set("x-sanctos-cache", "MISS-NOCACHE-POLICY");
        } else {
          // Store longer than "fresh" TTL so SWR works.
          const swrWin = staleWindowSec(env);
          const storeTtl = Math.max(1, Math.min(3600, policy.ttl + swrWin));

          const cacheResp = makeResponseFromText({
            status: payload.status,
            bodyText: payload.bodyText,
            contentType: payload.contentType,
            cacheControl: `public, max-age=${storeTtl}`,
          });

          cacheResp.headers.set("x-sanctos-cached-at", String(Date.now()));
          cacheResp.headers.set("x-sanctos-cache-ttl", String(policy.ttl));

          await cachePutWithDebug(env, ctx, cache, cacheKey, cacheResp);

          if (policy.reason === "incomplete_tx") {
            resp.headers.set("x-sanctos-cache", "MISS-CACHED-SHORT-INCOMPLETE");
          }
        }
      }
    } catch {
      resp.headers.set("x-sanctos-cache", "MISS-NOCACHE-NONJSON");
    }
  } else {
    resp.headers.set("x-sanctos-cache", "MISS-NOCACHE-HTTPERR");
  }

  resp.headers.set("x-sanctos-worker-build", WORKER_BUILD);
  return applyCors(resp, request, env);
}

// Single canonical cache writer (NO DUPLICATES)
async function cachePutWithDebug(env, ctx, cache, cacheKey, cacheResp) {
  const doPut = async () => {
    await cache.put(cacheKey, cacheResp.clone());
  };

  if (String(env.SANCTOS_CACHE_SYNC_WRITE || "") === "1") {
    try { await doPut(); } catch {}
    return;
  }

  ctx.waitUntil((async () => { try { await doPut(); } catch {} })());
}


// ============================================================================
// Worker entry
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();
      // -------------------------
      // ✅ GLOBAL CORS preflight (covers /watch + any other route)
      // -------------------------
      if (method === "OPTIONS") {
        return applyCors(new Response(null, { status: 204 }), request, env);
      }

      // -------------------------
      // DO ping (debug)
      // -------------------------
      if (method === "GET" && path === "/__sanctos_do_ping") {
        const stub = getStatsStub(env);
        const r = await stub.fetch("https://do/ping", { method: "GET" });
        const j = await r.json();
        return json(request, env, { ok: true, do: j }, 200, {
          "x-sanctos-worker-build": WORKER_BUILD,
        });
      }

      // -------------------------
      // Route-aware counting (to DO)
      // -------------------------
      if (method !== "OPTIONS") {
        const internal = (request.headers.get("x-sanctos-internal") || "").toLowerCase() === "dash";

        const isHealth = method === "GET" && (path === "/health" || path === "/__sanctos_health");
        const isDash = (method === "GET" || method === "HEAD") && path === "/dash";
        const isIndexer = path === "/indexer" || path.startsWith("/indexer/");
        const isRpcRootPost = method === "POST" && path === "/";

        let lane = method === "POST" ? "otherPost" : "otherGet";
        if (isDash) lane = "dashGet";
        else if (isHealth) lane = "healthGet";
        else if (isIndexer) lane = method === "POST" ? "indexerPost" : "indexerGet";
        else if (isRpcRootPost) lane = "rpcPost";

        if (!internal) {
          doBump(env, ctx, { type: "traffic", ts: Date.now(), lane, httpMethod: method });
        }
      }


      // Indexer proxy routes
      if (path === "/indexer" || path.startsWith("/indexer/")) {
        return await handleIndexer(request, env);
      }

      // Health JSON (DO-backed)
      if (method === "GET" && (path === "/health" || path === "/__sanctos_health")) {
        const s = await doGet(env);

        const uptimeSec = Math.floor((Date.now() - (s.startTime || Date.now())) / 1000);
        const upstreamList = getUpstreamList(env);
        const upstreamLabels = computeUpstreamLabels(upstreamList, env);

        const payload = {
          status: "ok",
          uptimeSec,
          env: {
            workerBuild: WORKER_BUILD,
            cacheAll: env.SANCTOS_CACHE_ALL === "1",
            defaultTTL: Number(env.SANCTOS_DEFAULT_TTL || "2") || 2,
            upstreams: upstreamLabels,
            upstreamUrlsRedacted: upstreamList.map(redactUrl),
            indexerUrl: getIndexerBase(env) || "https://indexer.sanctos.app",
            indexerEnabled: isIndexerEnabled(env),
          },
          stats: {
            totalRequests: s.totalRequests || 0,
            totalPostRequests: s.totalPostRequests || 0,
            cacheHits: s.cacheHits || 0,
            cacheMisses: s.cacheMisses || 0,
            cacheBypass: s.cacheBypass || 0,
            inflightEntries: INFLIGHT.size,
            inflightJoined: INFLIGHT_JOINED,
            inflightCreated: INFLIGHT_CREATED,
            inflightMax: INFLIGHT_MAX,

            lastUpstreamOkAt: s.lastUpstreamOkAt || 0,
            lastUpstreamUrl: redactUrl(s.lastUpstreamUrl || ""),
            lastUpstreamName: s.lastUpstreamName || "",
            lastUpstreamStatus: s.lastUpstreamStatus || 0,
            lastUpstreamErrorAt: s.lastUpstreamErrorAt || 0,
            lastUpstreamError: s.lastUpstreamError || "",

            traffic: {
              totals: (s.traffic && s.traffic.totals) ? s.traffic.totals : {},
              last60: (s.traffic && s.traffic.last60) ? s.traffic.last60 : {},
              series60: (s.traffic && s.traffic.series60) ? s.traffic.series60 : {},
            },
          },
          methods: {
            today: s.today || "",
            todayCounts: s.todayCounts || {},
            allTimeCounts: s.allTimeCounts || {},
            byDay: s.byDay || {},
          },
        };

        const res = json(request, env, payload, 200, {
          "x-sanctos-health": "1",
          "x-sanctos-worker-build": WORKER_BUILD,
        });
        return res; // ✅ REQUIRED
      }


      // Dashboard HTML (+ HEAD)
      if ((method === "GET" || method === "HEAD") && path === "/dash") {
        const origin = new URL(request.url).origin;
        const html = dashHtml(origin);
        const res = new Response(method === "HEAD" ? null : html, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
        res.headers.set("x-sanctos-worker-build", WORKER_BUILD);
        return applyCors(withSecurityHeaders(res, { isHtml: true }), request, env);
      }

      // Default: RPC handler
      return await handleRpc(request, env, ctx);
    } catch (e) {
      try {
        const res = new Response("Worker error: " + String(e?.message || e), { status: 500 });
        return applyCors(res, request, env);
      } catch {
        return new Response("Worker error", { status: 500 });
      }
    }
  },
};
