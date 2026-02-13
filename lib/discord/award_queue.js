const crypto = require("crypto");

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

const QUEUE_KEY = "vine:award:queue:v1";
const DEDUPE_TTL_SEC = Math.max(
  300,
  Math.floor(Number(process.env.AWARD_QUEUE_DEDUPE_TTL_SEC || 30 * 60))
);
const DEDUPE_STALE_MS = Math.max(
  60 * 1000,
  Math.floor(Number(process.env.AWARD_QUEUE_DEDUPE_STALE_MS || 10 * 60 * 1000))
);

function dedupeKey(threadId, day) {
  return `vine:award:dedupe:${String(threadId)}:${String(day)}`;
}

function doneKey(threadId, day) {
  return `vine:award:done:${String(threadId)}:${String(day)}`;
}

function workerLockKey() {
  return "vine:award:worker:lock";
}

function parseJob(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

function parseDedupe(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw;
  return null;
}

function isDedupeStale(dedupe) {
  const at = dedupe?.at ? Date.parse(String(dedupe.at)) : NaN;
  if (!Number.isFinite(at)) return false;
  return Date.now() - at > DEDUPE_STALE_MS;
}

function shouldRecoverDedupe(raw, parsed) {
  // Legacy/corrupt dedupe payloads can block new jobs forever until TTL expires.
  if (raw && !parsed) return true;
  if (parsed && !parsed.at) return true;
  return isDedupeStale(parsed);
}

async function enqueueAwardJob({ guildId, threadId, day, requestedBy }) {
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");
  if (!guildId || !threadId || !day) throw new Error("Missing guildId/threadId/day");

  const job = {
    id: crypto.randomUUID(),
    guildId: String(guildId),
    threadId: String(threadId),
    day: String(day),
    requestedBy: requestedBy ? String(requestedBy) : null,
    enqueuedAt: new Date().toISOString(),
  };

  // Atomic dedupe lock: prevents concurrent duplicate enqueues for the same thread/day.
  const dk = dedupeKey(threadId, day);
  let locked = await kv.set(
    dk,
    JSON.stringify({ id: job.id, at: job.enqueuedAt }),
    { nx: true, ex: DEDUPE_TTL_SEC }
  );

  if (!locked) {
    // Recover automatically from stale dedupe locks.
    const existingRaw = await kv.get(dk);
    const existing = parseDedupe(existingRaw);
    if (shouldRecoverDedupe(existingRaw, existing)) {
      await kv.del(dk);
      locked = await kv.set(
        dk,
        JSON.stringify({ id: job.id, at: job.enqueuedAt }),
        { nx: true, ex: DEDUPE_TTL_SEC }
      );
    }
  }

  if (!locked) return { ok: false, reason: "duplicate" };

  await kv.rpush(QUEUE_KEY, JSON.stringify(job));
  return { ok: true, job };
}

async function popAwardJob() {
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");
  const raw = await kv.lpop(QUEUE_KEY);
  return parseJob(raw);
}

async function releaseDedupe(threadId, day) {
  const kv = getKV();
  if (!kv) return false;
  await kv.del(dedupeKey(threadId, day));
  return true;
}

async function markAwardDone(threadId, day) {
  const kv = getKV();
  if (!kv) return false;
  await kv.set(doneKey(threadId, day), "1", { ex: 2 * 24 * 60 * 60 });
  return true;
}

async function hasAwardDone(threadId, day) {
  const kv = getKV();
  if (!kv) return false;
  const v = await kv.get(doneKey(threadId, day));
  return Boolean(v);
}

async function acquireWorkerLock(lockSeconds = 50) {
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");
  const token = crypto.randomUUID();
  const ok = await kv.set(workerLockKey(), token, { nx: true, ex: lockSeconds });
  return { ok: Boolean(ok), token };
}

async function releaseWorkerLock(token) {
  const kv = getKV();
  if (!kv) return false;
  const current = await kv.get(workerLockKey());
  if (current && String(current) === String(token)) {
    await kv.del(workerLockKey());
    return true;
  }
  return false;
}

module.exports = {
  enqueueAwardJob,
  popAwardJob,
  releaseDedupe,
  markAwardDone,
  hasAwardDone,
  acquireWorkerLock,
  releaseWorkerLock,
};
