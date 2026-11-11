import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { EdfClient } from "#/client/edf";
import { READ_ANNOTATIONS, wrap } from "#/tools/util";

/** Upstream answers can be large (elec-pmax is 60 kB); past this, cut and say so. */
const MAX_CHARS = 60_000;

/**
 * `/v1/...` or `/v2/...`, with nothing that could climb out of the API: no
 * `..`, no scheme, no host, no query (that goes in `query`).
 */
const PATH = /^\/v[12]\/[A-Za-z0-9\-_/.]+$/;

export const registerRequestTool = (server: McpServer, client: EdfClient): void => {
  server.registerTool(
    "edf_request",
    {
      title: "EDF: Request",
      description:
        "Escape hatch: GET any Suivi Conso API path for this home, returning the raw JSON (cut at " +
        "60,000 characters). GET only; the same login and home headers as the other tools. Prefer the " +
        "dedicated tools: their output is shaped, this one's is not. Paths seen in the Suivi Conso " +
        "site include /v2/sites/-/elec-price-changes (beginTs, endTs), /v1/sites/-/billing-windows " +
        "(fluids=ELEC,GAS), /v2/sites/-/elec-tariff-calendars (date=2026-11-11, a bare date), /v1/sites/-/usage-breakdowns " +
        "(ts, fluid=ELEC|GAS), /v2/sites/-/forecast-consumptions (beginDate, endDate, fluid, " +
        "strategy=ESTIMATION_AFTER_REAL). `-` stands for the current home. Some endpoints are v1 " +
        "and others v2, and a wrong version answers 404.",
      inputSchema: z.object({
        path: z
          .string()
          .regex(PATH, "A path like /v2/sites/-/elec-pmax: v1 or v2, no query string, no '..'.")
          .refine((p) => !p.split("/").includes(".."), "No '..' segments.")
          .describe(
            "API path under https://suiviconso.edf.fr/api, e.g. /v2/sites/-/elec-tariff-calendars.",
          ),
        query: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Query parameters, e.g. {"date": "2026-11-11"}. Timestamps (beginTs, beginDate, ts) want an ' +
              "offset: 2026-11-01T00:00:00+01:00. v1 begin-date/end-date want 2026-11-01.",
          ),
      }),
      annotations: READ_ANNOTATIONS,
    },
    async ({ path, query }) =>
      wrap(async () => {
        const body = await client.get(path, query);
        const text = JSON.stringify(body);
        if (text.length <= MAX_CHARS) return body;
        return {
          truncated: true,
          total_chars: text.length,
          note: "Cut at 60,000 characters. Narrow the query, or use a dedicated tool.",
          partial: text.slice(0, MAX_CHARS),
        };
      }),
  );
};
