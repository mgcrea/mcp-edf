# @mgcrea/mcp-edf

A [Model Context Protocol](https://modelcontextprotocol.io) server for **EDF Suivi Conso**, the
consumption pages of EDF's French customer area: daily and monthly electricity (Linky) and gas
(Gazpar) consumption in kWh and in euros, the 30-minute load curve, daily peak power, and the
contracts behind them.

It reads; it never writes. There are no mutating tools to enable.

> **How it talks to EDF.** EDF offers no API to its customers. This server uses the same JSON API
> the Suivi Conso website (suiviconso.edf.fr) uses, after the same EDF login, and borrows that
> website's own login client to do it. It sends the same requests a browser on that site would,
> at a similar volume. It is not endorsed by EDF, and it can break whenever EDF changes the site.

## Tools

| Tool                              | What it does                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `edf_auth_status`                 | Signed in or not, which home it reads, where the login is stored               |
| `edf_auth_login`                  | Logs in through a Safari tab (macOS) and keeps a refresh token                 |
| `edf_auth_logout`                 | Revokes the refresh token at EDF and deletes it locally                        |
| `edf_get_contracts`               | Electricity option (BASE / HPHC / TEMPO…), subscribed kVA, gas tariff, history |
| `edf_get_electricity_consumption` | kWh and € per day or month, split by tariff heading, with totals               |
| `edf_get_electricity_load_curve`  | `[start, kWh, avg kW]` per 30 minutes or hour, with the peak                   |
| `edf_get_electricity_max_power`   | Daily peak kVA against the subscribed power                                    |
| `edf_get_gas_consumption`         | kWh, m³ and € per day or month, with the conversion factor                     |
| `edf_request`                     | GET any other Suivi Conso API path (raw JSON)                                  |

Costs are EDF's own estimate at the contract's prices, taxes included, as shown on Suivi Conso.
They follow the bill closely, but they are not the invoice. Invoices are not available through
this API.

## Logging in

There is nothing to configure. Ask your agent to call `edf_auth_login`:

1. It opens the EDF login in a background Safari tab. If Safari is already signed in to EDF, the
   login completes on its own within a second or two.
2. Otherwise Safari comes forward after two seconds, and you log in as usual.
3. The first time, macOS asks whether the app running the server (your editor, a terminal, or
   Bastion) may control Safari. Allow it. That grant is how the server reads the one-time code
   from the tab's address.

**Why Safari automation.** EDF registers exactly one redirect for this client,
`https://suiviconso.edf.fr/openid`, so there is no localhost callback to listen on. The page at
that address uses up the code as soon as it loads. The server polls the tab's address every
20 ms and closes the tab the moment the code arrives, before the page can use it.

The login is kept as a refresh token in `~/.config/edf/tokens.json` (mode 600). EDF's access
tokens last 20 minutes and are renewed from it silently. EDF does not rotate the refresh token,
and does not publish how long it lasts. When it expires, the tools answer `signedIn: false` and
you log in again.

**Without macOS.** `edf_auth_login` also takes a `redirect_url`: the address the browser lands
on after logging in, `https://suiviconso.edf.fr/openid?code=…`. The Suivi Conso page strips the
code within a second, so you have to copy the address before the page runs, for example with
JavaScript disabled for that site. A refresh token obtained elsewhere can be supplied as
`EDF_REFRESH_TOKEN` (in Docker, for instance).

## Configure (all optional)

| Variable            | Description                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `EDF_SITE`          | The home to read, as part of its address (e.g. `LYON`). Required only if the account has several; any read refuses a mismatch. |
| `EDF_REFRESH_TOKEN` | A refresh token from outside. Kept in memory only, so a login made in-session lasts until restart.                             |
| `EDF_TOKEN_FILE`    | Where the login is stored. Defaults to `~/.config/edf/tokens.json`.                                                            |
| `EDF_CONFIG`        | A JSON config file with the same settings (`site`, `tokenFile`, …). Defaults to `~/.config/edf/config.json`.                   |
| `EDF_MAX_RETRIES`   | Retries for 401 / 429 / 5xx. Default 3.                                                                                        |
| `EDF_TIMEOUT_MS`    | Per-request timeout. Default 30000.                                                                                            |
| `EDF_DEBUG`         | `1` logs each request to stderr.                                                                                               |

The environment wins over the config file, field by field.

## Quick start

```bash
pnpm install
pnpm build
```

```json
{
  "mcpServers": {
    "edf": { "command": "node", "args": ["/absolute/path/to/mcp-edf/dist/cli.js"] }
  }
}
```

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest, against recorded and anonymised Suivi Conso responses
pnpm typecheck
pnpm lint
pnpm format
```

### API notes

The Suivi Conso API's traps are documented in the code at the point where each is handled:

- **Date formats differ by endpoint** (`src/client/time.ts`):
  - `beginTs`, `beginDate` and `ts` want `2026-11-01T00:00:00+01:00`;
  - `begin-date` wants `2026-11-01`;
  - `begin-month` wants `2026-11`.
- **v1 and v2 are not interchangeable.** Each endpoint lives in exactly one, and the wrong one
  answers 404.
- **Site headers.** Every `/sites/-/…` call needs the `person-ext-id` and `site-ext-id` headers
  (`src/client/edf.ts`). Without them it answers 401.

### Publish

```bash
pnpm dlx release-it       # bump, commit, tag
git push --follow-tags    # CI publishes to npm from the tag
```

## License

MIT
