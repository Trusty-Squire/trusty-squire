// T3.1 — parseEgressGeo turns an ipinfo.io/json body into the
// timezone + geolocation the browser context declares, so the
// browser's geo matches where its traffic actually exits. The parser
// is the error-prone bit: a bad timezoneId thrown into Playwright's
// newContext() would abort the whole run, so anything not a plausible
// IANA zone must come back null and let the caller keep its default.

import { describe, expect, it } from "vitest";
import { parseEgressGeo } from "../browser.js";

// A representative ipinfo.io/json response (Seoul / SK Broadband).
const seoul = JSON.stringify({
  ip: "121.130.0.1",
  city: "Seoul",
  region: "Seoul",
  country: "KR",
  loc: "37.5660,126.9784",
  org: "AS9318 SK Broadband Co Ltd",
  timezone: "Asia/Seoul",
});

describe("parseEgressGeo", () => {
  it("parses timezone + geolocation from a full response", () => {
    expect(parseEgressGeo(seoul)).toEqual({
      timezoneId: "Asia/Seoul",
      geolocation: { latitude: 37.566, longitude: 126.9784 },
    });
  });

  it("accepts a multi-segment IANA zone", () => {
    const r = parseEgressGeo(
      JSON.stringify({ timezone: "America/Argentina/Buenos_Aires", loc: "-34.6,-58.4" }),
    );
    expect(r?.timezoneId).toBe("America/Argentina/Buenos_Aires");
  });

  it("returns timezone-only when loc is absent", () => {
    const r = parseEgressGeo(JSON.stringify({ timezone: "Asia/Seoul" }));
    expect(r).toEqual({ timezoneId: "Asia/Seoul" });
    expect(r?.geolocation).toBeUndefined();
  });

  it("drops a malformed loc but keeps the timezone", () => {
    const r = parseEgressGeo(
      JSON.stringify({ timezone: "Asia/Seoul", loc: "not-coordinates" }),
    );
    expect(r).toEqual({ timezoneId: "Asia/Seoul" });
  });

  it("drops an out-of-range loc but keeps the timezone", () => {
    const r = parseEgressGeo(
      JSON.stringify({ timezone: "Asia/Seoul", loc: "999,999" }),
    );
    expect(r).toEqual({ timezoneId: "Asia/Seoul" });
  });

  it("returns null when the timezone is absent", () => {
    expect(parseEgressGeo(JSON.stringify({ city: "Seoul", loc: "37.5,127.0" }))).toBeNull();
  });

  it("returns null for an implausible timezone string", () => {
    // No slash → not an IANA zone. A garbage value here would throw
    // inside Playwright's newContext().
    expect(parseEgressGeo(JSON.stringify({ timezone: "EST" }))).toBeNull();
    expect(parseEgressGeo(JSON.stringify({ timezone: "<script>" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseEgressGeo("{not json")).toBeNull();
    expect(parseEgressGeo("")).toBeNull();
  });

  it("returns null for non-object JSON", () => {
    expect(parseEgressGeo("42")).toBeNull();
    expect(parseEgressGeo("null")).toBeNull();
    expect(parseEgressGeo('"Asia/Seoul"')).toBeNull();
  });
});
