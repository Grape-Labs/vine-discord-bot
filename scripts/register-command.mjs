import "dotenv/config";
const appId = process.env.DISCORD_APP_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
// Optional: set a guild for instant updates while testing
const guildId = process.env.DISCORD_TEST_GUILD_ID;

console.log("APP_ID:", process.env.DISCORD_APP_ID ? "OK" : "MISSING");
console.log("BOT_TOKEN:", process.env.DISCORD_BOT_TOKEN ? "OK" : "MISSING");
console.log("BOT_TOKEN_LEN:", process.env.DISCORD_BOT_TOKEN?.length);

const url = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : `https://discord.com/api/v10/applications/${appId}/commands`;

const commands = [
  {
    name: "points",
    description: "Points system",
    options: [
      {
        type: 1,
        name: "add",
        description: "Add points to a user",
        options: [
          { type: 6, name: "user", description: "User", required: true },
          { type: 4, name: "amount", description: "Amount", required: true },
          { type: 3, name: "reason", description: "Reason", required: false },
        ],
      },
      {
        type: 1,
        name: "balance",
        description: "Check point balance",
        options: [{ type: 6, name: "user", description: "User (optional)", required: false }],
      },
    ],
  },
];

const res = await fetch(url, {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bot ${botToken}`,
  },
  body: JSON.stringify(commands),
});

const text = await res.text();
if (!res.ok) {
  console.error(res.status, text);
  process.exit(1);
}
console.log("Registered commands:", text);