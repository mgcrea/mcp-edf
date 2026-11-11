import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import { summarizePeriodComparison, summarizeYearComparison } from "#/client/shape";
import { addDays, assertRange, parisMidnight, parisToday } from "#/client/time";
import { scoped, type ToolContext } from "#/tools/index";
import { fromArg, READ_ANNOTATIONS, toArg, wrap } from "#/tools/util";

/** The same date a year earlier; 29 February falls back to the 28th. */
export const yearBefore = (date: string): string => {
  const y = Number(date.slice(0, 4)) - 1;
  const md = date.slice(5) === "02-29" ? "02-28" : date.slice(5);
  return `${y}-${md}`;
};

export const registerComparisonTools = (
  server: McpServer,
  client: EdfClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "edf_compare_years",
    {
      title: "EDF: Compare Years",
      description:
        "Each month of a year against the same month of the year before, from EDF's own comparison: " +
        "kWh and euros both years and the change in %, for electricity or gas. `total_complete_months` " +
        "sums only months present in both years. EDF rounds to whole kWh and euros. These are raw " +
        "figures, NOT weather-adjusted: pair them with edf_get_weather (step=month) to tell a colder " +
        "winter from a change in the home, or use edf_compare_periods for EDF's weather verdict on " +
        "electricity.",
      inputSchema: z.object({
        energy: z.enum(["electricity", "gas"]).describe("Which meter to compare."),
        year: z
          .number()
          .int()
          .min(2015)
          .max(2100)
          .optional()
          .describe(
            "The year to compare with the one before, e.g. 2026. Defaults to the current year.",
          ),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ energy, year }) =>
      wrap(async () => {
        const y = year ?? Number(parisToday(ctx.now()).slice(0, 4));
        return scoped(client, async () => {
          const res = await client.get("/v1/sites/-/monthly-comparisons", {
            year: y,
            fluid: energy === "electricity" ? "ELEC" : "GAS",
          });
          return { energy, ...summarizeYearComparison(res, y) };
        });
      }),
  );

  server.registerTool(
    "edf_compare_periods",
    {
      title: "EDF: Compare Periods",
      description:
        "Electricity used in one period against a reference period (by default the same dates a " +
        "year earlier), with EDF's weather verdict: whether the period was warmer, similar or colder " +
        "than the reference, and whether consumption was higher, similar or lower. Use it to ask " +
        '"did we use more this summer than last, and was it hotter?". The verdict is qualitative and ' +
        'reads temperature only: the kWh are NOT weather-adjusted, and in summer "colder" just means ' +
        "cooler, which lowers a cooling load rather than raising a heating one. Electricity only; " +
        "EDF answers FLUID_NOT_SUPPORTED for gas, " +
        "so use edf_compare_years with energy=gas plus edf_get_weather there.",
      inputSchema: z.object({
        from: fromArg.describe("First day of the period, inclusive, e.g. 2026-06-01."),
        to: toArg.describe(
          "Last day of the period, inclusive, e.g. 2026-08-31. Defaults to yesterday.",
        ),
        reference_from: fromArg
          .optional()
          .describe("First day of the reference period. Defaults to `from` a year earlier."),
        reference_to: fromArg
          .optional()
          .describe(
            "Last day of the reference period, inclusive. Defaults to `to` a year earlier.",
          ),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ from, to, reference_from, reference_to }) =>
      wrap(async () => {
        const period = assertRange(from, to ?? addDays(parisToday(ctx.now()), -1), 400);
        const reference = assertRange(
          reference_from ?? yearBefore(period.from),
          reference_to ?? yearBefore(period.to),
          400,
        );
        return scoped(client, async () => {
          const res = await client.get("/v1/sites/-/consumptions-self-comparison", {
            fluid: "ELEC",
            // The site's monthly view sends SAME_DAYS_MONTH; SHORTEST_PERIOD_LENGTH
            // is the other value of the enum, and the one that fits two
            // arbitrary periods of possibly different lengths.
            strategy: "SHORTEST_PERIOD_LENGTH",
            selectedPeriodBeginTs: parisMidnight(period.from),
            selectedPeriodEndTs: parisMidnight(addDays(period.to, 1)),
            referencePeriodBeginTs: parisMidnight(reference.from),
            referencePeriodEndTs: parisMidnight(addDays(reference.to, 1)),
          });
          return summarizePeriodComparison(res);
        });
      }),
  );
};
