import { z } from "zod";

import { EdfApiError, PreconditionError, SignInRequiredError } from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * `extra` is spread at the top level, so a `remedy` lands beside the error
 * rather than inside the upstream envelope, where it gets skimmed past.
 */
export const fail = (message: string, extra?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }],
  isError: true,
});

/** Render a thrown value as a tool error, preserving upstream detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof EdfApiError) {
    return fail(err.message, {
      ...(err.remedy ? { remedy: err.remedy } : {}),
      status: err.status,
      ...(err.errors !== undefined ? { details: err.errors } : {}),
    });
  }
  if (err instanceof SignInRequiredError)
    return fail(err.message, { signedIn: false, remedy: err.remedy });
  if (err instanceof PreconditionError) {
    return fail(err.message, err.remedy ? { remedy: err.remedy } : undefined);
  }
  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
    if (err.name === "TimeoutError") {
      return fail("EDF did not answer in time.", { remedy: "Retry, or narrow the date range." });
    }
    return fail(err.message);
  }
  return fail("Unknown error", { details: err });
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Read tools that call EDF: they never change anything, but they do reach the network. */
export const READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const fromArg = z
  .string()
  .regex(DATE, "A date like 2026-11-01.")
  .describe("First day, inclusive, as YYYY-MM-DD in Paris time, e.g. 2026-10-01.");

export const toArg = z
  .string()
  .regex(DATE, "A date like 2026-11-30.")
  .optional()
  .describe(
    "Last day, INCLUSIVE, as YYYY-MM-DD, e.g. 2026-10-31. Defaults to yesterday: the meters " +
      "report once a day, and a day's figures usually land the next morning around 08:00.",
  );
