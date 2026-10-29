# @ryuhq/services-cli

`ryu-services`: a command line and a stdio MCP server for Ryu's standalone
services, built on [`@ryuhq/services`](../services/README.md).

> `@ryuhq/services-cli` is not yet published to npm. It depends on
> `@ryuhq/services`, which requires `@ryuhq/client` 0.4 or later and is not on
> npm yet either. Inside this repository, run it with
> `bun packages/services-cli/src/bin.ts`. The same command line arrives as
> `ryu-cli services` in a Ryu release after 0.4.0.

## Commands

```
ryu-services <service> <command> [args] [--json] [--dry-run] [--base-url U] [--api-key K]
             [--idempotency-key K] [--timeout ms] [--max-retries n]
ryu-services doctor [--check]
ryu-services webhooks verify --service mail|notify|messaging [--kind destination|callback]
             [--scheme standard|legacy] [--allow-body-only-signature] [--secret @file] --headers @h.json < payload
ryu-services mcp [--services notify,box] [--allow-writes]
ryu-services connect          # prints where Connect's own /mcp endpoint is
```

Run `ryu-services --help`, `ryu-services <service> --help` or
`ryu-services <service> <command> --help` for the commands each service has.
`ryu-services --version` (or `-V`), with no command, prints the installed
version; with `--json` it prints `{ "data": { "name": "ryu-services",
"npmNote": …, "npmPublishedVersion": …, "version": … }, "meta": null }`.
While `@ryuhq/services` is not on npm, `--version` adds a `note:` line on
stderr and `doctor` one at the end of its report (`npmStatusNote`): a
workspace build says so, and a host that bundles the CLI passes
`CliIo.bundledWith` (`ryu-cli services` passes `ryu-cli <version>`) so the
note names it instead. Under `--json` the same text is `npmNote` (null once
published). `CliIo.npmPublishedVersion` overrides the published version.

Configuration comes from the environment variables that `@ryuhq/services`
reads (`RYU_NOTIFY_URL`, `RYU_NOTIFY_API_KEY`, `RYU_GATEWAY_URL`, …) and from the
flags above. Nothing is written to disk. Pass keys through env vars rather than
`--api-key`: flags end up in shell history.

- `--json` prints one JSON document on stdout: `{ "data", "meta" }` on success,
  `{ "error" }` (from `RyuError.toJSON()`, which never contains keys) on failure.
  Streams print one JSON line per item.
- A list command that reads one page (`notify events list`, `box list`, …)
  prints one JSON line per item without `--json`, and says how to read the
  next page (or `No <items>.`) on stderr, so stdout holds only items. With
  `--json` it prints the page as the SDK returns it under `{ data, meta }`;
  `--all`, on the lists that page, streams every item as JSON lines.
- `--dry-run` prints the request as `curl` instead of sending it. Keys appear
  only as their env placeholder: `$RYU_<SERVICE>_API_KEY` (Notify, Box,
  Passport, Sites, self-hosted Mail), `$RYU_API_KEY` for Managed Agents and
  Messaging, `$RYU_GATEWAY_TOKEN` for Gateway, `$RYU_MAIL_GATEWAY_KEY` for
  hosted Mail (`$RYU_API_KEY` when hosted Mail is reached with only the `ryu_`
  key). It works without a key.
  Only the first request is printed: a command that makes several calls (for
  example create, then send) stops after the first one, and a stream shows
  only its opening request. `mail send --from <address>` first looks the
  inbox up, so its dry run prints that `GET` and a stderr line saying the
  send was left out (with `--json`, the output carries `complete: false` and
  that `note`); pass the inbox id as `--from` to print the send itself.
- `doctor` shows what each service resolves to, with keys shown only as set or
  unset. A service that resolves only through a built-in default (Gateway's
  `http://127.0.0.1:7981`) shows as `default (not set)` and is neither probed
  nor counted. `doctor --check` sends one GET per configured service. These
  probes verify the key and report `authenticated`: Managed Agents
  `agents?limit=1`; Messaging `/api/messaging/orgs/{orgId}/settings`; Mail `/api/mail/pods` when hosted or `/api/mail/status`
  when self-hosted; Notify `/v1/events?limit=1`; Box `/v1/boxes`; Sites
  `/api/sites/status`; Passport `/v1/capabilities`, or
  `/v1/runtime/connections` with only a runtime grant. Gateway and Connect
  still probe their public `/health` and report
  `reachable (auth not verified)`. A `ryu_` key without `mail:read` is
  reported as `authenticated (key lacks the scope this probe reads)` and does
  not fail the check. `--check` also exits `1` for a service that env sets but
  that does not resolve (for example `RYU_BOX_URL` without a scheme), since it
  can never be probed.
  `doctor` and `webhooks verify` send no service call, so they reject
  `--dry-run`, `--api-key`, `--base-url`, `--idempotency-key` and
  `--max-retries`.
- `webhooks verify` reads the signing secret from `--secret @file`,
  `RYU_WEBHOOK_SECRET`, or `--secret value` (which lands in shell history).
  `--headers` takes a JSON object mapping each header name to its value,
  inline or as `@file`. `--scheme legacy` verifies Mail webhooks created
  before Standard Webhooks signing. A Notify destination delivery without
  the `webhook-*` headers is rejected, because its body-only signature can be
  replayed. `--allow-body-only-signature` (Notify destination deliveries only)
  accepts it, as `allowBodyOnlySignature` does in the SDK; `--require-timestamp`
  is the default and cannot be combined with it.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The service answered with an error (`code`, `message`, `status`, `requestId`, `retryAfter` when the service sent a Retry-After delay, and `hint` are printed) |
| 2 | Usage or configuration error |
| 4 | `webhooks verify` rejected the delivery |

## MCP server

`ryu-services mcp` serves MCP over stdio as `ryu-services`. It registers the tools
of every service whose configuration is set in env; services that are not set
register nothing and get one line on stderr. stdout carries JSON-RPC only.
Only tools annotated `readOnlyHint` are registered unless you pass
`--allow-writes`; a startup stderr line names the mode in effect. `--read-only`
is still accepted (it is the default) and cannot be combined with
`--allow-writes`. Connect has no tools:
it is an MCP server itself, so point your client at `${RYU_CONNECT_URL}/mcp`.
Because most hosts never show stderr to the model, the `initialize` result
also carries `instructions`: the mode in effect, the registered services, each
skipped service with the env vars it needs (Connect's names its `/mcp`
endpoint), and a pointer to `ryu-services doctor`. They name variables, never
values.

Until the package is on npm there is no `ryu-services` executable to point a
client at; run the workspace entry with Bun (use the checkout's absolute
path, as `ryu-services mcp --help` prints it). `ryu-cli services mcp` arrives
in a Ryu release after 0.4.0; no released Ryu carries it yet:

```json
{
  "mcpServers": {
    "ryu-services": {
      "command": "bun",
      "args": ["/path/to/ryu/packages/services-cli/src/bin.ts", "mcp"],
      "env": { "RYU_NOTIFY_URL": "https://notify.example.com", "RYU_NOTIFY_API_KEY": "…" }
    }
  }
}
```

Tool results are `structuredContent: { data, meta }` plus the same JSON as text.
Errors set `isError` and carry `{ error }` with a stable `error.code`.

## Library

```ts
import { registerServiceTools, runCli, SERVICE_COMMANDS } from "@ryuhq/services-cli";

const code = await runCli(["doctor", "--json"], {
	env: { RYU_GATEWAY_URL: "http://127.0.0.1:7981" },
	stdout: { write: (chunk) => process.stdout.write(chunk) },
});
```

`runCli(argv, io)` never calls `process.exit`; `io` injects `stdout`, `stderr`,
`env`, `fetch` and `stdin`. `registerServiceTools(server, ryu, { services,
readOnly })` adds the service tools to any `McpServer` (`readOnly` defaults
to `true`; pass `false` for the write tools), for exactly the
services `ryu.isConfigured(service)` reports (set explicitly, not by a default
alone). Importing the package has no side effects; the bin is a separate
entry.

## Adding commands and tools

- A service's CLI commands are a `readonly ServiceCommand[]` in
  `src/commands/<service>.ts`. Each declares its `path`, `summary`, optional
  `flags` and `usage`, and a `run(ctx)` that returns the facade call
  (`ctx.ryu.notify.publish(…)`), so `--json`, `--dry-run` and
  `--idempotency-key` work without extra code: `ctx.ryu` already has
  `--idempotency-key` and `--timeout` bound to every namespace.
- A service's MCP tools are registered in `src/mcp/tools/<service>.ts` with
  `server.tool({ name, title, description, inputSchema, annotations, run })`.
  Names start with the service prefix (`notify_`, `managed_agents_`, …) and all
  four annotations are required. Bound streaming tools with `collectEvents`.
