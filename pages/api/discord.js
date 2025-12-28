const { verifyKey } = require("discord-interactions");

// If you haven't added KV yet, you can comment kv out for now
let kv = null;
try {
  kv = require("@vercel/kv").kv;
} catch (e) {
  // KV not installed or not configured yet; ok for local testing
}

/*
exports.config = {
  api: {
    bodyParser: false, // IMPORTANT: must read raw body
  },
};*/

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function pointsKey(guildId, userId) {
  return `points:${guildId}:${userId}`;
}

async function addPoints(guildId, userId, amount) {
  if (!kv) return Number(amount); // fallback if KV not set up yet
  const key = pointsKey(guildId, userId);
  const current = (await kv.get(key)) ?? 0;
  const next = Number(current) + Number(amount);
  await kv.set(key, next);
  return next;
}

async function getPoints(guildId, userId) {
  if (!kv) return 0; // fallback if KV not set up yet
  return (await kv.get(pointsKey(guildId, userId))) ?? 0;
}

async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const rawBodyBuf = await readRawBody(req);
  const rawBody = rawBodyBuf.toString("utf8");

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) return json(res, 500, { error: "Missing DISCORD_PUBLIC_KEY" });
  if (!sig || !ts) return json(res, 401, { error: "Missing signature headers" });

 const sig = Array.isArray(signature) ? signature[0] : signature;
  const ts  = Array.isArray(timestamp) ? timestamp[0] : timestamp;

  const isValid = verifyKey(rawBody, sig, ts, publicKey);

  if (!isValid) return json(res, 401, { error: "Invalid request signature" });

  const interaction = JSON.parse(rawBody);

  // Discord PING
  if (interaction.type === 1) {
    return json(res, 200, { type: 1 });
  }

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

      return json(res, 200, {
        type: 4,
        data: {
          content: `✅ Added **${amount}** point(s) to <@${user}>. New balance: **${next}**.${reason ? `\nReason: ${reason}` : ""}`,
        },
      });
    }

    if (subName === "balance") {
      const opts = sub.options ?? [];
      const user = opts.find((o) => o.name === "user")?.value ?? interaction.member.user.id;
      const bal = await getPoints(guildId, user);

      return json(res, 200, { type: 4, data: { content: `💳 <@${user}> has **${bal}** point(s).` } });
    }
  }

  return json(res, 200, { type: 4, data: { content: "Unknown command." } });
}

module.exports = handler;
module.exports.config = {
  api: { bodyParser: false },
};