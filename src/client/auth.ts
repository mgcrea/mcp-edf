import { SignInRequiredError } from "#/client/errors";
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
      /** When the current access token was obtained (a login or a silent renewal). */
      obtainedAt: number;
      /** When the access token runs out; 0 once invalidated after a 401. */
      accessExpiresAt: number;
      /** The last renewal failure, if the stored login is in doubt. */
      lastError?: string;
    };

export type TokenProvider = {
  getToken(): Promise<string>;
  /** Called by the client's retry loop on a 401, so a rejected token is renewed once. */
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
 * Gets a fresh login when the stored one has run out; throws SignInRequiredError
 * when it cannot. The auth controller supplies it (a silent Safari login).
 */
export type Renewer = () => Promise<StoredTokens>;

/**
 * EDF's access token lives 1199 s and cannot be refreshed: the refresh token
 * EDF issues with it is dead within a second (see StoredTokens). So the token
 * is used until it is a minute from expiry, then `renew` replaces it. One
 * in-flight promise coordinates concurrent callers, so a burst of tool calls at
 * expiry renews once rather than once per call.
 */
export const sessionTokenProvider = (opts: {
  store: TokenStore;
  /** Undefined when silent renewal is off: an expired login then means "log in again". */
  renew?: Renewer | undefined;
  logger?: Logger | undefined;
  now?: () => number;
}): TokenProvider => {
  const now = opts.now ?? Date.now;
  /** Renew a minute early, so a token cannot expire mid-flight. */
  const SKEW_MS = 60_000;
  let inFlight: Promise<string> | undefined;
  let lastError: string | undefined;

  const renew = async (renewer: Renewer): Promise<string> => {
    try {
      const next = await renewer();
      lastError = undefined;
      return next.accessToken;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  return {
    refreshable: opts.renew !== undefined,

    async getToken() {
      const tokens = opts.store.read();
      if (!tokens) throw new SignInRequiredError("Not signed in to EDF.");
      if (tokens.expiresAt - SKEW_MS > now()) return tokens.accessToken;
      if (!opts.renew) {
        throw new SignInRequiredError(
          "The EDF login ran out: EDF logins last 20 minutes, and silent renewal is off (EDF_SILENT_RELOGIN).",
        );
      }
      const renewer = opts.renew;
      inFlight ??= renew(renewer).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },

    invalidate() {
      const tokens = opts.store.read();
      if (tokens && tokens.expiresAt !== 0) opts.store.write({ ...tokens, expiresAt: 0 });
    },

    describe() {
      const tokens = opts.store.read();
      if (!tokens) return { signedIn: false, reason: "no stored login" };
      return {
        signedIn: true,
        obtainedAt: tokens.obtainedAt,
        accessExpiresAt: tokens.expiresAt,
        ...(lastError ? { lastError } : {}),
      };
    },
  };
};
