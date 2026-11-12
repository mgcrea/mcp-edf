import { execFile } from "node:child_process";

/**
 * Catch the OAuth redirect in a Safari tab, on macOS.
 *
 * EDF registers exactly one redirect for this client,
 * https://suiviconso.edf.fr/openid, so there is no loopback listener to send
 * the browser to. The page served there is the Suivi Conso SPA, and it redeems
 * any `?code=` it finds (when it saved no state of its own, it accepts any
 * state). EDF also ignores `response_mode=fragment`. So the code has to be read
 * from the tab's address bar before the SPA spends it: AppleScript polls the
 * tab every 20 ms and closes it the moment the redirect lands. That won 3 out
 * of 3 races on 2026-11-11; the SPA needs its bundles before it can act.
 *
 * The tab opens in the background. If EDF's SSO session in Safari is still
 * alive, the redirect arrives within a second (0.3 to 0.8 s measured) and the
 * user sees nothing but a flicker. If not, an interactive login brings Safari
 * forward after two seconds so the user can log in; a silent renewal
 * (`reveal: false`) never does, and gives up at its deadline instead.
 */

export type CaptureResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason: "timeout" | "unsupported" | "not_authorized" | "cancelled" | "error";
      message: string;
    };

export type RedirectCapture = (opts: {
  authorizeUrl: string;
  /** The redirect prefix to wait for, e.g. https://suiviconso.edf.fr/openid */
  redirectPrefix: string;
  timeoutMs: number;
  /**
   * Bring Safari forward when the login needs the user. Defaults to true. The
   * silent renewal passes false: it runs behind a tool call, unasked, so it must
   * never take the focus.
   */
  reveal?: boolean;
  signal?: AbortSignal;
}) => Promise<CaptureResult>;

const POLL_MS = 20;
/** Bring Safari forward only after this long, so a silent login stays silent. */
const REVEAL_AFTER_MS = 2_000;

/** AppleScript string literal. The URLs here are percent-encoded, but be safe. */
const asString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Printed by the script when the user closed the login tab, so the wait ends at once. */
export const TAB_CLOSED = "TAB_CLOSED";

/**
 * Two lessons from running this against Safari (2026-11-12):
 *
 * - The loop runs against a clock deadline, not an iteration count. Each pass is
 *   a 20 ms delay PLUS Apple Events, so 15,000 passes meant as 5 minutes outlived
 *   execFile's kill timer. A killed script never closes its tab, and reports a
 *   bare "Command failed" instead of a timeout.
 * - The tab is found by the login's `state`, not held as `tab N of window W`.
 *   AppleScript tab references are indices, so closing any tab to the left of
 *   ours shifted the reference onto another tab or off the end. The state is in
 *   every address of the flow (the authorize URL, the login page's `goto`, the
 *   final redirect), so one `URL of every tab of every window` per pass finds
 *   it wherever it is, and a tab once seen and then gone for 5 s was closed.
 */
export const buildCaptureScript = (opts: {
  authorizeUrl: string;
  redirectPrefix: string;
  timeoutMs: number;
  reveal?: boolean;
}): string => {
  const marker = new URL(opts.authorizeUrl).searchParams.get("state") ?? opts.authorizeUrl;
  const seconds = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
  const revealAfter = Math.ceil(REVEAL_AFTER_MS / 1000);
  // The reveal block is left out entirely rather than skipped at run time, so a
  // silent renewal cannot activate Safari by any path.
  const revealBlock =
    opts.reveal === false
      ? "    -- Silent: the tab stays in the background and Safari stays where it is."
      : `    -- No redirect within 2 s: the user has to log in, so show the tab. This must
    -- not wait for the marker to be seen: Safari leaves a background tab in an
    -- unfocused window unloaded, with a missing URL, until it is shown.
    if not revealed and ((current date) - startedAt) >= ${revealAfter} then
      set revealed to true
      try
        set index of window id wid to 1
        set current tab of window id wid to last tab of window id wid
      end try
      activate
    end if`;
  return `
tell application "Safari"
  -- A regular window, never a Private Browsing one: Safari hides private tabs'
  -- URLs from AppleScript (they read as ""), and a private window has none of
  -- the user's EDF cookies, so the login could neither complete silently nor
  -- be seen (2026-11-12). A window whose current tab's URL reads back is a
  -- regular one; with none, open a new regular window. Its id is stable where
  -- a tab index is not.
  set wid to missing value
  repeat with w in windows
    try
      set cu to URL of current tab of w
      -- A private tab reads back as "" (or missing value), never as its URL.
      if cu is not missing value and cu is not "" then
        set wid to id of w
        exit repeat
      end if
    end try
  end repeat
  if wid is missing value then
    make new document
    set wid to id of front window
  end if
  make new tab at end of tabs of window id wid with properties {URL:${asString(opts.authorizeUrl)}}
  set startedAt to current date
  set deadline to startedAt + ${seconds}
  set revealed to false
  set seenAt to missing value
  repeat while (current date) < deadline
    delay ${POLL_MS / 1000}
    set hit to false
    try
      set allUrls to URL of every tab of every window
    on error
      set allUrls to {}
    end try
    set wi to 0
    repeat with windowUrls in allUrls
      set wi to wi + 1
      set ti to 0
      repeat with oneUrl in windowUrls
        set ti to ti + 1
        set u to contents of oneUrl
        if u is not missing value and u contains ${asString(marker)} then
          set hit to true
          set seenAt to current date
          if u starts with ${asString(opts.redirectPrefix)} and u contains "code=" then
            try
              close tab ti of window wi
            end try
            return u
          end if
        end if
      end repeat
    end repeat
${revealBlock}
    if not hit and seenAt is not missing value and ((current date) - seenAt) > 5 then return "${TAB_CLOSED}"
  end repeat
  -- Out of time: close our tab if it is still open, so nothing is left behind.
  try
    set allUrls to URL of every tab of every window
    repeat with wi from (count of allUrls) to 1 by -1
      set windowUrls to item wi of allUrls
      repeat with ti from (count of windowUrls) to 1 by -1
        set u to item ti of windowUrls
        if u is not missing value and u contains ${asString(marker)} then close tab ti of window wi
      end repeat
    end repeat
  end try
  return ""
end tell`;
};

export const safariCapture: RedirectCapture = ({
  authorizeUrl,
  redirectPrefix,
  timeoutMs,
  reveal,
  signal,
}) =>
  new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve({
        ok: false,
        reason: "unsupported",
        message:
          "The automatic login drives Safari and needs macOS. Pass redirect_url to " +
          "edf_auth_login instead (see its description).",
      });
      return;
    }
    const script = buildCaptureScript({
      authorizeUrl,
      redirectPrefix,
      timeoutMs,
      ...(reveal === undefined ? {} : { reveal }),
    });
    const child = execFile(
      "osascript",
      ["-e", script],
      // A little headroom over the script's own loop, so the loop ends first and
      // gets to close its tab.
      { timeout: timeoutMs + 15_000, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (signal?.aborted) {
          resolve({ ok: false, reason: "cancelled", message: "The login was cancelled." });
          return;
        }
        if (err && (err as { killed?: boolean }).killed) {
          resolve({
            ok: false,
            reason: "timeout",
            message: "No login completed in the Safari tab before the wait ran out.",
          });
          return;
        }
        if (err) {
          // -1743: the user (or MDM) has not allowed this process to control Safari.
          if (/-1743|not authori[sz]ed/i.test(`${stderr} ${err.message}`)) {
            resolve({
              ok: false,
              reason: "not_authorized",
              message:
                "macOS did not allow this app to control Safari. Open System Settings → Privacy " +
                "& Security → Automation, allow it for Safari, then call edf_auth_login again.",
            });
            return;
          }
          resolve({
            ok: false,
            reason: "error",
            message: `osascript failed: ${stderr.trim() || err.message}`,
          });
          return;
        }
        const url = stdout.trim();
        if (url === TAB_CLOSED) {
          resolve({
            ok: false,
            reason: "cancelled",
            message: "The EDF login tab was closed before the login finished.",
          });
          return;
        }
        resolve(
          url
            ? { ok: true, url }
            : {
                ok: false,
                reason: "timeout",
                message: "No login completed in the Safari tab before the wait ran out.",
              },
        );
      },
    );
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
