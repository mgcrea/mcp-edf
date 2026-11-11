import type { CaptureResult, RedirectCapture } from "#/auth/capture";
import type { Logger, TokenProvider } from "#/client/auth";
import { PreconditionError } from "#/client/errors";
import { createState, toStoredTokens, type OAuthClient } from "#/client/oauth";
import type { StoredTokens, TokenStore } from "#/client/tokens";
import { SSO_REDIRECT_URI } from "#/config";

type CaptureFailure = Extract<CaptureResult, { ok: false }>;

export type LoginOutcome =
  | { signedIn: true; tokens: StoredTokens }
  | { signedIn: false; pending: true; authorizeUrl: string }
  | {
      signedIn: false;
      pending: false;
      authorizeUrl: string;
      reason: CaptureFailure["reason"];
      message: string;
    };

/**
 * Owns the login lifecycle so the tools stay thin: at most one pending login at
 * a time, and every change of identity drops the client's cached site.
 */
export type AuthController = {
  readonly tokenProvider: TokenProvider;
  readonly store: TokenStore;
  pendingUrl(): string | undefined;
  lastError(): string | undefined;
  /** Automatic: open Safari and catch the redirect. Waits up to `waitMs`, then keeps going in the background. */
  login(opts: { waitMs: number }): Promise<LoginOutcome>;
  /** Manual: finish with a redirect URL the user copied from the browser. */
  completeWithRedirect(redirectUrl: string): Promise<StoredTokens>;
  logout(): Promise<{ hadLogin: boolean; revoked: boolean }>;
};

/**
 * Pull the code out of `https://suiviconso.edf.fr/openid?code=…&state=…`. The
 * state is checked when this server started the login, so a stale URL from an
 * earlier attempt cannot be replayed into a new one.
 */
export const parseRedirect = (redirectUrl: string, expectedState: string | undefined): string => {
  let url: URL;
  try {
    url = new URL(redirectUrl.trim());
  } catch {
    throw new PreconditionError("redirect_url is not a URL.", {
      remedy: `Paste the whole address the browser landed on, starting with ${SSO_REDIRECT_URI}?code=`,
    });
  }
  if (`${url.origin}${url.pathname}` !== SSO_REDIRECT_URI) {
    throw new PreconditionError(`redirect_url must start with ${SSO_REDIRECT_URI}.`);
  }
  const code = url.searchParams.get("code");
  if (!code) {
    throw new PreconditionError("redirect_url carries no code.", {
      remedy:
        "The Suivi Conso page removes the code as soon as it uses it. Copy the address before the page finishes loading, or use the automatic login on macOS.",
    });
  }
  const state = url.searchParams.get("state");
  if (expectedState !== undefined && state !== expectedState) {
    throw new PreconditionError(
      "redirect_url belongs to a different login attempt (state mismatch).",
      {
        remedy: "Call edf_auth_login again and use the URL from that attempt.",
      },
    );
  }
  return code;
};

/** Five minutes, the same budget the fleet's loopback listeners allow a human to log in. */
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export const createAuthController = (opts: {
  store: TokenStore;
  oauth: OAuthClient;
  tokenProvider: TokenProvider;
  capture: RedirectCapture;
  /** Called after every change of identity, so the client re-resolves its site. */
  onIdentityChange: () => void;
  logger?: Logger | undefined;
  loginTimeoutMs?: number;
  now?: () => number;
}): AuthController => {
  const now = opts.now ?? Date.now;
  let pending: { state: string; authorizeUrl: string; abort: AbortController } | undefined;
  let lastError: string | undefined;

  const finish = async (code: string): Promise<StoredTokens> => {
    const res = await opts.oauth.exchangeCode(code);
    const tokens = toStoredTokens(res, { now: now() });
    opts.store.write(tokens);
    opts.onIdentityChange();
    return tokens;
  };

  return {
    tokenProvider: opts.tokenProvider,
    store: opts.store,
    pendingUrl: () => pending?.authorizeUrl,
    lastError: () => lastError,

    async login({ waitMs }) {
      pending?.abort.abort();
      const state = createState();
      const authorizeUrl = opts.oauth.authorizeUrl(state);
      const attempt = { state, authorizeUrl, abort: new AbortController() };
      pending = attempt;
      lastError = undefined;

      const done: Promise<LoginOutcome> = opts
        .capture({
          authorizeUrl,
          redirectPrefix: SSO_REDIRECT_URI,
          timeoutMs: opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS,
          signal: attempt.abort.signal,
        })
        .then(async (result): Promise<LoginOutcome> => {
          if (!result.ok) {
            return {
              signedIn: false,
              pending: false,
              authorizeUrl,
              reason: result.reason,
              message: result.message,
            };
          }
          const tokens = await finish(parseRedirect(result.url, state));
          return { signedIn: true, tokens };
        })
        .catch((err: unknown): LoginOutcome => ({
          signedIn: false,
          pending: false,
          authorizeUrl,
          reason: "error",
          message: err instanceof Error ? err.message : String(err),
        }))
        .then((outcome) => {
          // Only the CURRENT attempt may report back: a superseded one ends as
          // "cancelled", and that must not show up beside a fresh success.
          if (pending === attempt) {
            pending = undefined;
            lastError = outcome.signedIn || outcome.pending ? undefined : outcome.message;
          }
          return outcome;
        });

      const timer = new Promise<undefined>((resolve) => {
        setTimeout(() => resolve(undefined), waitMs).unref?.();
      });
      const winner = await Promise.race([done, timer]);
      return winner ?? { signedIn: false, pending: true, authorizeUrl };
    },

    async completeWithRedirect(redirectUrl) {
      const code = parseRedirect(redirectUrl, pending?.state);
      pending?.abort.abort();
      pending = undefined;
      lastError = undefined;
      return finish(code);
    },

    async logout() {
      pending?.abort.abort();
      pending = undefined;
      lastError = undefined;
      const tokens = opts.store.read();
      // Revoke at EDF too, not just locally: a deleted file leaves a live
      // refresh token in any backup or copy of it.
      const revoked = tokens ? await opts.oauth.revoke(tokens.refreshToken) : false;
      opts.store.clear();
      opts.onIdentityChange();
      return { hadLogin: tokens !== undefined, revoked };
    },
  };
};
