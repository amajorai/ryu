// packages/services-cli/src/commands/notify.ts
//
// `ryu-services notify …`: Ryu Notify commands (design §10).
//
//   publish --title T [--body B] [--level L] [--topic T] [--source S] [--recipient R] [--tag T…]
//   request-approval --title T [--prompt P] [--response-type approval|yes_no] [--timeout-ms N] [--wait-ms N] […publish flags]
//   events list [--limit N] [--before CURSOR] [--level L] [--topic T] [--source S] [--recipient R] [--acknowledged|--unacknowledged] [--all]
//   events get <id>
//   events ack <id>
//   usage [--from ISO] [--to ISO]
//
// The commands cover the `notify_*` tools one for one (publish,
// request_approval, list_events, get_event, ack_event, usage) with the same
// inputs, so a person can do in a shell what an agent does through MCP.
//
// Configuration comes from RYU_NOTIFY_URL and RYU_NOTIFY_API_KEY, or
// --base-url / --api-key. `ctx.ryu` already carries --idempotency-key (the
// publish key) and --timeout.

import {
	createRyuError,
	isRyuError,
	messageWithoutHint,
	type Ryu,
} from "@ryuhq/services";
import {
	DEFAULT_APPROVAL_TOOL_TIMEOUT_MS,
	DEFAULT_APPROVAL_WAIT_MS,
	defaultNotifyUsageWindow,
	MAX_APPROVAL_TIMEOUT_MS,
	MAX_APPROVAL_WAIT_MS,
	NOTIFY_TOOL_LEVELS,
} from "@ryuhq/services/tools";
import {
	booleanFlag,
	CliUsageError,
	countFlag,
	type FlagSpecs,
	numberFlag,
	requireStringFlag,
	stringFlag,
	stringsFlag,
} from "../args.ts";
import { listPage, nextCursorOf } from "../list-output.ts";
import type { CommandContext, ServiceCommand } from "../registry.ts";

/** Notify's event levels (the `notify_*` tools' list, from one registry). */
export const NOTIFY_LEVELS = NOTIFY_TOOL_LEVELS;

type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

/** The `notify.publish` input (the `@ryuhq/client` NotifyEventInput). */
type NotifyEventInput = Parameters<Ryu["notify"]["publish"]>[0];

/**
 * The window `usage` reads when `--from`/`--to` are omitted: the 24 whole UTC
 * hours before the next hour boundary, so the current hour is included. The
 * same function as the `notify_usage` tool's default.
 */
export const defaultUsageWindow = defaultNotifyUsageWindow;

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

function levelFlag(ctx: CommandContext): NotifyLevel | undefined {
	const level = stringFlag(ctx.flags, "level");
	if (level === undefined) {
		return undefined;
	}
	const known = NOTIFY_LEVELS.find((candidate) => candidate === level);
	if (known === undefined) {
		throw new CliUsageError(
			`--level must be one of ${NOTIFY_LEVELS.join(", ")}.`
		);
	}
	return known;
}

/** `--limit` as a page size Notify accepts (1-100). */
function limitFlag(ctx: CommandContext): number | undefined {
	const limit = numberFlag(ctx.flags, "limit");
	if (limit === undefined) {
		return undefined;
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new CliUsageError("--limit must be an integer from 1 to 100.");
	}
	return limit;
}

/** The event fields `publish` and `request-approval` share. */
function eventInput(ctx: CommandContext): NotifyEventInput {
	const input: NotifyEventInput = {
		title: requireStringFlag(ctx.flags, "title"),
	};
	const body = stringFlag(ctx.flags, "body");
	const level = levelFlag(ctx);
	const topic = stringFlag(ctx.flags, "topic");
	const source = stringFlag(ctx.flags, "source");
	const recipient = stringFlag(ctx.flags, "recipient");
	const url = stringFlag(ctx.flags, "url");
	const tags = stringsFlag(ctx.flags, "tag");
	if (recipient !== undefined) {
		if (recipient === "") {
			throw new CliUsageError("--recipient needs a value.");
		}
		input.recipient = recipient;
	}
	if (body !== undefined) {
		input.body = body;
	}
	if (level !== undefined) {
		input.level = level;
	}
	if (topic !== undefined) {
		input.topic = topic;
	}
	if (source !== undefined) {
		input.source = source;
	}
	if (url !== undefined) {
		input.url = url;
	}
	if (tags.length > 0) {
		input.tags = [...tags];
	}
	return input;
}

function publish(ctx: CommandContext): unknown {
	rejectArgs(ctx);
	return ctx.ryu.notify.publish(eventInput(ctx));
}

/** A millisecond flag within `[min, max]`, or undefined. */
function msFlag(
	ctx: CommandContext,
	name: string,
	min: number,
	max: number
): number | undefined {
	const value = countFlag(ctx.flags, name);
	if (value !== undefined && (value < min || value > max)) {
		throw new CliUsageError(`--${name} must be from ${min} to ${max}.`);
	}
	return value;
}

/**
 * The hint a keyed `request-approval` rerun's 409 `idempotency_conflict`
 * gets. Each run sets a new deadline (`response.expiresAt`), so Notify
 * refuses the rerun's body under the first run's key instead of replaying
 * it; the first request is read with `events get` / `events list`. The
 * `notify_request_approval` tool says the same with its own tool names.
 */
export const APPROVAL_KEY_REUSED_CLI_HINT =
	"An approval request was already published under this --idempotency-key, and a rerun cannot replay it because each run sets a new deadline. Read the first request with `ryu-services notify events get <id>` (or find it with `ryu-services notify events list`) instead of running request-approval again; use a new key only to ask again.";

/** Gives a keyed rerun's 409 `idempotency_conflict` {@link APPROVAL_KEY_REUSED_CLI_HINT}. */
function withApprovalKeyHint(error: unknown): unknown {
	if (
		!isRyuError(error) ||
		error.status !== 409 ||
		error.code !== "idempotency_conflict"
	) {
		return error;
	}
	const { name: _name, ...fields } = error.toJSON();
	return createRyuError({
		...fields,
		message: messageWithoutHint(error),
		hint: APPROVAL_KEY_REUSED_CLI_HINT,
		cause: error.cause,
	});
}

/**
 * `request-approval`: the `notify_request_approval` tool's call, through the
 * same `ryu.notify.requestApproval` helper and defaults (open 10 minutes,
 * wait 45 s). With --idempotency-key, a rerun gets 409
 * `idempotency_conflict` (see {@link APPROVAL_KEY_REUSED_CLI_HINT}).
 */
function requestApproval(ctx: CommandContext): unknown {
	rejectArgs(ctx);
	const input = eventInput(ctx);
	const prompt = stringFlag(ctx.flags, "prompt");
	const responseType = stringFlag(ctx.flags, "response-type");
	if (
		responseType !== undefined &&
		responseType !== "approval" &&
		responseType !== "yes_no"
	) {
		throw new CliUsageError("--response-type must be approval or yes_no.");
	}
	const timeoutMs =
		msFlag(ctx, "timeout-ms", 1000, MAX_APPROVAL_TIMEOUT_MS) ??
		DEFAULT_APPROVAL_TOOL_TIMEOUT_MS;
	const waitMs =
		msFlag(ctx, "wait-ms", 0, MAX_APPROVAL_WAIT_MS) ?? DEFAULT_APPROVAL_WAIT_MS;
	const keyed = ctx.call.idempotencyKey !== undefined;
	return ctx.ryu.notify
		.requestApproval(
			{
				...input,
				timeoutMs,
				...(prompt === undefined ? {} : { prompt }),
				...(responseType === undefined ? {} : { responseType }),
			},
			{
				// The helper needs a positive wait; 0 means one read right after publishing.
				waitMs: Math.max(1, waitMs),
				...(ctx.call.idempotencyKey === undefined
					? {}
					: { idempotencyKey: ctx.call.idempotencyKey }),
			}
		)
		.catch((error: unknown) => {
			throw keyed ? withApprovalKeyHint(error) : error;
		});
}

/** `--acknowledged` / `--unacknowledged` as the list filter, or undefined. */
function acknowledgedFlag(ctx: CommandContext): boolean | undefined {
	const acknowledged = booleanFlag(ctx.flags, "acknowledged");
	const unacknowledged = booleanFlag(ctx.flags, "unacknowledged");
	if (acknowledged && unacknowledged) {
		throw new CliUsageError(
			"Pass either --acknowledged or --unacknowledged, not both."
		);
	}
	if (acknowledged) {
		return true;
	}
	return unacknowledged ? false : undefined;
}

function listEvents(ctx: CommandContext): unknown {
	rejectArgs(ctx);
	const limit = limitFlag(ctx);
	const level = levelFlag(ctx);
	const before = stringFlag(ctx.flags, "before");
	const topic = stringFlag(ctx.flags, "topic");
	const source = stringFlag(ctx.flags, "source");
	const recipient = stringFlag(ctx.flags, "recipient");
	const acknowledged = acknowledgedFlag(ctx);
	const filters = {
		...(limit === undefined ? {} : { limit }),
		...(level === undefined ? {} : { level }),
		...(topic === undefined ? {} : { topic }),
		...(source === undefined ? {} : { source }),
		...(recipient === undefined ? {} : { recipient }),
		...(acknowledged === undefined ? {} : { acknowledged }),
	};
	if (ctx.flags.all === true) {
		if (before !== undefined) {
			throw new CliUsageError(
				"--all pages from the newest event; drop --before."
			);
		}
		return ctx.ryu.notify.events.iterate(filters);
	}
	return listPage(
		ctx,
		ctx.ryu.notify.events.list(
			before === undefined ? filters : { ...filters, before }
		),
		{
			noun: "events",
			items: (page) => page.events,
			next: (page) => {
				const cursor = nextCursorOf(page);
				return cursor === null
					? null
					: `More events: pass --before ${cursor} for the next page, or --all for every event.`;
			},
		}
	);
}

function usage(ctx: CommandContext): unknown {
	rejectArgs(ctx);
	const from = stringFlag(ctx.flags, "from");
	const to = stringFlag(ctx.flags, "to");
	if ((from === undefined) !== (to === undefined)) {
		throw new CliUsageError("Pass both --from and --to, or neither.");
	}
	const window =
		from === undefined || to === undefined
			? defaultUsageWindow(Date.now())
			: { from, to };
	return ctx.ryu.notify.usage(window);
}

const FILTER_FLAGS = {
	level: {
		type: "string",
		valueName: "level",
		description: `One of ${NOTIFY_LEVELS.join(", ")}.`,
	},
	topic: { type: "string", valueName: "topic", description: "The topic." },
	source: { type: "string", valueName: "source", description: "The source." },
	recipient: {
		type: "string",
		valueName: "label",
		description: "Your label for who the event is for, e.g. oncall.",
	},
} as const;

/** The event flags `publish` and `request-approval` share. */
const EVENT_FLAGS: FlagSpecs = {
	title: {
		type: "string",
		valueName: "text",
		description: "The title.",
		required: true,
	},
	body: { type: "string", valueName: "text", description: "The body." },
	url: {
		type: "string",
		valueName: "url",
		description: "A link for the event.",
	},
	tag: {
		type: "strings",
		valueName: "tag",
		description: "A tag; repeat for more.",
	},
	...FILTER_FLAGS,
	recipient: {
		...FILTER_FLAGS.recipient,
		description:
			"Your label for who the event is for, e.g. oncall. Recipient preferences (mute, quiet hours) apply to it.",
	},
};

/** Every `ryu-services notify` command. */
export const notifyCommands: readonly ServiceCommand[] = [
	{
		path: ["publish"],
		summary:
			"Publish an event. The SDK adds an Idempotency-Key; pass --idempotency-key to make a retry safe across runs.",
		effect:
			"Records a real event in the tenant and sends it to its live streams and configured destinations (webhooks, push).",
		example:
			'ryu-services notify publish --title "Deploy finished" --level success --topic deploys',
		flags: EVENT_FLAGS,
		run: publish,
	},
	{
		path: ["request-approval"],
		summary:
			"Publish an approval (or yes/no) request and wait up to --wait-ms (default 45 s) for an answer. A pending result means the request is still open: read it with events get, do not ask again. Rerunning with the same --idempotency-key never publishes a second request but gets 409 idempotency_conflict, so after a lost reply read the first request with events get or events list.",
		effect:
			"Records a real event that asks a person to answer, and sends it to its live streams and configured destinations (webhooks, push).",
		example:
			'ryu-services notify request-approval --title "Deploy build 184?" --prompt "Ship build 184?" --idempotency-key deploy-184',
		flags: {
			...EVENT_FLAGS,
			prompt: {
				type: "string",
				valueName: "text",
				description: "The question shown with the event.",
			},
			"response-type": {
				type: "string",
				valueName: "approval|yes_no",
				description: "approval (approve or deny, the default) or yes_no.",
			},
			"timeout-ms": {
				type: "number",
				valueName: "ms",
				description: `How long the request stays open, 1000-${MAX_APPROVAL_TIMEOUT_MS} (default ${DEFAULT_APPROVAL_TOOL_TIMEOUT_MS}); Notify expires it then.`,
			},
			"wait-ms": {
				type: "number",
				valueName: "ms",
				description: `How long this command waits for an answer, 0-${MAX_APPROVAL_WAIT_MS} (default ${DEFAULT_APPROVAL_WAIT_MS}).`,
			},
		},
		run: requestApproval,
	},
	{
		path: ["events", "list"],
		summary:
			"List events, newest first (one page: one JSON line per event, the next page's cursor on stderr). --all pages through every matching event.",
		readOnly: true,
		flags: {
			limit: {
				type: "number",
				valueName: "n",
				description: "Events per page, 1-100 (server default 100).",
			},
			before: {
				type: "string",
				valueName: "cursor",
				description: "The nextCursor of the previous page.",
			},
			all: {
				type: "boolean",
				description: "Page through every matching event, one JSON line each.",
			},
			...FILTER_FLAGS,
			recipient: {
				...FILTER_FLAGS.recipient,
				description: "Only events for this recipient label, e.g. oncall.",
			},
			acknowledged: {
				type: "boolean",
				description: "Only acknowledged events.",
			},
			unacknowledged: {
				type: "boolean",
				description: "Only events not yet acknowledged.",
			},
		},
		run: listEvents,
	},
	{
		path: ["events", "get"],
		usage: "<id>",
		summary: "Show one event, including its interactive response.",
		readOnly: true,
		run: (ctx) => ctx.ryu.notify.events.get(requireArg(ctx, "id")),
	},
	{
		path: ["events", "ack"],
		usage: "<id>",
		summary: "Mark one event acknowledged. Acknowledging it again is harmless.",
		run: (ctx) => ctx.ryu.notify.events.acknowledge(requireArg(ctx, "id")),
	},
	{
		path: ["usage"],
		summary:
			"Show accepted events for a window of whole UTC hours (default: the last 24 hours).",
		readOnly: true,
		flags: {
			from: {
				type: "string",
				valueName: "iso",
				description: "Window start, on a whole UTC hour.",
			},
			to: {
				type: "string",
				valueName: "iso",
				description:
					"Window end (exclusive), on a whole UTC hour, at most 31 days after --from.",
			},
		},
		run: usage,
	},
];
