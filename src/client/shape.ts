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
