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
 * alive, the redirect arrives within a second or two and the user sees nothing
 * but a flicker. If not, Safari is brought forward after two seconds so the
 * user can log in.
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
  signal?: AbortSignal;
}) => Promise<CaptureResult>;

const POLL_MS = 20;
/** Bring Safari forward only after this long, so a silent login stays silent. */
const REVEAL_AFTER_MS = 2_000;

/** AppleScript string literal. The URLs here are percent-encoded, but be safe. */
const asString = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const buildCaptureScript = (opts: {
  authorizeUrl: string;
  redirectPrefix: string;
  timeoutMs: number;
}): string => {
  const iterations = Math.max(1, Math.ceil(opts.timeoutMs / POLL_MS));
  const revealAt = Math.ceil(REVEAL_AFTER_MS / POLL_MS);
  return `
tell application "Safari"
  if (count of windows) is 0 then make new document
  set w to front window
  set t to make new tab at end of tabs of w with properties {URL:${asString(opts.authorizeUrl)}}
  set found to ""
  set i to 0
  repeat ${iterations} times
    delay ${POLL_MS / 1000}
    set i to i + 1
    try
      set u to URL of t
      if u starts with ${asString(opts.redirectPrefix)} and u contains "code=" then
        set found to u
        exit repeat
      end if
    end try
    if i is ${revealAt} then
      try
        set current tab of w to t
        activate
      end try
    end if
  end repeat
  try
    close t
  end try
  return found
end tell`;
};

export const safariCapture: RedirectCapture = ({
  authorizeUrl,
  redirectPrefix,
  timeoutMs,
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
    const script = buildCaptureScript({ authorizeUrl, redirectPrefix, timeoutMs });
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
