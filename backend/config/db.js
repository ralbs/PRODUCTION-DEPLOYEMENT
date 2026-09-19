const mongoose = require("mongoose");

// Strips credentials (everything between "://" and "@") so the host/db
// name can be logged without ever printing the password.
function redactUri(uri) {
  const atIndex = uri.indexOf("@");
  if (atIndex === -1) return uri;
  const protocolMatch = uri.match(/^[a-zA-Z0-9+]+:\/\//);
  const protocol = protocolMatch ? protocolMatch[0] : "";
  return protocol + uri.slice(atIndex + 1);
}

async function connectDB() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/aqms";

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri);
  console.log(`[DB] Connected to MongoDB: ${redactUri(uri)}`);

  mongoose.connection.on("error", (err) => {
    console.error("[DB] Connection error:", err.message);
  });
  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] Disconnected — mongoose will attempt to reconnect");
  });
}

module.exports = { connectDB };
