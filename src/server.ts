import { McpServer } from "@modelcontextprotocol/server";

import { safariCapture, type RedirectCapture } from "#/auth/capture";
import { createAuthController, type AuthController } from "#/auth/controller";
import { BUILD_INFO } from "#/build-info";
import type { Logger, TokenProvider } from "#/client/auth";
import { EdfClient } from "#/client/edf";
import { createOAuthClient } from "#/client/oauth";
import { createFileTokenStore, type TokenStore } from "#/client/tokens";
import { API_BASE_URL, type Config } from "#/config";
import { registerTools } from "#/tools/index";

export const SERVER_NAME = BUILD_INFO.name;
export const SERVER_VERSION = BUILD_INFO.version;
export const USER_AGENT = `mcp-edf-js/${BUILD_INFO.version}`;

export type CreateServerOptions = {
  config: Config;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override the token provider (tests). */
  tokenProvider?: TokenProvider;
  /** Override the token store (tests). */
  store?: TokenStore;
  /** Override how the login redirect is caught (tests; the default drives Safari). */
  capture?: RedirectCapture;
  now?: () => number;
};

export type CreatedServer = {
  server: McpServer;
  client: EdfClient;
  auth: AuthController;
};

export const createServer = (opts: CreateServerOptions): CreatedServer => {
  const { config } = opts;
  const now = opts.now ?? Date.now;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const store = opts.store ?? createFileTokenStore(config.tokenFile, opts.logger);
  const oauth = createOAuthClient({
    timeoutMs: config.timeoutMs,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    logger: opts.logger,
  });

  // The controller owns the token provider (it renews through a silent login),
  // and the client needs the provider, so the client comes second. The
  // controller only reaches the client from a callback, after both exist.
  let client: EdfClient | undefined;
  const auth = createAuthController({
    store,
    oauth,
    tokenProvider: opts.tokenProvider,
    capture: opts.capture ?? safariCapture,
    silentRenewal: config.silentRelogin,
    onIdentityChange: () => client?.resetSite(),
    logger: opts.logger,
    now,
  });

  client = new EdfClient({
    baseUrl: API_BASE_URL,
    tokenProvider: auth.tokenProvider,
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    userAgent: USER_AGENT,
    expectedSite: config.site,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    logger: opts.logger,
  });

  registerTools(server, client, { config, auth, now });
  return { server, client, auth };
};
