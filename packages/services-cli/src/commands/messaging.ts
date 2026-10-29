// packages/services-cli/src/commands/messaging.ts
//
// `ryu-services messaging …`: Ryu Messaging (early access) commands.
//
//   status
//   quote --to E164 --body T
//   sms send --from NUMBER_ID --to E164 --body T [--message-type T] [--ttl S] [--metadata k=v…]
//   numbers list [--include-released]
//   messages list [--limit N] [--cursor C] [--channel C] [--direction D] [--status S] [--all]
//   messages get <id>
//
// Configuration comes from RYU_API_KEY and RYU_ORGANIZATION_ID (and
// RYU_API_URL), or --api-key / --base-url. `ctx.ryu` already carries
// --idempotency-key (the send key) and --timeout. A send spends the
// organization's credit: retry a failed send with the same
// --idempotency-key, never without one.

import type { Ryu } from "@ryuhq/services";
import {
	booleanFlag,
	CliUsageError,
	countFlag,
	requireStringFlag,
	stringFlag,
	stringsFlag,
} from "../args.ts";
import { listPage, nextCursorOf } from "../list-output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";

type MessageListQuery = NonNullable<
	Parameters<Ryu["messaging"]["messages"]["list"]>[0]
>;

const CHANNELS = ["sms", "mms", "voice", "whatsapp"] as const;
const DIRECTIONS = ["outbound", "inbound"] as const;
const STATUSES = [
	"queued",
	"sending",
	"accepted",
	"delivered",
	"failed",
	"unresolved",
	"refused",
	"received",
] as const;
const MESSAGE_TYPES = ["TRANSACTIONAL", "PROMOTIONAL"] as const;

function requireArg(ctx: CommandContext, name: string): string {
	const [value, ...extra] = ctx.args;
	if (value === undefined || value === "") {
		throw new CliUsageError(`<${name}> is required.`);
	}
	if (extra.length > 0) {
		throw new CliUsageError(`Unexpected argument ${JSON.stringify(extra[0])}.`);
	}
	return value;
}

function rejectArgs(ctx: CommandContext): void {
	if (ctx.args.length > 0) {
		throw new CliUsageError(
			`Unexpected argument ${JSON.stringify(ctx.args[0])}.`
		);
	}
}

function oneOf<const T extends readonly string[]>(
	ctx: CommandContext,
	name: string,
	allowed: T
): T[number] | undefined {
	const value = stringFlag(ctx.flags, name);
	if (value === undefined) {
		return undefined;
	}
	const known = allowed.find((candidate) => candidate === value);
	if (known === undefined) {
		throw new CliUsageError(`--${name} must be one of ${allowed.join(", ")}.`);
	}
	return known;
}

/** `--metadata key=value`, repeatable. */
function metadataFlag(ctx: CommandContext): Record<string, string> | undefined {
	const entries = stringsFlag(ctx.flags, "metadata");
	if (entries.length === 0) {
		return undefined;
	}
	const metadata: Record<string, string> = {};
	for (const entry of entries) {
		const equals = entry.indexOf("=");
		if (equals <= 0) {
			throw new CliUsageError(
				`--metadata expects key=value, got ${JSON.stringify(entry)}.`
			);
		}
		metadata[entry.slice(0, equals)] = entry.slice(equals + 1);
	}
	return metadata;
}

const status: ServiceCommand = {
	path: ["status"],
	summary: "Whether Messaging is configured and which channels can send.",
	readOnly: true,
	run: (ctx) => {
		rejectArgs(ctx);
		return ctx.ryu.messaging.status();
	},
};

const quote: ServiceCommand = {
	path: ["quote"],
	summary:
		"The hold an SMS would place, and the organization's credit, without sending.",
	readOnly: true,
	example:
		'ryu-services messaging quote --to +6591234567 --body "Your order has shipped."',
	flags: {
		to: {
			type: "string",
			valueName: "e164",
			description: "Recipient, E.164 (+6591234567).",
			required: true,
		},
		body: {
			type: "string",
			valueName: "text",
			description: "The message text.",
			required: true,
		},
	},
	run: (ctx) => {
		rejectArgs(ctx);
		return ctx.ryu.messaging.quote({
			channel: "sms",
			to: requireStringFlag(ctx.flags, "to"),
			body: requireStringFlag(ctx.flags, "body"),
		});
	},
};

const sendSms: ServiceCommand = {
	path: ["sms", "send"],
	summary:
		"Send an SMS from one of the organization's numbers (holds credit first; pass --idempotency-key to retry safely).",
	effect:
		"Sends a real SMS to --to and charges the organization's credit. Check the cost first with messaging quote.",
	example:
		'ryu-services messaging sms send --from <number-id> --to +6591234567 --body "Your order has shipped." --idempotency-key order-123',
	flags: {
		from: {
			type: "string",
			valueName: "number-id",
			description:
				"The id of an organization number with the SMS capability (see numbers list).",
			required: true,
		},
		to: {
			type: "string",
			valueName: "e164",
			description: "Recipient, E.164.",
			required: true,
		},
		body: {
			type: "string",
			valueName: "text",
			description: "1 to 1600 characters.",
			required: true,
		},
		"message-type": {
			type: "string",
			valueName: "TRANSACTIONAL|PROMOTIONAL",
			description: "AWS message type.",
		},
		ttl: {
			type: "number",
			valueName: "seconds",
			description: "How long AWS keeps trying, 5 to 259200 seconds.",
		},
		metadata: {
			type: "strings",
			valueName: "key=value",
			description: "Returned on the message and its webhooks.",
		},
	},
	run: (ctx) => {
		rejectArgs(ctx);
		const messageType = oneOf(ctx, "message-type", MESSAGE_TYPES);
		const ttlSeconds = countFlag(ctx.flags, "ttl");
		const metadata = metadataFlag(ctx);
		return ctx.ryu.messaging.sms.send({
			from: requireStringFlag(ctx.flags, "from"),
			to: requireStringFlag(ctx.flags, "to"),
			body: requireStringFlag(ctx.flags, "body"),
			...(messageType === undefined ? {} : { messageType }),
			...(ttlSeconds === undefined ? {} : { ttlSeconds }),
			...(metadata === undefined ? {} : { metadata }),
		});
	},
};

const listNumbers: ServiceCommand = {
	path: ["numbers", "list"],
	summary:
		"List the numbers the organization holds, newest first, one JSON line each.",
	readOnly: true,
	flags: {
		"include-released": {
			type: "boolean",
			description: "Also list released and failed numbers (at most 200).",
		},
		all: {
			type: "boolean",
			description:
				"Not a paging flag here (the list is one page); use --include-released.",
		},
	},
	run: (ctx) => {
		rejectArgs(ctx);
		if (booleanFlag(ctx.flags, "all")) {
			// `--all` streams every page on the other list commands; this list
			// has one page, and its old `--all` meant released numbers too.
			throw new CliUsageError(
				"numbers list has one page, so it takes no --all; pass --include-released to also list released and failed numbers."
			);
		}
		return listPage(
			ctx,
			ctx.ryu.messaging.numbers.list(
				booleanFlag(ctx.flags, "include-released") ? { status: "all" } : {}
			),
			{ noun: "numbers", items: (numbers) => numbers }
		);
	},
};

const listMessages: ServiceCommand = {
	path: ["messages", "list"],
	summary:
		"List the message log, newest first (one page: one JSON line per message, the next page's cursor on stderr). --all reads every page.",
	readOnly: true,
	flags: {
		limit: {
			type: "number",
			valueName: "n",
			description: "Page size, 1 to 200 (default 50).",
		},
		cursor: {
			type: "string",
			valueName: "cursor",
			description: "The nextCursor of the previous page.",
		},
		channel: {
			type: "string",
			valueName: "sms|mms|voice|whatsapp",
			description: "Only this channel.",
		},
		direction: {
			type: "string",
			valueName: "outbound|inbound",
			description: "Only this direction.",
		},
		status: {
			type: "string",
			valueName: "status",
			description: `Only this status (${STATUSES.join(", ")}).`,
		},
		all: {
			type: "boolean",
			description: "Follow nextCursor to the end of the log.",
		},
	},
	run: (ctx) => {
		rejectArgs(ctx);
		const limit = countFlag(ctx.flags, "limit");
		const cursor = stringFlag(ctx.flags, "cursor");
		const channel = oneOf(ctx, "channel", CHANNELS);
		const direction = oneOf(ctx, "direction", DIRECTIONS);
		const messageStatus = oneOf(ctx, "status", STATUSES);
		const filters: MessageListQuery = {
			...(limit === undefined ? {} : { limit }),
			...(channel === undefined ? {} : { channel }),
			...(direction === undefined ? {} : { direction }),
			...(messageStatus === undefined ? {} : { status: messageStatus }),
		};
		if (booleanFlag(ctx.flags, "all")) {
			if (cursor !== undefined) {
				throw new CliUsageError("--all and --cursor cannot be combined.");
			}
			return ctx.ryu.messaging.messages.iterate(filters);
		}
		return listPage(
			ctx,
			ctx.ryu.messaging.messages.list(
				cursor === undefined ? filters : { ...filters, cursor }
			),
			{
				noun: "messages",
				items: (page) => page.messages,
				next: (page) => {
					const next = nextCursorOf(page);
					return next === null
						? null
						: `More messages: pass --cursor ${next} for the next page, or --all for every message.`;
				},
			}
		);
	},
};

const getMessage: ServiceCommand = {
	path: ["messages", "get"],
	usage: "<id>",
	summary: "Show one message, with its delivery status and charge.",
	readOnly: true,
	run: (ctx) => ctx.ryu.messaging.messages.get(requireArg(ctx, "id")),
};

/** Every `ryu-services messaging` command, in help order. */
export const messagingCommands: readonly ServiceCommand[] = [
	status,
	quote,
	sendSms,
	listNumbers,
	listMessages,
	getMessage,
];
