const { fetchDiscordGuilds, canManageGuild } = require("../../../lib/discord/oauth_client");
const { getWebSession } = require("../../../lib/discord/web_auth");
const {
  getSignerMetaForGuild,
  setSignerForGuild,
  clearSignerForGuild,
} = require("../../../lib/discord/signer_store");
const { getDaoIdForGuild } = require("../../../lib/discord/dao_store");

function bodyAsObject(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

async function assertCanManageGuild(accessToken, guildId) {
  if (!guildId) throw new Error("Missing guildId");
  const guilds = await fetchDiscordGuilds(accessToken);
  const hit = (guilds || []).find((g) => String(g.id) === String(guildId));
  if (!hit) throw new Error("You are not a member of that guild.");
  if (!canManageGuild(hit)) {
    throw new Error("You need Manage Server or Administrator in that guild.");
  }
}

module.exports = async function handler(req, res) {
  try {
    const session = await getWebSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    if (req.method === "GET") {
      const guildId = req.query?.guildId;
      await assertCanManageGuild(session.accessToken, guildId);

      const [meta, daoId] = await Promise.all([
        getSignerMetaForGuild(guildId),
        getDaoIdForGuild(guildId),
      ]);

      return res.status(200).json({
        guildId: String(guildId),
        daoId: daoId || null,
        signer: meta,
      });
    }

    if (req.method === "POST") {
      const body = bodyAsObject(req);
      const guildId = body.guildId;
      await assertCanManageGuild(session.accessToken, guildId);

      const authoritySecret = body.authoritySecret;
      const payerSecret = body.payerSecret || null;
      const rpcUrl = body.rpcUrl || null;

      if (!authoritySecret) {
        return res.status(400).json({ error: "Missing authoritySecret." });
      }

      const saved = await setSignerForGuild(guildId, {
        authoritySecret,
        payerSecret,
        rpcUrl,
        updatedBy: session.user?.id || null,
      });

      return res.status(200).json({
        ok: true,
        guildId: String(guildId),
        signer: saved,
      });
    }

    if (req.method === "DELETE") {
      const body = bodyAsObject(req);
      const guildId = body.guildId;
      await assertCanManageGuild(session.accessToken, guildId);

      await clearSignerForGuild(guildId);
      return res.status(200).json({ ok: true, guildId: String(guildId) });
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST, DELETE");
    return res.end("Method Not Allowed");
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
};
