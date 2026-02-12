const { buildDiscordOauthUrl } = require("../../../../lib/discord/oauth_client");
const { issueOauthState, sanitizeReturnTo } = require("../../../../lib/discord/web_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    return res.end("Method Not Allowed");
  }

  try {
    const returnTo = sanitizeReturnTo(req.query?.returnTo);
    const state = await issueOauthState(returnTo);
    const url = buildDiscordOauthUrl(state);
    return res.redirect(302, url);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
