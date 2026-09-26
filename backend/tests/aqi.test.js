const { subIndex, calculateAQI, BREAKPOINTS } = require("../lib/aqi");

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

  test("the sweep actually found gaps to check", () => {
    expect(gaps.length).toBeGreaterThan(40);
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
