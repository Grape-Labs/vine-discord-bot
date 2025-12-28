require("dotenv").config();
const fetch = require("node-fetch");
const commands = require("../lib/discord/slash-commands");

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// OPTIONAL but recommended while developing
const GUILD_ID = process.env.DISCORD_TEST_GUILD_ID;

if (!APP_ID || !BOT_TOKEN) {
  console.error("Missing DISCORD_APP_ID or DISCORD_BOT_TOKEN");
  process.exit(1);
}

const url = GUILD_ID
  ? `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`
  : `https://discord.com/api/v10/applications/${APP_ID}/commands`;

(async () => {
  console.log("Registering slash commands…");

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("❌ Failed to register commands:", text);
    process.exit(1);
  }

  console.log("✅ Commands registered successfully");
})();