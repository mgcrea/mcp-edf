import { readFileSync } from "node:fs";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import type { RedirectCapture } from "#/auth/capture";
import { staticTokenProvider } from "#/client/auth";
import {
  createMemoryTokenStore,
  TOKEN_FILE_VERSION,
  type StoredTokens,
  type TokenStore,
} from "#/client/tokens";
import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * A path that cannot exist, so the developer's own ~/.config/edf never leaks
 * into the suite: it would pass on the machine that has a login and fail in CI,
 * or the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/edf/config.json";
export const ABSENT_TOKENS = "/nonexistent/edf/tokens.json";

/** 2026-11-11T12:00:00Z: "yesterday" in Paris is 2026-11-10. */
export const NOW = Date.parse("2026-11-11T12:00:00Z");

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

type Route = unknown | ((url: URL, init: RequestInit) => Response | Promise<Response>);

/**
 * A fetch that answers by pathname. An unrouted path answers 404 with Spring's
 * envelope, the way Suivi Conso does, so a test that forgets a route fails loudly.
 */
export const router = (routes: Record<string, Route>) =>
  vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = url.pathname.replace(/^\/api/, "");
    const route = routes[key] ?? routes[url.toString()];
    if (route === undefined) {
      return jsonResponse({ status: 404, error: "Not Found", path: url.pathname }, { status: 404 });
    }
    return typeof route === "function"
      ? (route as (u: URL, i: RequestInit) => Response | Promise<Response>)(url, init)
      : jsonResponse(route);
  });

/** The routes every signed-in data test needs. */
export const baseRoutes = (): Record<string, Route> => ({
  "/v1/client/sites": fixture("sites"),
});

export const signedInTokens = (overrides: Partial<StoredTokens> = {}): StoredTokens => ({
  version: TOKEN_FILE_VERSION,
  refreshToken: "refresh-1",
  accessToken: "access-1",
  expiresAt: NOW + 15 * 60_000,
  obtainedAt: NOW - 3_600_000,
  ...overrides,
});

export const connect = async (
  opts: {
    env?: Record<string, string>;
    fetch?: ReturnType<typeof vi.fn>;
    /** Build the real token provider over `store` instead of a static token. */
    realAuth?: boolean;
    store?: TokenStore;
    capture?: RedirectCapture;
  } = {},
) => {
  const config: Config = loadConfig({ EDF_TOKEN_FILE: ABSENT_TOKENS, ...opts.env }, ABSENT_CONFIG);
  const fetchMock = opts.fetch ?? router(baseRoutes());
  const store = opts.store ?? createMemoryTokenStore(opts.realAuth ? undefined : signedInTokens());
  const capture: RedirectCapture =
    opts.capture ??
    (async () => ({ ok: false, reason: "cancelled", message: "no capture in tests" }));
  const { server } = createServer({
    config,
    fetch: fetchMock as unknown as typeof fetch,
    store,
    capture,
    now: () => NOW,
    ...(opts.realAuth ? {} : { tokenProvider: staticTokenProvider("test-token") }),
  });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const calls = () => fetchMock.mock.calls as [string | URL, RequestInit | undefined][];
  return {
    client,
    store,
    /**
     * Primitives rather than the mock itself: a vitest mock's type drags
     * @vitest/spy internals into this function's inferred return type, and
     * `tsc --noEmit` then fails with TS2883.
     */
    callCount: (): number => calls().length,
    urls: (): URL[] => calls().map((c) => new URL(String(c[0]))),
    headersAt: (index: number): Record<string, string> =>
      Object.fromEntries(
        Object.entries((calls()[index]?.[1]?.headers ?? {}) as Record<string, string>),
      ),
    bodyAt: (index: number): string => String(calls()[index]?.[1]?.body ?? ""),
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body, which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, error: text } as Record<string, unknown>;
      }
    },
  };
};
