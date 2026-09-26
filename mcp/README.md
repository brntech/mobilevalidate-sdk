# @mobilevalidate/mcp

<!-- mcp-name: com.mobilevalidate/mcp -->

[Model Context Protocol](https://modelcontextprotocol.io) server for [MobileValidate](https://mobilevalidate.com). It
lets AI agents (Claude Desktop, Claude Code, Cursor, VS Code and any other MCP client) check phone numbers — registration
on WhatsApp, Telegram, Viber, Signal and other platforms, carrier and line type, report-based spam reputation — and e-mail
addresses (mailbox exists; account on Gmail, Outlook, Apple and others; yes / no / unknown only, never names or
profiles). Several services can be checked in one call (`checks`); `list_services` shows what the key can use.

It is a thin client of the public MobileValidate API, built on the [`mobilevalidate`](https://mobilevalidate.com/docs/sdk)
SDK. It holds no credentials of its own: your key is only forwarded to `api.mobilevalidate.com`.

Two ways to use it:

| | Hosted (remote) | Local (stdio) |
|---|---|---|
| Runs | at `https://mcp.mobilevalidate.com/mcp` (Streamable HTTP) | on your machine via `npx -y @mobilevalidate/mcp` |
| Key | header `Authorization: Bearer <key>` | env `MOBILEVALIDATE_API_KEY` |
| Needs | nothing to install | Node.js ≥ 20 (`npx` downloads the package) |

Both run the same tools with the same spend safeguards. Try either with a test key: the documented test values return
fixed answers and nothing is billed.

Keys: an **agent key** (`mv_agent_…`, scoped, daily spend cap) or a **test key** (`mv_test_…`, free, never billed).
Live keys (`mv_live_…`) are refused by the MCP server on purpose. Get a personal test key at
<https://mobilevalidate.com/get-test-key>; agent keys come with an approved account.

Docs: <https://mobilevalidate.com/docs/mcp>

## Quick start (hosted, test key)

```bash
export MOBILEVALIDATE_API_KEY=mv_test_...     # your personal test key
claude mcp add --transport http mobilevalidate https://mcp.mobilevalidate.com/mcp \
  --header "Authorization: Bearer $MOBILEVALIDATE_API_KEY"
```

Then ask: *"Check +447700900001, +447700900002 and +447700900003 on WhatsApp."* You get registered, not registered and
unknown. Test keys never reach a real network and are never billed: the magic values below give fixed answers, and
any other number gets a made-up but stable answer.

Just looking? The public sandbox key `mv_test_publicSandboxn9ZgneuhR1B9CRfKG3fulym` works too, but it answers **only**
the magic values below (anything else is refused with `sandbox_magic_only`), has low shared rate limits and cannot run
large jobs. Use your own test key for anything more.

| Test number | Result |
|---|---|
| `+447700900001` | registered |
| `+447700900002` | not registered |
| `+447700900003` | unknown (`registered: null`) |
| `+447700900004` | pending for about 5 s, then registered |
| `+447700900005` | `unsupported_country` |
| `+447700900006` | registered, business account |

Test e-mail addresses: `registered@test.mobilevalidate.com`, `not-registered@…`, `unknown@…` (same domain). Full list:
<https://mobilevalidate.com/docs/test-values>.

## Client configuration

### Claude Code

```bash
# hosted
claude mcp add --transport http mobilevalidate https://mcp.mobilevalidate.com/mcp \
  --header "Authorization: Bearer $MOBILEVALIDATE_API_KEY"
# local stdio
claude mcp add mobilevalidate --env MOBILEVALIDATE_API_KEY=mv_agent_... -- npx -y @mobilevalidate/mcp
```

`.mcp.json` equivalent of the hosted setup:

```json
{
  "mcpServers": {
    "mobilevalidate": {
      "type": "http",
      "url": "https://mcp.mobilevalidate.com/mcp",
      "headers": { "Authorization": "Bearer ${MOBILEVALIDATE_API_KEY}" }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

Hosted (live):

```json
{
  "mcpServers": {
    "mobilevalidate": {
      "url": "https://mcp.mobilevalidate.com/mcp",
      "headers": { "Authorization": "Bearer ${env:MOBILEVALIDATE_API_KEY}" }
    }
  }
}
```

Local stdio: `{ "mcpServers": { "mobilevalidate": { "command": "npx", "args": ["-y", "@mobilevalidate/mcp"], "env": { "MOBILEVALIDATE_API_KEY": "mv_agent_..." } } } }`

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "mobilevalidate": {
      "type": "http",
      "url": "https://mcp.mobilevalidate.com/mcp",
      "headers": { "Authorization": "Bearer ${input:mobilevalidate-key}" }
    }
  },
  "inputs": [
    { "id": "mobilevalidate-key", "type": "promptString", "description": "MobileValidate agent or test key", "password": true }
  ]
}
```

### Claude Desktop (`claude_desktop_config.json`)

Claude Desktop connects to remote servers with a key through a stdio bridge such as the community
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) package (hosted server, live):

```json
{
  "mcpServers": {
    "mobilevalidate": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.mobilevalidate.com/mcp", "--header", "Authorization:Bearer ${MOBILEVALIDATE_API_KEY}"],
      "env": { "MOBILEVALIDATE_API_KEY": "mv_agent_..." }
    }
  }
}
```

Local stdio:

```json
{
  "mcpServers": {
    "mobilevalidate": {
      "command": "npx",
      "args": ["-y", "@mobilevalidate/mcp"],
      "env": { "MOBILEVALIDATE_API_KEY": "mv_agent_..." }
    }
  }
}
```

### Any other MCP client

- **Streamable HTTP:** URL `https://mcp.mobilevalidate.com/mcp`, header `Authorization: Bearer mv_agent_…`. The
  server is stateless: `POST` only, JSON responses, no session id.
- **stdio:** command `npx`, args `["-y", "@mobilevalidate/mcp"]`, env `MOBILEVALIDATE_API_KEY=mv_agent_…`.
  To pin a version use `@mobilevalidate/mcp@1.0.3`. After `npm install -g @mobilevalidate/mcp` the command is
  `mobilevalidate-mcp`.

## Tools

| Tool | What it does | Spends credits | Annotations |
|---|---|---|---|
| `normalize_numbers` | Local, free E.164 formatting. Flags ambiguous inputs (no country) and duplicates | no | read-only, idempotent, closed-world |
| `estimate_cost` | Free pre-flight (numbers and/or `emails`): valid, invalid, duplicate and cached counts, plus the maximum cost of a bulk job | no | read-only, idempotent |
| `lookup_numbers` | Check up to 100 numbers (optionally with `emails`, 100 in total) for one or more real-time services (`checks`; waits up to `wait_seconds`, default 20) | yes | not read-only, idempotent, open-world |
| `lookup_emails` | Check up to 100 e-mail addresses (default check `email`; e.g. `apple.email`) in real time | yes | not read-only, idempotent, open-world |
| `check_spam_reputation` | Spam reputation of up to 100 numbers (runs `number.spam` only): per number `risk_level`, `risk_score`, reasons, top category, first/last seen, sources, plus counts per level | yes | not read-only, idempotent, open-world |
| `create_lookup_job` | Bulk check (up to 50,000 numbers and/or `emails`) for any active service, including bulk-only ones (e.g. `gmail`). Returns `job_id` | yes | not read-only, not idempotent (retries of the same arguments are deduplicated) |
| `get_lookup_job` | Job status plus a filtered (`registered`, `service`), paginated page of results (one item per number or e-mail) | no | read-only, idempotent |
| `list_services` | Services the key can use: input type (phone/email), real time or bulk only, attributes, countries, prices | no | read-only, idempotent |
| `get_account` | Balance, reserved credit, today's usage, limits | no | read-only, idempotent |

Every tool declares a `title`, annotations, `inputSchema` and `outputSchema`. Each one returns `structuredContent`
plus a one-line text summary. `checks` takes service codes or aliases (e.g. `whatsapp`, `telegram`, `viber`,
`carrier`, `spam`); its description lists the real-time and bulk-only codes known to this build (from the SDK's generated
catalog), and `list_services` gives the live list. Result items keep the v1 top-level fields (WhatsApp if requested,
otherwise the first service) and add a `checks` map per service when more than one service (or a non-WhatsApp service)
was requested. Tool descriptions state the anti-enumeration limits (≥ 20 consecutive numbers refused, daily caps).

**E-mails.** Phone services run on `numbers`, e-mail services on `emails`; send at least one check of each
kind you send. Result items carry `kind` (`phone`/`email`); e-mail items have `email` (normalized, `null` if invalid),
`email_status` (`valid`, `invalid_email`, `duplicate`, `suppressed`) and `number_status: null`. Descriptions state the
e-mail rules: ≥ 20 addresses on one domain differing only by digits are refused as enumeration, and answers are
yes/no/unknown only — no names, photos or profiles. Test keys use `registered@test.mobilevalidate.com`,
`not-registered@…`, `unknown@…` (same domain).

**Spam reputation.** `check_spam_reputation` (or `checks: ["spam"]` on the other tools) answers from spam and
nuisance-call reports: regulator actions, government complaint data, community reports and recently-unassigned numbers.
Countries US, CA, DE (others → `unsupported_country`, free). `no_reports` means no reports are known — **not** that the
number is safe; it is still a conclusive, billed answer. Limits: ≤ 100 numbers per call, the same spend confirmation and
anti-enumeration rules as `lookup_numbers`. Test keys: `+447700900001` high, `…002` no_reports, `…003` unknown, `…004`
pending then medium, `…005` unsupported_country. Attribute values may be integers (`risk_score`, `sources`). Live
network status (HLR, `hlr`) is coming soon and not offered by the tools yet.

### Spend safety

Before `lookup_numbers`, `lookup_emails`, `check_spam_reputation` or `create_lookup_job` spends anything, the server
calls the free estimate. Real-time tools quote the maximum at the key's **real-time** prices (from `list_services`),
`create_lookup_job` at bulk prices. The call is refused with a `confirmation_required` error result when either of
these is true:

- the maximum cost is above `MCP_CONFIRM_ABOVE_USD` (default `1.00`), or
- a job has more than 100 numbers and e-mails.

Scopes (agent keys): the real-time tools need `lookup:write` **and** `jobs:write` (the estimate is
`POST /v1/jobs/estimate`); `estimate_cost` and `create_lookup_job` need `jobs:write`; `get_lookup_job` needs `jobs:read`;
`get_account` needs `account:read`. `list_services` needs none.

The error text states the amount and tells the agent to ask the user. The agent then re-invokes the tool with
`confirm_max_cost` set to the amount shown. The confirmed (or estimated) amount is always sent to the API as
`max_cost`, so the API refuses any request that would cost more.

**Limitation:** this confirmation is agent-mediated. The server cannot prove that a human approved the amount.
The hard limits are the key's own spend cap and the `max_cost` guard. A human confirmation URL is planned.

Other rules:
- Only `mv_agent_…` (scoped, spend-capped) and `mv_test_…` keys are accepted. `mv_live_…` keys are rejected with
  a clear message.
- There is no `webhook_url` parameter, and request metadata is never echoed into tool output.
- Logs go to stderr and contain counts and ids only. Anything that looks like a phone number or an e-mail address is masked.

## Environment variables

| Env | Default | Used by |
|---|---|---|
| `MOBILEVALIDATE_API_KEY` | none (required) | stdio: the `mv_agent_`/`mv_test_` key |
| `MOBILEVALIDATE_BASE_URL` | `https://api.mobilevalidate.com` | both. |
| `MCP_CONFIRM_ABOVE_USD` | `1.00` | both |
| `MCP_HOST` / `MCP_PORT` | `127.0.0.1` / `3300` | HTTP |
| `MCP_ALLOWED_HOSTS` | none | HTTP: extra `Host` values allowed (comma-separated), e.g. behind a reverse proxy |
| `MCP_LOG` | on | set `off` to silence stderr logs |
| `MV_MCP_FORWARD_SECRET` | none | HTTP, hosted deployment only: secret shared with the API so sandbox-key calls are rate limited per end client, not per server |
| `MCP_CLIENT_IP_HEADER` | `cf-connecting-ip` | HTTP: header with the end client's IP, trusted only from a loopback peer (tunnel/proxy) |

## Self-hosting the HTTP transport

```bash
MCP_HOST=127.0.0.1 MCP_PORT=3300 npx -y -p @mobilevalidate/mcp mobilevalidate-mcp-http   # once published
```

`POST /mcp` only (stateless, JSON responses) and `GET /healthz`. Each request's `Authorization: Bearer` key is forwarded
to the API for that request only and never stored. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, plus any
value in `MCP_ALLOWED_HOSTS` (DNS-rebinding protection) — set it when you put the server behind a reverse proxy, and
terminate TLS in front of it. Bodies are limited to 2 MB.

## Security notes

- Use an agent key (`mv_agent_…`) with a spend cap you are comfortable with; the key's cap and the `max_cost` guard are
  the hard limits. Test keys are free.
- Put the key in the client's `env` / header configuration, not in prompts. The server never logs keys; its stderr
  logs contain counts and ids only, and anything that looks like a phone number or e-mail address is masked.
- Spending above `MCP_CONFIRM_ABOVE_USD` requires the agent to ask the user first (see *Spend safety*); this is
  agent-mediated, so keep the key's spend cap as the real limit.
- Only check numbers and addresses the user has a legitimate relationship with. Enumeration patterns are refused and
  daily caps apply.

## Maintainers

Source is TypeScript in `src/` (run directly with `tsx` inside the monorepo: `pnpm --filter @mobilevalidate/mcp start`
for HTTP on `127.0.0.1:3300`, `start:stdio` for stdio). The published package contains only the compiled `dist/`,
`README.md`, `LICENSE` and `server.json`; `publishConfig` swaps `main` / `exports` / `bin` from `src/` to `dist/` and
pnpm rewrites the `workspace:*` SDK dependency to the exact SDK version — so always pack with **pnpm**
(`ops/publish-packages.sh`), never plain `npm pack` / `npm publish` from this directory. The build compiles against the
SDK's `dist/` types, so build the SDK first.

```bash
pnpm --filter @mobilevalidate/mcp run typecheck
pnpm --filter @mobilevalidate/mcp test
pnpm --filter mobilevalidate run build && pnpm --filter @mobilevalidate/mcp run build   # → dist/
ops/publish-packages.sh                     # build, test, pack, leak-scan, npm publish --dry-run (SDK, then MCP)
NPM_TOKEN=… ops/publish-packages.sh --yes   # real publish
```

Release checklist: bump `version` in `package.json`, `SERVER_VERSION` in `src/tools.ts` and both `version` fields in
`server.json` (a test enforces they match). The SDK must be published first, because this package pins its exact
version.

**MCP Registry.** Listed as `com.mobilevalidate/mcp` (domain-verified namespace). `server.json` follows the registry
schema `2025-12-11`; `mcpName` in `package.json` must equal its `name` (the registry checks it on npm).

## License

MIT © 2026 BroadNet Technologies Inc. See [LICENSE](./LICENSE).
