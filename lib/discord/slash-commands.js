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
    name: "checkin",
    description: "Post your Solana wallet in the participation thread (first one counts)",
    options: [
      {
        name: "wallet",
        description: "Your Solana wallet address (public)",
        type: 3, // STRING
        required: true,
      },
    ],
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
    }
];