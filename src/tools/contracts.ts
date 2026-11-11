import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import { EdfApiError } from "#/client/errors";
import { summarizeElecContracts, summarizeGasContract } from "#/client/shape";
import { addDays, parisMidnight, parisToday } from "#/client/time";
import { scoped, type ToolContext } from "#/tools/index";
import { READ_ANNOTATIONS, wrap } from "#/tools/util";

/** How far back the contract history goes. EDF keeps versions from the start of the contract. */
const HISTORY_YEARS = 10;

export const registerContractTools = (
  server: McpServer,
  client: EdfClient,
  ctx: ToolContext,
): void => {
  server.registerTool(
    "edf_get_contracts",
    {
      title: "EDF: Contracts",
      description:
        "The home's EDF contracts. Electricity: the tariff option (BASE, HPHC for peak/off-peak, " +
        "TEMPO…), the subscribed power in kVA and EDF's tariff code, as a history of versions, " +
        "since EDF writes a new one at every price or option change; `current` is the one in force. " +
        'For options with off-peak hours, the meter\'s calendar (e.g. "HC 01:30-07:00"). Gas: ' +
        "tariff code, consumption option and price zone, or null with no gas contract. Call it to " +
        "learn the option before reading costs by tariff heading.",
      inputSchema: z.object({}),
      annotations: READ_ANNOTATIONS,
    },
    async () =>
      wrap(async () =>
        scoped(client, async () => {
          const today = parisToday(ctx.now());
          const [elec, gas] = await Promise.all([
            client.get("/v2/sites/-/elec-contracts", {
              beginDate: parisMidnight(addDays(today, -365 * HISTORY_YEARS)),
              endDate: parisMidnight(addDays(today, 1)),
              withTariffCalendars: true,
            }),
            // v1, and `ts` must be yyyy-MM-dd'T'HH:mm:ssZ: a bare date answers 400.
            client
              .get("/v1/sites/-/gas-supply-contracts", { ts: parisMidnight(today) })
              .catch((err: unknown) => {
                if (err instanceof EdfApiError && (err.status === 404 || err.status === 204))
                  return null;
                throw err;
              }),
          ]);
          const history = summarizeElecContracts(elec);
          const current = history.filter((c) => c.since <= today).at(-1);
          return {
            electricity: current ? { current, history } : null,
            gas: gas === null ? null : (summarizeGasContract(gas) ?? null),
          };
        }),
      ),
  );
};
