const { runAwardParticipationJob } = require("../../lib/discord/commands");
const {
  popAwardJob,
  releaseDedupe,
  markAwardDone,
  hasAwardDone,
  acquireWorkerLock,
  releaseWorkerLock,
} = require("../../lib/discord/award_queue");

function isAuthorized(req) {
  // Vercel Cron calls include this header.
  if (req.headers["x-vercel-cron"]) return true;

  const secret = process.env.AWARD_WORKER_SECRET;
  if (!secret) return false;

  const auth = req.headers.authorization || "";
  return auth === `Bearer ${secret}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const lock = await acquireWorkerLock(55);
  if (!lock.ok) {
    return res.status(200).json({ ok: true, processed: 0, skipped: "worker_locked" });
  }

  let processed = 0;
  let failed = 0;
  let last = null;

  try {
    const maxJobs = Math.max(1, Math.min(3, Number(req.query?.max || 1)));

    for (let i = 0; i < maxJobs; i += 1) {
      const job = await popAwardJob();
      if (!job) break;

      last = { id: job.id, threadId: job.threadId, day: job.day };

      try {
        const alreadyDone = await hasAwardDone(job.threadId, job.day);
        if (alreadyDone) {
          await releaseDedupe(job.threadId, job.day);
          continue;
        }

        const out = await runAwardParticipationJob(job);
        processed += 1;

        if (out?.ok && out?.status === "completed") {
          await markAwardDone(job.threadId, job.day);
        }
      } catch (e) {
        failed += 1;
        console.error("award-worker: job failed:", e);
      } finally {
        await releaseDedupe(job.threadId, job.day);
      }
    }

    return res.status(200).json({ ok: true, processed, failed, last });
  } catch (e) {
    console.error("award-worker: fatal:", e);
    return res.status(500).json({ ok: false, error: e.message, processed, failed, last });
  } finally {
    await releaseWorkerLock(lock.token);
  }
};
