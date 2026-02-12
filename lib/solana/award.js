// lib/solana/award.js
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const bs58Mod = require("bs58");
const bs58 = bs58Mod?.default ?? bs58Mod;
const { getSignerSecretsForGuild } = require("../discord/signer_store");

let vineClientModPromise;

async function getVineClient() {
  if (!vineClientModPromise) vineClientModPromise = import("@grapenpm/vine-reputation-client");
  const mod = await vineClientModPromise;
  return mod?.default ?? mod;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function keypairFromSecret(raw, label = "secret") {
  if (!raw) throw new Error(`Missing ${label}`);

  const s = String(raw).trim();

  // JSON array
  if (s.startsWith("[") && s.endsWith("]")) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error(`${label} JSON is not an array`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  // base58
  try {
    const bytes = bs58.decode(s);
    return Keypair.fromSecretKey(bytes);
  } catch {}

  // base64
  try {
    const bytes = Buffer.from(s, "base64");
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  } catch {}

  throw new Error(`${label} is not valid base58 / base64 / JSON-array secret.`);
}

function getSecretFromGuildMap(envName, guildId) {
  if (!guildId) return null;
  const raw = process.env[envName];
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${envName}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object keyed by guild id`);
  }

  const v = parsed[String(guildId).trim()];
  return v ? String(v).trim() : null;
}

function getSecretFromGuildEnvPrefix(prefix, guildId) {
  if (!guildId) return null;
  const key = `${prefix}_${String(guildId).trim()}`;
  const v = process.env[key];
  return v ? String(v).trim() : null;
}

async function resolveSignerSecrets(opts = {}) {
  const guildId = opts.guildId ? String(opts.guildId).trim() : null;
  let guildSigner = null;

  if (guildId) {
    guildSigner = await getSignerSecretsForGuild(guildId);
  }

  const authorityFromGuild =
    guildSigner?.authoritySecret ||
    getSecretFromGuildEnvPrefix("VINE_AUTHORITY_SECRET_GUILD", guildId) ||
    getSecretFromGuildMap("VINE_AUTHORITY_SECRET_BY_GUILD_JSON", guildId);

  const payerFromGuild =
    guildSigner?.payerSecret ||
    getSecretFromGuildEnvPrefix("VINE_PAYER_SECRET_GUILD", guildId) ||
    getSecretFromGuildMap("VINE_PAYER_SECRET_BY_GUILD_JSON", guildId);

  const authoritySecret =
    opts.authoritySecret || authorityFromGuild || process.env.VINE_AUTHORITY_SECRET;
  if (!authoritySecret) {
    throw new Error(
      "Missing authority secret. Set opts.authoritySecret, VINE_AUTHORITY_SECRET, or a guild override env."
    );
  }

  const payerSecret =
    opts.payerSecret || payerFromGuild || process.env.VINE_PAYER_SECRET || authoritySecret;

  const rpcUrlFromGuild = guildSigner?.rpcUrl || null;

  return { authoritySecret, payerSecret, rpcUrlFromGuild };
}

function inferClusterFromRpc(rpcUrl) {
  const u = String(rpcUrl || "").toLowerCase();
  if (u.includes("devnet")) return "devnet";
  if (u.includes("testnet")) return "testnet";
  return "mainnet-beta";
}

function txUrl(sig, cluster) {
  const c = cluster || "mainnet-beta";
  return `https://explorer.solana.com/tx/${sig}?cluster=${encodeURIComponent(c)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toDaoPublicKey(daoIdMaybe) {
  if (!daoIdMaybe) return null;
  if (daoIdMaybe instanceof PublicKey) return daoIdMaybe;
  return new PublicKey(String(daoIdMaybe).trim());
}

/**
 * awardOnePoint(wallets, opts)
 * opts:
 * {
 *   daoId?: string|PublicKey,
 *   guildId?: string,             // enables per-guild signer lookup (KV/env)
 *   amount?: bigint,
 *   rpcUrl?: string,
 *   cluster?: string,
 *   authoritySecret?: string, // base58/base64/json-array secret
 *   payerSecret?: string      // base58/base64/json-array secret (optional; defaults to authoritySecret)
 * }
 */
async function awardOnePoint(wallets, opts = {}) {
  const vine = await getVineClient();
  const { buildAddReputationPointsIx, VINE_REP_PROGRAM_ID } = vine;

  const { authoritySecret, payerSecret, rpcUrlFromGuild } = await resolveSignerSecrets(opts);
  const rpcUrl = opts.rpcUrl || rpcUrlFromGuild || mustEnv("SOLANA_RPC_URL");
  const cluster = opts.cluster || inferClusterFromRpc(rpcUrl);

  // daoId: prefer opts, fallback to env (legacy)
  const daoPk = toDaoPublicKey(opts.daoId) || toDaoPublicKey(process.env.VINE_DAO_ID);
  if (!daoPk) throw new Error("Missing daoId (pass opts.daoId or set VINE_DAO_ID)");

  const amount = typeof opts.amount === "bigint" ? opts.amount : 1n;

  // authority/payer: opts > guild KV signer > per-guild env map > global env fallback
  const authorityKp = keypairFromSecret(authoritySecret, "authoritySecret");
  const payerKp = keypairFromSecret(payerSecret, "payerSecret");

  const conn = new Connection(rpcUrl, "confirmed");
  const concurrency = Math.max(
    1,
    Math.floor(Number(opts.concurrency ?? process.env.VINE_AWARD_CONCURRENCY ?? 4))
  );
  const txDelayMs = Math.max(
    0,
    Math.floor(Number(opts.txDelayMs ?? process.env.VINE_AWARD_TX_DELAY_MS ?? 0))
  );

  // dedupe + normalize
  const unique = Array.from(
    new Set((wallets || []).map((w) => String(w || "").trim()).filter(Boolean))
  );

  const results = new Array(unique.length);

  async function awardAtIndex(i) {
    const w = unique[i];
    try {
      const user = new PublicKey(w);

      const { ix } = await buildAddReputationPointsIx({
        conn,
        daoId: daoPk,
        authority: authorityKp.publicKey,
        payer: payerKp.publicKey,
        user,
        amount,
        programId: VINE_REP_PROGRAM_ID,
      });

      const tx = new Transaction().add(ix);

      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payerKp.publicKey;

      // include payer signer if different
      const signers = payerKp.publicKey.equals(authorityKp.publicKey)
        ? [authorityKp]
        : [authorityKp, payerKp];

      const sig = await sendAndConfirmTransaction(conn, tx, signers, {
        commitment: "confirmed",
      });

      results[i] = { wallet: w, ok: true, sig, url: txUrl(sig, cluster) };
      if (txDelayMs > 0) await sleep(txDelayMs);
    } catch (e) {
      results[i] = { wallet: w, ok: false, error: e?.message || String(e) };
    }
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= unique.length) return;
      await awardAtIndex(i);
    }
  });

  await Promise.all(workers);

  return results;
}

module.exports = { awardOnePoint };
