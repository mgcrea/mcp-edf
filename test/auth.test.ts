import { describe, expect, it, vi } from "vitest";

import { buildCaptureScript, type RedirectCapture } from "#/auth/capture";
import { parseRedirect } from "#/auth/controller";
import { createMemoryTokenStore } from "#/client/tokens";
import {
  baseRoutes,
  connect,
  fixture,
  jsonResponse,
  NOW,
  router,
  signedInTokens,
} from "#test/helpers";

const TOKEN_URL = "https://espace-client.edf.fr/sso/oauth2/INTERNET/access_token";
const REVOKE_URL = "https://espace-client.edf.fr/sso/oauth2/INTERNET/token/revoke";

/** A capture that "lands" on the redirect with whatever state the login asked for. */
const landingWith =
  (code: string, stateOverride?: string): RedirectCapture =>
  async ({ authorizeUrl }) => {
    const state = stateOverride ?? new URL(authorizeUrl).searchParams.get("state");
    return { ok: true, url: `https://suiviconso.edf.fr/openid?code=${code}&state=${state}` };
  };

const tokenEndpoint =
  (onForm: (form: URLSearchParams) => Response) => (_url: URL, init: RequestInit) =>
    onForm(new URLSearchParams(String(init.body)));

const never: RedirectCapture = () => new Promise(() => {});

const denied: RedirectCapture = async () => ({
  ok: false,
  reason: "not_authorized",
  message: "allow it",
});

describe("edf_auth_login (automatic)", () => {
  it("asks EDF for the Suivi Conso client, catches the code, and stores the refresh token", async () => {
    let authorizeUrl = "";
    const store = createMemoryTokenStore(undefined);
    const harness = await connect({
      realAuth: true,
      store,
      capture: async (opts) => {
        authorizeUrl = opts.authorizeUrl;
        return landingWith("CODE-1")(opts);
      },
      fetch: router({
        ...baseRoutes(),
        [TOKEN_URL]: tokenEndpoint((form) => {
          expect(form.get("grant_type")).toBe("authorization_code");
          expect(form.get("code")).toBe("CODE-1");
          expect(form.get("client_id")).toBe("equilibre-portal-v2");
          expect(form.get("redirect_uri")).toBe("https://suiviconso.edf.fr/openid");
          // A public client: no secret travels.
          expect(form.has("client_secret")).toBe(false);
          return jsonResponse({
            access_token: "A1",
            refresh_token: "R1",
            expires_in: 1199,
            token_type: "Bearer",
          });
        }),
      }),
    });

    const res = await harness.call("edf_auth_login", { wait_seconds: 5 });
    expect(res.signedIn).toBe(true);
    expect(res.site).toBe("1 RUE DE L EXEMPLE 75001 PARIS");
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://espace-client.edf.fr/sso/oauth2/INTERNET/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("equilibre-portal-v2");
    expect(url.searchParams.get("scope")).toBe("b2c_business_process b2c_services");
    expect(store.read()).toMatchObject({
      refreshToken: "R1",
      accessToken: "A1",
      expiresAt: NOW + 1_199_000,
    });

    const status = await harness.call("edf_auth_status");
    expect(status.signedIn).toBe(true);
    expect((status.site as { address: string }).address).toBe("1 RUE DE L EXEMPLE 75001 PARIS");
  });

  it("refuses a redirect whose state belongs to another attempt", async () => {
    const store = createMemoryTokenStore(undefined);
    const harness = await connect({
      realAuth: true,
      store,
      capture: landingWith("CODE-1", "someone-else"),
    });
    const res = await harness.call("edf_auth_login", { wait_seconds: 5 });
    expect(res.signedIn).toBe(false);
    expect(res.error).toContain("state mismatch");
    expect(store.read()).toBeUndefined();
  });

  it("returns pending when the human has not finished, and reports not_authorized plainly", async () => {
    const pending = await (
      await connect({ realAuth: true, capture: never })
    ).call("edf_auth_login", { wait_seconds: 0 });
    expect(pending).toMatchObject({ signedIn: false, pending: true });
    const res = await (
      await connect({ realAuth: true, capture: denied })
    ).call("edf_auth_login", { wait_seconds: 5 });
    expect(res).toMatchObject({ signedIn: false, pending: false, reason: "not_authorized" });
  });
});

describe("edf_auth_login (manual redirect_url)", () => {
  it("exchanges a pasted redirect URL", async () => {
    const store = createMemoryTokenStore(undefined);
    const harness = await connect({
      realAuth: true,
      store,
      fetch: router({
        ...baseRoutes(),
        [TOKEN_URL]: () =>
          jsonResponse({ access_token: "A1", refresh_token: "R1", expires_in: 1199 }),
      }),
    });
    const res = await harness.call("edf_auth_login", {
      redirect_url: "https://suiviconso.edf.fr/openid?code=PASTED&state=whatever",
    });
    expect(res.signedIn).toBe(true);
    expect(store.read()?.refreshToken).toBe("R1");
  });

  it("explains a URL the SPA already stripped", () => {
    expect(() => parseRedirect("https://suiviconso.edf.fr/openid", undefined)).toThrow(/no code/);
    expect(() => parseRedirect("https://evil.example/openid?code=x", undefined)).toThrow(
      /must start with/,
    );
  });
});

describe("the token provider", () => {
  it("refreshes an expired access token and keeps the refresh token EDF does not rotate", async () => {
    const store = createMemoryTokenStore(
      signedInTokens({ accessToken: "OLD", expiresAt: NOW - 1 }),
    );
    const harness = await connect({
      realAuth: true,
      store,
      fetch: router({
        ...baseRoutes(),
        "/v2/sites/-/elec-pmax": fixture("elec_pmax"),
        [TOKEN_URL]: tokenEndpoint((form) => {
          expect(form.get("grant_type")).toBe("refresh_token");
          expect(form.get("refresh_token")).toBe("refresh-1");
          // EDF answers a refresh without a new refresh_token.
          return jsonResponse({ access_token: "NEW", expires_in: 1199 });
        }),
      }),
    });
    const res = await harness.call("edf_get_electricity_max_power", {
      from: "2026-11-08",
      to: "2026-11-10",
    });
    expect(res.isToolError).toBe(false);
    expect(store.read()).toMatchObject({ refreshToken: "refresh-1", accessToken: "NEW" });
    const api = harness.urls().findIndex((u) => u.pathname.endsWith("/elec-pmax"));
    expect(harness.headersAt(api).Authorization).toBe("Bearer NEW");
    // One refresh for the burst (sites + pmax + contract), not one per call.
    expect(harness.urls().filter((u) => u.toString() === TOKEN_URL)).toHaveLength(1);
  });

  it("turns invalid_grant into signedIn: false with the login remedy", async () => {
    const store = createMemoryTokenStore(signedInTokens({ accessToken: undefined, expiresAt: 0 }));
    const harness = await connect({
      realAuth: true,
      store,
      fetch: router({
        [TOKEN_URL]: () =>
          jsonResponse(
            { error: "invalid_grant", error_description: "grant is invalid" },
            { status: 400 },
          ),
      }),
    });
    const res = await harness.call("edf_get_contracts");
    expect(res).toMatchObject({ isToolError: true, signedIn: false });
    expect(res.remedy).toContain("edf_auth_login");
    const status = await harness.call("edf_auth_status");
    // A token file alone is not a login: status asks EDF, and reports the rejection.
    expect(status.signedIn).toBe(false);
    expect(status.reason).toContain("expired or was revoked");
  });

  it("retries a 401 once after refreshing", async () => {
    let sitesCalls = 0;
    const store = createMemoryTokenStore(signedInTokens());
    const harness = await connect({
      realAuth: true,
      store,
      fetch: router({
        "/v1/client/sites": () => {
          sitesCalls += 1;
          return sitesCalls === 1
            ? jsonResponse({}, { status: 401 })
            : jsonResponse(fixture("sites"));
        },
        "/v2/sites/-/elec-pmax": [],
        [TOKEN_URL]: () => jsonResponse({ access_token: "NEW", expires_in: 1199 }),
      }),
    });
    const res = await harness.call("edf_get_electricity_max_power", {});
    expect(res.isToolError).toBe(false);
    expect(sitesCalls).toBe(2);
  });
});

describe("edf_auth_logout", () => {
  it("revokes at EDF and forgets the login", async () => {
    const revoke = vi.fn(() => new Response(null, { status: 200 }));
    const store = createMemoryTokenStore(signedInTokens());
    const harness = await connect({
      realAuth: true,
      store,
      fetch: router({ [REVOKE_URL]: revoke }),
    });
    const res = await harness.call("edf_auth_logout");
    expect(res).toMatchObject({ signedIn: false, signedOut: true, revoked_at_edf: true });
    expect(store.read()).toBeUndefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("the Safari capture script", () => {
  const script = buildCaptureScript({
    authorizeUrl: "https://espace-client.edf.fr/sso/oauth2/INTERNET/authorize?state=mcpabc123",
    redirectPrefix: "https://suiviconso.edf.fr/openid",
    timeoutMs: 1000,
  });

  it("waits on a clock deadline, not an iteration count", () => {
    // Each pass is a delay plus Apple Events, so a counted loop overran its budget.
    expect(script).toContain("set deadline to startedAt + 1");
    expect(script).toContain("repeat while (current date) < deadline");
  });

  it("finds its tab by the login's state, in a regular window", () => {
    // Tab references are indices and shift when another tab closes.
    expect(script).toContain('u contains "mcpabc123"');
    expect(script).toContain(
      'u starts with "https://suiviconso.edf.fr/openid" and u contains "code="',
    );
    // Private Browsing tabs read back as "", and have no EDF cookies.
    expect(script).toContain('cu is not missing value and cu is not ""');
  });

  it("reports a closed tab, and closes its tab on timeout", () => {
    expect(script).toContain('return "TAB_CLOSED"');
    expect(script).toContain("Out of time: close our tab");
  });
});

describe("edf_auth_status with a live login", () => {
  it("stays signed in when the stored access token is still valid, without calling EDF", async () => {
    const harness = await connect({
      realAuth: true,
      store: createMemoryTokenStore(signedInTokens()),
      fetch: router(baseRoutes()),
    });
    const status = await harness.call("edf_auth_status");
    expect(status.signedIn).toBe(true);
    expect(harness.urls().some((u) => u.toString() === TOKEN_URL)).toBe(false);
  });
});
