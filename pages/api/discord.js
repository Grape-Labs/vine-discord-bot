// pages/api/discord.js
const { verifyKey } = require("discord-interactions");

// Optional KV (safe if not configured yet)
let kv = null;
try {
  kv = require("@vercel/kv").kv;
} catch (e) {
  // ok if KV not installed/configured yet
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function pointsKey(guildId, userId) {
  return `points:${guildId}:${userId}`;
}

async function addPoints(guildId, userId, amount) {
  if (!kv) return Number(amount); // fallback if KV not set up
  const key = pointsKey(guildId, userId);
  const current = (await kv.get(key)) ?? 0;
  const next = Number(current) + Number(amount);
  await kv.set(key, next);
  return next;
}

async function getPoints(guildId, userId) {
  if (!kv) return 0; // fallback if KV not set up
  return (await kv.get(pointsKey(guildId, userId))) ?? 0;
}

async function handleCommand(interaction, res) {
  const guildId = interaction.guild_id;
  const command = interaction.data?.name;

  if (command === "points") {
    const sub = interaction.data.options?.[0]; // add|balance
    const subName = sub?.name;

    if (subName === "add") {
      const opts = sub.options ?? [];
      const user = opts.find((o) => o.name === "user")?.value;
      const amount = opts.find((o) => o.name === "amount")?.value;
      const reason = opts.find((o) => o.name === "reason")?.value ?? "";

      const next = await addPoints(guildId, user, amount);

      return sendJson(res, 200, {
        type: 4,
        data: {
          content: `✅ Added **${amount}** point(s) to <@${user}>. New balance: **${next}**.${reason ? `\nReason: ${reason}` : ""}`,
        },
      });
    }

    if (subName === "balance") {
      const opts = sub.options ?? [];
      const user = opts.find((o) => o.name === "user")?.value ?? interaction.member?.user?.id;
      const bal = await getPoints(guildId, user);

      return sendJson(res, 200, {
        type: 4,
        data: { content: `💳 <@${user}> has **${bal}** point(s).` },
      });
    }
  }

  return sendJson(res, 200, { type: 4, data: { content: "Unknown command." } });
}

async function handler(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, version: "v2-2025-12-28" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });


  // Read raw bytes (critical for signature verification)
  const rawBodyBuf = await readRawBody(req);
  const rawBody = rawBodyBuf.toString("utf8");

  // Normalize headers (Vercel can provide string[])
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const sig = Array.isArray(signature) ? signature[0] : signature;
  const ts = Array.isArray(timestamp) ? timestamp[0] : timestamp;

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) return sendJson(res, 500, { error: "Missing DISCORD_PUBLIC_KEY" });
  if (!sig || !ts) return sendJson(res, 401, { error: "Missing signature headers" });

  // Verify Discord signature
  const isValid = verifyKey(rawBody, sig, ts, publicKey);
  if (!isValid) return sendJson(res, 401, { error: "Invalid request signature" });

  const interaction = JSON.parse(rawBody);

  // Respond to PING immediately (Discord endpoint verification)
  if (interaction.type === 1) {
    return sendJson(res, 200, { type: 1 });
  }

  // Handle commands
  return handleCommand(interaction, res);
}

module.exports = handler;

// IMPORTANT: disable body parser so we can verify raw body
module.exports.config = {
  api: { bodyParser: false },
};