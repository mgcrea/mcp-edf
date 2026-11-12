import { randomBytes } from "node:crypto";

import type { Logger } from "#/client/auth";
import type { StoredTokens } from "#/client/tokens";
import { TOKEN_FILE_VERSION } from "#/client/tokens";
import { SSO_BASE_URL, SSO_CLIENT_ID, SSO_REDIRECT_URI, SSO_SCOPE } from "#/config";

/**
 * EDF's token endpoint answer (ForgeRock AM). No id_token: the scope has no
 * `openid`. It carries a refresh_token too, which is ignored: EDF honours it
 * for about one second (see StoredTokens), so a refresh grant is never worth
 * attempting.
 */
export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

/** An OAuth error from the token endpoint: `invalid_grant` is the one that means "log in again". */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, opts: { status: number; code?: string }) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
  }
}

export type OAuthClient = {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenResponse>;
  /** Best effort: true only when EDF confirmed the revocation. */
  revoke(token: string): Promise<boolean>;
};

/** 96 random bits as hex: the state is compared, never parsed, so any opaque string works. */
export const createState = (random: (n: number) => Buffer = randomBytes): string =>
  `mcp${random(12).toString("hex")}`;

export const createOAuthClient = (
  opts: {
    fetch?: typeof fetch;
    logger?: Logger | undefined;
    timeoutMs?: number;
  } = {},
): OAuthClient => {
  const fetchImpl = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const post = async (path: string, form: Record<string, string>): Promise<Response> =>
    fetchImpl(`${SSO_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });

  const tokenRequest = async (form: Record<string, string>): Promise<TokenResponse> => {
    const res = await post("/access_token", form);
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Akamai answers a blocked request with an HTML "Access Denied" page.
      body = undefined;
    }
    if (!res.ok) {
      const record = (body ?? {}) as { error?: string; error_description?: string };
      const detail = record.error_description ?? record.error ?? text.slice(0, 200);
      throw new OAuthError(`EDF token endpoint answered HTTP ${res.status}: ${detail}`, {
        status: res.status,
        ...(record.error ? { code: record.error } : {}),
      });
    }
    const token = body as TokenResponse | undefined;
    if (!token || typeof token.access_token !== "string") {
      throw new OAuthError("EDF token endpoint answered without an access_token.", {
        status: res.status,
      });
    }
    return token;
  };

  return {
    authorizeUrl(state) {
      const url = new URL(`${SSO_BASE_URL}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", SSO_SCOPE);
      url.searchParams.set("client_id", SSO_CLIENT_ID);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", SSO_REDIRECT_URI);
      return url.toString();
    },

    // A public client: client_id in the body, no secret, and no PKCE, because
    // the SPA this client belongs to sends none (a code_verifier is ignored).
    exchangeCode: (code) =>
      tokenRequest({
        grant_type: "authorization_code",
        code,
        client_id: SSO_CLIENT_ID,
        redirect_uri: SSO_REDIRECT_URI,
      }),

    async revoke(token) {
      try {
        const res = await post("/token/revoke", { token, client_id: SSO_CLIENT_ID });
        return res.ok;
      } catch (err) {
        opts.logger?.debug?.("token revocation failed", err);
        return false;
      }
    },
  };
};

/** Turn a token response into what the store keeps. */
export const toStoredTokens = (res: TokenResponse, opts: { now: number }): StoredTokens => {
  // EDF says 1199 s. Without a figure, assume the short end rather than reuse
  // a token the server has already dropped.
  const lifetimeMs = (res.expires_in ?? 600) * 1000;
  return {
    version: TOKEN_FILE_VERSION,
    accessToken: res.access_token,
    expiresAt: opts.now + lifetimeMs,
    obtainedAt: opts.now,
  };
};
