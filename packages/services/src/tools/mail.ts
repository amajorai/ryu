// packages/services/src/tools/mail.ts
//
// Ryu Mail tools (`mail_*`): status, list_inboxes, list_messages,
// get_message, create_inbox and send. `mail_status` is credential-free on hosted Mail (the
// control plane's `GET /api/mail/status` needs no key), so `ryu-services mcp`
// registers it even without a Mail key. `mail_send` delivers real email to
// the outside world, so it is open-world, and it requires an `idempotencyKey`: a tool call re-issued
// after a host timeout must not send the email twice. `mail_create_inbox`
// requires a `clientId` for the same reason: both Mail servers answer a
// create that repeats a `clientId` with the inbox it already made, and both
// hold the clientId unique (hosted: the `one_inbox_per_client_id` index per
// owner scope; self-hosted: the lookup and insert run under one store lock),
// so a retry is idempotent even while the first call is still running. Tools
// call the canonical resource spelling (`ryu.mail.messages.list`).
//
// Ids go into request paths unencoded by MailAPI, so every id input is held
// to MAIL_ID (no `/`, `?`, `#`, `%` or dot segments): a crafted id must not
// reach another route, such as a "read" that lists webhooks or a send that
// becomes a forward.

import * as z from "zod";
import { READ, SEND } from "./annotations.ts";
import { nullableText, openObject, stringMap, toolOutput } from "./output.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

/** A Mail resource id: letters, digits, `_` and `-` (UUIDs and `inbox_1` alike). */
const MAIL_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** What both Mail servers accept as an Idempotency-Key: printable ASCII, 1-255 characters. */
const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,255}$/u;
const ADDRESS_WITH_AT = /@/u;
/** A full inbox address: one `@` with something on each side and no whitespace. */
const INBOX_ADDRESS = /^[^@\t\n\r ]+@[^@\t\n\r ]+$/u;
/**
 * A create-inbox `clientId`: printable ASCII that neither starts nor ends with a space.
 * Hosted Mail trims the clientId and self-hosted Mail compares it raw, so a padded id would
 * name one inbox on one server and two on the other.
 */
const CLIENT_ID = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/u;

const mailId = (what: string) =>
	z
		.string()
		.regex(MAIL_ID, `${what} is letters, digits, \`_\` and \`-\` only.`);

const listMessagesInput = z.object({
	inboxId: mailId("Inbox id").describe("Inbox id (from mail_list_inboxes)."),
	limit: z
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe("At most this many messages (default 50)."),
	before: z
		.string()
		.optional()
		.describe(
			"Only messages created before this ISO timestamp; pass the last message's createdAt for the next page."
		),
	direction: z
		.enum(["inbound", "outbound"])
		.optional()
		.describe(
			"inbound for messages the inbox received, outbound for messages it sent; omit for both."
		),
	q: z.string().optional().describe("Search text."),
});

const createInboxInput = z.object({
	name: z
		.string()
		.regex(/\S/u, "name must not be blank.")
		.describe(
			"Display name, also used as the sender name, e.g. 'Support agent'. Hosted Mail derives the address from it when no localPart is given."
		),
	clientId: z
		.string()
		.regex(
			CLIENT_ID,
			"clientId is printable ASCII with no leading or trailing space."
		)
		.describe(
			"Required. Your own id for this inbox (printable ASCII, no leading or trailing space). Creating again with the same clientId gives back the inbox already made instead of a second one, so reuse it when you retry."
		),
	address: z
		.string()
		.regex(INBOX_ADDRESS, "address is a full email address.")
		.optional()
		.describe(
			"Self-hosted Mail: required, the inbox's full address, e.g. 'support@example.com'. Hosted Mail ignores it."
		),
	localPart: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Hosted Mail: the part before the @. A taken or invalid one is refused rather than changed; omit it to derive one from name. Self-hosted Mail ignores it."
		),
	domainId: mailId("Domain id")
		.optional()
		.describe(
			"Hosted Mail: a verified custom domain to create the address on; omit for the default domain."
		),
	podId: mailId("Pod id")
		.optional()
		.describe("The pod (group of inboxes) to put the inbox in."),
	description: z
		.string()
		.optional()
		.describe(
			"Hosted Mail: a note about what the inbox is for. Self-hosted Mail ignores it."
		),
});

const getMessageInput = z.object({
	messageId: mailId("Message id").describe("Message id."),
});

const sendInput = z
	.object({
		from: z
			.string()
			.min(1)
			.refine((from) => ADDRESS_WITH_AT.test(from) || MAIL_ID.test(from), {
				message:
					"from is a sender address or an inbox id (letters, digits, `_` and `-`).",
			})
			.describe(
				"The sending inbox: its address (e.g. 'agent@example.com') or its id from mail_list_inboxes."
			),
		to: z
			.array(z.string().min(1))
			.min(1)
			.describe("Recipient addresses, e.g. ['someone@example.com']."),
		cc: z
			.array(z.string().min(1))
			.optional()
			.describe("Copy recipient addresses, e.g. ['team@example.com']."),
		bcc: z
			.array(z.string().min(1))
			.optional()
			.describe(
				"Blind-copy recipient addresses, hidden from the other recipients."
			),
		subject: z
			.string()
			.min(1)
			.describe("The subject line, e.g. 'Your build finished'."),
		text: z
			.string()
			.min(1)
			.optional()
			.describe("Plain-text body. Give exactly one of text or html."),
		html: z
			.string()
			.min(1)
			.optional()
			.describe("HTML body. Give exactly one of text or html."),
		idempotencyKey: z
			.string()
			.regex(
				IDEMPOTENCY_KEY,
				"idempotencyKey is printable ASCII, 1-255 characters."
			)
			.refine((key) => key.trim() !== "", {
				message: "idempotencyKey must not be blank.",
			})
			.describe(
				"Required. A key unique to this email (printable ASCII, 1-255 characters). Reuse the same key when you retry the same send: the server answers from the first attempt instead of sending again. A new key sends a new email."
			),
	})
	.refine(
		(input) => (input.text === undefined) !== (input.html === undefined),
		{
			message: "Give exactly one of text or html.",
			path: ["text"],
		}
	);

// Replies, as the Mail client normalizes them (packages/client mail.ts
// `inbox()` and `message()`): every field below is always set.

const statusData = z
	.looseObject({
		apiVersion: z.string(),
		configured: z.boolean(),
		sendConfigured: z.boolean(),
		domain: nullableText,
		domainMode: z.string(),
		inbound: z.string(),
		inboxCount: z.number(),
	})
	.describe("The Mail server's status.");

const inboxData = z
	.looseObject({
		id: z.string(),
		address: z.string(),
		name: z.string(),
		agentId: nullableText,
		clientId: nullableText,
		podId: nullableText,
		provider: z.string(),
		metadata: openObject,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Mail inbox.");

const attachmentData = z.looseObject({
	id: nullableText,
	filename: nullableText,
	contentType: nullableText,
	contentId: nullableText,
	inline: z.boolean(),
	size: z.number(),
});

const messageData = z
	.looseObject({
		id: z.string(),
		inboxId: z.string(),
		threadId: nullableText,
		direction: z.string(),
		status: z.string(),
		from: nullableText,
		to: z.array(z.string()),
		cc: z.array(z.string()),
		bcc: z.array(z.string()),
		replyTo: nullableText,
		subject: nullableText,
		text: nullableText,
		html: nullableText,
		preview: nullableText,
		labels: z.array(z.string()),
		headers: stringMap,
		attachments: z.array(attachmentData),
		read: z.boolean(),
		error: nullableText,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Mail message.");

/**
 * What `mail_list_inboxes` and `mail_send` tell an agent whose key has no
 * inbox yet: `mail_create_inbox` makes one where writes are allowed.
 */
const NO_INBOX_YET =
	"With no inbox yet, create one with `mail_create_inbox` (a write tool: an MCP server offers it only when writes are allowed, and a hosted key needs the mail:manage scope); without it, ask the person to create one with the SDK's `mail.inboxes.create` or the CLI's `mail inboxes create`.";

/**
 * Creates Ryu state, destroys nothing; a repeat with the same clientId changes nothing more.
 */
const CREATE_IDEMPOTENT = Object.freeze({
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

/** The Ryu Mail tools. */
export const MAIL_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "mail",
		name: "mail_status",
		title: "Check Ryu Mail status",
		description:
			"Reports whether the Mail server this client talks to has Mail configured and can send: configured, sendConfigured, domainMode (managed on hosted Mail, byo on a self-hosted server), domain (the domain hosted inboxes use; null when unset and on a self-hosted server), inbound and apiVersion; inboxCount is counted by a self-hosted server only (hosted Mail reports 0). On hosted Mail it describes the deployment, not whether your key or organization may use Mail. Hosted Mail answers it without a key, so it works before any Mail key is set; a self-hosted server needs its token.",
		inputSchema: z.object({}),
		annotations: READ,
		credentialFree: true,
		outputSchema: toolOutput(statusData),
		run: (ryu) => ryu.mail.status(),
	}),
	defineRyuTool({
		service: "mail",
		name: "mail_list_inboxes",
		title: "List Mail inboxes",
		description: `Lists the inboxes this Mail key can see, with their ids and addresses. ${NO_INBOX_YET}`,
		inputSchema: z.object({}),
		annotations: READ,
		outputSchema: toolOutput(z.array(inboxData)),
		run: (ryu) => ryu.mail.inboxes.list(),
	}),
	defineRyuTool({
		service: "mail",
		name: "mail_list_messages",
		title: "List Mail messages",
		description:
			"Lists one inbox's messages, newest first. Page with `before` set to the last message's createdAt.",
		inputSchema: listMessagesInput,
		annotations: READ,
		outputSchema: toolOutput(z.array(messageData)),
		run: (ryu, { inboxId, ...query }) => ryu.mail.messages.list(inboxId, query),
	}),
	defineRyuTool({
		service: "mail",
		name: "mail_get_message",
		title: "Get a Mail message",
		description:
			"Reads one message in full: sender, recipients, subject, body and attachment list.",
		inputSchema: getMessageInput,
		annotations: READ,
		outputSchema: toolOutput(messageData),
		run: (ryu, { messageId }) => ryu.mail.messages.get(messageId),
	}),
	defineRyuTool({
		service: "mail",
		name: "mail_create_inbox",
		title: "Create a Mail inbox",
		description:
			"Creates an inbox to send and receive email from and returns it with its id and address. `clientId` is required: a retry with the same one gives back the inbox already made. Self-hosted Mail needs `address`; hosted Mail ignores it and builds the address from `localPart`, else from `name`, on its default domain or `domainId`. A hosted key needs the mail:manage scope.",
		inputSchema: createInboxInput,
		annotations: CREATE_IDEMPOTENT,
		outputSchema: toolOutput(inboxData),
		run: (ryu, input) => ryu.mail.inboxes.create(input),
	}),
	defineRyuTool({
		service: "mail",
		name: "mail_send",
		title: "Send an email",
		description:
			"Sends an email from one of your inboxes to real recipients. Name the inbox in `from` (its address or id; the hosted Ryu MCP server's `mail_send` takes `inboxId` and `organizationId` instead). Give exactly one of `text` or `html`. `idempotencyKey` is required: reuse it to retry the same send safely, and use a new one for a new email. " +
			NO_INBOX_YET,
		inputSchema: sendInput,
		annotations: SEND,
		outputSchema: toolOutput(messageData),
		run: (ryu, { idempotencyKey, ...input }) =>
			ryu.mail.send(input, { idempotencyKey }),
	}),
];
