const { getWebSession } = require("../../../lib/discord/web_auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    return res.end("Method Not Allowed");
  }

  try {
    const session = await getWebSession(req);
    if (!session) {
      return res.status(200).json({ authenticated: false });
    }

    return res.status(200).json({
      authenticated: true,
      user: session.user,
      expiresAtMs: session.expiresAtMs,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
