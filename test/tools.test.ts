import { describe, expect, it } from "vitest";

import { baseRoutes, connect, fixture, jsonResponse, router } from "#test/helpers";

const ALL_TOOLS = [
  "edf_auth_login",
  "edf_auth_logout",
  "edf_auth_status",
  "edf_get_contracts",
  "edf_get_electricity_consumption",
  "edf_get_electricity_load_curve",
  "edf_get_electricity_max_power",
  "edf_get_gas_consumption",
  "edf_request",
];

describe("tool registration", () => {
  // There is nothing to configure before a login, and the login happens at
  // runtime, so the set is the same signed in or out. Adding a tool must be a
  // deliberate act with a visible diff here.
  it("registers the same read-only set signed out", async () => {
    expect(await (await connect({ realAuth: true })).toolNames()).toEqual(ALL_TOOLS);
  });

  it("registers the same set signed in", async () => {
    expect(await (await connect()).toolNames()).toEqual(ALL_TOOLS);
  });

  it("has no write tools at all", async () => {
    const harness = await connect();
    for (const tool of (await harness.client.listTools()).tools) {
      if (tool.name.startsWith("edf_auth_")) continue;
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });
});

describe("signed out", () => {
  // The regression that produces "MCP error -32000: Connection closed": a
  // server that exits on startup takes every tool with it and leaves no way to
  // discover what to do. Here it starts, and says how to log in.
  it("answers edf_auth_status as a setup guide", async () => {
    const res = await (await connect({ realAuth: true })).call("edf_auth_status");
    expect(res.signedIn).toBe(false);
    expect((res.setup as string[]).join(" ")).toContain("edf_auth_login");
  });

  it("answers a data tool with signedIn: false and a remedy, without calling EDF", async () => {
    const harness = await connect({ realAuth: true });
    const res = await harness.call("edf_get_contracts");
    expect(res.isToolError).toBe(true);
    expect(res.signedIn).toBe(false);
    expect(res.remedy).toContain("edf_auth_login");
    expect(harness.callCount()).toBe(0);
  });
});

describe("the home (rule 11)", () => {
  it("sends the site headers the SPA's interceptor adds, and stamps the address", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v2/sites/-/elec-pmax": fixture("elec_pmax") }),
    });
    const res = await harness.call("edf_get_electricity_max_power", {
      from: "2026-11-08",
      to: "2026-11-10",
    });
    expect(res.site).toBe("1 RUE DE L EXEMPLE 75001 PARIS");
    const i = harness.urls().findIndex((u) => u.pathname.endsWith("/elec-pmax"));
    expect(harness.headersAt(i)).toMatchObject({
      Authorization: "Bearer test-token",
      "person-ext-id": "P-0001",
      "site-ext-id": "S-0001",
    });
  });

  it("refuses to read when EDF_SITE names another home", async () => {
    const harness = await connect({ env: { EDF_SITE: "LYON" } });
    const res = await harness.call("edf_get_contracts");
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain('EDF_SITE is "LYON"');
    expect(res.error).toContain("1 RUE DE L EXEMPLE 75001 PARIS");
    expect(harness.urls().map((u) => u.pathname)).toEqual(["/api/v1/client/sites"]);
  });

  it("asks for EDF_SITE when the account has several homes", async () => {
    const two = [
      { personExternalId: "P", siteExternalId: "S1", address: "1 RUE A 75001 PARIS" },
      { personExternalId: "P", siteExternalId: "S2", address: "2 RUE B 69001 LYON" },
    ];
    const res = await (
      await connect({ fetch: router({ "/v1/client/sites": two }) })
    ).call("edf_get_contracts");
    expect(res.error).toContain("2 homes");
    expect(res.remedy).toContain("EDF_SITE");
  });

  it("picks the matching home when EDF_SITE is set", async () => {
    const two = [
      { personExternalId: "P", siteExternalId: "S1", address: "1 RUE A 75001 PARIS" },
      { personExternalId: "P", siteExternalId: "S2", address: "2 RUE B 69001 LYON" },
    ];
    const harness = await connect({
      env: { EDF_SITE: "lyon" },
      fetch: router({ "/v1/client/sites": two, "/v2/sites/-/elec-pmax": [] }),
    });
    const res = await harness.call("edf_get_electricity_max_power", {});
    expect(res.site).toBe("2 RUE B 69001 LYON");
  });
});

const row = (day: string, hp: number, hc: number) => ({
  period: { startTime: `${day}T00:00:00+01:00` },
  energyMeter: { total: hp + hc, byTariffHeading: { HP: hp, HC: hc } },
  cost: {
    total: hp * 0.27 + hc * 0.2 + 1,
    standingCharge: 1,
    byTariffHeading: { HP: hp * 0.27, HC: hc * 0.2 },
  },
  status: "COMPLETE",
  nature: "REAL",
});

describe("edf_get_electricity_consumption", () => {
  it("asks for Paris-midnight days with an offset, end exclusive, and sums the range", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v2/sites/-/consumptions": fixture("consumptions_days") }),
    });
    const res = await harness.call("edf_get_electricity_consumption", {
      from: "2026-10-01",
      to: "2026-10-03",
    });
    const url = harness.urls().find((u) => u.pathname.endsWith("/consumptions"));
    expect(url?.searchParams.get("beginTs")).toBe("2026-10-01T00:00:00+02:00");
    // 2026-10-03 inclusive, so the end is the 4th; still summer time.
    expect(url?.searchParams.get("endTs")).toBe("2026-10-04T00:00:00+02:00");
    // The offset's `+` must travel as %2B, or EDF reads a space.
    expect(url?.search).toContain("%2B02%3A00");
    expect(url?.searchParams.get("stepUnit")).toBe("DAYS");

    expect(res.tariff_headings).toEqual(["BASE"]);
    const rows = res.rows as {
      date: string;
      kwh: number;
      cost_eur: number;
      by_tariff_heading?: unknown;
    }[];
    expect(rows.map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    // A single heading is not repeated per row.
    expect(rows[0]?.by_tariff_heading).toBeUndefined();
    const total = res.total as { kwh: number; avg_price_eur_per_kwh: number };
    expect(total.kwh).toBeCloseTo(
      rows.reduce((s, r) => s + r.kwh, 0),
      2,
    );
    expect(total.avg_price_eur_per_kwh).toBeGreaterThan(0.1);
    expect(total.avg_price_eur_per_kwh).toBeLessThan(0.4);
  });

  it("uses calendar months for step=month", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/consumptions": fixture("consumptions_months"),
      }),
    });
    const res = await harness.call("edf_get_electricity_consumption", {
      from: "2025-11-15",
      to: "2025-12-03",
      step: "month",
    });
    const url = harness.urls().find((u) => u.pathname.endsWith("/consumptions"));
    expect(url?.searchParams.get("beginTs")).toBe("2025-11-01T00:00:00+01:00");
    expect(url?.searchParams.get("endTs")).toBe("2026-01-01T00:00:00+01:00");
    expect(url?.searchParams.get("stepUnit")).toBe("MONTHS");
    expect((res.rows as { date: string }[]).map((r) => r.date)).toEqual(["2025-11", "2025-12"]);
  });

  it("splits by tariff heading on a peak/off-peak contract", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/consumptions": { consumptions: [row("2026-11-01", 10, 5)] },
      }),
    });
    const res = await harness.call("edf_get_electricity_consumption", {
      from: "2026-11-01",
      to: "2026-11-01",
    });
    expect(res.tariff_headings).toEqual(["HC", "HP"]);
    expect((res.rows as { by_tariff_heading: unknown }[])[0]?.by_tariff_heading).toEqual({
      HC: { kwh: 5, eur: 1 },
      HP: { kwh: 10, eur: 2.7 },
    });
  });

  it("defaults `to` to yesterday in Paris and rejects a range that is too long", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v2/sites/-/consumptions": { consumptions: [] } }),
    });
    await harness.call("edf_get_electricity_consumption", { from: "2026-11-01" });
    const url = harness.urls().find((u) => u.pathname.endsWith("/consumptions"));
    expect(url?.searchParams.get("endTs")).toBe("2026-11-11T00:00:00+01:00");

    const res = await harness.call("edf_get_electricity_consumption", {
      from: "2020-01-01",
      to: "2026-01-01",
    });
    expect(res.isToolError).toBe(true);
    expect(res.remedy).toContain("coarser step");
  });

  it("rejects a malformed date at the schema", async () => {
    const res = await (
      await connect()
    ).call("edf_get_electricity_consumption", { from: "01/11/2026" });
    expect(res.isToolError).toBe(true);
  });
});

describe("edf_get_electricity_load_curve", () => {
  it("returns [start, kWh, avg kW] rows and the peak", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/consumptions/load-curve": fixture("load_curve_30m"),
      }),
    });
    const res = await harness.call("edf_get_electricity_load_curve", {
      from: "2026-11-05",
      to: "2026-11-05",
    });
    const url = harness.urls().find((u) => u.pathname.endsWith("/load-curve"));
    expect(url?.searchParams.get("stepUnit")).toBe("MINUTES");
    expect(url?.searchParams.get("stepValue")).toBe("30");
    const rows = res.rows as [string, number, number][];
    expect(rows[0]).toEqual(["2026-11-05T00:00", 0.615, 1.23]);
    expect((res.peak as { avg_kw: number }).avg_kw).toBe(Math.max(...rows.map((r) => r[2])));
  });

  it("caps 30-minute requests at 7 days", async () => {
    const res = await (
      await connect()
    ).call("edf_get_electricity_load_curve", { from: "2026-11-01", to: "2026-11-09" });
    expect(res.isToolError).toBe(true);
    expect(res.error).toContain("at most 7");
  });
});

describe("edf_get_electricity_max_power", () => {
  it("filters the history to the range, in kVA, beside the subscribed power", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/elec-pmax": fixture("elec_pmax"),
        "/v2/sites/-/elec-contracts": fixture("elec_contracts"),
      }),
    });
    const res = await harness.call("edf_get_electricity_max_power", {
      from: "2026-11-08",
      to: "2026-11-10",
    });
    expect(res.rows).toEqual([
      ["2026-11-08", 6.35],
      ["2026-11-09", 11.08],
      ["2026-11-10", 9.17],
    ]);
    expect(res.max).toEqual({ date: "2026-11-09", kva: 11.08 });
    expect(res.subscribed_kva).toBe(12);
    expect(res.history_starts).toBe("2023-11-12");
  });

  it("still answers when the contract lookup fails", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/elec-pmax": fixture("elec_pmax"),
        "/v2/sites/-/elec-contracts": () => jsonResponse({ errorCode: "X" }, { status: 400 }),
      }),
    });
    const res = await harness.call("edf_get_electricity_max_power", {
      from: "2026-11-08",
      to: "2026-11-10",
    });
    expect(res.isToolError).toBe(false);
    expect(res.subscribed_kva).toBeUndefined();
  });
});

describe("edf_get_gas_consumption", () => {
  it("reads days from v1 with bare dates, end exclusive", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v1/sites/-/smart-daily-gas-consumptions": fixture("daily_gas"),
      }),
    });
    const res = await harness.call("edf_get_gas_consumption", {
      from: "2026-10-01",
      to: "2026-10-03",
    });
    const url = harness.urls().find((u) => u.pathname.endsWith("/smart-daily-gas-consumptions"));
    expect(url?.searchParams.get("begin-date")).toBe("2026-10-01");
    expect(url?.searchParams.get("end-date")).toBe("2026-10-04");
    const rows = res.rows as {
      date: string;
      kwh: number;
      m3: number;
      conversion_factor?: number;
    }[];
    expect(rows.map((r) => r.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    // A constant factor is stated once, not per row.
    expect(res.conversion_factor_kwh_per_m3).toBe(11.27084);
    expect(rows[0]?.conversion_factor).toBeUndefined();
    expect((res.total as { m3: number }).m3).toBeCloseTo(
      rows.reduce((s, r) => s + r.m3, 0),
      2,
    );
  });

  it("reads months from v2 with YYYY-MM and keeps only the range", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/compositions/monthly-gas-consumptions": fixture("monthly_gas"),
      }),
    });
    const res = await harness.call("edf_get_gas_consumption", {
      from: "2025-11-01",
      to: "2025-12-31",
      step: "month",
    });
    const url = harness.urls().find((u) => u.pathname.endsWith("/monthly-gas-consumptions"));
    expect(url?.searchParams.get("begin-month")).toBe("2025-11");
    expect(url?.searchParams.get("end-month")).toBe("2025-12");
    expect((res.rows as { date: string }[]).map((r) => r.date)).toEqual(["2025-11", "2025-12"]);
  });
});

describe("edf_get_contracts", () => {
  it("returns the electricity history with the current version, and the gas contract", async () => {
    const harness = await connect({
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/elec-contracts": fixture("elec_contracts"),
        "/v1/sites/-/gas-supply-contracts": fixture("gas_contract"),
      }),
    });
    const res = await harness.call("edf_get_contracts");
    const elec = res.electricity as { current: Record<string, unknown>; history: unknown[] };
    expect(elec.current).toEqual({
      since: "2026-06-25",
      tariff_option: "BASE",
      subscribed_kva: 12,
      tariff_code: "ELEC_PE_ARIANE",
    });
    expect(elec.history).toHaveLength(2);
    expect(res.gas).toEqual({ tariff_code: "GAZ_PF2_KWH_98", option: "CONSO 3", zone: "Z1" });
    const gasUrl = harness.urls().find((u) => u.pathname.endsWith("/gas-supply-contracts"));
    // `ts` must carry a time and an offset: a bare date answers 400.
    expect(gasUrl?.searchParams.get("ts")).toBe("2026-11-11T00:00:00+01:00");
  });

  it("reports gas as null on an electricity-only account", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v2/sites/-/elec-contracts": fixture("elec_contracts") }),
    });
    const res = await harness.call("edf_get_contracts");
    expect(res.isToolError).toBe(false);
    expect(res.gas).toBeNull();
  });

  it("shows the off-peak calendar only when the option uses it", async () => {
    const hphc = {
      contracts: [
        {
          date: "2026-01-01T00:00:00+01:00",
          supplyContractParameters: {
            TARIFF_OPTION: "HPHC",
            SUBSCRIBED_POWER: "9",
            TARIFF: "ELEC_X",
          },
          tariffCalendars: [
            {
              timeRangeByLabels: [
                { label: "HC", ranges: [{ begin: "01:30:00", end: "07:30:00" }] },
              ],
            },
          ],
        },
      ],
    };
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v2/sites/-/elec-contracts": hphc }),
    });
    const res = await harness.call("edf_get_contracts");
    expect(
      (res.electricity as { current: { tariff_calendar: string[] } }).current.tariff_calendar,
    ).toEqual(["HC 01:30-07:30"]);
  });
});

describe("edf_request", () => {
  it("GETs a raw path with the site headers", async () => {
    const harness = await connect({
      fetch: router({ ...baseRoutes(), "/v2/sites/-/elec-tariff-calendars": { ok: 1 } }),
    });
    const res = await harness.call("edf_request", {
      path: "/v2/sites/-/elec-tariff-calendars",
      query: { date: "2026-11-11" },
    });
    expect(res.ok).toBe(1);
    const url = harness.urls().at(-1);
    expect(url?.searchParams.get("date")).toBe("2026-11-11");
  });

  it.each(["/v2/../oauth/token", "https://evil.example/v2/x", "/v3/sites", "/v2/sites?x=1"])(
    "refuses %s",
    async (path) => {
      const harness = await connect();
      const res = await harness.call("edf_request", { path });
      expect(res.isToolError).toBe(true);
      expect(harness.callCount()).toBe(0);
    },
  );
});

/**
 * The contract every tool owes the model, enforced mechanically. A missing
 * `.describe()` is invisible in review and at runtime, and makes the model guess.
 */
describe("tool contract", () => {
  it("gives every tool a service-prefixed title", async () => {
    // `title` is what a host renders in its permission dialog.
    for (const tool of (await (await connect()).client.listTools()).tools) {
      expect(tool.title, tool.name).toMatch(/^EDF: /);
    }
  });

  it("describes every input field", async () => {
    for (const tool of (await (await connect()).client.listTools()).tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(props)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool", async () => {
    for (const tool of (await (await connect()).client.listTools()).tools) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
  });
});
