import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import { summarizeDailyWeather, summarizeMonthlyWeather } from "#/client/shape";
import { addDays, addMonths, assertRange, monthOf, parisToday } from "#/client/time";
import { scoped, type ToolContext } from "#/tools/index";
import { fromArg, READ_ANNOTATIONS, toArg, wrap } from "#/tools/util";

const MAX_DAYS = { day: 400, month: 3700 } as const;

export const registerWeatherTools = (
  server: McpServer,
  client: EdfClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "edf_get_weather",
    {
      title: "EDF: Weather",
      description:
        "The weather at the home's weather station, as Suivi Conso shows it beside the consumption: " +
        "the average outdoor temperature per day (to 0.1 °C) with the sky (sunny, sunny spells, " +
        "overcast, light rain…), or per month (whole °C). Use it to read consumption against the " +
        "weather: heating demand follows the temperature, cooling the heat, and a sunny day lowers " +
        "heating needs. The sky is one coarse label per day; for sunshine hours or solar radiation " +
        "use an external weather archive. Same Paris-time days as the consumption tools, so rows " +
        "line up with edf_get_electricity_consumption and edf_get_gas_consumption.",
      inputSchema: z.object({
        from: fromArg,
        to: toArg,
        step: z
          .enum(["day", "month"])
          .default("day")
          .describe(
            "day: temperature and sky per day (at most 400 days). month: temperature only.",
          ),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ from, to, step }) =>
      wrap(async () => {
        const range = assertRange(from, to ?? addDays(parisToday(ctx.now()), -1), MAX_DAYS[step]);
        return scoped(client, async () => {
          if (step === "day") {
            // v1; bare dates; end exclusive (2026-11-01..2026-11-08 answers 7 days).
            const res = await client.get("/v1/sites/-/daily-weathers", {
              "begin-day": range.from,
              "end-day": addDays(range.to, 1),
            });
            return { from: range.from, to: range.to, ...summarizeDailyWeather(res) };
          }
          const fromMonth = monthOf(range.from);
          const toMonth = monthOf(range.to);
          // v1; YYYY-MM; end exclusive (2025-01..2025-12 answers 11 months).
          const res = await client.get("/v1/sites/-/monthly-temperatures", {
            "begin-month": fromMonth,
            "end-month": addMonths(toMonth, 1),
          });
          return { from: fromMonth, to: toMonth, ...summarizeMonthlyWeather(res) };
        });
      }),
  );
};
