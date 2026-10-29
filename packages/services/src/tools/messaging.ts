// packages/services/src/tools/messaging.ts
//
// Ryu Messaging tools (`messaging_*`): status (credential-free: `GET
// /api/messaging/status` needs no key), quote, send_sms and list_messages,
// plus list_numbers (the `from` id a send needs) and get_message (to follow
// up an `outcome_unknown` send). Messaging is early access and enabled per
// organization by Ryu.
//
// `messaging_send_sms` sends a real SMS and holds, then charges, the
// organization's credit, so it is open-world and requires an
// `idempotencyKey`: a tool call re-issued after a host timeout must not send
// or charge twice. The client percent-encodes every id it puts in a path.

import * as z from "zod";
import { READ, SEND } from "./annotations.ts";
import { nullableText, stringMap, toolOutput } from "./output.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

/** Printable ASCII, as the server's 255-character key allows. */
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/u;
const E164 = /^\+[1-9]\d{1,14}$/u;
/** The server's MESSAGING_METADATA_MAX_ENTRIES (packages/db messaging.model.ts); more entries get a 400. */
export const MESSAGING_METADATA_MAX_ENTRIES = 16;
/** The server's SMS ttlSeconds bounds (packages/api messaging router `ttlSchema`). */
const MESSAGING_TTL_MIN_SECONDS = 5;
const MESSAGING_TTL_MAX_SECONDS = 259_200;

const e164 = z
	.string()
	.regex(E164, "Use an E.164 phone number such as +6591234567.");

const quoteInput = z.object({
	to: e164.describe("Recipient, E.164 (+6591234567)."),
	body: z.string().min(1).max(1600).describe("The SMS text."),
});

const sendSmsInput = z.object({
	from: z
		.string()
		.min(1)
		.max(128)
		.describe(
			"The id of one of the organization's numbers with the SMS capability (see messaging_list_numbers)."
		),
	to: e164.describe("Recipient, E.164 (+6591234567)."),
	body: z.string().min(1).max(1600).describe("1 to 1600 characters."),
	messageType: z
		.enum(["TRANSACTIONAL", "PROMOTIONAL"])
		.optional()
		.describe(
			"AWS message type (default TRANSACTIONAL). Use PROMOTIONAL for marketing."
		),
	ttlSeconds: z
		.int()
		.min(MESSAGING_TTL_MIN_SECONDS)
		.max(MESSAGING_TTL_MAX_SECONDS)
		.optional()
		.describe(
			`How long AWS keeps trying to deliver, ${MESSAGING_TTL_MIN_SECONDS} to ${MESSAGING_TTL_MAX_SECONDS} seconds.`
		),
	metadata: z
		.record(z.string().min(1).max(64), z.string().max(512))
		.refine(
			(value) => Object.keys(value).length <= MESSAGING_METADATA_MAX_ENTRIES,
			`metadata holds at most ${MESSAGING_METADATA_MAX_ENTRIES} entries.`
		)
		.optional()
		.describe("Up to 16 entries, returned on the message and its webhooks."),
	idempotencyKey: z
		.string()
		.regex(
			IDEMPOTENCY_KEY,
			"idempotencyKey is printable ASCII without spaces, 1-255 characters."
		)
		.describe(
			"Required. A key unique to this SMS. Reuse it when you retry the same send: the server replays the first result instead of sending and charging again, unless the first attempt was refused (provider_refused or a 4xx), which frees the key for a new attempt. A new key sends a new SMS."
		),
});

const listMessagesInput = z.object({
	limit: z.int().min(1).max(200).optional().describe("Page size (default 50)."),
	cursor: z
		.string()
		.max(256)
		.optional()
		.describe("The nextCursor of the previous page."),
	channel: z
		.enum(["sms", "mms", "voice", "whatsapp"])
		.optional()
		.describe("Only this channel."),
	direction: z
		.enum(["outbound", "inbound"])
		.optional()
		.describe("Only outbound sends or inbound replies."),
	status: z
		.enum([
			"queued",
			"sending",
			"accepted",
			"delivered",
			"failed",
			"unresolved",
			"refused",
			"received",
		])
		.optional()
		.describe("Only this status."),
});

const getMessageInput = z.object({
	messageId: z.string().min(1).max(128).describe("The message id."),
});

const listNumbersInput = z.object({
	includeReleased: z
		.boolean()
		.optional()
		.describe("Also list released and failed numbers."),
	all: z
		.boolean()
		.optional()
		.describe(
			"Deprecated alias of includeReleased (the list is one page, so this is not a paging flag)."
		),
});

// Replies, mirroring the Messaging contracts (packages/client
// messaging-contracts.ts `messageValidation`, `numberValidation` and
// `quoteValidation`). Amounts are micro-USD.

const statusData = z
	.looseObject({
		apiVersion: z.string(),
		configured: z.boolean(),
		channels: z.looseObject({
			sms: z.boolean(),
			mms: z.boolean(),
			voice: z.boolean(),
			whatsapp: z.boolean(),
		}),
	})
	.describe("Whether the control plane has Messaging configured, by channel.");

const messageData = z
	.looseObject({
		id: z.string(),
		organizationId: z.string(),
		channel: z.string(),
		direction: z.string(),
		status: z.string(),
		from: z.string(),
		to: z.string(),
		body: nullableText,
		segments: z.number(),
		numberId: nullableText,
		isoCountryCode: nullableText,
		providerStatus: nullableText,
		heldMicroUsd: z.number(),
		priceMicroUsd: z.number().nullable(),
		chargedMicroUsd: z.number(),
		chargeState: z.string(),
		metadata: stringMap,
		error: nullableText,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Messaging message.");

const numberData = z
	.looseObject({
		id: z.string(),
		phoneNumber: nullableText,
		isoCountryCode: z.string(),
		numberType: z.string(),
		capabilities: z.array(z.string()),
		messageType: z.string(),
		status: z.string(),
		label: nullableText,
		twoWayEnabled: z.boolean(),
		monthlyLeaseMicroUsd: z.number(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A leased phone number.");

const quoteData = z
	.looseObject({
		channel: z.string(),
		credit: z.looseObject({
			availableMicroUsd: z.number(),
			heldMicroUsd: z.number(),
		}),
		quote: z.looseObject({
			ceilingMicroUsd: z.number(),
			isoCountryCode: z.string(),
		}),
	})
	.describe(
		"The most the send would hold (quote.ceilingMicroUsd, with segments for SMS) and the available credit."
	);

/** The Ryu Messaging tools. */
export const MESSAGING_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "messaging",
		name: "messaging_status",
		title: "Check Ryu Messaging status",
		description:
			"Reports whether the Ryu control plane has Messaging configured and which channels can send (configured, channels.sms, channels.mms, channels.voice, channels.whatsapp, apiVersion). It describes the deployment, not your organization: Ryu enables Messaging per organization and the organization also turns on its Messaging feature, which this does not show. Needs no key, so it works before RYU_API_KEY and RYU_ORGANIZATION_ID are set, and then sends neither.",
		inputSchema: z.object({}),
		annotations: READ,
		credentialFree: true,
		outputSchema: toolOutput(statusData),
		run: (ryu) => ryu.messaging.status(),
	}),
	defineRyuTool({
		service: "messaging",
		name: "messaging_quote",
		title: "Quote an SMS",
		description:
			"Returns the most an SMS to this recipient would hold from the organization's credit (in micro-USD, from the AWS price list), the segment count, and the available credit. Sends nothing.",
		inputSchema: quoteInput,
		annotations: READ,
		outputSchema: toolOutput(quoteData),
		run: (ryu, input) => ryu.messaging.quote({ channel: "sms", ...input }),
	}),
	defineRyuTool({
		service: "messaging",
		name: "messaging_send_sms",
		title: "Send an SMS",
		description:
			"Sends a real SMS from one of the organization's numbers and holds its quoted cost on the organization's credit until AWS reports the price. `idempotencyKey` is required: reuse it to retry the same send safely. An `outcome_unknown` error means it may have been sent; read the message with messaging_get_message before sending again with a new key.",
		inputSchema: sendSmsInput,
		annotations: SEND,
		outputSchema: toolOutput(messageData),
		run: (ryu, { idempotencyKey, ...input }) =>
			ryu.messaging.sms.send(input, { idempotencyKey }),
	}),
	defineRyuTool({
		service: "messaging",
		name: "messaging_list_messages",
		title: "List Messaging messages",
		description:
			"Lists the organization's message log, newest first (one page): sends with their delivery status and charge, and inbound replies. Page with `cursor` set to the previous nextCursor.",
		inputSchema: listMessagesInput,
		annotations: READ,
		outputSchema: toolOutput(
			z.looseObject({
				messages: z.array(messageData),
				nextCursor: nullableText,
			})
		),
		run: (ryu, input) => ryu.messaging.messages.list(input),
	}),
	defineRyuTool({
		service: "messaging",
		name: "messaging_get_message",
		title: "Get a Messaging message",
		description:
			"Reads one message: status, provider status, segments and its held, settled and charged amounts.",
		inputSchema: getMessageInput,
		annotations: READ,
		outputSchema: toolOutput(messageData),
		run: (ryu, { messageId }) => ryu.messaging.messages.get(messageId),
	}),
	defineRyuTool({
		service: "messaging",
		name: "messaging_list_numbers",
		title: "List Messaging numbers",
		description:
			"Lists the phone numbers the organization leases, with their ids, capabilities and status. Use an id as `from` in messaging_send_sms.",
		inputSchema: listNumbersInput,
		annotations: READ,
		outputSchema: toolOutput(z.array(numberData)),
		run: (ryu, { includeReleased, all }) =>
			ryu.messaging.numbers.list(
				includeReleased === true || all === true ? { status: "all" } : {}
			),
	}),
];
