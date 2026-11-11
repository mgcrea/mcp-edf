import type { Logger, TokenProvider } from "#/client/auth";
import { EdfApiError, PreconditionError } from "#/client/errors";

export type Query = Record<string, string | number | boolean | undefined>;

/** One home on the account, from `GET /v1/client/sites`. */
export type Site = {
  personExternalId: string;
  siteExternalId: string;
  address: string;
};

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

/** Suivi Conso's error envelope: `{errorCode, errorDescription}`, or Spring's `{status, error, path}`. */
const describeError = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null)
    return typeof body === "string" ? body.slice(0, 200) : undefined;
  const rec = body as { errorCode?: string; errorDescription?: string; error?: string };
  if (rec.errorCode)
    return rec.errorDescription ? `${rec.errorCode}: ${rec.errorDescription}` : rec.errorCode;
  return rec.error;
};

const remedyFor = (status: number, body: unknown): string | undefined => {
  if (status === 401) {
    return "EDF rejected the login for this call. Call edf_auth_status; if it is signed out, call edf_auth_login.";
  }
  if (status === 400 && /DATE/i.test(describeError(body) ?? "")) {
    return "A date parameter is in the wrong format for this endpoint. With edf_request: beginTs / beginDate / ts want 2026-11-01T00:00:00+01:00, begin-date wants 2026-11-01, begin-month wants 2026-11.";
  }
  if (status === 404) {
    return "This endpoint does not exist for this account or API version (v1 vs v2), e.g. a gas endpoint on an electricity-only contract.";
  }
  if (status === 429)
    return "Rate limited by EDF. Wait a minute, then make fewer, larger requests.";
  return undefined;
};

export type EdfClientOptions = {
  baseUrl: string;
  tokenProvider: TokenProvider;
  maxRetries: number;
  timeoutMs: number;
  userAgent: string;
  /** EDF_SITE: matched against the address (substring) or the siteExternalId. */
  expectedSite?: string | undefined;
  fetch?: typeof fetch;
  logger?: Logger | undefined;
};

/** Summarized site for responses and auth_status. The external ids stay internal. */
export const siteLabel = (site: Site): string => site.address || site.siteExternalId;

export class EdfClient {
  private readonly baseUrl: string;
  private readonly tokens: TokenProvider;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly expectedSite: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private sitePromise: Promise<Site> | undefined;
  private sitesPromise: Promise<Site[]> | undefined;

  constructor(opts: EdfClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.tokens = opts.tokenProvider;
    this.maxRetries = opts.maxRetries;
    this.timeoutMs = opts.timeoutMs;
    this.userAgent = opts.userAgent;
    this.expectedSite = opts.expectedSite;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
  }

  /** Drop the cached site: a new login may be another account. */
  resetSite(): void {
    this.sitePromise = undefined;
    this.sitesPromise = undefined;
  }

  /** Every home on the account. Not cached on failure, so one blip does not stick. */
  async sites(): Promise<Site[]> {
    this.sitesPromise ??= this.send<Site[]>("GET", "/v1/client/sites", undefined, undefined).catch(
      (err: unknown) => {
        this.sitesPromise = undefined;
        throw err;
      },
    );
    return this.sitesPromise;
  }

  /**
   * The home every data call reads. The login picks the account, and an account
   * can hold several homes; a wrong one does not fail, it answers with another
   * home's figures. So: one home is used as is, several need EDF_SITE, and
   * EDF_SITE refuses a mismatch instead of guessing. Catch on the outer promise
   * so a "no such site" thrown on the success path is not cached forever.
   */
  async site(): Promise<Site> {
    this.sitePromise ??= this.sites()
      .then((all) => pickSite(all, this.expectedSite))
      .catch((err: unknown) => {
        this.sitePromise = undefined;
        throw err;
      });
    return this.sitePromise;
  }

  /** A site-scoped GET under /api, e.g. `/v2/sites/-/elec-pmax`. */
  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    const site = await this.site();
    return this.send<T>("GET", path, query, site);
  }

  private async send<T>(
    method: string,
    path: string,
    query: Query | undefined,
    site: Site | undefined,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      // URLSearchParams encodes the `+` of an offset as %2B. A raw `+` would be
      // read as a space and answered with INVALID_DATE_FORMAT.
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let attempt = 0;
    for (;;) {
      const token = await this.tokens.getToken();
      this.logger?.debug?.(`${method} ${url.pathname}${url.search} (attempt ${attempt + 1})`);
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent,
          Accept: "application/json",
          // The SPA's HTTP interceptor adds these two to every call once a home
          // is chosen. Without them every /sites/-/… path answers 401.
          ...(site
            ? { "person-ext-id": site.personExternalId, "site-ext-id": site.siteExternalId }
            : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (res.status === 401 && this.tokens.refreshable && attempt < this.maxRetries) {
        this.logger?.warn?.("HTTP 401, refreshing the EDF token and retrying");
        this.tokens.invalidate();
        attempt += 1;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const delay = retryAfterMs(res) ?? backoffMs(attempt);
        this.logger?.warn?.(`HTTP ${res.status}, retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
        continue;
      }

      const text = await res.text();
      let parsed: unknown = undefined;
      if (text) {
        // A proxy's error page is HTML; parsing it must not hide the status.
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text.slice(0, 500);
        }
      }
      if (!res.ok) {
        const remedy = remedyFor(res.status, parsed);
        const detail = describeError(parsed);
        throw new EdfApiError(
          `${method} ${path} failed: HTTP ${res.status}${detail ? ` (${detail})` : ""}`,
          { status: res.status, ...(remedy ? { remedy } : {}), errors: parsed },
        );
      }
      return parsed as T;
    }
  }
}

export const pickSite = (all: Site[], expected: string | undefined): Site => {
  if (all.length === 0) {
    throw new PreconditionError("This EDF account has no home in Suivi Conso.", {
      remedy:
        "Check https://suiviconso.edf.fr in a browser: the account may not have a contract with consumption tracking.",
    });
  }
  const list = all.map(siteLabel).join(" | ");
  if (expected) {
    const needle = expected.toLowerCase();
    const match = all.find(
      (s) => s.siteExternalId === expected || s.address.toLowerCase().includes(needle),
    );
    if (!match) {
      throw new PreconditionError(
        `EDF_SITE is "${expected}", but this login's homes are: ${list}.`,
        {
          remedy: "Log in with the account that holds that home, or correct EDF_SITE.",
        },
      );
    }
    return match;
  }
  if (all.length > 1) {
    throw new PreconditionError(`This EDF account has ${all.length} homes: ${list}.`, {
      remedy: "Set EDF_SITE to part of the address of the one to read, then restart the server.",
    });
  }
  return all[0] as Site;
};
