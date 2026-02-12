const DISCORD_API = "https://discord.com/api/v10";
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_MANAGE_GUILD = 1n << 5n;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getOauthConfig() {
  return {
    clientId: process.env.DISCORD_CLIENT_ID || mustEnv("DISCORD_APP_ID"),
    clientSecret: mustEnv("DISCORD_CLIENT_SECRET"),
    redirectUri: mustEnv("DISCORD_OAUTH_REDIRECT_URI"),
  };
}

function buildDiscordOauthUrl(state) {
  const { clientId, redirectUri } = getOauthConfig();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "identify guilds",
    state,
    prompt: "consent",
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForToken(code) {
  const { clientId, clientSecret, redirectUri } = getOauthConfig();

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: String(code || ""),
    redirect_uri: redirectUri,
    scope: "identify guilds",
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Discord token exchange failed (${res.status}): ${JSON.stringify(json || {})}`
    );
  }

  return json;
}

async function discordApiGet(path, accessToken) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  return data;
}

async function fetchDiscordUser(accessToken) {
  return discordApiGet("/users/@me", accessToken);
}

async function fetchDiscordGuilds(accessToken) {
  return discordApiGet("/users/@me/guilds", accessToken);
}

function hasGuildConfigPermission(permissionsRaw) {
  let bits = 0n;
  try {
    bits = BigInt(permissionsRaw || 0);
  } catch {
    return false;
  }

  return (
    (bits & PERM_ADMINISTRATOR) === PERM_ADMINISTRATOR ||
    (bits & PERM_MANAGE_GUILD) === PERM_MANAGE_GUILD
  );
}

function canManageGuild(guild) {
  return hasGuildConfigPermission(guild?.permissions);
}

module.exports = {
  buildDiscordOauthUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
  fetchDiscordGuilds,
  canManageGuild,
  hasGuildConfigPermission,
};
