import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import {
  summarizeElecConsumption,
  summarizeElecContracts,
  summarizeLoadCurve,
  summarizeMaxPower,
} from "#/client/shape";
import { addDays, addMonths, assertRange, monthOf, parisMidnight, parisToday } from "#/client/time";
import { scoped, type ToolContext } from "#/tools/index";
import { fromArg, READ_ANNOTATIONS, toArg, wrap } from "#/tools/util";

/** Ranges: a year of days, three years of months. Wider than that, ask for a coarser step. */
const MAX_DAYS = { day: 400, month: 1200 } as const;
const MAX_CURVE_DAYS = { "30m": 7, "1h": 31 } as const;

export const registerElectricityTools = (
  server: McpServer,
  client: EdfClient,
  ctx: ToolContext,
): void => {
  const yesterday = (): string => addDays(parisToday(ctx.now()), -1);

  server.registerTool(
    "edf_get_electricity_consumption",
    {
      title: "EDF: Electricity Consumption",
      description:
        "Electricity used per day or per month, in kWh and in euros, from the Linky meter via EDF " +
        "Suivi Conso. Each row has the total cost, the daily share of the subscription " +
        "(standing_charge_eur), and, on a peak/off-peak or Tempo contract, the split by tariff " +
        "heading. `total` sums the range and gives the average price per kWh. Costs are EDF's own " +
        "estimate at the contract's prices, taxes included; they track the bill closely but are not " +
        "the invoice. Rows flagged `nature` other than REAL are estimates. Use step=month for " +
        "anything over a few months: a year of days is ~25 kB.",
      inputSchema: z.object({
        from: fromArg,
        to: toArg,
        step: z
          .enum(["day", "month"])
          .default("day")
          .describe(
            "day: one row per day (at most 400 days). month: one row per calendar month (at most ~3 years).",
          ),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ from, to, step }) =>
      wrap(async () => {
        const range = assertRange(from, to ?? yesterday(), MAX_DAYS[step]);
        const begin = step === "day" ? range.from : `${monthOf(range.from)}-01`;
        const end = step === "day" ? addDays(range.to, 1) : `${addMonths(monthOf(range.to), 1)}-01`;
        return scoped(client, async () => {
          const res = await client.get("/v2/sites/-/consumptions", {
            beginTs: parisMidnight(begin),
            endTs: parisMidnight(end),
            stepUnit: step === "day" ? "DAYS" : "MONTHS",
            stepValue: 1,
            withEstimated: "SURROUNDING_ESTIMATED",
            // Fills a day the daily index missed from the 30-minute curve, as the site does.
            withLoadCurveCompletion: true,
            isGlobalConsumptionWanted: true,
          });
          return { from: range.from, to: range.to, ...summarizeElecConsumption(res, step) };
        });
      }),
  );

  server.registerTool(
    "edf_get_electricity_load_curve",
    {
      title: "EDF: Electricity Load Curve",
      description:
        "The Linky load curve: energy per 30 minutes (or per hour) as compact rows of " +
        "[start, kWh, average kW], with the range total and the peak interval. Use it to see when " +
        "power is drawn (night vs day, a heater, a car charging); use " +
        "edf_get_electricity_consumption for daily or monthly totals and costs. Paris local times. " +
        "At most 7 days at 30m, 31 days at 1h, since a single day is 48 rows. The curve only exists " +
        "if load-curve collection is switched on for the meter (it is on Suivi Conso's hourly view).",
      inputSchema: z.object({
        from: fromArg,
        to: toArg,
        resolution: z
          .enum(["30m", "1h"])
          .default("30m")
          .describe(
            "30m: the meter's native step (at most 7 days). 1h: hourly sums (at most 31 days).",
          ),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ from, to, resolution }) =>
      wrap(async () => {
        const range = assertRange(from, to ?? yesterday(), MAX_CURVE_DAYS[resolution]);
        return scoped(client, async () => {
          const res = await client.get("/v2/sites/-/consumptions/load-curve", {
            beginTs: parisMidnight(range.from),
            endTs: parisMidnight(addDays(range.to, 1)),
            stepUnit: resolution === "30m" ? "MINUTES" : "HOURS",
            stepValue: resolution === "30m" ? 30 : 1,
          });
          return { from: range.from, to: range.to, ...summarizeLoadCurve(res, resolution) };
        });
      }),
  );

  server.registerTool(
    "edf_get_electricity_max_power",
    {
      title: "EDF: Electricity Max Power",
      description:
        "The highest power drawn each day, in kVA, as [date, max_kva] rows, with the range maximum " +
        "and the subscribed power of the current contract to compare against. Use it to decide " +
        "whether the subscription (e.g. 6, 9, 12 kVA) is too high or close to tripping. The meter's " +
        "history goes back years; this filters it to the range asked.",
      inputSchema: z.object({
        from: fromArg
          .optional()
          .describe("First day, inclusive, YYYY-MM-DD. Defaults to 30 days before `to`."),
        to: toArg,
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ from, to }) =>
      wrap(async () => {
        const end = to ?? yesterday();
        const range = assertRange(from ?? addDays(end, -29), end, 1200);
        return scoped(client, async () => {
          // One call returns the whole history (938 days on a 2023 meter), so
          // filtering is ours. The contract is fetched alongside for the
          // subscribed power; a failure there must not lose the power data.
          const today = parisToday(ctx.now());
          const [pmax, contracts] = await Promise.all([
            client.get("/v2/sites/-/elec-pmax"),
            client
              .get("/v2/sites/-/elec-contracts", {
                beginDate: parisMidnight(addDays(today, -1)),
                endDate: parisMidnight(addDays(today, 1)),
                withTariffCalendars: false,
              })
              .catch(() => undefined),
          ]);
          const subscribed = summarizeElecContracts(contracts).at(-1)?.subscribed_kva;
          return {
            from: range.from,
            to: range.to,
            ...(subscribed !== undefined ? { subscribed_kva: subscribed } : {}),
            ...summarizeMaxPower(pmax, range.from, range.to),
          };
        });
      }),
  );
};
