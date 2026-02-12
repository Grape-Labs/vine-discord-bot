const { fetchDiscordGuilds, canManageGuild } = require("../../../lib/discord/oauth_client");
const { getWebSession } = require("../../../lib/discord/web_auth");
const { getDaoIdForGuild } = require("../../../lib/discord/dao_store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    return res.end("Method Not Allowed");
  }

  try {
    const session = await getWebSession(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });

    const guilds = await fetchDiscordGuilds(session.accessToken);
    const manageable = (guilds || []).filter(canManageGuild);

    const enriched = await Promise.all(
      manageable.map(async (g) => ({
        id: g.id,
        name: g.name || `Guild ${g.id}`,
        icon: g.icon || null,
        permissions: g.permissions,
        daoId: await getDaoIdForGuild(g.id),
      }))
    );

    enriched.sort((a, b) => a.name.localeCompare(b.name));
    return res.status(200).json({ guilds: enriched });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
