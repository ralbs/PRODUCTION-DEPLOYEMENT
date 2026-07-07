require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { ApolloServer } = require("apollo-server-express");

const { connectDB } = require("./config/db");
const { setupMqtt } = require("./config/mqtt");
const telemetryRoutes = require("./routes/telemetry");
const { typeDefs, resolvers } = require("./graphql/schema");

async function main() {
  await connectDB();

  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "64kb" })); // telemetry payloads are tiny; cap generously

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean);
  app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : "*" }));

  // Device ingest gets its own, tighter rate limit — one station posting
  // every minute is nowhere near this ceiling, but it blocks a compromised
  // or misbehaving device from hammering the DB.
  const ingestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use("/api/telemetry", ingestLimiter);

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const mqttPublish = setupMqtt();
  app.set("mqttPublish", mqttPublish);

  app.use("/api/telemetry", telemetryRoutes);
  app.use("/api/aqi", require("./routes/aqi"));
  app.use("/api/plume", require("./routes/plume"));
  app.use("/api/stations", require("./routes/stations"));
  app.use("/api/forecast", require("./routes/forecast"));

  const apollo = new ApolloServer({ typeDefs, resolvers });
  await apollo.start();
  apollo.applyMiddleware({ app, path: "/graphql" });

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`[server] AQMS backend listening on :${port}`);
    console.log(`[server] REST ingest:  POST http://localhost:${port}/api/telemetry`);
    console.log(`[server] REST query:   GET  http://localhost:${port}/api/telemetry/latest?station_id=...`);
    console.log(`[server] GraphQL:      http://localhost:${port}${apollo.graphqlPath}`);
  });
}

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
