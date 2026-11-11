import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import { summarizeDailyGas, summarizeMonthlyGas } from "#/client/shape";
import { addDays, assertRange, monthOf, parisToday } from "#/client/time";
import { scoped, type ToolContext } from "#/tools/index";
import { fromArg, READ_ANNOTATIONS, toArg, wrap } from "#/tools/util";

const MAX_DAYS = { day: 400, month: 1200 } as const;

export const registerGasTools = (server: McpServer, client: EdfClient, ctx: ToolContext): void => {
  server.registerTool(
    "edf_get_gas_consumption",
    {
      title: "EDF: Gas Consumption",
      description:
        "Gas used per day or per month from the Gazpar meter via EDF Suivi Conso: kWh, m³, the " +
        "conversion factor between them, and euros (energy plus the daily share of the " +
        "subscription). `total` sums the range. Costs are EDF's estimate at the contract's prices, " +
        "taxes included. Daily figures need a communicating Gazpar meter and arrive a day or two " +
        "late; months are available further back. Answers 404 on an account with no gas contract.",
      inputSchema: z.object({
        from: fromArg,
        to: toArg,
        step: z
          .enum(["day", "month"])
          .default("day")
          .describe("day: one row per day (at most 400 days). month: one row per calendar month."),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ from, to, step }) =>
      wrap(async () => {
        const range = assertRange(from, to ?? addDays(parisToday(ctx.now()), -1), MAX_DAYS[step]);
        return scoped(client, async () => {
          if (step === "day") {
            // v1, and bare dates: this endpoint rejects ISO timestamps. End exclusive.
            const res = await client.get("/v1/sites/-/smart-daily-gas-consumptions", {
              "begin-date": range.from,
              "end-date": addDays(range.to, 1),
            });
            return { from: range.from, to: range.to, ...summarizeDailyGas(res) };
          }
          const fromMonth = monthOf(range.from);
          const toMonth = monthOf(range.to);
          // v2, YYYY-MM. `ended=false` includes the month in progress.
          const res = await client.get("/v2/sites/-/compositions/monthly-gas-consumptions", {
            "begin-month": fromMonth,
            "end-month": toMonth,
            ended: false,
          });
          return { from: fromMonth, to: toMonth, ...summarizeMonthlyGas(res, fromMonth, toMonth) };
        });
      }),
  );
};
