# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; @ryuhq/client

> Typed TypeScript client for the Ryu Core HTTP API. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/TypeScript-Client-3178C6.svg?logo=typescript&logoColor=white)](../../README.md)

`@ryuhq/client` is a typed client over Ryu Core's HTTP API: create a client, pick an agent, and stream. It has no internal Ryu dependencies and zero runtime dependencies. It uses native `fetch` and works in Node 18+, Bun, Deno, modern browsers, and React Native. It pairs with the open Core.

**Tier:** OSS, Apache-2.0

## React Native / Expo

Use the same package in a React Native app. Expo apps can inject `expo/fetch`
when they need streaming response bodies:

```tsx
import { fetch as expoFetch } from "expo/fetch";
import { createRyuClient, type RyuFetch } from "@ryuhq/client";

const client = createRyuClient({
  baseUrl: "http://192.168.1.10:7980",
  token: "your-node-token",
  fetch: expoFetch as RyuFetch,
});

const reply = await client.agents.run("pi", [
  { role: "user", content: "What is Ryu?" },
]);
```

Store the node token with the platform's secure storage. Do not put a provider
API key in the mobile bundle. For the full Core surface, use
`@ryuhq/core-client` with the same `{ url, token, fetch }` target shape.

## Install / Build

```bash
bun add @ryuhq/client
# build from source
bun run build   # tsup → dist/
```

## What it provides

- **`createRyuClient` / `RyuClient`** (`client.ts`): entry point and typed options (`RyuClientOptions`).
- **Agents API** (`agents.ts`, `AgentsAPI`): list and address agents, stream chat (`StreamChunk`).
- **Sessions API** (`sessions.ts`, `SessionsAPI`): conversations and messages (`Conversation`, `Message`).
- **Harness API** (`harness.ts`, `HarnessAPI`): durable sessions, idempotent runs, cursorable events, permissions, and cancellation.
- **Spaces API** (`spaces.ts`, `SpacesAPI`): Spaces / RAG retrieval (`Space`, `SpaceMatch`).
- **Mail API** (`mail.ts`, `MailAPI`): Agent Inboxes, messages, threads, attachments, drafts, signed webhooks and secret rotation, events, lists, pods, custom domains and their verification, idempotent sends, and realtime subscriptions.
- **Notify API** (`notify.ts`, `NotifyAPI`): tenant-scoped events, ntfy-style topics, SSE, live activities, interactive responses, destinations, delivery history, preferences, silences, groups, and analytics.
- **Box API** (`box.ts`, `BoxAPI`, `createBoxClient`): standalone Ryu Box service with its own tenant key: Box lifecycle, streaming and background commands, process logs, files and archives, previews, terminal and tunnel sockets, SSH, snapshots, forks, secrets, managed agent prompts, and usage. The package's `box-tunnel` command is an SSH `ProxyCommand` that reads `RYU_BOX_URL` and `RYU_BOX_API_KEY`.
- **Managed Agents API** (`managed-agents.ts`, `ManagedAgentsAPI`, `createManagedAgentsClient`): the hosted Ryu Managed Agents API with an API key: versioned agents, environments, read-only BYOK credentials, sessions, the event log, and a resumable event stream.
- **Messaging API** (`messaging.ts`, `MessagingAPI`, `createMessagingClient`): hosted Ryu Messaging with an API key: SMS, MMS, voice messages and WhatsApp over AWS End User Messaging, phone number quotes and leases, send quotes, the message log, the opt-out list, settings, and `verifyMessagingWebhook` for signed webhooks.
- **Transport** (`request.ts`, `types.ts`): the native-`fetch` request layer and shared types.

```ts
const session = await client.harness.createSession({
  runnableId: "pi",
  runnableKind: "agent",
});
const run = await client.harness.startRun(session.id, {
  prompt: "Summarize the current project.",
}, { idempotencyKey: "summary-1" });
for await (const event of client.harness.events(run.run.id)) {
  if (event.type === "text_delta") process.stdout.write(event.delta);
}

const inboxes = await client.mail.listInboxes();
const message = await client.mail.send(inboxes[0].id, {
	to: ["person@example.com"],
	subject: "Hello",
	text: "Sent through the Ryu Mail contract.",
}, "send-once-1");
```

### Standalone Notify

Pass a separate tenant API key and service URL when creating the top-level
client, or use `createNotifyClient` directly. Notify credentials are not Core
node credentials:

```ts
const client = createRyuClient({
  baseUrl: "http://localhost:7980",
  token: "core-node-token",
  notify: {
    baseUrl: "https://notify.example",
    apiKey: "notify-tenant-key",
  },
});

const event = await client.notify?.publish(
  { title: "Deploy complete", source: "ci", topic: "deployments" },
  "deploy-184",
);
```

### Managed Agents

`createManagedAgentsClient` talks to the hosted Managed Agents API on the Ryu
control plane, not to a Core node. It sends the API key as `x-api-key` and
appends `/api/v1/managed-agents` to `baseUrl`. Pass `organizationId` when you
use a personal API key; an organization key carries its organization.

```ts
import { createManagedAgentsClient, ManagedAgentsError } from "@ryuhq/client";

const managed = createManagedAgentsClient({
  baseUrl: "https://api.ryuhq.com",
  apiKey: "your-ryu-api-key",
});

const agent = await managed.agents.create(
  { name: "Support triage", model: "claude-opus-5-5" },
  { idempotencyKey: "agent-support-triage-1" },
);
const session = await managed.sessions.create(
  {
    agentId: agent.id,
    environmentId: "menv_…",
    initialEvents: [
      { type: "user.message", content: [{ type: "text", text: "Summarize ticket 1234" }] },
    ],
  },
  { idempotencyKey: "ticket-1234-session" },
);

try {
  for await (const event of managed.sessions.stream(session.id)) {
    if (event.type === "agent.message") console.log(event.content);
    if (event.type === "session.status" && event.status === "idle") break;
  }
} catch (error) {
  if (error instanceof ManagedAgentsError) console.error(error.status, error.code, error.requestId);
  throw error;
}
```

- `sessions.stream` replays the log and then tails it. It resumes a dropped
  connection with `Last-Event-ID`, skips event types newer than the client,
  and ends at the server's end frame, after a terminal status, or when its
  `signal` aborts. Use `sessions.events` to page the log instead.
- Pass `idempotencyKey` on writes you may retry; without it a retried
  `sessions.send` can append the same message twice.
- Environment writes need a personal API key. Credential writes need a signed-in
  console session, so this client only lists and reads credentials.
- Every non-2xx reply throws `ManagedAgentsError` with `status`, the stable
  `code`, `requestId` and `details`. The client never follows a redirect, so
  the API key is not resent to another origin; a 3xx throws with code
  `redirect_refused` (`MANAGED_AGENTS_REDIRECT_ERROR_CODE`).
- `environments.list({ includeArchived: true })` adds archived environments, and
  `credentials.list({ includeRevoked: true })` adds revoked credentials.
- `MANAGED_AGENTS_PROTOCOL_VERSION` names the wire contract the client
  implements (`ryu.managed-agents.v1`).

### Ryu Messaging

`createMessagingClient` talks to the hosted Ryu Messaging API on the Ryu
control plane (`/api/messaging`), not to a Core node. It sends the API key as
`x-api-key` and uses `organizationId` both in the route and as
`X-Ryu-Organization`. Reads need a key with the `messaging:read` scope; sends,
number purchases and settings need `messaging:manage`.

```ts
import {
  createMessagingClient,
  isKnownMessagingWebhookEvent,
  MessagingError,
  verifyMessagingWebhook,
} from "@ryuhq/client";

const messaging = createMessagingClient({
  baseUrl: "https://api.ryuhq.com",
  apiKey: "your-ryu-api-key",
  organizationId: "your-organization-id",
});

const [number] = await messaging.numbers.list();
const { quote, credit } = await messaging.quote({
  channel: "sms",
  to: "+12065550123",
  body: "Your code is 1234",
});

try {
  const message = await messaging.sms.send(
    { from: number.id, to: "+12065550123", body: "Your code is 1234" },
    { idempotencyKey: "order-1234-code" },
  );
  console.log(message.status, message.heldMicroUsd);
} catch (error) {
  if (error instanceof MessagingError && error.code === "insufficient_credits") {
    console.error(error.details.requiredMicroUsd);
  }
  throw error;
}

// In your webhook handler, with the raw request body:
const event = await verifyMessagingWebhook(secret, request.headers, rawBody);
if (isKnownMessagingWebhookEvent(event) && event.event_type === "message.received") {
  console.log(event.data.message.from, event.data.message.body);
}
```

- Every send and number purchase holds the quoted ceiling against the
  organization's credit, then charges the provider's price and releases the
  rest. Money fields are integer micro-USD.
- Sends and purchases always carry an `Idempotency-Key`. The client generates
  one when you omit it, so pass your own to retry safely: the same key and
  body replay the first result instead of sending or charging twice.
- Every non-2xx reply throws `MessagingError` with `status`, the stable `code`
  (`insufficient_credits`, `recipient_opted_out`, `country_not_allowed`,
  `outcome_unknown`, `price_changed`, ...), the reply's other fields in
  `details`, and `retryAfterSeconds`. An `outcome_unknown` send may have been
  sent; `messagingErrorMessageRecord(error)` returns its stored message, so
  check it with `messages.get` before sending again with a new key. An
  `outcome_unknown` number purchase is finished by retrying it with the same
  key. The client never follows a redirect (code `redirect_refused`).
- `messages.list` pages newest first; pass `nextCursor` back as `cursor`.
- `settings.update` returns the webhook signing secret once, when the first
  webhook URL is set, and `settings.rotateWebhookSecret` returns a new one.
  `verifyMessagingWebhook` checks the Standard Webhooks signature and a five
  minute timestamp tolerance and throws `MessagingWebhookVerificationError`
  otherwise. An event type newer than the client verifies too; acknowledge it.

## License

Apache-2.0. See [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
