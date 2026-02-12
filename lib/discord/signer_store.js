const { Keypair } = require("@solana/web3.js");
const bs58Mod = require("bs58");
const { encryptString, decryptString } = require("../crypto/secrets");

const bs58 = bs58Mod?.default ?? bs58Mod;

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

function keyByGuild(guildId) {
  return `vine:signerByGuild:${String(guildId).trim()}`;
}

function keypairFromSecret(raw, label = "secret") {
  if (!raw) throw new Error(`Missing ${label}`);

  const s = String(raw).trim();

  if (s.startsWith("[") && s.endsWith("]")) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error(`${label} JSON is not an array`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  try {
    return Keypair.fromSecretKey(bs58.decode(s));
  } catch {}

  try {
    return Keypair.fromSecretKey(new Uint8Array(Buffer.from(s, "base64")));
  } catch {}

  throw new Error(`${label} is not valid base58 / base64 / JSON-array secret.`);
}

async function setSignerForGuild(
  guildId,
  { authoritySecret, payerSecret = null, rpcUrl = null, updatedBy = null } = {}
) {
  if (!guildId) throw new Error("Missing guildId");
  if (!authoritySecret) throw new Error("Missing authoritySecret");

  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");

  const authorityKp = keypairFromSecret(authoritySecret, "authoritySecret");
  const payerKp = payerSecret
    ? keypairFromSecret(payerSecret, "payerSecret")
    : authorityKp;

  const now = new Date().toISOString();
  const record = {
    v: 1,
    authoritySecretEnc: encryptString(String(authoritySecret).trim()),
    payerSecretEnc: payerSecret ? encryptString(String(payerSecret).trim()) : null,
    authorityPublicKey: authorityKp.publicKey.toBase58(),
    payerPublicKey: payerKp.publicKey.toBase58(),
    rpcUrl: rpcUrl ? String(rpcUrl).trim() : null,
    updatedAt: now,
    updatedBy: updatedBy ? String(updatedBy) : null,
  };

  await kv.set(keyByGuild(guildId), record);

  return {
    authorityPublicKey: record.authorityPublicKey,
    payerPublicKey: record.payerPublicKey,
    rpcUrl: record.rpcUrl,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

async function getSignerMetaForGuild(guildId) {
  if (!guildId) return null;
  const kv = getKV();
  if (!kv) return null;

  const record = await kv.get(keyByGuild(guildId));
  if (!record || !record.authoritySecretEnc) return null;

  return {
    authorityPublicKey: record.authorityPublicKey || null,
    payerPublicKey: record.payerPublicKey || null,
    rpcUrl: record.rpcUrl || null,
    updatedAt: record.updatedAt || null,
    updatedBy: record.updatedBy || null,
  };
}

async function getSignerSecretsForGuild(guildId) {
  if (!guildId) return null;
  const kv = getKV();
  if (!kv) return null;

  const record = await kv.get(keyByGuild(guildId));
  if (!record || !record.authoritySecretEnc) return null;

  const authoritySecret = decryptString(record.authoritySecretEnc);
  const payerSecret = record.payerSecretEnc
    ? decryptString(record.payerSecretEnc)
    : null;

  return {
    authoritySecret,
    payerSecret,
    rpcUrl: record.rpcUrl || null,
    authorityPublicKey: record.authorityPublicKey || null,
    payerPublicKey: record.payerPublicKey || null,
  };
}

async function clearSignerForGuild(guildId) {
  if (!guildId) throw new Error("Missing guildId");
  const kv = getKV();
  if (!kv) throw new Error("KV is unavailable.");
  await kv.del(keyByGuild(guildId));
  return true;
}

module.exports = {
  setSignerForGuild,
  getSignerMetaForGuild,
  getSignerSecretsForGuild,
  clearSignerForGuild,
};
