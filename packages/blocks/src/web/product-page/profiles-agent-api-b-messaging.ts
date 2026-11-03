import { docsHref } from "../data/resources.tsx";
import type { ProductProfile } from "./profile-types.ts";
import { servicesCliRow, servicesSdkRow } from "./profiles-agent-api-a-data.ts";

/**
 * Ryu Messaging's profile, split out of ./profiles-agent-api-b.ts to keep each
 * file under the size limit. Messaging tells a ceiling story: quote a send,
 * hold the most it can cost, settle at the AWS price, and refuse anything that
 * cannot go before a hold is taken. Messaging has no Ryu price of its own, so
 * nothing here shows a dollar amount (profiles-agent-api-b.test.ts enforces
 * it); the only `$` signs are shell variables.
 */

const DOCS = "apps/fumadocs/content/docs";
const MESSAGING = `${DOCS}/standalone/messaging.mdx`;
const MESSAGING_API = `${DOCS}/standalone/messaging-api.mdx`;
const MESSAGING_NUMBERS = `${DOCS}/standalone/messaging-numbers.mdx`;
const MESSAGING_SDK = `${DOCS}/standalone/sdk/messaging.mdx`;

const QUOTE_LINE =
	'curl -sS "$RYU_API_URL/api/messaging/orgs/$RYU_ORGANIZATION_ID/quote?channel=sms&to=%2B6591234567&body=Your%20order%20has%20shipped." \\';

const MESSAGING_QUOTE = [
	QUOTE_LINE,
	'  -H "x-api-key: $RYU_API_KEY" \\',
	'  -H "X-Ryu-Organization: $RYU_ORGANIZATION_ID"',
].join("\n");

const SEND_BODY = `-d '{"from":"<number-id>","to":"+6591234567","body":"Your order has shipped."}'`;

const MESSAGING_SEND = [
	'curl -sS -X POST "$RYU_API_URL/api/messaging/orgs/$RYU_ORGANIZATION_ID/sms" \\',
	'  -H "x-api-key: $RYU_API_KEY" \\',
	'  -H "X-Ryu-Organization: $RYU_ORGANIZATION_ID" \\',
	'  -H "Idempotency-Key: order-1842-shipped" \\',
	'  -H "Content-Type: application/json" \\',
	`  ${SEND_BODY}`,
].join("\n");

/** One SMS send as a single terminal line, with its own idempotency key. */
function sendCommand(key: string, to: string): string {
	return `curl -sS -X POST "$RYU_API_URL/api/messaging/orgs/$RYU_ORGANIZATION_ID/sms" -H "x-api-key: $RYU_API_KEY" -H "Idempotency-Key: ${key}" -d '{"from":"<number-id>","to":"${to}","body":"Your order has shipped."}'`;
}

export const MESSAGING_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Carrier network",
			value: "AWS End User Messaging, passed through with no markup",
			source: { path: MESSAGING, quote: "passed through with **no markup**." },
		},
		{
			label: "Voice",
			value: "Outbound text-to-speech messages only, no live calls",
			source: {
				path: MESSAGING,
				quote: "Voice is outbound text-to-speech only.",
			},
		},
		{
			label: "Credit balance",
			value: "A Messaging charge never takes it below zero",
			source: {
				path: MESSAGING,
				quote: "A Messaging charge never takes the balance below zero:",
			},
		},
		{
			label: "Access",
			value:
				"Enabled by Ryu per organization, then turned on by the organization",
			source: {
				path: MESSAGING,
				quote:
					"Ryu enables it for each organization, and the organization must also turn on the **Ryu Messaging** feature, which is off by default.",
			},
		},
		{
			label: "Hosting",
			value: "Ryu-hosted only; there is no self-hosted Messaging service",
			source: {
				path: MESSAGING,
				quote: "There is no self-hosted Messaging service;",
			},
		},
	],
	code: [
		{
			id: "messaging-quote",
			label: "Quote a send",
			language: "bash",
			code: MESSAGING_QUOTE,
			source: { path: MESSAGING_SDK, quote: QUOTE_LINE },
		},
		{
			id: "messaging-send",
			label: "Send it",
			language: "bash",
			code: MESSAGING_SEND,
			source: { path: MESSAGING_SDK, quote: SEND_BODY },
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Messaging API",
			summary:
				"Quote, send, and read SMS, MMS, WhatsApp, and voice messages; lease and release numbers; manage opt-outs and settings.",
			href: docsHref("/docs/standalone/messaging-api"),
			source: {
				path: MESSAGING_API,
				quote:
					"| `GET` | `/orgs/:orgId/quote` | read | The hold a send would place, and the organization's credit |",
			},
		},
		{
			kind: "Webhook",
			name: "Signed delivery events",
			summary:
				"Replies, delivery results, and number changes arrive signed with Standard Webhooks headers. Deduplicate on the event id.",
			href: docsHref("/docs/standalone/messaging-api#settings-and-webhooks"),
			source: {
				path: MESSAGING_API,
				quote: "Deduplicate on `event_id`, which equals `webhook-id`.",
			},
		},
		servicesSdkRow("Messaging", "/docs/standalone/sdk/messaging"),
		servicesCliRow(
			"ryu-services messaging",
			"/docs/standalone/sdk/messaging-cli-mcp"
		),
	],
	openapi: {
		href: "/openapi/messaging.json",
		baseUrl: "https://api.ryuhq.com/api/messaging",
		source: {
			path: "apps/web/public/openapi/messaging.json",
			quote: "https://api.ryuhq.com/api/messaging",
		},
	},
	limits: {
		title: "Send caps and channel limits",
		rows: [
			{
				label: "Price per message",
				value: "The AWS End User Messaging price",
				note: "Varies by destination country, carrier, number type, encoding, and WhatsApp category. No Ryu markup.",
				source: {
					path: MESSAGING,
					quote:
						"Prices depend on the destination country, the carrier, the number type, the message encoding, and, for WhatsApp, Meta's conversation category.",
				},
			},
			{
				label: "Sends per minute",
				value: "60",
				note: "Per organization. A throttled send gets 429 with a Retry-After header.",
				source: {
					path: MESSAGING_API,
					quote: "| Per organization per minute | 60 sends |",
				},
			},
			{
				label: "Sends per hour",
				value: "1,000",
				source: {
					path: MESSAGING_API,
					quote: "| Per organization per hour | 1,000 sends |",
				},
			},
			{
				label: "Sends per UTC day",
				value: "1,000 by default",
				note: "Or the organization's own daily limit, from 0 to 100,000.",
				source: {
					path: MESSAGING_API,
					quote:
						"1,000 sends, or the organization's `dailySendLimit` (0 to 100,000)",
				},
			},
			{
				label: "Numbers per organization",
				value: "25 by default",
				note: "Each lease renews every 30 days. One whose renewal cannot be paid is suspended for 7 days, then released.",
				source: {
					path: MESSAGING,
					quote: "An organization holds at most 25 numbers by default.",
				},
			},
			{
				label: "SMS body",
				value: "1,600 characters",
				note: "Split into parts by AWS.",
				source: {
					path: MESSAGING,
					quote:
						"Text messages up to 1,600 characters, split into parts by AWS",
				},
			},
			{
				label: "MMS media",
				value: "600 KiB",
				note: "One JPEG, PNG, GIF, or MP4, with optional text.",
				source: {
					path: MESSAGING,
					quote:
						"One image or video (JPEG, PNG, GIF, or MP4, up to 600 KiB) with optional text",
				},
			},
		],
	},
	guardrail: {
		title: "Nothing is held for a send that cannot go",
		description:
			"Each send is checked in order: the sender, the price, allowed countries, the opt-out list, spend limits, and send limits. The hold is taken only after all of them pass, so a refused send is never charged.",
		lines: [
			{
				kind: "command",
				text: sendCommand("order-1842-shipped", "+6591234567"),
			},
			{
				kind: "allowed",
				text: "202 accepted · the ceiling is held, then settled at the AWS price",
			},
			{
				kind: "command",
				text: sendCommand("order-1843-shipped", "<a number that sent STOP>"),
			},
			{
				kind: "denied",
				text: "422 recipient_opted_out · refused before any hold is taken",
			},
			{
				kind: "command",
				text: sendCommand("order-1844-shipped", "+6591234567"),
			},
			{
				kind: "denied",
				text: "402 insufficient_credits · nothing was sent or charged",
			},
		],
		source: {
			path: MESSAGING_API,
			quote: "The hold is taken only after all of them pass.",
		},
	},
	related: [
		{
			label: "Numbers, senders, and opt-outs",
			href: "/docs/standalone/messaging-numbers",
			kind: "docs",
		},
		{
			label: "Live calls with the phone assistant",
			href: "/docs/gateway/phone-assistant",
			kind: "docs",
		},
		{
			label: "Channel bots on your own credentials",
			href: "/docs/gateway/channels",
			kind: "docs",
		},
	],
	docs: [
		{
			label: "Ryu Messaging",
			path: "/docs/standalone/messaging",
			description: "Channels, holds, access, and limits.",
		},
		{
			label: "Messaging SDK quickstart",
			path: "/docs/standalone/sdk/messaging",
			description: "Quote and send a first SMS.",
		},
		{
			label: "Messaging API",
			path: "/docs/standalone/messaging-api",
			description: "Every route, error code, and send limit.",
		},
	],
};

/** The opt-out rule the guardrail shows, as the numbers page states it. */
export const OPT_OUT_SOURCE = {
	path: MESSAGING_NUMBERS,
	quote:
		"refuses a listed recipient with `422 recipient_opted_out`, before any hold is taken.",
} as const;
