module.exports = [
  {
    name: "checkin",
    description: "Check in to the DAO call with your Solana wallet",
    options: [
      {
        name: "wallet",
        description: "Your Solana wallet address",
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: "award_participation",
    description: "Award participation points to checked-in users",
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