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

  const secret = process.env.AWARD_WORKER_SECRET || process.env.DISCORD_BOT_TOKEN;
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

  const lockSeconds = Math.max(
    60,
    Math.floor(Number(process.env.AWARD_WORKER_LOCK_SECONDS || 60))
  );
  const lock = await acquireWorkerLock(lockSeconds);
  if (!lock.ok) {
    console.log("award-worker: skipped (worker_locked)");
    return res.status(200).json({ ok: true, processed: 0, skipped: "worker_locked" });
  }

  let processed = 0;
  let failed = 0;
  let last = null;

  try {
    const maxJobs = Math.max(1, Math.min(3, Number(req.query?.max || 1)));

    for (let i = 0; i < maxJobs; i += 1) {
      const job = await popAwardJob();
      if (!job) {
        console.log("award-worker: no queued job");
        break;
      }

      last = { id: job.id, threadId: job.threadId, day: job.day };
      console.log("award-worker: picked job", last);

      try {
        const alreadyDone = await hasAwardDone(job.threadId, job.day);
        if (alreadyDone) {
          console.log("award-worker: skipping already_done", last);
          await releaseDedupe(job.threadId, job.day);
          continue;
        }

        const out = await runAwardParticipationJob(job);
        processed += 1;
        console.log("award-worker: job result", { ...last, status: out?.status, ok: out?.ok });

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
