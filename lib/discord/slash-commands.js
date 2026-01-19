module.exports = [
  {
    name: "startparticipation",
    description: "Start a DAO participation thread with instructions",
    options: [
        {
        name: "note",
        description: "Optional note (agenda, links, etc.)",
        type: 3, // STRING
        required: false,
        },
    ],
    },
    {
      "name": "checkin",
      "description": "Post your Solana wallet in the participation thread (first one counts)",
      "options": [
        {
          "name": "wallet",
          "description": "Solana wallet address",
          "type": 3,
          "required": true
        },
        {
          "name": "fix",
          "description": "Fix my wallet before awards are issued",
          "type": 5,
          "required": false
        }
      ]
    },
    {
      name: "checkinwithlastwallet",
      description: "Check in using your most recently used wallet in this thread",
      type: 1
    },
    {
        name: "award_participation",
        description: "Award 1 participation point to each eligible participant (first wallet per user)",
    },
    {
        name: "setspace",
        description: "Set the Vine Reputation Space (DAO) for this Discord server",
        //default_member_permissions: "8", // ADMINISTRATOR only (recommended)
        options: [
        {
            name: "space",
            description: "Vine Space / DAO public key",
            type: 3, // STRING
            required: true,
        },
        ],
    },
    {
    name: "getspace",
    description: "Show the currently configured Vine Reputation Space (DAO) for this Discord server",
    },
    {
      name: "points",
      description: "Show your current Vine points balance",
      options: [
        {
          name: "wallet",
          description: "Optional Solana wallet address (otherwise uses your last check-in wallet)",
          type: 3,
          required: false
        }
      ]
    },
    {
    name: "whoami",
    description: "Show the wallet you have on record (and today’s check-in if applicable)",
  },
  {
    name: "participants",
    description: "List eligible participants for today in this participation thread",
    options: [
      {
        name: "format",
        description: "How to display participants",
        type: 3, // STRING
        required: false,
        choices: [
          { name: "wallets", value: "wallets" },
          { name: "mentions", value: "mentions" },
          { name: "both", value: "both" },
        ],
      },
      {
        name: "limit",
        description: "Max participants to show (default 25, max 50)",
        type: 4, // INTEGER
        required: false,
      },
      {
        name: "show_all",
        description: "If true, splits into multiple messages to show everyone",
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
  {
    name: "leaderboard",
    description: "Show top Vine points for this Space (DAO)",
    options: [
      {
        name: "limit",
        description: "How many results (default 10, max 25)",
        type: 4, // INTEGER
        required: false,
      },
      {
        name: "season",
        description: "Optional season number (defaults to current season)",
        type: 4, // INTEGER
        required: false,
      },
      {
        name: "ephemeral",
        description: "If true, only you can see it (default true)",
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
];