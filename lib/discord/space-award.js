// lib/solana/space-award.js
const { kv } = require("@vercel/kv");
const { decryptString } = require("../crypto/secrets");
const { awardOnePoint } = require("./award");

async function awardForGuild(guildId, wallets, { amount = 1n } = {}) {
  const space = await kv.get(`space:${String(guildId).trim()}`);
  if (!space) throw new Error("This server is not configured yet.");

  if (!space.daoId) throw new Error("Server is configured but missing daoId.");

  const authoritySecret = decryptString(space.authoritySecretEnc);
  const payerSecret = space.payerSecretEnc ? decryptString(space.payerSecretEnc) : authoritySecret;

  return awardOnePoint(wallets, {
    daoId: space.daoId,
    rpcUrl: space.rpcUrl || process.env.SOLANA_RPC_URL,
    authoritySecret,
    payerSecret,
    amount,
  });
}

module.exports = { awardForGuild };