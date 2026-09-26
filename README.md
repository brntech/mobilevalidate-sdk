# MobileValidate SDKs, MCP server and examples

Official client libraries for the [MobileValidate API](https://mobilevalidate.com): check phone numbers and e-mail
addresses (messaging-app registration, carrier and line type, spam reputation, mailbox and account checks) before you
message, call or approve them.

| Directory | Package | Install |
|---|---|---|
| [`node/`](node) | [`mobilevalidate`](https://www.npmjs.com/package/mobilevalidate) (SDK + CLI) | `npm install mobilevalidate` |
| [`python/`](python) | [`mobilevalidate-sdk`](https://pypi.org/project/mobilevalidate-sdk/) | `pip install mobilevalidate-sdk` |
| [`mcp/`](mcp) | [`@mobilevalidate/mcp`](https://www.npmjs.com/package/@mobilevalidate/mcp) (MCP server for AI agents) | `npx -y @mobilevalidate/mcp` |
| [`examples/`](examples) | Tested recipes, [`AGENTS.md`](examples/AGENTS.md) and an agent skill | — |

Try it without signing up — the public sandbox key answers the documented
[test values](https://mobilevalidate.com/docs/test-values) and is never billed:

```bash
npx mobilevalidate check +447700900001 --sandbox
```

Docs: <https://mobilevalidate.com/docs> · API reference: <https://mobilevalidate.com/docs/api-reference> ·
Status: <https://mobilevalidate.com/status> · Changelog: <https://mobilevalidate.com/changelog>

This repository is exported from our internal monorepo; pull requests are welcome and are applied there.
Report problems at <https://mobilevalidate.com/contact>.

MIT © 2026 BroadNet Technologies Inc.
