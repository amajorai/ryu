// packages/services/src/tools/notify.ts
//
// Ryu Notify tools (`notify_*`): publish, request_approval, list_events,
// get_event, ack_event and usage. A published event fans out to the tenant's
// live streams and delivery destinations (webhooks, ntfy), so
// `notify_publish` and `notify_request_approval` are open-world.
// `notify_request_approval` waits at most `waitMs` (default 45 s, at most
// 50 s) for an answer, below the 60 s request timeout common in MCP clients
// (the TypeScript SDK's default): a host that times out without sending a
// cancellation leaves the wait running and might retry, publishing a second
// request. A cancellation the host does send stops the wait (the context's
// abort signal is passed through). The request itself stays open for
// `timeoutMs`; a still-pending answer comes back as `status: "pending"` with
// the event, for `notify_get_event` to read later.
//
// Its `idempotencyKey` cannot replay the first attempt: every publish carries
// `response.expiresAt` (now + timeoutMs) and Notify hashes the body under the
// key, so a re-issued call with the same key is refused with
// `409 idempotency_conflict` rather than publishing a second request. The key
// says so, and that error gets `APPROVAL_KEY_REUSED_HINT` pointing the model
// at notify_get_event / notify_list_events. The Python port does the same.

import * as z from "zod";
import { READ, SEND } from "./annotations.ts";
import { createRyuError, isRyuError, messageWithoutHint } from "./core.ts";
import { HEADER_KEY_128, optionalIdempotencyKey } from "./idempotency.ts";
import { nullableText, openObject, toolOutput } from "./output.ts";
import { settled } from "./run.ts";
import { type AnyRyuTool, defineRyuTool } from "./types.ts";

/** Notify event levels. */
export const NOTIFY_TOOL_LEVELS = [
	"info",
	"success",
	"warning",
	"error",
	"critical",
] as const;

/** The longest time a `notify_request_approval` request stays open: 15 minutes. */
export const MAX_APPROVAL_TIMEOUT_MS = 900_000;
/** How long a `notify_request_approval` request stays open by default: 10 minutes. */
export const DEFAULT_APPROVAL_TOOL_TIMEOUT_MS = 600_000;
/** The longest `notify_request_approval` wait inside one tool call: 50 seconds. */
export const MAX_APPROVAL_WAIT_MS = 50_000;
/** The default `notify_request_approval` wait inside one tool call: 45 seconds. */
export const DEFAULT_APPROVAL_WAIT_MS = 45_000;

const HOUR_MS = 3_600_000;

/**
 * The window `notify_usage` reads when `from`/`to` are omitted: the 24 whole
 * UTC hours before the next hour boundary, so the current hour is included.
 */
export function defaultNotifyUsageWindow(nowMs: number): {
	from: string;
	to: string;
} {
	const to = Math.ceil(nowMs / HOUR_MS) * HOUR_MS;
	const end = to === nowMs ? to + HOUR_MS : to;
	return {
		from: new Date(end - 24 * HOUR_MS).toISOString(),
		to: new Date(end).toISOString(),
	};
}

const ACK = Object.freeze({
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

const KEY_FORMAT = "printable ASCII without spaces, 1-128 characters";

const idempotencyKey = optionalIdempotencyKey({
	subject: "event",
	format: KEY_FORMAT,
	pattern: HEADER_KEY_128,
	duplicate: "publishing a second event",
	fresh: "publishes a new event",
});

/**
 * `notify_request_approval`'s key. Unlike the other open-world writes it does
 * not claim a replay: each attempt sends a new deadline, so a retry under the
 * same key is refused (see the header).
 */
const approvalIdempotencyKey = z
	.string()
	.regex(HEADER_KEY_128, `idempotencyKey is ${KEY_FORMAT}.`)
	.optional()
	.describe(
		`Recommended. A key unique to this approval request (${KEY_FORMAT}). Reusing it never publishes a second request, but it does not replay the first: each call sets a new deadline, so Notify refuses the retry with idempotency_conflict. After a lost reply, poll notify_get_event with the first call's event.id, or find the event with notify_list_events. A new key publishes a new request. Without a key, each tool call gets its own, so a call the host retries publishes a second request.`
	);

/** The hint a keyed `notify_request_approval` retry's 409 `idempotency_conflict` gets. */
export const APPROVAL_KEY_REUSED_HINT =
	"An approval request was already published under this idempotencyKey, and a retry cannot replay it because each call sets a new deadline. Poll notify_get_event with the event.id from the first call (or find the event with notify_list_events) instead of calling notify_request_approval again; use a new key only to ask again.";

/** Adds {@link APPROVAL_KEY_REUSED_HINT} to a keyed approval's `idempotency_conflict`. */
function withApprovalKeyHint(error: unknown): unknown {
	if (
		!isRyuError(error) ||
		error.status !== 409 ||
		error.code !== "idempotency_conflict" ||
		error.hint !== null
	) {
		return error;
	}
	// Built here like sites.ts withSlugHint: `withRyuErrorFields` is not a root export.
	const { name: _name, ...fields } = error.toJSON();
	return createRyuError({
		...fields,
		message: messageWithoutHint(error),
		hint: APPROVAL_KEY_REUSED_HINT,
		cause: error.cause,
	});
}

const eventFields = {
	title: z.string().min(1).describe("The event title."),
	body: z.string().optional().describe("The event body."),
	level: z.enum(NOTIFY_TOOL_LEVELS).optional().describe("Default info."),
	topic: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Stream or topic name that subscribers filter on, e.g. 'deploys'."
		),
	source: z
		.string()
		.min(1)
		.optional()
		.describe("Label for what produced the event, e.g. 'ci' or 'agent-mail'."),
	recipient: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Your own label for who the event is for, e.g. 'oncall'. Recipient preferences (mute, quiet hours) apply to it."
		),
	url: z.string().optional().describe("A link for the event."),
	tags: z
		.array(z.string().min(1))
		.optional()
		.describe("Labels for filtering, at most 16, e.g. ['release', 'web']."),
};

const publishInput = z.object({ ...eventFields, idempotencyKey });

const approvalInput = z.object({
	...eventFields,
	prompt: z
		.string()
		.optional()
		.describe("The question shown with the event, e.g. 'Ship build 184?'."),
	responseType: z
		.enum(["approval", "yes_no"])
		.optional()
		.describe("approval (approve or deny, the default) or yes_no."),
	timeoutMs: z
		.int()
		.min(1000)
		.max(MAX_APPROVAL_TIMEOUT_MS)
		.optional()
		.describe(
			"How long the request stays open, in ms (default 600000, at most 900000). Notify expires it at that moment."
		),
	waitMs: z
		.int()
		.min(0)
		.max(MAX_APPROVAL_WAIT_MS)
		.optional()
		.describe(
			"How long this call waits for an answer, in ms (default 45000, at most 50000). If nobody has answered by then, the result is status pending with the event; read it later with notify_get_event."
		),
	idempotencyKey: approvalIdempotencyKey,
});

const listEventsInput = z.object({
	limit: z
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe("At most this many events (default 100)."),
	before: z
		.string()
		.optional()
		.describe("The nextCursor of the previous page."),
	level: z
		.enum(NOTIFY_TOOL_LEVELS)
		.optional()
		.describe("Only events at this level, e.g. 'error'."),
	topic: z
		.string()
		.optional()
		.describe("Only events published to this topic, e.g. 'deploys'."),
	source: z
		.string()
		.optional()
		.describe("Only events from this source label, e.g. 'ci'."),
	recipient: z
		.string()
		.optional()
		.describe("Only events for this recipient label, e.g. 'oncall'."),
	acknowledged: z
		.boolean()
		.optional()
		.describe("true for acknowledged events only, false for unacknowledged."),
});

const eventIdInput = z.object({
	eventId: z.string().min(1).describe("Event id (evt_…)."),
});

const usageInput = z
	.object({
		from: z
			.string()
			.optional()
			.describe("Window start, an RFC 3339 time on a whole UTC hour."),
		to: z
			.string()
			.optional()
			.describe(
				"Window end (exclusive), on a whole UTC hour, at most 31 days after from. Omit both for the last 24 hours."
			),
	})
	.refine((input) => (input.from === undefined) === (input.to === undefined), {
		message: "Pass both from and to, or neither.",
		path: ["to"],
	});

// Replies, mirroring the Notify contracts (packages/client
// notify-contracts.ts `eventValidation`, `eventListValidation` and
// `usageReportValidation`) and the approval helper's result
// (notify/helpers.ts `NotifyApprovalResult`).

const eventData = z
	.looseObject({
		id: z.string(),
		type: z.string(),
		title: z.string(),
		body: z.string(),
		level: z.enum(NOTIFY_TOOL_LEVELS),
		priority: z.number(),
		source: z.string(),
		topic: nullableText,
		recipient: nullableText,
		project: nullableText,
		url: nullableText,
		tags: z.array(z.string()),
		data: openObject,
		actions: z.array(z.looseObject({ label: z.string(), url: z.string() })),
		response: z
			.looseObject({
				type: z.string(),
				status: z.string(),
				prompt: nullableText,
				value: nullableText,
				expiresAt: nullableText,
				respondedAt: nullableText,
			})
			.nullable()
			.describe("The interactive response (approval, yes/no, text), or null."),
		acknowledgedAt: nullableText,
		archivedAt: nullableText,
		occurredAt: z.string(),
		createdAt: z.string(),
	})
	.describe("A Notify event.");

const approvalData = z.looseObject({
	approved: z.boolean(),
	status: z
		.string()
		.describe(
			"approved, denied, yes, no, expired, canceled, or pending (still open)."
		),
	timedOut: z.boolean(),
	value: nullableText,
	event: eventData,
});

const eventListData = z.looseObject({
	events: z.array(eventData),
	nextCursor: nullableText,
});

const usageData = z.looseObject({
	from: z.string(),
	to: z.string(),
	meters: z.looseObject({ events: z.number() }),
});

/** The Ryu Notify tools. */
export const NOTIFY_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "notify",
		name: "notify_publish",
		title: "Publish a Notify event",
		description:
			"Publishes an event to the Notify inbox; it reaches live streams and the tenant's delivery destinations (webhooks, ntfy). Pass an idempotencyKey so a retry never publishes twice.",
		inputSchema: publishInput,
		annotations: SEND,
		outputSchema: toolOutput(eventData),
		run: (ryu, { idempotencyKey: key, ...input }) =>
			key === undefined
				? ryu.notify.publish(input)
				: ryu.notify.with({ idempotencyKey: key }).publish(input),
	}),
	defineRyuTool({
		service: "notify",
		name: "notify_request_approval",
		title: "Ask a person for approval",
		description:
			"Publishes an approval (or yes/no) request and waits up to waitMs (default 45 s) for someone to answer in Notify. Returns approved, status (approved, denied, yes, no, expired, canceled, or pending) and timedOut. status pending with timedOut false means the request is still open until timeoutMs: poll notify_get_event with event.id instead of calling this tool again, which would publish a second request.",
		inputSchema: approvalInput,
		annotations: SEND,
		outputSchema: toolOutput(approvalData),
		run: async (
			ryu,
			{ idempotencyKey: key, timeoutMs, waitMs, ...input },
			{ signal }
		) => {
			try {
				return await settled(
					ryu.notify.requestApproval(
						{
							...input,
							timeoutMs: timeoutMs ?? DEFAULT_APPROVAL_TOOL_TIMEOUT_MS,
						},
						{
							...(signal === undefined ? {} : { signal }),
							// The helper needs a positive wait; 0 means one read right after publishing.
							waitMs: Math.max(1, waitMs ?? DEFAULT_APPROVAL_WAIT_MS),
							...(key === undefined ? {} : { idempotencyKey: key }),
						}
					)
				);
			} catch (error) {
				throw key === undefined ? error : withApprovalKeyHint(error);
			}
		},
	}),
	defineRyuTool({
		service: "notify",
		name: "notify_list_events",
		title: "List Notify events",
		description:
			"Lists events, newest first, with filters. Page with `before` set to the previous answer's nextCursor.",
		inputSchema: listEventsInput,
		annotations: READ,
		outputSchema: toolOutput(eventListData),
		run: (ryu, query) => ryu.notify.events.list(query),
	}),
	defineRyuTool({
		service: "notify",
		name: "notify_get_event",
		title: "Get a Notify event",
		description:
			"Reads one event, including the state of its interactive response.",
		inputSchema: eventIdInput,
		annotations: READ,
		outputSchema: toolOutput(eventData),
		run: (ryu, { eventId }) => ryu.notify.events.get(eventId),
	}),
	defineRyuTool({
		service: "notify",
		name: "notify_ack_event",
		title: "Acknowledge a Notify event",
		description:
			"Marks one event acknowledged. Acknowledging it again is harmless.",
		inputSchema: eventIdInput,
		annotations: ACK,
		outputSchema: toolOutput(eventData),
		run: (ryu, { eventId }) => ryu.notify.events.acknowledge(eventId),
	}),
	defineRyuTool({
		service: "notify",
		name: "notify_usage",
		title: "Read Notify usage",
		description:
			"Counts accepted events for a window of whole UTC hours (default: the last 24 hours).",
		inputSchema: usageInput,
		annotations: READ,
		outputSchema: toolOutput(usageData),
		run: (ryu, { from, to }) =>
			ryu.notify.usage(
				from === undefined || to === undefined
					? defaultNotifyUsageWindow(Date.now())
					: { from, to }
			),
	}),
];
