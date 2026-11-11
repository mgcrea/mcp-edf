import { SignInRequiredError } from "#/client/errors";
import { OAuthError, toStoredTokens, type OAuthClient } from "#/client/oauth";
import type { StoredTokens, TokenStore } from "#/client/tokens";

export type Logger = {
  debug?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
};

export type AuthStatus =
  | { signedIn: false; reason: string }
  | {
      signedIn: true;
      /** When the user last logged in (the refresh token's issue time). */
      obtainedAt: number;
      /** When the cached access token runs out; 0 when none is cached. */
      accessExpiresAt: number;
      /** The last refresh failure, if the stored login is in doubt. */
      lastError?: string;
    };

export type TokenProvider = {
  getToken(): Promise<string>;
  /** Called by the client's retry loop on a 401, so an expired token is reminted once. */
  invalidate(): void;
  /**
   * Whether invalidate() can produce a different token. A static token cannot,
   * so for it a 401 is final: retrying would only resend the rejected one.
   */
  readonly refreshable: boolean;
  describe(): AuthStatus;
};

/** A fixed token (tests): never refreshed, so a 401 is final. */
export const staticTokenProvider = (token: string): TokenProvider => ({
  getToken: async () => token,
  invalidate: () => {},
  refreshable: false,
  describe: () => ({ signedIn: true, obtainedAt: 0, accessExpiresAt: 0 }),
});

/**
 * EDF's access token lives 1199 s and is refreshed on demand. One in-flight
 * promise coordinates concurrent callers, so a burst of tool calls at expiry
 * refreshes once rather than once per call.
 */
export const oauthTokenProvider = (opts: {
  store: TokenStore;
  oauth: OAuthClient;
  logger?: Logger | undefined;
  now?: () => number;
}): TokenProvider => {
  const now = opts.now ?? Date.now;
  /** Refresh a minute early, so a token cannot expire mid-flight. */
  const SKEW_MS = 60_000;
  let inFlight: Promise<string> | undefined;
  let lastError: string | undefined;

  const refresh = async (tokens: StoredTokens): Promise<string> => {
    try {
      const res = await opts.oauth.refresh(tokens.refreshToken);
      const next = toStoredTokens(res, { now: now(), previous: tokens });
      opts.store.write(next);
      lastError = undefined;
      return res.access_token;
    } catch (err) {
      if (err instanceof OAuthError && (err.code === "invalid_grant" || err.status === 401)) {
        lastError = "EDF rejected the stored login (it expired or was revoked).";
        throw new SignInRequiredError(`${lastError} Log in again.`, { cause: err });
      }
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  return {
    refreshable: true,

    async getToken() {
      const tokens = opts.store.read();
      if (!tokens) throw new SignInRequiredError("Not signed in to EDF.");
      if (tokens.accessToken && tokens.expiresAt - SKEW_MS > now()) return tokens.accessToken;
      inFlight ??= refresh(tokens).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    invalidate() {
      const tokens = opts.store.read();
      if (tokens?.accessToken) {
        const { accessToken: _dropped, ...rest } = tokens;
        opts.store.write({ ...rest, expiresAt: 0 });
      }
    },

    describe() {
      const tokens = opts.store.read();
      if (!tokens) return { signedIn: false, reason: "no stored login" };
      return {
        signedIn: true,
        obtainedAt: tokens.obtainedAt,
        accessExpiresAt: tokens.accessToken ? tokens.expiresAt : 0,
        ...(lastError ? { lastError } : {}),
      };
    },
  };
};
