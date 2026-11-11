import { describe, expect, it } from "vitest";

import { parseWeatherVerdict } from "#/client/shape";
import { yearBefore } from "#/tools/comparisons";
import { baseRoutes, connect, fixture, router } from "#test/helpers";

describe("edf_get_weather", () => {
  it("reads days from v1 with bare dates, end exclusive, and names the sky", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v1/sites/-/daily-weathers": fixture("daily_weathers") }),
    });
    const res = await harness.call("edf_get_weather", { from: "2026-11-01", to: "2026-11-03" });
    const url = harness.urls().find((u) => u.pathname.endsWith("/daily-weathers"));
    expect(url?.searchParams.get("begin-day")).toBe("2026-11-01");
    expect(url?.searchParams.get("end-day")).toBe("2026-11-04");
    expect(res.rows).toEqual([
      ["2026-11-01", 9, "sunny"],
      ["2026-11-02", 8.6, "overcast"],
      ["2026-11-03", 7.5, "overcast"],
    ]);
    expect(res).toMatchObject({ coldest: { date: "2026-11-03", temp_c: 7.5 }, avg_temp_c: 8.4 });
    expect(res.site).toBe("1 RUE DE L EXEMPLE 75001 PARIS");
  });

  it("reads months with YYYY-MM, end exclusive", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v1/sites/-/monthly-temperatures": fixture("monthly_temperatures"),
      }),
    });
    const res = await harness.call("edf_get_weather", {
      from: "2025-11-01",
      to: "2026-01-31",
      step: "month",
    });
    const url = harness.urls().find((u) => u.pathname.endsWith("/monthly-temperatures"));
    expect(url?.searchParams.get("begin-month")).toBe("2025-11");
    expect(url?.searchParams.get("end-month")).toBe("2026-02");
    expect(res.rows).toEqual([
      ["2025-11", 8],
      ["2025-12", 6],
      ["2026-01", 5],
    ]);
  });
});

describe("edf_compare_years", () => {
  it("compares each month with last year and totals complete months only", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v1/sites/-/monthly-comparisons": fixture("monthly_comparisons"),
      }),
    });
    const res = await harness.call("edf_compare_years", { energy: "electricity" });
    const url = harness.urls().find((u) => u.pathname.endsWith("/monthly-comparisons"));
    // Defaults to the current year in Paris.
    expect(url?.searchParams.get("year")).toBe("2026");
    expect(url?.searchParams.get("fluid")).toBe("ELEC");
    const rows = res.rows as { month: string; partial_month?: boolean }[];
    expect(rows.map((r) => r.month)).toEqual(["2026-01", "2026-02", "2026-11"]);
    expect(rows[2]?.partial_month).toBe(true);
    // January and February only: the running month would skew it.
    expect(res.total_complete_months).toMatchObject({
      kwh: 1148 + 815,
      kwh_previous_year: 1079 + 1013,
      kwh_change_pct: -6.2,
    });
  });

  it("asks for GAS and the year given", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v1/sites/-/monthly-comparisons": [] }),
    });
    await harness.call("edf_compare_years", { energy: "gas", year: 2025 });
    const url = harness.urls().find((u) => u.pathname.endsWith("/monthly-comparisons"));
    expect(url?.searchParams.get("fluid")).toBe("GAS");
    expect(url?.searchParams.get("year")).toBe("2025");
  });
});

describe("edf_compare_periods", () => {
  it("defaults the reference to the same dates a year earlier, with Paris offsets", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v1/sites/-/consumptions-self-comparison": fixture("self_comparison"),
      }),
    });
    const res = await harness.call("edf_compare_periods", { from: "2026-10-01", to: "2026-10-31" });
    const url = harness.urls().find((u) => u.pathname.endsWith("/consumptions-self-comparison"));
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      fluid: "ELEC",
      strategy: "SHORTEST_PERIOD_LENGTH",
      selectedPeriodBeginTs: "2026-10-01T00:00:00+02:00",
      selectedPeriodEndTs: "2026-11-01T00:00:00+01:00",
      referencePeriodBeginTs: "2025-10-01T00:00:00+02:00",
      referencePeriodEndTs: "2025-11-01T00:00:00+01:00",
    });
    expect(res).toMatchObject({
      period: { from: "2026-10-01", kwh: 758.607, cost_eur: 182.63 },
      reference: { from: "2025-10-01", kwh: 818.962 },
      kwh_change_pct: -7.4,
      weather_verdict: { weather: "similar", consumption: "lower" },
    });
  });

  it("reads EDF's verdict codes, and passes an unknown one through", () => {
    expect(parseWeatherVerdict("COLDER_WEATHER_HIGHER_CONSO")).toMatchObject({
      weather: "colder",
      consumption: "higher",
    });
    expect(parseWeatherVerdict("BAD_INDEX_INFORMATION_OR_CONTRACT_CHANGE_MISSING")).toEqual({
      code: "BAD_INDEX_INFORMATION_OR_CONTRACT_CHANGE_MISSING",
    });
  });

  it("maps 29 February to the 28th a year earlier", () => {
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
    expect(yearBefore("2026-06-01")).toBe("2025-06-01");
  });
});

describe("edf_get_usage_breakdown", () => {
  it("returns EDF's model by use, the declared AC, and monthly electric heating", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v1/sites/-/usage-breakdowns": fixture("usage_elec"),
        "/v1/sites/-/profiles": fixture("profile"),
        "/v1/sites/-/monthly-elec-heating-consumptions": fixture("monthly_elec_heating"),
      }),
    });
    const res = await harness.call("edf_get_usage_breakdown", { energy: "electricity" });
    const usages = res.usages as { usage: string; kwh: number }[];
    expect(usages.map((u) => u.usage)).toContain("heating");
    // Largest first.
    expect(usages.map((u) => u.kwh)).toEqual(usages.map((u) => u.kwh).toSorted((a, b) => b - a));
    expect(res.model).toBe("MIX_DISAGGREGATION_SIMFAST");
    expect(res.profile_declares_air_conditioning).toBe(false);
    expect((res.monthly_electric_heating as { rows: unknown[] }).rows[0]).toEqual([
      "2025-11",
      472,
      115,
    ]);
    const heating = harness
      .urls()
      .find((u) => u.pathname.endsWith("/monthly-elec-heating-consumptions"));
    expect(heating?.searchParams.get("begin-month")).toBe("2025-11");
    expect(heating?.searchParams.get("end-month")).toBe("2026-11");
  });

  it("skips the electric-heating series for gas, and survives a missing profile", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v1/sites/-/usage-breakdowns": fixture("usage_elec") }),
    });
    const res = await harness.call("edf_get_usage_breakdown", { energy: "gas" });
    expect(res.isToolError).toBe(false);
    expect(res.monthly_electric_heating).toBeUndefined();
    expect(res.profile_declares_air_conditioning).toBeUndefined();
    expect(
      harness.urls().some((u) => u.pathname.endsWith("/monthly-elec-heating-consumptions")),
    ).toBe(false);
  });
});
