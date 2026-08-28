const { gql } = require("apollo-server-express");
const Telemetry = require("../models/Telemetry");
const { prepareDisplayPollutants } = require("../lib/prepare");

const typeDefs = gql`
  type Location {
    lat: Float
    lon: Float
  }
  type Weather {
    temperature: Float
    humidity: Float
    pressure: Float
  }
  type Pollutants {
    pm1: Float
    pm2_5: Float
    pm10: Float
    co: Float
    co2: Float
    no2: Float
    o3: Float
    nh3: Float
    h2s: Float
    mq135: Float
    h2: Float
    mq7_co: Float
    voc_gas_ohm: Float
  }
  type Battery {
    voltage: Float
    percent: Float
  }
  type Health {
    mq_ads1: String
    mq_ads2: String
    pms5003: String
    bme680: String
  }
  type Flags {
    offline_buffered: Boolean
    delayed: Boolean
  }

  type Reading {
    id: ID!
    timestamp: String!
    device_id: String!
    station_id: String!
    location: Location
    weather: Weather
    pollutants: Pollutants
    battery: Battery
    health: Health
    flags: Flags
  }

  type Query {
    latestReading(stationId: String!): Reading
    history(stationId: String!, from: String, to: String, limit: Int = 500): [Reading!]!
    stations: [String!]!
  }
`;

async function toReading(doc) {
  return {
    id: doc._id.toString(),
    timestamp: doc.timestamp.toISOString(),
    device_id: doc.meta.device_id,
    station_id: doc.meta.station_id,
    location: doc.location,
    weather: doc.weather,
    pollutants: await prepareDisplayPollutants(doc.pollutants, doc.diagnostics, doc.meta.device_id),
    battery: doc.battery,
    health: doc.health,
    flags: doc.flags,
  };
}

const resolvers = {
  Query: {
    latestReading: async (_, { stationId }) => {
      const doc = await Telemetry.findOne({ "meta.station_id": stationId })
        .sort({ timestamp: -1 })
        .lean();
      return doc ? toReading(doc) : null;
    },

    history: async (_, { stationId, from, to, limit }) => {
      const query = { "meta.station_id": stationId };
      if (from || to) {
        query.timestamp = {};
        if (from) query.timestamp.$gte = new Date(from);
        if (to) query.timestamp.$lte = new Date(to);
      }
      const docs = await Telemetry.find(query)
        .sort({ timestamp: -1 })
        .limit(Math.min(limit, 5000))
        .lean();
      const out = [];
      for (const d of docs) out.push(await toReading(d));
      return out;
    },

    stations: async () => {
      const ids = await Telemetry.distinct("meta.station_id");
      return ids;
    },
  },
};

module.exports = { typeDefs, resolvers };
