require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const routes = require("./routes");

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/binbyb";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", routes);

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "binbyb-backend" });
});

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("MongoDB connected:", MONGODB_URI);
    app.listen(PORT, () => {
      console.log("Server running on port", PORT);
    });
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
