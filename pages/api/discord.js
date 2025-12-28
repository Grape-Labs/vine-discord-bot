// pages/api/discord.js
const { verifyKey } = require("discord-interactions");

let kv = null;
try {
  kv = require("@vercel/kv").kv;
} catch (_) {}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

function pointsKey(guildId, userId) {
  return `points:${guildId}:${userId}`;
}

async function addPoints(guildId, userId, amount) {
  if (!kv) return Number(amount);
  const key = pointsKey(guildId, userId);
  const current = (await kv.get(key)) ?? 0;
  const next = Number(current) + Number(amount);
  await kv.set(key, next);
  return next;
}

async function getPoints(guildId, userId) {
  if (!kv) return 0;
  return (await kv.get(pointsKey(guildId, userId))) ?? 0;
}

async function handlePoints(interaction, res) {
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
        content: `✅ Added **${amount}** point(s) to <@${user}>. New balance: **${next}**.${reason ? `\nReason: ${reason}` : ""}`,
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

  return sendJson(res, 200, { type: 4, data: { content: "Unknown points subcommand." } });
}

async function handler(req, res) {
  // Keep the endpoint strict and predictable
  if (req.method === "HEAD") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end("Method Not Allowed");
  }

  const rawBodyBuf = await readRawBody(req);
  const rawBody = rawBodyBuf.toString("utf8");

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const sig = Array.isArray(signature) ? signature[0] : signature;
  const ts = Array.isArray(timestamp) ? timestamp[0] : timestamp;

  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) return sendJson(res, 500, { error: "Missing DISCORD_PUBLIC_KEY" });
  if (!sig || !ts) return sendJson(res, 401, { error: "Missing Discord signature headers" });

  const isValid = verifyKey(rawBody, sig, ts, publicKey);
  if (!isValid) return sendJson(res, 401, { error: "Invalid request signature" });

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (e) {
    return sendJson(res, 400, { error: "Invalid JSON" });
  }

  // Discord PING — return exact bytes, explicit Content-Length
  if (interaction.type === 1) {
    const body = '{"type":1}';
    console.log("Discord PING verified -> responding with strict raw pong");
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.setHeader("Cache-Control", "no-store");
    return res.end(body);
  }

  const command = interaction.data?.name;
  if (command === "points") return handlePoints(interaction, res);

  return sendJson(res, 200, { type: 4, data: { content: "Unknown command." } });
}

module.exports = handler;
module.exports.config = {
  api: { bodyParser: false },
};