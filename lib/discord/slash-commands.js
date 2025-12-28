module.exports = [
  {
    name: "startparticipation",
    description: "Post the participation instructions in this thread",
    options: [
      {
        name: "date",
        description: "Display date/time label (e.g. Tue Dec 29 19:00 UTC)",
        type: 3, // STRING
        required: true,
      },
      {
        name: "note",
        description: "Optional note (agenda/links/etc.)",
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
    description: "Collect first wallet per user from this thread (and later award on-chain)",
    options: [
      {
        name: "amount",
        description: "Amount of reputation to award (default: 1)",
        type: 4, // INTEGER
        required: false,
      },
    ],
  },
];