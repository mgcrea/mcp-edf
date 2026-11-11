// The context-window layer. Suivi Conso answers with envelopes built for its
// charts: a period object per row, the same tariff heading repeated in two
// maps, quality flags, index natures. A month of 30-minute steps is 26 kB of
// that. Each shaper keeps what a question about consumption or cost needs,
// rounded to what the meter actually resolves, and adds the totals a model
// would otherwise sum itself (and sometimes get wrong).

import { localMinute } from "#/client/time";

type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
/** kWh to the Wh: the Linky reports whole Wh. */
export const kwh = (value: number): number => Math.round(value * 1000) / 1000;
/** Euros to the cent. */
export const eur = (value: number): number => Math.round(value * 100) / 100;
const price = (cost: number, energy: number): number | undefined =>
  energy > 0 ? Math.round((cost / energy) * 10_000) / 10_000 : undefined;

const byHeading = (value: unknown): Record<string, number> => {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, num(v)]));
};

// ---------------------------------------------------------------- electricity

/** One row of `GET /v2/sites/-/consumptions` (and `/consumptions/load-curve`). */
type V2Consumption = {
  period?: { startTime?: string; endTime?: string };
  energyMeter?: { total?: number; byTariffHeading?: Rec };
  cost?: { total?: number; standingCharge?: number; byTariffHeading?: Rec };
  status?: string;
  nature?: string;
};

type V2Envelope = {
  step?: string;
  consumptions?: V2Consumption[];
  globalConsumption?: V2Consumption;
};

export type ElecStep = "day" | "month";

const headingsOf = (rows: V2Consumption[]): string[] => {
  const all = new Set<string>();
  for (const row of rows)
    for (const k of Object.keys(row.energyMeter?.byTariffHeading ?? {})) all.add(k);
  return [...all].toSorted();
};

const totalsOf = (energy: number, cost: number, standing: number) => {
  const avg = price(cost - standing, energy);
  return {
    kwh: kwh(energy),
    cost_eur: eur(cost),
    energy_cost_eur: eur(cost - standing),
    standing_charge_eur: eur(standing),
    ...(avg !== undefined ? { avg_price_eur_per_kwh: avg } : {}),
  };
};

/**
 * Daily or monthly electricity. `nature` is REAL for metered data, and is
 * reported only when it is not (an estimate, a gap filled from the load curve).
 * `status` likewise only when the period is not COMPLETE, i.e. still running.
 */
export const summarizeElecConsumption = (res: unknown, step: ElecStep) => {
  const env = (isRecord(res) ? res : {}) as V2Envelope;
  const rows = env.consumptions ?? [];
  const headings = headingsOf(rows);
  const split = headings.length > 1;
  const out = rows.map((row) => {
    const start = row.period?.startTime ?? "";
    const e = byHeading(row.energyMeter?.byTariffHeading);
    const c = byHeading(row.cost?.byTariffHeading);
    return {
      date: step === "day" ? start.slice(0, 10) : start.slice(0, 7),
      kwh: kwh(num(row.energyMeter?.total)),
      cost_eur: eur(num(row.cost?.total)),
      standing_charge_eur: eur(num(row.cost?.standingCharge)),
      ...(split
        ? {
            by_tariff_heading: Object.fromEntries(
              headings.map((h) => [h, { kwh: kwh(e[h] ?? 0), eur: eur(c[h] ?? 0) }]),
            ),
          }
        : {}),
      ...(row.nature && row.nature !== "REAL" ? { nature: row.nature } : {}),
      ...(row.status && row.status !== "COMPLETE" ? { status: row.status } : {}),
    };
  });
  const g = env.globalConsumption;
  const energy = g
    ? num(g.energyMeter?.total)
    : rows.reduce((s, r) => s + num(r.energyMeter?.total), 0);
  const cost = g ? num(g.cost?.total) : rows.reduce((s, r) => s + num(r.cost?.total), 0);
  const standing = g
    ? num(g.cost?.standingCharge)
    : rows.reduce((s, r) => s + num(r.cost?.standingCharge), 0);
  return {
    step,
    units: { energy: "kWh", cost: "EUR (EDF's estimate, taxes included)" },
    tariff_headings: headings,
    total: totalsOf(energy, cost, standing),
    rows: out,
  };
};

export type CurveStep = "30m" | "1h";

/**
 * The load curve as `[start, kWh, avg kW]` triples: 48 rows a day at 30
 * minutes, so objects would triple the size for nothing. avg kW is the energy
 * over the interval divided by its length, the figure to compare with the
 * subscribed power.
 */
export const summarizeLoadCurve = (res: unknown, step: CurveStep) => {
  const env = (isRecord(res) ? res : {}) as V2Envelope;
  const hours = step === "30m" ? 0.5 : 1;
  let peak: { start: string; avg_kw: number } | undefined;
  let energy = 0;
  let cost = 0;
  const rows: [string, number, number][] = [];
  for (const row of env.consumptions ?? []) {
    const start = localMinute(row.period?.startTime ?? "");
    const e = num(row.energyMeter?.total);
    const kw = Math.round((e / hours) * 1000) / 1000;
    energy += e;
    cost += num(row.cost?.total);
    rows.push([start, kwh(e), kw]);
    if (!peak || kw > peak.avg_kw) peak = { start, avg_kw: kw };
  }
  return {
    step,
    columns: ["start (Paris time)", "kwh", "avg_kw"],
    total: { kwh: kwh(energy), cost_eur: eur(cost) },
    ...(peak ? { peak } : {}),
    rows,
  };
};

/** `GET /v2/sites/-/elec-pmax`: the whole history in one answer, values in VA. */
export const summarizeMaxPower = (res: unknown, from: string, to: string) => {
  const all = Array.isArray(res) ? (res as { date?: string; value?: number }[]) : [];
  const rows: [string, number][] = [];
  let max: { date: string; kva: number } | undefined;
  for (const item of all) {
    const date = (item.date ?? "").slice(0, 10);
    if (date < from || date > to) continue;
    const kva = Math.round(num(item.value) / 10) / 100;
    rows.push([date, kva]);
    if (!max || kva > max.kva) max = { date, kva };
  }
  const first = all[0]?.date?.slice(0, 10);
  return {
    columns: ["date", "max_kva"],
    ...(max ? { max } : {}),
    ...(first ? { history_starts: first } : {}),
    rows,
  };
};

// ------------------------------------------------------------------------ gas

type GasConsumption = {
  energy?: number;
  energyM3?: number;
  conversionFactor?: number;
  cost?: number;
};

/** One day of `GET /v1/sites/-/smart-daily-gas-consumptions` (a bare array). */
type GasDay = {
  day?: string;
  standingCharge?: number;
  totalCost?: number;
  consumption?: GasConsumption;
};

/** One month of `GET /v2/sites/-/compositions/monthly-gas-consumptions`. */
type GasMonth = GasDay & { month?: string; source?: string; nature?: string };

export type GasStep = "day" | "month";

const gasRows = (items: GasMonth[], step: GasStep) => {
  const factors = new Set(items.map((i) => num(i.consumption?.conversionFactor)));
  const constant = factors.size === 1 ? [...factors][0] : undefined;
  let energy = 0;
  let m3 = 0;
  let cost = 0;
  let standing = 0;
  const rows = items.map((item) => {
    const c = item.consumption ?? {};
    energy += num(c.energy);
    m3 += num(c.energyM3);
    cost += num(item.totalCost);
    standing += num(item.standingCharge);
    return {
      date: step === "day" ? (item.day ?? "") : (item.month ?? ""),
      kwh: kwh(num(c.energy)),
      m3: Math.round(num(c.energyM3) * 100) / 100,
      cost_eur: eur(num(item.totalCost)),
      standing_charge_eur: eur(num(item.standingCharge)),
      ...(constant === undefined ? { conversion_factor: num(c.conversionFactor) } : {}),
      // Monthly gas says "REEL" (French) where electricity says "REAL".
      ...(item.nature && item.nature !== "REEL" && item.nature !== "REAL"
        ? { nature: item.nature }
        : {}),
    };
  });
  return {
    step,
    units: { energy: "kWh", volume: "m³", cost: "EUR (EDF's estimate, taxes included)" },
    ...(constant !== undefined ? { conversion_factor_kwh_per_m3: constant } : {}),
    total: { ...totalsOf(energy, cost, standing), m3: Math.round(m3 * 100) / 100 },
    rows,
  };
};

export const summarizeDailyGas = (res: unknown) =>
  gasRows(Array.isArray(res) ? (res as GasDay[]) : [], "day");

export const summarizeMonthlyGas = (res: unknown, fromMonth: string, toMonth: string) => {
  const env = isRecord(res) ? res : {};
  const months = (
    Array.isArray(env.monthlyGasEnergies) ? (env.monthlyGasEnergies as GasMonth[]) : []
  ).filter((m) => (m.month ?? "") >= fromMonth && (m.month ?? "") <= toMonth);
  return gasRows(months, "month");
};

// ------------------------------------------------------------------ contracts

type ElecContract = {
  date?: string;
  supplyContractParameters?: Record<string, string>;
  tariffCalendars?: {
    date?: string;
    timeRangeByLabels?: { label?: string; ranges?: { begin?: string; end?: string }[] }[];
  }[];
};

/**
 * One entry per contract version, oldest first: EDF writes a new one on every
 * change (tariff "millésime", power, option), so `since` is when each began.
 * The tariff calendar (the meter's off-peak windows) is shown only for options
 * that use it; a BASE contract still has one, because the meter keeps it.
 */
export const summarizeElecContracts = (res: unknown) => {
  const contracts =
    isRecord(res) && Array.isArray(res.contracts) ? (res.contracts as ElecContract[]) : [];
  return contracts
    .map((c) => {
      const p = c.supplyContractParameters ?? {};
      const option = p.TARIFF_OPTION;
      const power = Number(p.SUBSCRIBED_POWER);
      const calendar = (c.tariffCalendars ?? []).at(-1)?.timeRangeByLabels ?? [];
      return {
        since: (c.date ?? "").slice(0, 10),
        ...(option ? { tariff_option: option } : {}),
        ...(Number.isFinite(power) ? { subscribed_kva: power } : {}),
        ...(p.TARIFF ? { tariff_code: p.TARIFF } : {}),
        ...(p.PEAK_LOAD_GROUP && p.PEAK_LOAD_GROUP !== "NO_PEAK_LOAD_GROUP"
          ? { peak_load_group: p.PEAK_LOAD_GROUP }
          : {}),
        ...(option && option !== "BASE" && calendar.length > 0
          ? {
              tariff_calendar: calendar.flatMap((l) =>
                (l.ranges ?? []).map(
                  (r) =>
                    `${l.label ?? "?"} ${(r.begin ?? "").slice(0, 5)}-${(r.end ?? "").slice(0, 5)}`,
                ),
              ),
            }
          : {}),
      };
    })
    .toSorted((a, b) => a.since.localeCompare(b.since));
};

/** `GET /v1/sites/-/gas-supply-contracts?ts=…`: the contract in force at `ts`. */
export const summarizeGasContract = (res: unknown) => {
  if (!isRecord(res)) return undefined;
  const pick = (k: string): string | undefined =>
    typeof res[k] === "string" ? (res[k] as string) : undefined;
  const tariff = pick("tariff");
  const option = pick("option");
  const zone = pick("zone");
  return {
    ...(tariff ? { tariff_code: tariff } : {}),
    ...(option ? { option } : {}),
    ...(zone ? { zone } : {}),
  };
};

// -------------------------------------------------------------------- weather

/**
 * Suivi Conso's weather pictograms (`picto`), from the site's French
 * translations (`weather_picto_P4_description` = "Belles éclaircies"). The
 * weather is the home's nearest station, as the site shows it under the
 * consumption chart: one average temperature and one sky per day.
 */
export const SKY_BY_PICTO: Record<string, string> = {
  P1: "sunny",
  P2: "hazy sun",
  P3: "cloudy",
  P4: "sunny spells",
  P5: "brief sunny spells",
  P6: "overcast",
  P7: "occasional showers",
  P8: "light rain",
  P9: "heavy rain",
  P10: "light snow",
  P11: "snow",
  P12: "heavy snow",
  P13: "isolated thunderstorms",
  P14: "thunderstorms",
  P15: "fog",
  P16: "freezing fog",
  P17: "black ice",
};

const roundTenth = (value: number): number => Math.round(value * 10) / 10;

const tempSummary = (temps: { date: string; t: number }[]) => {
  if (temps.length === 0) return {};
  const coldest = temps.reduce((a, b) => (b.t < a.t ? b : a));
  const warmest = temps.reduce((a, b) => (b.t > a.t ? b : a));
  return {
    avg_temp_c: roundTenth(temps.reduce((s, x) => s + x.t, 0) / temps.length),
    coldest: { date: coldest.date, temp_c: coldest.t },
    warmest: { date: warmest.date, temp_c: warmest.t },
  };
};

/** `GET /v1/sites/-/daily-weathers`: `[{day, valueWithDecimal, value, picto}]`. */
export const summarizeDailyWeather = (res: unknown) => {
  const days = Array.isArray(res)
    ? (res as { day?: string; valueWithDecimal?: number; value?: number; picto?: string }[])
    : [];
  const rows: [string, number | null, string | null][] = days.map((d) => {
    const t = typeof d.valueWithDecimal === "number" ? d.valueWithDecimal : d.value;
    return [
      d.day ?? "",
      typeof t === "number" ? roundTenth(t) : null,
      d.picto ? (SKY_BY_PICTO[d.picto] ?? d.picto) : null,
    ];
  });
  return {
    step: "day",
    columns: ["date", "avg_temp_c", "sky"],
    ...tempSummary(rows.flatMap(([date, t]) => (t === null ? [] : [{ date, t }]))),
    rows,
  };
};

/** `GET /v1/sites/-/monthly-temperatures`: `[{month, value}]`, whole degrees. */
export const summarizeMonthlyWeather = (res: unknown) => {
  const months = Array.isArray(res) ? (res as { month?: string; value?: number }[]) : [];
  const rows: [string, number | null][] = months.map((m) => [
    m.month ?? "",
    typeof m.value === "number" ? m.value : null,
  ]);
  return {
    step: "month",
    columns: ["month", "avg_temp_c"],
    ...tempSummary(rows.flatMap(([date, t]) => (t === null ? [] : [{ date, t }]))),
    rows,
  };
};

// ---------------------------------------------------------------- comparisons

type YearPoint = { energy?: number; totalCost?: number };
type MonthComparison = {
  month?: number;
  currentYearMonthConsumption?: YearPoint;
  previousYearMonthConsumption?: YearPoint;
  isFullMonth?: boolean;
  energyDifferenceRate?: number;
  totalCostDifferenceRate?: number;
};

const pct = (now: number, before: number): number | null =>
  before > 0 ? Math.round(((now - before) / before) * 1000) / 10 : null;

/**
 * `GET /v1/sites/-/monthly-comparisons?year&fluid`: each month of `year` against
 * the same month a year earlier. EDF rounds these to whole kWh and euros. The
 * totals cover only months present in both years, so a half-finished month or a
 * month with no data last year cannot skew the comparison.
 */
export const summarizeYearComparison = (res: unknown, year: number) => {
  const months = Array.isArray(res) ? (res as MonthComparison[]) : [];
  let now = 0;
  let before = 0;
  let nowCost = 0;
  let beforeCost = 0;
  const rows = months.map((m) => {
    const cur = m.currentYearMonthConsumption ?? {};
    const prev = m.previousYearMonthConsumption ?? {};
    const hasBoth = typeof cur.energy === "number" && typeof prev.energy === "number";
    if (hasBoth && m.isFullMonth !== false) {
      now += num(cur.energy);
      before += num(prev.energy);
      nowCost += num(cur.totalCost);
      beforeCost += num(prev.totalCost);
    }
    return {
      month: `${year}-${String(m.month ?? 0).padStart(2, "0")}`,
      kwh: typeof cur.energy === "number" ? cur.energy : null,
      kwh_previous_year: typeof prev.energy === "number" ? prev.energy : null,
      kwh_change_pct: m.energyDifferenceRate ?? null,
      cost_eur: typeof cur.totalCost === "number" ? cur.totalCost : null,
      cost_previous_year_eur: typeof prev.totalCost === "number" ? prev.totalCost : null,
      cost_change_pct: m.totalCostDifferenceRate ?? null,
      ...(m.isFullMonth === false ? { partial_month: true } : {}),
    };
  });
  return {
    year,
    previous_year: year - 1,
    total_complete_months: {
      kwh: now,
      kwh_previous_year: before,
      kwh_change_pct: pct(now, before),
      cost_eur: nowCost,
      cost_previous_year_eur: beforeCost,
      cost_change_pct: pct(nowCost, beforeCost),
    },
    rows,
  };
};

/**
 * EDF's verdict on a period comparison, e.g. `COLDER_WEATHER_HIGHER_CONSO`:
 * whether the period was warmer or colder than the reference, and whether
 * consumption went up or down. It is a qualitative reading, not a correction:
 * the kWh themselves are not weather-adjusted.
 */
export const parseWeatherVerdict = (code: unknown) => {
  if (typeof code !== "string") return undefined;
  const m = /^(WARMER|NEUTRAL|COLDER)_WEATHER_(HIGHER|NEUTRAL|LOWER)_CONSO$/.exec(code);
  if (!m) return { code };
  const weather = { WARMER: "warmer", NEUTRAL: "similar", COLDER: "colder" }[m[1] as string];
  const consumption = { HIGHER: "higher", NEUTRAL: "similar", LOWER: "lower" }[m[2] as string];
  return { weather, consumption, code };
};

type PeriodSide = {
  period?: { startTime?: string; endTime?: string };
  cost?: { total?: number };
  energyMeter?: { total?: number };
  errorFlags?: unknown[];
};

const rate = (v: number | undefined): number | null =>
  typeof v === "number" ? Math.round(v * 10) / 10 : null;

/** `GET /v1/sites/-/consumptions-self-comparison`: one comparison of two periods. */
export const summarizePeriodComparison = (res: unknown) => {
  const c = (isRecord(res) && Array.isArray(res.comparisons) ? res.comparisons[0] : undefined) as
    | {
        selectedPeriod?: PeriodSide;
        referencePeriod?: PeriodSide;
        weatherImpactMessageCode?: string;
        differenceRate?: { cost?: { total?: number }; energyMeter?: { total?: number } };
      }
    | undefined;
  if (!c) return { comparison: null };
  const side = (s: PeriodSide | undefined) => ({
    from: (s?.period?.startTime ?? "").slice(0, 10),
    to_exclusive: (s?.period?.endTime ?? "").slice(0, 10),
    kwh: kwh(num(s?.energyMeter?.total)),
    cost_eur: eur(num(s?.cost?.total)),
    ...(s?.errorFlags && s.errorFlags.length > 0 ? { error_flags: s.errorFlags } : {}),
  });
  return {
    period: side(c.selectedPeriod),
    reference: side(c.referencePeriod),
    kwh_change_pct: rate(c.differenceRate?.energyMeter?.total),
    cost_change_pct: rate(c.differenceRate?.cost?.total),
    ...(c.weatherImpactMessageCode
      ? { weather_verdict: parseWeatherVerdict(c.weatherImpactMessageCode) }
      : {}),
  };
};

// -------------------------------------------------------------------- usages

type UsageEntry = {
  usage?: string;
  cost?: number;
  percent?: number;
  energy?: number;
  fiability?: { isReliable?: boolean };
};

/**
 * `GET /v1/sites/-/usage-breakdowns?ts&fluid`: EDF's MODEL of where the energy
 * went over the 12 months to `ts` (`algorithm` names it, e.g.
 * MIX_DISAGGREGATION_SIMFAST). It leans on the home profile declared in Suivi
 * Conso, so it is only as current as that profile.
 */
export const summarizeUsageBreakdown = (res: unknown) => {
  const env = isRecord(res) ? res : {};
  const entries = Array.isArray(env.usageBreakdowns) ? (env.usageBreakdowns as UsageEntry[]) : [];
  return {
    from_month: typeof env.beginMonth === "string" ? env.beginMonth : null,
    to_month_exclusive: typeof env.endMonth === "string" ? env.endMonth : null,
    model: typeof env.algorithm === "string" ? env.algorithm : null,
    total: { kwh: num(env.totalEnergy), cost_eur: num(env.totalCost) },
    usages: entries
      .map((u) => ({
        usage: (u.usage ?? "").replace(/^US_/, "").toLowerCase(),
        kwh: num(u.energy),
        cost_eur: num(u.cost),
        percent: num(u.percent),
        ...(u.fiability?.isReliable === false ? { reliable: false } : {}),
      }))
      .toSorted((a, b) => b.kwh - a.kwh),
  };
};

/** `GET /v1/sites/-/monthly-elec-heating-consumptions`: EDF's monthly estimate of electric heating. */
export const summarizeMonthlyElecHeating = (res: unknown) => {
  const months = Array.isArray(res)
    ? (res as { month?: string; energy?: number; cost?: number }[])
    : [];
  // costVariationRelatedToMeteorology / …ToComfort are left out on purpose:
  // they come as large opposite numbers (-2039 / +2065 for a 26 € change on
  // 2026-11-11) whose unit and meaning are not documented anywhere.
  return months.map((m): [string, number, number] => [m.month ?? "", num(m.energy), num(m.cost)]);
};
