// lib/solana/award.js
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

// ✅ bs58 in Node/Next can be ESM-shaped; normalize it
const bs58Mod = require("bs58");
const bs58 = bs58Mod?.default ?? bs58Mod;

let vineClientModPromise;

async function getVineClient() {
  if (!vineClientModPromise) {
    vineClientModPromise = import("@grapenpm/vine-reputation-client");
  }
  const mod = await vineClientModPromise;
  return mod?.default ?? mod;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function keypairFromEnv(name) {
  const raw = mustEnv(name).trim();

  // 1) JSON array secret (Solana default keypair file format)
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error(`${name} JSON is not an array`);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }

  // 2) base58
  try {
    const bytes = bs58.decode(raw);
    return Keypair.fromSecretKey(bytes);
  } catch (_) {}

  // 3) base64
  try {
    const bytes = Buffer.from(raw, "base64");
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  } catch (_) {}

  throw new Error(
    `${name} is not valid base58 / base64 / JSON-array secret. Check for quotes, spaces, or wrong format.`
  );
}

function txUrl(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

// ---- small binary helpers (u16/u64 LE) ----
function readU16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}
function readU64LE(buf, off) {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) + BigInt(buf[off + i]);
  return x;
}
function writeU64LE(n) {
  const b = Buffer.alloc(8);
  let x = BigInt(n);
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}

/**
 * Decode rep points for both possible layouts.
 * We keep this tolerant to avoid the exact bug you're seeing.
 */
function decodeRepPoints(data) {
  const DISC = 8;

  // layout A (newer): disc(8) + version(1) + dao(32) + user(32) + season(2) + points(8) + ...
  if (data.length >= DISC + 1 + 32 + 32 + 2 + 8) {
    const seasonOff = DISC + 1 + 32 + 32; // after version+dao+user
    const pointsOff = seasonOff + 2;
    const season = readU16LE(data, seasonOff);
    const points = readU64LE(data, pointsOff);
    // sanity: points shouldn't be insane
    if (points >= 0n) return { season, points };
  }

  // layout B (older): disc(8) + version(1) + user(32) + season(2) + points(8) + ...
  if (data.length >= DISC + 1 + 32 + 2 + 8) {
    const seasonOff = DISC + 1 + 32;
    const pointsOff = seasonOff + 2;
    const season = readU16LE(data, seasonOff);
    const points = readU64LE(data, pointsOff);
    if (points >= 0n) return { season, points };
  }

  return { season: null, points: 0n };
}

async function awardOnePoint(wallets) {
  const vine = await getVineClient();
  const {
    VINE_REP_PROGRAM_ID,
    getConfigPda,
    getReputationPda,
    decodeReputationConfig,
    ixDiscriminator,
  } = vine;

  const rpc = mustEnv("SOLANA_RPC_URL");
  const daoId = new PublicKey(mustEnv("VINE_DAO_ID"));

  const authorityKp = keypairFromEnv("VINE_AUTHORITY_SECRET");
  const payerKp = authorityKp; // same kp
  const conn = new Connection(rpc, "confirmed");

  // 1) Fetch config once → get current season
  const [configPda] = getConfigPda(daoId, VINE_REP_PROGRAM_ID);
  const cfgAi = await conn.getAccountInfo(configPda, "confirmed");
  if (!cfgAi?.data) throw new Error("Config PDA not found for this DAO.");

  const cfg = await decodeReputationConfig(cfgAi.data);
  const season =
    typeof cfg.currentSeason === "bigint"
      ? Number(cfg.currentSeason)
      : (cfg.currentSeason?.toNumber?.() ?? Number(cfg.currentSeason));

  if (!Number.isFinite(season) || season <= 0) {
    throw new Error(`Bad currentSeason in config: ${String(cfg.currentSeason)}`);
  }

  // 2) Build discriminator for add_reputation (matches your UI logic)
  const disc = await ixDiscriminator("addReputation"); // vine client uses camel for ix names
  const discBuf = Buffer.from(disc);

  const results = [];
  for (const w of wallets) {
    try {
      const user = new PublicKey(w);

      // 3) derive rep PDA for current season
      const [repPda] = getReputationPda(configPda, user, season, VINE_REP_PROGRAM_ID);

      // 4) read current points
      const repAi = await conn.getAccountInfo(repPda, "confirmed");
      const current = repAi?.data ? decodeRepPoints(repAi.data).points : 0n;

      // IMPORTANT: program expects TOTAL, not delta
      const nextTotal = current + 1n;

      // data = disc(8) + total(u64)
      const data = Buffer.concat([discBuf, writeU64LE(nextTotal)]);

      const ix = new TransactionInstruction({
        programId: VINE_REP_PROGRAM_ID,
        keys: [
          { pubkey: configPda, isSigner: false, isWritable: false },
          { pubkey: authorityKp.publicKey, isSigner: true, isWritable: false },
          { pubkey: user, isSigner: false, isWritable: false },
          { pubkey: repPda, isSigner: false, isWritable: true },
          { pubkey: payerKp.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      const tx = new Transaction().add(ix);

      const sig = await sendAndConfirmTransaction(conn, tx, [authorityKp], {
        commitment: "confirmed",
      });

      results.push({ wallet: w, ok: true, sig, url: txUrl(sig), nextTotal: String(nextTotal) });
    } catch (e) {
      results.push({ wallet: w, ok: false, error: e?.message || String(e) });
    }
  }

  return results;
}

module.exports = { awardOnePoint };