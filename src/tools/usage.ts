import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import { isRecord, summarizeMonthlyElecHeating, summarizeUsageBreakdown } from "#/client/shape";
import { addMonths, monthOf, parisMidnight, parisToday } from "#/client/time";
import { scoped, type ToolContext } from "#/tools/index";
import { READ_ANNOTATIONS, wrap } from "#/tools/util";

/**
 * The one profile field that matters most for reading the model: whether the
 * home declares air conditioning. Defensive, because the profile is a deep,
 * undocumented document; anything unexpected yields undefined, not an error.
 */
const declaredAirConditioning = (profile: unknown): boolean | undefined => {
  if (!isRecord(profile) || !isRecord(profile.housing)) return undefined;
  const equipment = profile.housing.equipment;
  if (!isRecord(equipment) || !isRecord(equipment.airConditioning)) return undefined;
  const present = equipment.airConditioning.isACPresent;
  return typeof present === "boolean" ? present : undefined;
};

export const registerUsageTools = (
  server: McpServer,
  client: EdfClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "edf_get_usage_breakdown",
    {
      title: "EDF: Usage Breakdown",
      description:
        "EDF's ESTIMATE of where the energy went over the last 12 months, by use (heating, hot water, " +
        "cooking, fridge and freezer, washing, lighting…), in kWh, euros and %. For electricity it " +
        "adds EDF's estimate of electric heating per month as [month, kWh, €] rows. This is a model " +
        "(`model` names EDF's algorithm) fed by the home profile declared on suiviconso.edf.fr, not " +
        "a measurement: `profile_declares_air_conditioning` shows one profile field that changes it " +
        "most. A profile that predates new equipment skews it, so update the profile on the site " +
        "first. For measured figures use the consumption tools.",
      inputSchema: z.object({
        energy: z.enum(["electricity", "gas"]).describe("Which meter's breakdown."),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ energy }) =>
      wrap(async () => {
        const month = monthOf(parisToday(ctx.now()));
        const ts = parisMidnight(`${month}-01`);
        return scoped(client, async () => {
          const [breakdown, profile, heating] = await Promise.all([
            client.get("/v1/sites/-/usage-breakdowns", {
              ts,
              fluid: energy === "electricity" ? "ELEC" : "GAS",
            }),
            client.get("/v1/sites/-/profiles", { ts, version: "EDELIA" }).catch(() => undefined),
            energy === "electricity"
              ? client
                  .get("/v1/sites/-/monthly-elec-heating-consumptions", {
                    // YYYY-MM, end exclusive: the 12 complete months before this one.
                    "begin-month": addMonths(month, -12),
                    "end-month": month,
                  })
                  .catch(() => undefined)
              : Promise.resolve(undefined),
          ]);
          const ac = declaredAirConditioning(profile);
          return {
            energy,
            ...summarizeUsageBreakdown(breakdown),
            ...(ac !== undefined ? { profile_declares_air_conditioning: ac } : {}),
            ...(heating !== undefined
              ? {
                  monthly_electric_heating: {
                    columns: ["month", "kwh", "cost_eur"],
                    rows: summarizeMonthlyElecHeating(heating),
                  },
                }
              : {}),
          };
        });
      }),
  );
};
