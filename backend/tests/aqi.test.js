const { subIndex, calculateAQI, BREAKPOINTS, informationalReadings, INFORMATIONAL_CHANNELS } = require("../lib/aqi");

// The CPCB tables publish bands with a one-unit gap between them (PM2.5
// 0-30 then 31-60; CO 1.0 then 1.1). A real reading can land strictly
// inside a gap -- these four were found in the audit and each used to
// return null, silently dropping that pollutant out of calculateAQI()'s
// max(). A gap value belongs to the LOWER band (equivalent to truncating
// to the table's precision, e.g. 30.5 -> 30), so it gets that band's top
// sub-index.
describe("subIndex -- readings between two published bands", () => {
  test.each([
    // [pollutant, gap reading, lower band's top sub-index]
    ["pm2_5", 30.5, 50],
    ["pm10", 50.5, 50],
    ["no2", 40.7, 50],
    ["co", 1.05, 50],
  ])("%s %p falls into the lower band -> %p (not null)", (pollutant, conc, expected) => {
    expect(subIndex(pollutant, conc)).toBe(expected);
  });

  test.each([
    ["pm2_5", 30.5],
    ["pm10", 50.5],
    ["no2", 40.7],
    ["co", 1.05],
  ])("%s %p now reaches calculateAQI()'s max instead of vanishing", (pollutant, conc) => {
    // calculateAQI takes CO in µg/m³ via mq7_co and converts to mg/m³ itself.
    const input = pollutant === "co" ? { mq7_co: conc * 1000 } : { [pollutant]: conc };
    const result = calculateAQI(input);
    expect(result).not.toBeNull();
    expect(result.sub_indices[pollutant]).toBe(50);
    expect(result.aqi).toBe(50);
    expect(result.dominant_pollutant).toBe(pollutant);
  });

  // Every gap in every table, not just the four found live.
  const gaps = [];
  for (const [pollutant, table] of Object.entries(BREAKPOINTS)) {
    for (let k = 0; k < table.length - 1; k++) {
      const [, bHi, , iHi] = table[k];
      const nextLo = table[k + 1][0];
      if (nextLo > bHi) gaps.push([pollutant, (bHi + nextLo) / 2, iHi]);
    }
  }

  test("the sweep found every gap: 6 official tables x 5 gaps", () => {
    expect(gaps.length).toBe(30);
  });

  test.each(gaps)("%s gap midpoint %p -> lower band top %p", (pollutant, conc, expected) => {
    expect(subIndex(pollutant, conc)).toBe(expected);
  });
});

describe("subIndex -- in-band behaviour unchanged", () => {
  const endpoints = [];
  for (const [pollutant, table] of Object.entries(BREAKPOINTS)) {
    for (const [bLo, bHi, iLo, iHi] of table) {
      endpoints.push([pollutant, bLo, iLo], [pollutant, bHi, iHi]);
    }
  }

  test.each(endpoints)("%s band endpoint %p -> %p", (pollutant, conc, expected) => {
    expect(subIndex(pollutant, conc)).toBe(expected);
  });

  test("interior interpolation: PM2.5 45 -> round(51 + 49/29 * 14) = 75", () => {
    expect(subIndex("pm2_5", 45)).toBe(75);
  });

  test("above the top band still caps at 500; missing/negative still null", () => {
    expect(subIndex("pm2_5", 999)).toBe(500);
    expect(subIndex("pm2_5", null)).toBeNull();
    expect(subIndex("pm2_5", -1)).toBeNull();
    expect(subIndex("not_a_pollutant", 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The official AQI is the six CPCB pollutants ONLY.
// ---------------------------------------------------------------------------
const OFFICIAL = ["pm2_5", "pm10", "no2", "o3", "co", "nh3"];
const INVENTED = ["h2s", "h2", "mq135", "voc_gas_ohm"];

// NEL-001's real captured reading (live /api/telemetry/latest, 2026-09-08T20:45Z).
// Before this change it produced AQI 234 "Poor", dominant voc_gas_ohm.
const NEL001 = {
  pm1: 10, pm2_5: 20, pm10: 33, co: -1, no2: 15, o3: -1, nh3: 8,
  h2s: 2.5, mq135: 130, h2: 2, mq7_co: 190, voc_gas_ohm: 50000,
};

describe("calculateAQI -- official CPCB pollutants only", () => {
  test("NEL-001's real reading -> AQI 33 'Good' with a real CPCB pollutant dominant (was 234 / VOC)", () => {
    const r = calculateAQI(NEL001);
    expect(r.aqi).toBe(33);
    expect(r.category).toBe("Good");
    expect(OFFICIAL).toContain(r.dominant_pollutant);
    expect(r.dominant_pollutant).toBe("pm2_5"); // pm2_5 and pm10 tie at 33; first in order wins
  });

  test("sub_indices holds exactly the six CPCB pollutants -- no invented channel keys at all", () => {
    expect(Object.keys(calculateAQI(NEL001).sub_indices).sort()).toEqual([...OFFICIAL].sort());
    expect(Object.keys(BREAKPOINTS).sort()).toEqual([...OFFICIAL].sort());
  });

  // Every invented channel at every magnitude, including the old top bands,
  // absurd values, and the values that used to win for NEL-001.
  const extremes = [0.001, 1, 2.5, 10, 130, 5000, 50000, 99999, 100000, 1e6, 1e12];
  const cases = INVENTED.flatMap((ch) => extremes.map((v) => [ch, v]));
  test.each(cases)("%s = %p can never be dominant and never changes the AQI", (ch, v) => {
    const base = { pm2_5: 5, pm10: 10 }; // official sub-indices 8 and 10
    const withChannel = calculateAQI({ ...base, [ch]: v });
    expect(withChannel.dominant_pollutant).toBe("pm10");
    expect(withChannel).toEqual(calculateAQI(base));
    expect(withChannel.sub_indices).not.toHaveProperty(ch);
  });

  test("all four invented channels maxed out, no official pollutant -> no AQI at all (null)", () => {
    expect(calculateAQI({ h2s: 1e6, h2: 1e6, mq135: 1e6, voc_gas_ohm: 1e6 })).toBeNull();
  });

  test("subIndex() has no table for an invented channel", () => {
    for (const ch of INVENTED) expect(subIndex(ch, 50000)).toBeNull();
  });
});

describe("informationalReadings -- separate from the AQI", () => {
  test("reports NEL-001's four informational channels with units, flagged not-in-AQI", () => {
    const info = informationalReadings(NEL001);
    expect(Object.keys(info).sort()).toEqual([...INVENTED].sort());
    expect(info.voc_gas_ohm).toMatchObject({ value: 50000, unit: "Ω", in_official_aqi: false });
    expect(info.mq135.value).toBe(130); // no AQI sanity ceiling: 130 is a routine MQ-135 reading
    expect(info.h2s.value).toBe(2.5);
    expect(info.h2.value).toBe(2);
    for (const r of Object.values(info)) expect(r.in_official_aqi).toBe(false);
    expect(info.voc_gas_ohm.note).toMatch(/falls as VOCs rise/i);
  });

  test("fault sentinel (-1), zero, NaN and missing all become null", () => {
    const info = informationalReadings({ h2s: -1, h2: 0, mq135: NaN });
    expect(info.h2s.value).toBeNull();
    expect(info.h2.value).toBeNull();
    expect(info.mq135.value).toBeNull();
    expect(info.voc_gas_ohm.value).toBeNull();
  });

  test("the channel list is exactly the four invented channels, disjoint from the official six", () => {
    expect(Object.keys(INFORMATIONAL_CHANNELS).sort()).toEqual([...INVENTED].sort());
    for (const ch of INVENTED) expect(OFFICIAL).not.toContain(ch);
  });
});
