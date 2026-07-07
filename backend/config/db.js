const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/aqms";

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri);
  console.log(`[DB] Connected to MongoDB: ${uri}`);

  mongoose.connection.on("error", (err) => {
    console.error("[DB] Connection error:", err.message);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] Disconnected — mongoose will attempt to reconnect");
  });
}

module.exports = { connectDB };
