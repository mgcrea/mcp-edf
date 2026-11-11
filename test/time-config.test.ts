import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  assertRange,
  daysInclusive,
  parisMidnight,
  parisToday,
} from "#/client/time";
import { loadConfig } from "#/config";
import { ABSENT_CONFIG } from "#test/helpers";

describe("Paris time", () => {
  it("uses +01:00 in winter and +02:00 in summer", () => {
    expect(parisMidnight("2026-01-15")).toBe("2026-01-15T00:00:00+01:00");
    expect(parisMidnight("2026-07-15")).toBe("2026-07-15T00:00:00+02:00");
  });

  it("uses the offset in force AT midnight on the days the clocks change", () => {
    // Spring forward at 02:00 on 2026-03-29: midnight is still winter time.
    expect(parisMidnight("2026-03-29")).toBe("2026-03-29T00:00:00+01:00");
    expect(parisMidnight("2026-03-30")).toBe("2026-03-30T00:00:00+02:00");
    // Fall back at 03:00 on 2026-10-25: midnight is still summer time.
    expect(parisMidnight("2026-10-25")).toBe("2026-10-25T00:00:00+02:00");
    expect(parisMidnight("2026-10-26")).toBe("2026-10-26T00:00:00+01:00");
  });

  it("knows today in Paris, not in UTC", () => {
    // 23:30 UTC on 10 November is already 11 November in Paris.
    expect(parisToday(Date.parse("2026-11-10T23:30:00Z"))).toBe("2026-11-11");
  });

  it("does date and month arithmetic across boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(daysInclusive("2026-11-01", "2026-11-01")).toBe(1);
  });

  it("rejects inverted and oversized ranges", () => {
    expect(() => assertRange("2026-11-02", "2026-11-01", 10)).toThrow(/after/);
    expect(() => assertRange("2026-11-01", "2026-11-20", 10)).toThrow(/at most 10/);
    expect(() => assertRange("2026-02-30", "2026-03-01", 10)).toThrow(/must be a date/);
  });
});

const writeConfig = (body: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "edf-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  return path;
};

describe("config", () => {
  it("needs nothing at all", () => {
    const config = loadConfig({}, ABSENT_CONFIG);
    expect(config.refreshToken).toBeUndefined();
    expect(config.tokenFile).toMatch(/edf\/tokens\.json$/);
  });

  it("merges per field, environment first", () => {
    const path = writeConfig({ site: "PARIS", maxRetries: 5 });
    const config = loadConfig({ EDF_SITE: "LYON" }, path);
    expect(config.site).toBe("LYON");
    expect(config.maxRetries).toBe(5);
  });

  it("rejects an unknown key in the file rather than ignoring it", () => {
    const path = writeConfig({ tokenfile: "/tmp/x" });
    expect(() => loadConfig({}, path)).toThrow(/invalid/);
  });

  it("honours XDG_CONFIG_HOME for the token file", () => {
    expect(loadConfig({ XDG_CONFIG_HOME: "/xdg" }, ABSENT_CONFIG).tokenFile).toBe(
      "/xdg/edf/tokens.json",
    );
  });
});
