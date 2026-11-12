import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/**
 * EDF Suivi Conso, the consumption site of EDF's customer area. It is an
 * Angular SPA on Edelia's "jedi" platform, and this is the JSON API it calls.
 * The site's own "Téléchargez les données" CSV is generated client-side from
 * these same calls, so there is no export endpoint to reach for instead.
 */
export const API_BASE_URL = "https://suiviconso.edf.fr/api";

/**
 * EDF's ForgeRock SSO, realm INTERNET. `equilibre-portal-v2` is the client the
 * Suivi Conso SPA itself uses: a public client (no secret, no PKCE), whose only
 * registered redirect is https://suiviconso.edf.fr/openid. localhost and any
 * other host answer `redirect_uri_mismatch`, so there is no loopback flow: the
 * login has to catch the code in a browser tab before the SPA redeems it. See
 * src/auth/capture.ts.
 */
export const SSO_BASE_URL = "https://espace-client.edf.fr/sso/oauth2/INTERNET";
export const SSO_CLIENT_ID = "equilibre-portal-v2";
export const SSO_REDIRECT_URI = "https://suiviconso.edf.fr/openid";
export const SSO_SCOPE = "b2c_business_process b2c_services";

const ConfigSchema = z
  .object({
    /** A refresh token supplied from outside (a secret store, CI) instead of the token file. */
    refreshToken: z.string().min(1).optional(),
    tokenFile: z.string().min(1),
    /**
     * Expected home, matched against the site's address (case-insensitive
     * substring) or its siteExternalId. When set, every data tool refuses to
     * read a different one. See rule 11: the login picks the account, and an
     * account can hold several homes.
     */
    site: z.string().min(1).optional(),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
    timeoutMs: z.number().int().positive().default(30_000),
  })
  .strict()
  .superRefine((_cfg, _ctx) => {
    // Deliberately NOT an error when nothing is set. An MCP server that exits on
    // startup shows up in the client as a bare "Connection closed", with stderr
    // swallowed, so the one message that would have explained the problem never
    // reaches anyone. This server needs no configuration at all: the login
    // happens at runtime through edf_auth_login.
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * `.strict()` on purpose: a typo'd `tokenfile` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect".
 */
const FileSchema = z
  .object({
    refreshToken: z.string().optional(),
    tokenFile: z.string().optional(),
    site: z.string().optional(),
    maxRetries: z.number().optional(),
    timeoutMs: z.number().optional(),
  })
  .strict();

type FileConfig = z.infer<typeof FileSchema>;

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

/** Maps "" to undefined, so an empty env var means "unset" rather than "empty". */
const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

export const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

const configDir = (env: NodeJS.ProcessEnv): string => {
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "edf");
};

export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.EDF_CONFIG);
  return explicit ? expandTilde(explicit) : join(configDir(env), "config.json");
};

export const warnIfGroupReadable = (
  path: string,
  logger?: { warn?(...args: unknown[]): void },
): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      logger?.warn?.(`${path} is readable by other users. Run: chmod 600 ${path}`);
    }
  } catch {
    /* a missing file is fine */
  }
};

const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  warnIfGroupReadable(path, {
    warn: (...a) => process.stderr.write(`[edf-mcp] ${a.join(" ")}\n`),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The config file ${path} is not valid JSON.`);
  }
  const result = FileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`The config file ${path} is invalid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, **per field**, not whole-source. A
 * container injects the environment and must keep working untouched, while a
 * one-off `EDF_SITE=…` still has to override a file that names another home.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  const tokenFile =
    trimmed(env.EDF_TOKEN_FILE) ?? trimmed(file.tokenFile) ?? join(configDir(env), "tokens.json");
  return ConfigSchema.parse({
    refreshToken: trimmed(env.EDF_REFRESH_TOKEN) ?? trimmed(file.refreshToken),
    tokenFile: expandTilde(tokenFile),
    site: trimmed(env.EDF_SITE) ?? trimmed(file.site),
    maxRetries: parseIntOpt(env.EDF_MAX_RETRIES) ?? file.maxRetries,
    timeoutMs: parseIntOpt(env.EDF_TIMEOUT_MS) ?? file.timeoutMs,
  });
};

/** Returned by edf_auth_status when signed out, and printed to stderr at startup. */
export const setupInstructions = (): string[] => [
  "Call edf_auth_login. On macOS it opens the EDF login in a Safari tab; log in as you " +
    "normally would (your EDF customer-area email and password). If Safari is already signed " +
    "in to EDF, it completes on its own in a second or two.",
  "The first time, macOS asks whether this app may control Safari: allow it. Without that " +
    "grant the login cannot read the tab's address, which is where the one-time code arrives.",
  "The login is kept as a refresh token (mode 600). How long EDF honours it is not known " +
    "yet and may be short: when it lapses, the tools answer signedIn: false; log in again.",
];
