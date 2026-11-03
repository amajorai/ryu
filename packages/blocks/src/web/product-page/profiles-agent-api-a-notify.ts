import { docsHref } from "../data/resources.tsx";
import {
	ENGLISH_LIMIT_VALUES,
	formatCount,
	PUBLISHED_PRICING,
} from "../data/standalone-pricing.ts";
import type { ProductProfile } from "./profile-types.ts";
import {
	API_HOSTS_SOURCE_PATH,
	PRICING_SOURCE,
	servicesCliRow,
	servicesSdkRow,
	profileMessage as tl,
} from "./profiles-agent-api-a-data.ts";

/**
 * Ryu Notify's profile, split out of ./profiles-agent-api-a.ts to keep each
 * file under the size limit. Notify tells a delivery story: publish, stream,
 * deliver, and what is redacted before storage. Same grounding rules: every
 * entry names its source file and a verbatim quote (checked by
 * ./profile-grounding.ts); the one price is computed from `PRICING_COPY`.
 */

const DOCS = "apps/fumadocs/content/docs";
const NOTIFY = `${DOCS}/standalone/notify.mdx`;
const NOTIFY_API = `${DOCS}/standalone/notify-api.mdx`;
const NOTIFY_STREAMS = `${DOCS}/standalone/notify-streams.mdx`;
const NOTIFY_SDK = `${DOCS}/standalone/sdk/notify.mdx`;

const NOTIFY_PUBLISH = [
	`curl -sS -X POST "\${RYU_NOTIFY_URL:-https://notify.ryuhq.com}/v1/events" \\`,
	'  -H "Authorization: Bearer $RYU_NOTIFY_API_KEY" \\',
	'  -H "Idempotency-Key: deploy-4821" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"title":"Deploy finished","level":"success","topic":"deployments"}'`,
].join("\n");

const NOTIFY_TOPIC = [
	'curl -fsS -X POST "$NOTIFY_URL/v1/topics/deployments" \\',
	`  -H "Authorization: Bearer \${RYU_NOTIFY_API_TOKEN}" \\`,
	"  -H 'Content-Type: text/plain' \\",
	"  -H 'Title: Canary live' \\",
	"  -d 'The canary is serving traffic.'",
].join("\n");

const NOTIFY_STREAM = [
	'curl -N "$NOTIFY_URL/v1/events/stream?source=github-actions" \\',
	`  -H "Authorization: Bearer \${RYU_NOTIFY_API_TOKEN}"`,
].join("\n");

const NOTIFY_REQUEST = `curl -sS -X POST "$RYU_NOTIFY_URL/v1/events" -H "Idempotency-Key: deploy-4821"`;

export const NOTIFY_PROFILE: ProductProfile = {
	facts: [
		{
			label: "History",
			value: "Bounded JSON events with history and aggregates",
			source: {
				path: NOTIFY,
				quote:
					"stores bounded JSON events in SQLite, with history and aggregates;",
			},
		},
		{
			label: "Live",
			value: "New events and activities over Server-Sent Events",
			source: {
				path: NOTIFY,
				quote:
					"streams new events and live activities over Server-Sent Events (SSE);",
			},
		},
		{
			label: "Delivery",
			value: "Durable, retrying HTTP destinations",
			source: {
				path: NOTIFY,
				quote: "delivers events to durable, retrying HTTP destinations;",
			},
		},
		{
			label: "Replies",
			value: "Approval, yes/no, and text, with optional signed callbacks",
			source: {
				path: NOTIFY,
				quote:
					"Collect approval, yes/no, and text replies with optional signed callbacks",
			},
		},
		{
			label: "Secrets at rest",
			value: "Destination and callback secrets sealed with AES-256-GCM",
			source: {
				path: NOTIFY,
				quote: "With AES-256-GCM, it encrypts these values in the database:",
			},
		},
	],
	code: [
		{
			id: "notify-publish",
			label: "Publish an event",
			language: "bash",
			code: NOTIFY_PUBLISH,
			source: {
				path: NOTIFY_SDK,
				quote: '-H "Idempotency-Key: deploy-4821" \\',
			},
		},
		{
			id: "notify-topic",
			label: "Post to a topic",
			language: "bash",
			code: NOTIFY_TOPIC,
			source: {
				path: NOTIFY_API,
				quote: "-d 'The canary is serving traffic.'",
			},
		},
		{
			id: "notify-stream",
			label: "Stream events",
			language: "bash",
			code: NOTIFY_STREAM,
			source: {
				path: NOTIFY_STREAMS,
				quote:
					'curl -N "$NOTIFY_URL/v1/events/stream?source=github-actions" \\',
			},
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Notify API",
			summary:
				"Events, topics, activities, destinations, deliveries, preferences, silences, and the usage report.",
			href: docsHref("/docs/standalone/notify-api"),
			source: {
				path: NOTIFY,
				quote: "| `usage` | Read accepted-event counts per whole UTC hour |",
			},
		},
		{
			kind: "REST",
			name: "Event stream",
			summary:
				"GET /v1/events/stream sends each new matching event as a Server-Sent Events frame.",
			href: docsHref("/docs/standalone/notify-streams"),
			source: {
				path: NOTIFY_STREAMS,
				quote:
					"The stream sends an initial `: ryu-notify` comment, then one frame for each matching event:",
			},
		},
		{
			kind: "Webhook",
			name: "Signed deliveries",
			summary:
				"Webhook destinations carry Standard Webhooks headers, so you can verify each delivery and drop replays.",
			href: docsHref("/docs/standalone/notify-api#webhook-signatures"),
			source: {
				path: NOTIFY_API,
				quote:
					"Verify `webhook-signature` with a constant-time comparison, reject timestamps more than a few minutes from your clock, and deduplicate on `webhook-id`.",
			},
		},
		servicesSdkRow("Notify", "/docs/standalone/sdk/notify"),
		servicesCliRow(
			"ryu-services notify",
			"/docs/standalone/sdk/notify-cli-mcp"
		),
	],
	openapi: {
		href: "/openapi/notify.json",
		baseUrl: "https://notify.ryuhq.com",
		source: { path: API_HOSTS_SOURCE_PATH, quote: '"notify.ryuhq.com",' },
	},
	limits: {
		title: "Rates and limits",
		rows: [
			{
				label: "Accepted events",
				value: ENGLISH_LIMIT_VALUES.notifyEvents,
				note: tl(
					"The first {freeEvents} events each calendar month are free. Replays and refused requests are not counted.",
					{
						freeEvents: formatCount(
							PUBLISHED_PRICING.notify.freeEventsPerMonth
						),
					}
				),
				source: PRICING_SOURCE,
			},
			{
				label: "Publishes",
				value: "10 per second per tenant",
				note: "Bursts of 200, shared by events and topics.",
				source: {
					path: NOTIFY_API,
					quote:
						"share a per-tenant budget of 10 per second with bursts of 200",
				},
			},
			{
				label: "Live streams",
				value: "64 per tenant",
				source: {
					path: NOTIFY_API,
					quote: "| Live streams | 64 per tenant;",
				},
			},
			{
				label: "JSON request body",
				value: "128 KiB",
				source: {
					path: NOTIFY_API,
					quote: "JSON request bodies are limited to 128 KiB.",
				},
			},
			{
				label: "Invalid keys",
				value: "30 per address per minute",
				note: "Then the address is blocked for a minute, doubling up to 15 minutes.",
				source: {
					path: NOTIFY_API,
					quote: "30 per client address per minute;",
				},
			},
		],
	},
	guardrail: {
		title: "Secrets in a payload are redacted before storage",
		description:
			"Event data is redacted recursively: a key that ends in token, secret, password, or a similar word is stored as [REDACTED]. Reusing an idempotency key with a different body is refused.",
		lines: [
			{
				kind: "command",
				text: `${NOTIFY_REQUEST} -d '{"title":"Deploy finished","data":{"commit":"abc123","githubToken":"<token>"}}'`,
			},
			{ kind: "allowed", text: "201 · event stored" },
			{
				kind: "output",
				text: 'data.commit = "abc123" · data.githubToken = "[REDACTED]"',
			},
			{
				kind: "command",
				text: `${NOTIFY_REQUEST} -d '{"title":"Deploy failed"}'`,
			},
			{
				kind: "denied",
				text: "409 idempotency_conflict · same key, different body",
			},
		],
		source: {
			path: NOTIFY_API,
			quote:
				"So `githubToken`, `x-api-key`, `AWS_SECRET_ACCESS_KEY`, and `db_password` are redacted, while `maxTokens` is not.",
		},
	},
	related: [
		{
			label: "Notify parity and adapters",
			href: "/docs/standalone/notify-parity",
			kind: "docs",
		},
		{
			label: "Notify CLI and MCP",
			href: "/docs/standalone/sdk/notify-cli-mcp",
			kind: "docs",
		},
	],
	docs: [
		{
			label: "Ryu Notify",
			path: "/docs/standalone/notify",
			description: "What it stores, abuse limits, and pricing.",
		},
		{
			label: "Notify SDK quickstart",
			path: "/docs/standalone/sdk/notify",
			description: "Publish and read events with curl and the SDK.",
		},
		{
			label: "Notify API",
			path: "/docs/standalone/notify-api",
			description: "Events, interactions, destinations, and errors.",
		},
		{
			label: "Event streams",
			path: "/docs/standalone/notify-streams",
			description: "Server-Sent Events frames and reconnects.",
		},
	],
};
