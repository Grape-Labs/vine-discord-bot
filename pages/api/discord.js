// pages/api/discord.js
const { verifyKey } = require("discord-interactions");

// Optional KV (safe if not configured yet)
let kv = null;
try {
  kv = require("@vercel/kv").kv;
} catch (e) {
  // KV not installed/configured yet — bot will still work (non-persistent)
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
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

async function handlePointsCommand(interaction, res) {
  const guildId = interaction.guild_id;
  const sub = interaction.data?.options?.[0];
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
        content: `✅ Added **${amount}** point(s) to <@${user}>. New balance: **${next}**.${
          reason ? `\nReason: ${reason}` : ""
        }`,
      },
    });
  }

  if (subName === "balance") {
    const opts = sub.options ?? [];
    const user =
      opts.find((o) => o.name === "user")?.value ??
      interaction.member?.user?.id;

    const bal = await getPoints(guildId, user);

    return sendJson(res, 200, {
      type: 4,
      data: { content: `💳 <@${user}> has **${bal}** point(s).` },
    });
  }

  return sendJson(res, 200, {
    type: 4,
    data: { content: "Unknown points subcommand." },
  });
}

async function handler(req, res) {
  // Discord will POST. Browser GET should just confirm route is live.
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, route: "/api/discord" });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  // Read raw bytes (critical)
  const rawBodyBuf = await readRawBody(req);
  const rawBody = rawBodyBuf.toString("utf8");

  // Normalize headers (string|string[])
  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const sig = Array.isArray(signature) ? signature[0] : signature;
  const ts = Array.isArray(timestamp) ? timestamp[0] : timestamp;

  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  // Basic guard rails
  if (!publicKey) return sendJson(res, 500, { error: "Missing DISCORD_PUBLIC_KEY" });
  if (!sig || !ts) return sendJson(res, 401, { error: "Missing Discord signature headers" });

  // Verify signature
  const isValid = verifyKey(rawBody, sig, ts, publicKey);
  if (!isValid) return sendJson(res, 401, { error: "Invalid request signature" });

  // Parse interaction
  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (e) {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  // ✅ PING: return the most literal response possible
  if (interaction.type === 1) {
    console.log("Discord PING verified -> responding with raw pong");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.end('{"type":1}');
  }

  // Commands
  const command = interaction.data?.name;

  if (command === "points") {
    return handlePointsCommand(interaction, res);
  }

  return sendJson(res, 200, {
    type: 4,
    data: { content: "Unknown command." },
  });
}

module.exports = handler;

// IMPORTANT: disable body parser so signature verification uses the true raw body
module.exports.config = {
  api: { bodyParser: false },
};