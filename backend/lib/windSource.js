// Distinct confidence sub-label for the WIND itself, not the bearing
// estimate -- per ctm-core/CLAUDE.md's confidence-treatment principle
// ("estimated" vs "measured" must be structurally distinct, never a
// caption people skim past). A bearing derived from live_model_nowcast
// wind (ctm-core/met/live_wind.py -- a real but MODELED nowcast) is a
// genuinely lower-confidence input than one derived from
// historical_ground_station wind (ctm-core/met/ingest_real_met.py -- a
// real directly-measured station reading, just not live).
//
// Deliberately its own module, NOT a static export on models/SourceDirection
// (a Mongoose model) -- routes/source-direction.js needs these real values
// for its own request-level validation and server-side label enforcement,
// and tests/source-direction.test.js does `jest.mock("../models/SourceDirection")`
// (automock), which strips plain object/array static exports off a mocked
// module. Keeping this data in its own ungapped module means the route's
// validation logic works the same whether the model is mocked or real.
const WIND_SOURCE_TIERS = ["live_model_nowcast", "historical_ground_station"];

const WIND_SOURCE_LABELS = {
  live_model_nowcast: "model-derived wind (live NWP nowcast, NOT a ground-station reading) -- see ctm-core/met/live_wind.py",
  historical_ground_station: "real ground-station wind (historical archive, NOT live) -- see ctm-core/met/ingest_real_met.py",
};

module.exports = { WIND_SOURCE_TIERS, WIND_SOURCE_LABELS };
