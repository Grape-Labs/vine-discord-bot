const {
  exchangeCodeForToken,
  fetchDiscordUser,
} = require("../../../../lib/discord/oauth_client");
const {
  consumeOauthState,
  createWebSession,
} = require("../../../../lib/discord/web_auth");

function safeRedirect(res, target) {
  return res.redirect(302, target || "/authority");
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    return res.end("Method Not Allowed");
  }

  const error = req.query?.error;
  if (error) {
    return safeRedirect(res, "/authority?error=oauth_denied");
  }

  const code = req.query?.code;
  const state = req.query?.state;
  if (!code || !state) {
    return safeRedirect(res, "/authority?error=oauth_missing_code");
  }

  try {
    const statePayload = await consumeOauthState(state);
    if (!statePayload) {
      return safeRedirect(res, "/authority?error=oauth_state_invalid");
    }

    const token = await exchangeCodeForToken(code);
    const user = await fetchDiscordUser(token.access_token);

    await createWebSession(req, res, {
      user: {
        id: user.id,
        username: user.username,
        global_name: user.global_name || null,
        avatar: user.avatar || null,
      },
      accessToken: token.access_token,
      expiresInSec: token.expires_in,
    });

    return safeRedirect(res, statePayload.returnTo || "/authority");
  } catch (e) {
    return safeRedirect(res, "/authority?error=oauth_callback_failed");
  }
};
