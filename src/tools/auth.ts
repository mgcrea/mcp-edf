import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { siteLabel, type EdfClient } from "#/client/edf";
import { fileMode } from "#/client/tokens";
import { setupInstructions } from "#/config";
import type { ToolContext } from "#/tools/index";
import { wrap } from "#/tools/util";

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * The auth tools double as the "Authenticate button" for supervisors that have
 * one: Bastion calls status, login and logout with no arguments and reads a
 * top-level boolean `signedIn` from the reply. Keep those shapes stable.
 */
export const registerAuthTools = (server: McpServer, client: EdfClient, ctx: ToolContext): void => {
  server.registerTool(
    "edf_auth_status",
    {
      title: "EDF: Auth Status",
      description:
        "Whether the server is signed in to EDF, which home it reads (the login picks the account, " +
        "and an account can hold several homes), when the login was made, and where it is stored. " +
        "Signed out, returns the steps to sign in. Call this first when a data tool answers " +
        "signedIn: false.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      wrap(async () => {
        const status = ctx.auth.tokenProvider.describe();
        const tokenFile = ctx.auth.store.path;
        const mode = tokenFile ? fileMode(tokenFile) : undefined;
        const pendingUrl = ctx.auth.pendingUrl();
        const lastError = ctx.auth.lastError();
        let site: Record<string, unknown> | undefined;
        if (status.signedIn) {
          try {
            const all = await client.sites();
            const chosen = await client.site();
            site = {
              address: siteLabel(chosen),
              ...(all.length > 1 ? { all_homes: all.map(siteLabel) } : {}),
            };
          } catch (err) {
            site = { error: err instanceof Error ? err.message : String(err) };
            const remedy = (err as { remedy?: unknown }).remedy;
            if (typeof remedy === "string") site.remedy = remedy;
          }
        }
        return {
          signedIn: status.signedIn,
          ...(status.signedIn
            ? {
                site,
                signed_in_at: status.obtainedAt ? iso(status.obtainedAt) : undefined,
                ...(status.accessExpiresAt
                  ? { access_token_expires_at: iso(status.accessExpiresAt) }
                  : {}),
                ...(status.lastError ? { last_refresh_error: status.lastError } : {}),
                note: "The access token lasts 20 minutes and is renewed from the stored refresh token on demand.",
              }
            : { reason: status.reason, setup: setupInstructions() }),
          ...(ctx.config.site ? { expected_site: ctx.config.site } : {}),
          token_source: tokenFile
            ? {
                file: tokenFile,
                mode: mode === undefined ? "absent" : `0${mode.toString(8)}`,
                ...(mode !== undefined && (mode & 0o077) !== 0
                  ? { warning: `Readable by other users. Run: chmod 600 ${tokenFile}` }
                  : {}),
              }
            : "EDF_REFRESH_TOKEN (environment; a login made here lasts until restart)",
          ...(pendingUrl
            ? {
                pending_login: {
                  authorize_url: pendingUrl,
                  note: "Waiting for the login in the Safari tab.",
                },
              }
            : {}),
          ...(lastError ? { last_login_error: lastError } : {}),
        };
      }),
  );

  server.registerTool(
    "edf_auth_login",
    {
      title: "EDF: Login",
      description:
        "Sign in to EDF. On macOS this opens the EDF login in a Safari tab and catches the one-time " +
        "code when EDF redirects back: if Safari is already signed in to EDF it completes in a " +
        "second or two with nothing to do; otherwise Safari comes forward and the user logs in as " +
        "usual. The first run triggers macOS's 'allow to control Safari' prompt. Waits up to " +
        "wait_seconds, then keeps listening in the background for 5 minutes: call edf_auth_status " +
        "afterwards. Elsewhere, pass redirect_url instead (see that argument). Logging in again " +
        "replaces the stored login.",
      inputSchema: z.object({
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(90)
          .describe(
            "How long to wait for the login before returning. Defaults to 90 (MCP calls time out near 120).",
          ),
        redirect_url: z
          .string()
          .optional()
          .describe(
            "Manual fallback, without Safari automation: the full address the browser landed on after " +
              "logging in, https://suiviconso.edf.fr/openid?code=…&state=…. The Suivi Conso page uses and " +
              "erases the code within a second, so it must be copied before the page loads (e.g. with " +
              "JavaScript disabled). Leave unset for the automatic login.",
          ),
      }),
      // Not readOnly (it drives Safari and writes a token file), and not
      // destructive: signing in changes nothing at EDF.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ wait_seconds, redirect_url }) =>
      wrap(async () => {
        if (redirect_url) {
          const tokens = await ctx.auth.completeWithRedirect(redirect_url);
          return {
            signedIn: true,
            signed_in_at: iso(tokens.obtainedAt),
            site: siteLabel(await client.site()),
            note: "No restart needed: the EDF tools use this login from the next call.",
          };
        }
        const outcome = await ctx.auth.login({ waitMs: wait_seconds * 1000 });
        if (outcome.signedIn) {
          let site: string | Record<string, string>;
          try {
            site = siteLabel(await client.site());
          } catch (err) {
            site = { error: err instanceof Error ? err.message : String(err) };
          }
          return {
            signedIn: true,
            signed_in_at: iso(outcome.tokens.obtainedAt),
            site,
            note: "No restart needed: the EDF tools use this login from the next call.",
          };
        }
        if (outcome.pending) {
          return {
            signedIn: false,
            pending: true,
            next_step:
              "Log in in the EDF tab Safari opened, then call edf_auth_status. The login keeps listening for 5 minutes.",
          };
        }
        return {
          signedIn: false,
          pending: false,
          reason: outcome.reason,
          error: outcome.message,
          ...(outcome.reason === "unsupported"
            ? {
                authorize_url: outcome.authorizeUrl,
                next_step:
                  "Open authorize_url, log in, then pass the address you land on as redirect_url.",
              }
            : {}),
        };
      }),
  );

  server.registerTool(
    "edf_auth_logout",
    {
      title: "EDF: Logout",
      description:
        "Revoke the stored refresh token at EDF (best effort) and delete it locally. Recoverable by " +
        "calling edf_auth_login again.",
      // No `confirm`: a supervisor's Sign out calls this with no arguments, and
      // the action is recoverable in the time it takes to log in again.
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      wrap(async () => {
        const { hadLogin, revoked } = await ctx.auth.logout();
        return { signedIn: false, signedOut: hadLogin, revoked_at_edf: revoked };
      }),
  );
};
