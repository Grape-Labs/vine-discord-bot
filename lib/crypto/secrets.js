const crypto = require("crypto");

const ENC_ALGO = "aes-256-gcm";
const PAYLOAD_VERSION = "v1";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getEncryptionKey() {
  const raw = mustEnv("VINE_SECRETS_ENC_KEY").trim();

  // 32-byte key as hex (64 chars)
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // 32-byte key as base64
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;

  throw new Error(
    "VINE_SECRETS_ENC_KEY must be 32-byte key in hex (64 chars) or base64."
  );
}

function encryptString(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    PAYLOAD_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

function decryptString(payload) {
  const parts = String(payload || "").split(":");
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error("Invalid encrypted payload format.");
  }

  const [, ivB64, tagB64, cipherB64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(cipherB64, "base64");

  const decipher = crypto.createDecipheriv(ENC_ALGO, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

module.exports = {
  encryptString,
  decryptString,
};
