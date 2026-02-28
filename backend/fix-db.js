/**
 * One-off script: set today's opening balance to 3450 in the database.
 * Run from backend: node fix-db.js
 * Adjust MONGODB_URI below if your database is different.
 */

const mongoose = require("mongoose");
const Setting = require("./models/Setting");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/binbyb";

mongoose
  .connect(MONGODB_URI)
  .then(async () => {
    const settings = await Setting.findOne();
    if (settings) {
      settings.dailyOpeningBalance = 3450;
      await settings.save();
      console.log("Success: Today's opening balance fixed to 3450");
    } else {
      console.log("No settings found in DB.");
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
