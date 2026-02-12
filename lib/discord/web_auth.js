const crypto = require("crypto");
const { encryptString, decryptString } = require("../crypto/secrets");

const SESSION_COOKIE = "vine_web_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
const OAUTH_STATE_TTL_SEC = 60 * 10; // 10 minutes

let kvClient;

function getKV() {
  if (kvClient !== undefined) return kvClient;
  try {
    kvClient = require("@vercel/kv").kv;
  } catch {
    kvClient = null;
  }
  return kvClient;
}

function sessionKey(sessionId) {
  return `vine:web:session:${sessionId}`;
}

function stateKey(state) {
  return `vine:web:oauth_state:${state}`;
}

function parseCookies(req) {
  const raw = req?.headers?.cookie || "";
  const out = {};

  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(value);
  }

  return out;
}

function appendSetCookie(res, cookieValue) {
  const prev = res.getHeader("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", cookieValue);
    return;
  }

  if (Array.isArray(prev)) {
    res.setHeader("Set-Cookie", [...prev, cookieValue]);
    return;
  }

  res.setHeader("Set-Cookie", [prev, cookieValue]);
}

function shouldUseSecureCookie(req) {
  if (process.env.NODE_ENV === "production") return true;
  const proto = String(req?.headers?.["x-forwarded-proto"] || "").toLowerCase();
  return proto === "https";
}

function buildCookie(name, value, { req, maxAgeSec }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];

  if (typeof maxAgeSec === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  }

  if (shouldUseSecureCookie(req)) {
    parts.push("Secure");
  }

  return parts.join("; ");
}

function sanitizeReturnTo(input) {
  const s = String(input || "").trim();
  if (!s.startsWith("/")) return "/authority";
  if (s.startsWith("//")) return "/authority";
  return s;
}

async function kvSetWithTtl(kv, key, value, ttlSec) {
  try {
    await kv.set(key, value, { ex: ttlSec });
  } catch {
    await kv.set(key, value);
  }
}

async function issueOauthState(returnTo) {
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");

  const state = crypto.randomBytes(24).toString("hex");
  const payload = {
    v: 1,
    returnTo: sanitizeReturnTo(returnTo),
    createdAt: new Date().toISOString(),
  };

  await kvSetWithTtl(kv, stateKey(state), payload, OAUTH_STATE_TTL_SEC);
  return state;
}

async function consumeOauthState(state) {
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");
  if (!state) return null;

  const key = stateKey(String(state).trim());
  const payload = await kv.get(key);
  await kv.del(key);
  return payload || null;
}

function setSessionCookie(res, req, sessionId) {
  const cookie = buildCookie(SESSION_COOKIE, sessionId, {
    req,
    maxAgeSec: SESSION_TTL_SEC,
  });
  appendSetCookie(res, cookie);
}

function clearSessionCookie(res, req) {
  const cookie = buildCookie(SESSION_COOKIE, "", { req, maxAgeSec: 0 });
  appendSetCookie(res, cookie);
}

async function createWebSession(req, res, { user, accessToken, expiresInSec }) {
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");

  const sessionId = crypto.randomBytes(32).toString("hex");
  const nowMs = Date.now();
  const expiresAtMs = nowMs + Math.max(30, Number(expiresInSec || 0)) * 1000;

  const record = {
    v: 1,
    user: user || null,
    accessTokenEnc: encryptString(String(accessToken || "")),
    expiresAtMs,
    createdAt: new Date(nowMs).toISOString(),
  };

  await kvSetWithTtl(kv, sessionKey(sessionId), record, SESSION_TTL_SEC);
  setSessionCookie(res, req, sessionId);
}

async function destroyWebSession(req, res) {
  const kv = getKV();
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];

  if (kv && sessionId) {
    await kv.del(sessionKey(sessionId));
  }

  clearSessionCookie(res, req);
}

async function getWebSession(req) {
  const kv = getKV();
  if (!kv) return null;

  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const record = await kv.get(sessionKey(sessionId));
  if (!record || !record.accessTokenEnc) return null;

  const expiresAtMs = Number(record.expiresAtMs || 0);
  if (!Number.isFinite(expiresAtMs) || Date.now() >= expiresAtMs) {
    await kv.del(sessionKey(sessionId));
    return null;
  }

  let accessToken;
  try {
    accessToken = decryptString(record.accessTokenEnc);
  } catch {
    await kv.del(sessionKey(sessionId));
    return null;
  }

  return {
    sessionId,
    user: record.user || null,
    accessToken,
    expiresAtMs,
  };
}

module.exports = {
  issueOauthState,
  consumeOauthState,
  createWebSession,
  getWebSession,
  destroyWebSession,
  sanitizeReturnTo,
};
