# @ryuhq/services

One TypeScript entry point for Ryu's standalone services: Managed Agents,
Messaging, Mail, Notify, Box, Gateway, Connect, Passport and Sites.

> **Status:** @ryuhq/services is not yet published to npm; it requires
> @ryuhq/client 0.4 or later, which is also not yet on npm (latest is 0.3.0).
> Inside the Ryu monorepo it is available as the `@ryuhq/services` workspace
> package.

## Quickstart

Once the package is on npm, install it with `npm install @ryuhq/services`.
The snippet below reads Notify's key (hosted Notify keys are provisioned by
Ryu in early access), so set it first. `RYU_NOTIFY_URL` defaults to
`https://notify.ryuhq.com`; set it only for another origin:

```sh
export RYU_NOTIFY_API_KEY="<your tenant key>"
```

```ts
import { Ryu } from "@ryuhq/services";

// Object mode: API and configuration errors are returned, never thrown.
const ryu = new Ryu({ result: "object" });
const { data, error, meta } = await ryu.notify.publish({
  title: "Deploy finished",
  level: "success",
});
if (error) {
  console.error(error.code, error.status, error.requestId);
} else {
  console.log(data.id, meta.requestId, meta.replayed);
}
```

The default `result: "throw"` returns the value and throws `RyuError`:

```ts
import { isRyuError, Ryu } from "@ryuhq/services";

const ryu = new Ryu();
try {
  await ryu.notify.publish({ title: "Deployed" });
} catch (error) {
  if (isRyuError(error)) console.error(error.code);
}

// The object form for one call:
const result = await ryu.safe.notify.publish({ title: "Deployed" });
```

Async iterables (`sessions.stream`, `notify.events.stream`, Box exec streams) throw
`RyuError` in both modes.

## Configuration

Constructor options win over environment variables, which win over defaults.
`new Ryu({ env: false })` turns env reads off; `new Ryu({ env: c.env })` reads
another object (for example Hono's bindings). Configuration is resolved on a
namespace's first call, so a missing variable fails that call with
`RyuConfigurationError` (`code: "configuration_error"`, `details.missing`
naming the variables), not the constructor.

| Service | URL env | Key env | Default URL |
|---|---|---|---|
| `managedAgents` | `RYU_API_URL` | `RYU_API_KEY` (+ `RYU_ORGANIZATION_ID`) | `https://api.ryuhq.com` |
| `messaging` | `RYU_API_URL` | `RYU_API_KEY` (`messaging:*` scopes) + `RYU_ORGANIZATION_ID` (required); `status()` needs neither | `https://api.ryuhq.com` |
| `mail` (hosted) | `RYU_MAIL_URL` | `RYU_MAIL_GATEWAY_KEY` (`x-gateway-key`), else `RYU_API_KEY` (`x-api-key`, + `RYU_ORGANIZATION_ID`) | `https://api.ryuhq.com` (`RYU_API_URL`) when no URL is given |
| `mail` (self-hosted) | `RYU_MAIL_URL` (required) | `RYU_MAIL_API_KEY` | none |
| `notify` | `RYU_NOTIFY_URL` | `RYU_NOTIFY_API_KEY` (provisioned by Ryu for hosted Notify) | `https://notify.ryuhq.com` |
| `box` | `RYU_BOX_URL` | `RYU_BOX_API_KEY` (provisioned by Ryu for hosted Box) | `https://box.ryuhq.com` |
| `gateway` | `RYU_GATEWAY_URL` | `RYU_GATEWAY_TOKEN` (required unless the Gateway sets `require_auth = false`) | `http://127.0.0.1:7981` |
| `connect` | `RYU_CONNECT_URL` | `RYU_CONNECT_API_KEY`, `RYU_CONNECT_MANAGEMENT_KEY` | none |
| `passport` | `RYU_PASSPORT_URL` | `RYU_PASSPORT_API_KEY`, `RYU_PASSPORT_RUNTIME_KEY` | none |
| `sites` | `RYU_SITES_URL` | `RYU_SITES_API_KEY` | none |

There is no single key for every service. A `ryu_` key (`RYU_API_KEY`) covers
Managed Agents, Messaging (with the `messaging:*` scopes) and hosted Mail (with
the `mail:read`, `mail:send` or `mail:manage` scopes), all on the control-plane
origin, and is never sent to
another service or origin, including a self-hosted Mail URL. Hosted Mail also
takes an `x-gateway-key` minted through Ryu node enrollment. A Mail key passed
as an option (`mail.gatewayKey`, `mail.apiKey`, `apiKey`) wins over every env
var; within options and then within env vars, the gateway key comes first,
then the self-hosted bearer (with a `RYU_MAIL_URL`), then the `ryu_` key.
`managedAgents.apiKey` never selects hosted Mail, and `mail.connectRealtime()`
throws `realtime_unavailable` with a `ryu_` key rather than putting it in a
socket URL. Every other service takes its own token.

So sending mail with a `ryu_` key whose Mail access is Read & send
(`mail:read` and `mail:send`; create it as a fine-grained token in the Ryu
console) is:

```ts
import { Ryu } from "@ryuhq/services";

const ryu = new Ryu(); // reads RYU_API_KEY
await ryu.mail.send({ from: "agent@acme.example", to: ["person@example.com"], subject: "Hi", text: "Hello" });
```

An address in `from` is looked up with a read (`mail:read`); a key with only
`mail:send` passes the inbox ID as `from` instead.

The table is exported as `ENV_VARS`, and each service's availability label as
`AVAILABILITY`.

## Errors

Every failure is a `RyuError` with a stable `code`, the HTTP `status` (0 when
no response arrived), `requestId`, `retryAfterSeconds`, `rateLimit`,
`deprecation`, `details`, `docs`, `hint` and `retryable`. Subclasses include
`RyuConfigurationError`, `RyuConnectionError`, `RyuTimeoutError`,
`RyuAbortError`, `RyuRedirectError`, `RyuInvalidRequestError`,
`RyuAuthenticationError`, `RyuPaymentRequiredError`, `RyuPermissionError`,
`RyuNotFoundError`, `RyuConflictError`, `RyuRateLimitError`,
`RyuQuotaExceededError`, `RyuUnavailableError`, `RyuServerError` and
`RyuResponseValidationError`. `error.toJSON()` is safe to log: it never contains
keys, headers or query strings.

Requests send `Accept: application/problem+json, application/json;q=0.9, */*;q=0.8`
unless a call sets its own, so services that negotiate RFC 9457 answer errors as
problem details (`error.envelope === "problem+json"`). The parser reads both that
form and each service's legacy envelope into the same fields.

## Retries, idempotency and timeouts

- Writes on each service's idempotent routes get an `Idempotency-Key` (a UUID)
  that is reused on every retry. Pass your own with
  `ryu.notify.with({ idempotencyKey: "deploy-4821" }).publish(…)`.
- Up to `maxRetries` (default 2) retries for network errors, timeouts, 408,
  425, 500, 502, 503 and 504 when the request is replay-safe, for 429 when the
  server says how long to wait, and for 409 `idempotency_in_progress`. Quota,
  billing and availability codes are never retried. A requested wait longer
  than `maxRetryDelayMs` (default 30 s) is returned as the error instead.
- `timeoutMs` (default 60 s) applies per attempt until response headers arrive,
  so streams are not cut off. `.with({ signal })` aborts a call.
- `meta.replayed` is true when the server answered with a stored result: an
  `Idempotent-Replayed: true` header (Box, the control plane) or the service's
  body marker (Box `type: "box.existing"`, Notify `idempotent: true`).
- Redirects are never followed, so keys never reach another origin.
- `hooks.onDeprecation` fires once per route when a response carries
  `Deprecation` or `Sunset`.

## Agent tools

`@ryuhq/services/tools` exposes the services as agent tools from one
registry, the same one `ryu-services mcp` serves: the same names, input
schemas and MCP hints.

```ts
import { Ryu } from "@ryuhq/services";
import { toAiSdkTools, toRyuAgentTools } from "@ryuhq/services/tools";

const ryu = new Ryu();
const agentTools = toRyuAgentTools(ryu); // for an @ryuhq/sdk Agent
const aiSdkTools = toAiSdkTools(ryu, { services: ["notify"] }); // Vercel AI SDK
```

Only read-only tools are returned unless you pass `readOnly: false`. By
default `needsApproval` covers every tool that is not read-only and every
open-world tool. See
`https://docs.ryuhq.com/docs/standalone/sdk/agent-tools`.

## Runtime support

The client runs on Node, Bun, Deno and edge runtimes that provide `fetch`. The
`User-Agent: ryu-services/<version>` header is sent only from server runtimes.
Passing a key in a browser throws unless `dangerouslyAllowBrowser: true` is
set. Box terminal and tunnel sockets need a `WebSocket` implementation.

## Namespaces in this release

All nine namespaces are implemented. Each has a quickstart at
`https://docs.ryuhq.com/docs/standalone/sdk/<service>`.

- `managedAgents`, `mail`, `notify` and `box` wrap the `@ryuhq/client`
  clients. `mail`, `notify` and `box` group calls by resource
  (`ryu.mail.inboxes.list()`, `ryu.notify.events.get()`); the flat client
  names (`listInboxes`, `getEvent`, ...) still work as deprecated aliases
  that send the same request.
- `messaging` covers Ryu Messaging on the control plane: SMS, MMS, voice and
  WhatsApp sends (`ryu.messaging.sms.send()`, ...), numbers, the messages and
  opt-outs lists with `iterate()` helpers, `quote`, settings and
  `settings.rotateWebhookSecret()`. Messaging is in early access: Ryu
  enables it per organization, and the organization must also turn on its
  Ryu Messaging feature.
- `gateway` covers the Gateway's OpenAI-compatible `/v1` routes, health and
  auth status.
- `connect` covers Connect's runtime routes only; management routes are not
  wrapped.
- `passport` covers Passport's admin and `/v1/runtime/*` routes. A connection
  starts `NEEDS_AUTH`; when `connections.login(id)` returns a `manual` flow,
  `connections.importState(id, { state })` seals the captured state and marks
  it `AUTHENTICATED`, after which `fetch` works.
- `sites` covers the Sites management listener.
