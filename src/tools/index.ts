import type { McpServer } from "@modelcontextprotocol/server";

import type { AuthController } from "#/auth/controller";
import { siteLabel, type EdfClient } from "#/client/edf";
import type { Config } from "#/config";
import { registerAuthTools } from "#/tools/auth";
import { registerContractTools } from "#/tools/contracts";
import { registerElectricityTools } from "#/tools/electricity";
import { registerGasTools } from "#/tools/gas";
import { registerRequestTool } from "#/tools/request";

export type ToolContext = {
  config: Config;
  auth: AuthController;
  /** Injectable clock, so "yesterday" is testable. */
  now: () => number;
};

/**
 * Every tool is registered, always. There is nothing to configure before a
 * login, and the login happens at runtime (edf_auth_login), so gating the data
 * tools on credentials at startup would hide them until a restart. Signed out,
 * they answer with `signedIn: false` and a remedy instead.
 *
 * There are no write tools. Suivi Conso has a few mutating endpoints (meter
 * readings you type in, consumption targets, the home profile) and none of
 * them is wrapped: this server reads.
 */
export const registerTools = (server: McpServer, client: EdfClient, ctx: ToolContext): void => {
  registerAuthTools(server, client, ctx);
  registerContractTools(server, client, ctx);
  registerElectricityTools(server, client, ctx);
  registerGasTools(server, client, ctx);
  registerRequestTool(server, client);
};

/**
 * Stamp the home on a data response. The login picks the account and an account
 * can hold several homes; this is the one field that makes the wrong one
 * visible from inside the conversation.
 */
export const scoped = async <T extends Record<string, unknown>>(
  client: EdfClient,
  fn: () => Promise<T>,
): Promise<{ site: string } & T> => {
  const site = await client.site();
  return { site: siteLabel(site), ...(await fn()) };
};
