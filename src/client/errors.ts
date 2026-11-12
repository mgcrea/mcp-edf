export class EdfApiError extends Error {
  // `string`, not the literal, so a subclass can override it.
  override readonly name: string = "EdfApiError";
  readonly status: number;
  /**
   * What to do about it, kept separate from `message`: the message says what
   * happened, the remedy is the half a model should act on, and fail() lifts it
   * to a top-level field so it is not buried inside the upstream envelope.
   */
  readonly remedy: string | undefined;
  readonly errors: unknown;

  constructor(message: string, opts: { status: number; remedy?: string; errors?: unknown }) {
    super(message);
    this.status = opts.status;
    this.remedy = opts.remedy;
    this.errors = opts.errors;
  }
}

/** No usable login: never logged in, logged out, or the 20-minute login ran out and could not be renewed. */
export class SignInRequiredError extends Error {
  override readonly name = "SignInRequiredError";
  readonly remedy = "Call edf_auth_login, then retry.";
}

/** A precondition the caller can fix (a bad date range, a missing argument). */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  readonly remedy: string | undefined;

  constructor(message: string, opts: { remedy?: string } = {}) {
    super(message);
    this.remedy = opts.remedy;
  }
}
