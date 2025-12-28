module.exports = [
  {
    name: "checkin",
    description: "Post your Solana wallet in the participation thread",
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
    description: "Collect unique wallets from this thread (and later award on-chain)",
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