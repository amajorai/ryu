// packages/services/src/tools/managed-agents.ts
//
// Ryu Managed Agents tools (`managed_agents_*`): list_agents,
// list_environments (read-only, so an agent can find the environment id
// create_session takes), create_session, send_message, get_session, list_events,
// list_pending_approvals and answer_approval. create_session and
// send_message run an agent against a model provider, so they are
// open-world; they take an optional `idempotencyKey` (see idempotency.ts) so
// a tool call the host retries does not start a second session or turn.
// `list_events` with `wait: true` follows the live stream until the latest
// turn ends, bounded by `maxEvents` and `timeoutMs`, and closes the stream
// when it stops, or when the host cancels the call (the context's signal).
// Defaults are kept small for a model's context: 50 events per page, 100 when
// waiting.
//
// Interactive tool approvals (anthropic sessions of agents with
// `requireApproval`): `list_pending_approvals` (read-only) lists the open
// `agent.tool_approval_request`s with the call's input, and `answer_approval`
// allows or denies one. Answering is a decision the model takes on the
// user's behalf, so it is a separate, non-read-only tool that read-only mode
// leaves out; nothing is ever answered implicitly. Repeating the same answer
// (same decision and message) is safe: the SDK derives its Idempotency-Key
// from the decision, the toolUseId and the message, so the server replays the
// first one. `list_events` with `wait: true` flags a turn that stopped on an
// approval (`requiresAction`) and names the tool to call next, so an agent
// does not mistake that stop for a finished turn.

import type { ManagedAgentEvent } from "@ryuhq/client";
import * as z from "zod";
import type { Ryu } from "../ryu.ts";
import { READ, SEND } from "./annotations.ts";
import { collectEvents } from "./collect.ts";
import { pendingToolApprovals, TOOL_APPROVAL_EVENT_TYPES } from "./core.ts";
import { MANAGED_AGENTS_KEY, optionalIdempotencyKey } from "./idempotency.ts";
import { nullableText, openObject, stringMap, toolOutput } from "./output.ts";
import {
	type AnyRyuTool,
	defineRyuTool,
	type RyuToolAnnotations,
} from "./types.ts";

/** Runs an agent against a model provider; each call is a new turn. */
const RUN = SEND;

const ANSWER: RyuToolAnnotations = Object.freeze({
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
});

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"canceled",
]);
/** Events per filtered page when listing pending approvals. */
export const APPROVAL_PAGE_LIMIT = 500;
/** At most this many filtered pages are read (10,000 approval-related events). */
export const APPROVAL_MAX_PAGES = 20;
const APPROVAL_MESSAGE_CHARS = 1024;

/** Events per page when not waiting. */
export const DEFAULT_EVENTS_PAGE = 50;
/** Events collected when waiting. */
export const DEFAULT_MAX_EVENTS = 100;
/** How long a waiting tool waits by default. */
export const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 300_000;

function textMessage(text: string) {
	return {
		type: "user.message" as const,
		content: [{ type: "text" as const, text }],
	};
}

const listAgentsInput = z.object({
	limit: z.int().min(1).max(100).optional().describe("Page size (default 20)."),
	cursor: z
		.string()
		.optional()
		.describe("The nextCursor of the previous page."),
	includeArchived: z
		.boolean()
		.optional()
		.describe("Also list archived agents."),
});

const listEnvironmentsInput = z.object({
	limit: z.int().min(1).max(100).optional().describe("Page size (default 20)."),
	cursor: z
		.string()
		.optional()
		.describe("The nextCursor of the previous page."),
	includeArchived: z
		.boolean()
		.optional()
		.describe("Also list archived environments."),
});

const createSessionInput = z.object({
	agentId: z.string().min(1).describe("Agent id (magt_…)."),
	environmentId: z.string().min(1).describe("Environment id (menv_…)."),
	message: z
		.string()
		.min(1)
		.optional()
		.describe("A first user message, queued before the session starts."),
	title: z.string().optional().describe("Session title."),
	idempotencyKey: optionalIdempotencyKey({
		subject: "session",
		format: "16-128 letters, digits, - or _",
		pattern: MANAGED_AGENTS_KEY,
		duplicate: "starting a second session",
		fresh: "starts a new session",
	}),
});

const sendMessageInput = z.object({
	sessionId: z.string().min(1).describe("Session id (msess_…)."),
	text: z.string().min(1).describe("The message text."),
	idempotencyKey: optionalIdempotencyKey({
		subject: "message",
		format: "16-128 letters, digits, - or _",
		pattern: MANAGED_AGENTS_KEY,
		duplicate: "appending it twice",
		fresh: "sends a new message",
	}),
});

const getSessionInput = z.object({
	sessionId: z.string().min(1).describe("Session id (msess_…)."),
});

const listEventsInput = z.object({
	sessionId: z.string().min(1).describe("Session id (msess_…)."),
	after: z
		.int()
		.min(0)
		.optional()
		.describe("Only events with a higher seq (default 0)."),
	limit: z
		.int()
		.min(1)
		.max(500)
		.optional()
		.describe("Page size when not waiting (default 100)."),
	wait: z
		.boolean()
		.optional()
		.describe(
			"Follow the live stream until the current turn ends instead of reading one page."
		),
	maxEvents: z
		.int()
		.min(1)
		.max(1000)
		.optional()
		.describe(
			`With wait: stop after this many events (default ${DEFAULT_MAX_EVENTS}).`
		),
	timeoutMs: z
		.int()
		.min(1)
		.max(MAX_WAIT_MS)
		.optional()
		.describe(
			`With wait: stop waiting after this long (default ${DEFAULT_WAIT_MS}).`
		),
});

const pendingApprovalsInput = z.object({
	sessionId: z.string().min(1).describe("Session id (msess_…)."),
});

const answerApprovalInput = z.object({
	sessionId: z.string().min(1).describe("Session id (msess_…)."),
	toolUseId: z
		.string()
		.min(1)
		.describe(
			"The toolUseId (mtool_…) of the open request, from managed_agents_list_pending_approvals."
		),
	decision: z
		.enum(["allow", "deny"])
		.describe('"allow" runs the tool call; "deny" refuses it.'),
	message: z
		.string()
		.max(APPROVAL_MESSAGE_CHARS)
		.optional()
		.describe("With deny: why, shown to the model."),
});

// Replies, mirroring the Managed Agents contracts (packages/client
// managed-agents-contracts.ts) and the shapes the bodies below build. An
// event is open: its envelope is typed and its body depends on `type`.

const agentData = z
	.looseObject({
		id: z.string(),
		name: z.string(),
		description: nullableText,
		model: nullableText,
		version: z.number(),
		metadata: stringMap,
		archivedAt: nullableText,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Managed Agents agent.");

const environmentData = z
	.looseObject({
		id: z.string(),
		name: z.string(),
		backend: z.string(),
		description: nullableText,
		config: openObject,
		revision: z.number(),
		archivedAt: nullableText,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Managed Agents environment.");

const sessionData = z
	.looseObject({
		id: z.string(),
		agentId: z.string(),
		environmentId: z.string(),
		backend: z.string(),
		status: z.string(),
		stopReason: nullableText,
		pendingToolUseIds: z.array(z.string()),
		title: nullableText,
		headSeq: z.number(),
		usage: openObject,
		lastError: z
			.looseObject({ code: z.string(), message: z.string() })
			.nullable(),
		metadata: stringMap,
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.describe("A Managed Agents session.");

const eventData = z
	.looseObject({
		id: z.string(),
		seq: z.number(),
		sessionId: z.string(),
		type: z.string(),
		createdAt: z.string(),
	})
	.describe(
		"A session event: the envelope (id, seq, sessionId, createdAt) and a body that depends on type."
	);

const listPage = (item: z.ZodType) =>
	z.looseObject({ data: z.array(item), nextCursor: nullableText });

const pendingApprovalsData = z.object({
	sessionStatus: z.string(),
	stopReason: nullableText,
	answerWith: z.literal("managed_agents_answer_approval"),
	complete: z
		.boolean()
		.describe("False when the log was too long to read every request."),
	data: z.array(
		z.object({
			toolUseId: z.string(),
			name: z.string(),
			source: z.enum(["builtin", "mcp"]),
			server: nullableText,
			expiresAt: z.string(),
			requestSeq: z.number(),
			input: openObject.nullable(),
			inputTruncated: z.boolean(),
		})
	),
});

const listEventsData = z
	.looseObject({
		data: z.array(eventData),
		// One page (wait false).
		hasMore: z.boolean().optional(),
		headSeq: z.number().optional(),
		nextAfter: z.number().optional(),
		// The followed stream (wait true).
		turnEnded: z.boolean().optional(),
		timedOut: z.boolean().optional(),
		canceled: z.literal(true).optional(),
		requiresAction: z.literal(true).optional(),
		pendingToolUseIds: z.array(z.string()).optional(),
		next: z.literal("managed_agents_list_pending_approvals").optional(),
	})
	.describe(
		"Without wait: one page (data, hasMore, headSeq, nextAfter). With wait: the events followed (data), turnEnded and timedOut, plus requiresAction, pendingToolUseIds and next when the turn stopped on a tool approval."
	);

type ToolUseEvent = Extract<ManagedAgentEvent, { type: "agent.tool_use" }>;

/** One open approval request, with the call's input from its `agent.tool_use`. */
export interface PendingApproval {
	expiresAt: string;
	input: Record<string, unknown> | null;
	inputTruncated: boolean;
	name: string;
	requestSeq: number;
	server: string | null;
	source: "builtin" | "mcp";
	toolUseId: string;
}

/**
 * The open approval requests of a session. Which requests are open is
 * `pendingToolApprovals` (the SDK's ledger: not answered, not abandoned by an
 * interrupt), read over the log filtered to `TOOL_APPROVAL_EVENT_TYPES`.
 * This tool only adds paging, drops requests past their `expiresAt` that the
 * session no longer lists in `pendingToolUseIds` (the pending set can trail
 * the log by a moment), and joins each request's input from its
 * `agent.tool_use`. Exported for the CLI's `sessions pending-approvals`.
 */
export async function listPendingApprovals(ryu: Ryu, sessionId: string) {
	const session = await ryu.managedAgents.sessions.get(sessionId);
	const pendingIds = new Set(session.pendingToolUseIds);
	const base = {
		sessionStatus: session.status,
		stopReason: session.stopReason,
		answerWith: "managed_agents_answer_approval",
	};
	if (TERMINAL_STATUSES.has(session.status)) {
		// A terminal session accepts no answers (409 session_closed).
		return { ...base, data: [], complete: true };
	}
	const events: ManagedAgentEvent[] = [];
	let after = 0;
	let complete = false;
	for (let page = 0; !complete && page < APPROVAL_MAX_PAGES; page += 1) {
		const result = await ryu.managedAgents.sessions.events(sessionId, {
			after,
			limit: APPROVAL_PAGE_LIMIT,
			types: TOOL_APPROVAL_EVENT_TYPES,
		});
		events.push(...result.data);
		complete = !result.hasMore || result.nextAfter <= after;
		after = result.nextAfter;
	}
	const toolUses = new Map<string, ToolUseEvent>();
	for (const event of events) {
		if (event.type === "agent.tool_use") {
			toolUses.set(event.toolUseId, event);
		}
	}
	const data: PendingApproval[] = [];
	for (const request of pendingToolApprovals(events)) {
		const expired = Date.parse(request.expiresAt) <= Date.now();
		if (expired && !pendingIds.has(request.toolUseId)) {
			continue;
		}
		const toolUse = toolUses.get(request.toolUseId);
		data.push({
			toolUseId: request.toolUseId,
			name: request.name,
			source: request.source,
			server: request.server,
			expiresAt: request.expiresAt,
			requestSeq: request.seq,
			input: toolUse?.input ?? null,
			inputTruncated: toolUse?.inputTruncated ?? false,
		});
	}
	return { ...base, data, complete };
}

/**
 * When the last status in `events` is a `requires_action` idle, what the
 * caller needs to see: the pending ids and the tool that lists them.
 */
function approvalWait(events: readonly ManagedAgentEvent[]) {
	const status = events.findLast((event) => event.type === "session.status");
	if (
		status?.type !== "session.status" ||
		status.stopReason !== "requires_action" ||
		status.pendingToolUseIds.length === 0
	) {
		return {};
	}
	return {
		requiresAction: true,
		pendingToolUseIds: status.pendingToolUseIds,
		next: "managed_agents_list_pending_approvals",
	};
}

/** The Ryu Managed Agents tools. */
export const MANAGED_AGENTS_TOOLS: readonly AnyRyuTool[] = [
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_list_agents",
		title: "List Managed Agents agents",
		description:
			"Lists the organization's Ryu Managed Agents agents (one page, newest first). Managed Agents is a preview.",
		inputSchema: listAgentsInput,
		annotations: READ,
		outputSchema: toolOutput(listPage(agentData)),
		run: (ryu, input) => ryu.managedAgents.agents.list(input),
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_list_environments",
		title: "List Managed Agents environments",
		description:
			"Lists the organization's Ryu Managed Agents environments (one page, newest first), with the id (menv_…) managed_agents_create_session takes. Managed Agents is a preview.",
		inputSchema: listEnvironmentsInput,
		annotations: READ,
		outputSchema: toolOutput(listPage(environmentData)),
		run: (ryu, input) => ryu.managedAgents.environments.list(input),
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_create_session",
		title: "Start a Managed Agents session",
		description:
			"Starts a session of an agent in an environment, optionally with a first message. Pass an idempotencyKey so a retried call never starts a second session. Read the reply with managed_agents_list_events (wait: true). If the agent requires approval for a tool, the turn stops until the user decides: see managed_agents_list_pending_approvals and managed_agents_answer_approval.",
		inputSchema: createSessionInput,
		annotations: RUN,
		outputSchema: toolOutput(sessionData),
		run: (ryu, { message, idempotencyKey, ...input }) =>
			(idempotencyKey === undefined
				? ryu.managedAgents
				: ryu.managedAgents.with({ idempotencyKey })
			).sessions.create({
				...input,
				...(message === undefined
					? {}
					: { initialEvents: [textMessage(message)] }),
			}),
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_send_message",
		title: "Send a message to a Managed Agents session",
		description:
			"Appends a user message to a session and returns the appended events. Pass an idempotencyKey so a retried call never sends the message twice. Read the reply with managed_agents_list_events (wait: true, after: the returned seq). A session waiting on a tool approval rejects new messages (409 tool_result_required): answer it first with managed_agents_answer_approval.",
		inputSchema: sendMessageInput,
		annotations: RUN,
		outputSchema: toolOutput(z.array(eventData)),
		run: (ryu, { sessionId, text, idempotencyKey }) =>
			(idempotencyKey === undefined
				? ryu.managedAgents
				: ryu.managedAgents.with({ idempotencyKey })
			).sessions.send(sessionId, [textMessage(text)]),
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_get_session",
		title: "Get a Managed Agents session",
		description:
			"Returns a session: status, stop reason, pending tool calls and usage.",
		inputSchema: getSessionInput,
		annotations: READ,
		outputSchema: toolOutput(sessionData),
		run: (ryu, { sessionId }) => ryu.managedAgents.sessions.get(sessionId),
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_list_pending_approvals",
		title: "List tool calls waiting for approval",
		description:
			"Lists a session's tool calls that wait for a human decision (agent.tool_approval_request, anthropic backend only), with each call's input and expiresAt, after which Ryu denies it. Show them to the user and answer each with managed_agents_answer_approval only as the user decides.",
		inputSchema: pendingApprovalsInput,
		annotations: READ,
		outputSchema: toolOutput(pendingApprovalsData),
		run: (ryu, { sessionId }) => listPendingApprovals(ryu, sessionId),
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_answer_approval",
		title: "Answer a tool approval request",
		description:
			"Allows or denies one tool call waiting for approval in a Managed Agents session. Only answer as the user decided; never allow on your own judgment. Repeating the same answer (same decision and message) is safe. Errors: 409 tool_result_already_submitted when the request already has an answer (including Ryu's denial at expiresAt), 409 unknown_tool_use when the toolUseId is not pending (a wrong id, or a request an interrupt abandoned). Then read the rest of the turn with managed_agents_list_events (wait: true, after: the returned seq minus 1).",
		inputSchema: answerApprovalInput,
		annotations: ANSWER,
		outputSchema: toolOutput(eventData),
		run: (ryu, { sessionId, toolUseId, decision, message }) => {
			const options = message === undefined ? {} : { message };
			return decision === "allow"
				? ryu.managedAgents.sessions.approveTool(sessionId, toolUseId, options)
				: ryu.managedAgents.sessions.denyTool(sessionId, toolUseId, options);
		},
	}),
	defineRyuTool({
		service: "managedAgents",
		name: "managed_agents_list_events",
		title: "List Managed Agents session events",
		description:
			"Reads a session's event log after a seq. With wait: true, follows the live stream until the turn ends (bounded by maxEvents and timeoutMs) and reports whether it ended. When the turn stopped on a tool approval, the result has requiresAction: true and the pending toolUseIds: the task is not done; call managed_agents_list_pending_approvals and ask the user.",
		inputSchema: listEventsInput,
		annotations: READ,
		outputSchema: toolOutput(listEventsData),
		run: async (
			ryu,
			{ sessionId, after, limit, wait, maxEvents, timeoutMs },
			{ signal }
		) => {
			if (wait !== true) {
				return ryu.managedAgents.sessions.events(sessionId, {
					...(after === undefined ? {} : { after }),
					limit: limit ?? DEFAULT_EVENTS_PAGE,
				});
			}
			// Aborting in `finally` closes the SSE connection: `return()` on the
			// stream would wait behind the pending `next()` and never cancel it.
			// A host cancel (the context's signal) aborts it too.
			const controller = new AbortController();
			const cancel = () => controller.abort();
			if (signal?.aborted) {
				cancel();
			}
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				const collected = await collectEvents(
					ryu.managedAgents.sessions.follow(sessionId, {
						...(after === undefined ? {} : { after }),
						signal: controller.signal,
					}),
					{
						maxEvents: maxEvents ?? DEFAULT_MAX_EVENTS,
						signal: controller.signal,
						timeoutMs: timeoutMs ?? DEFAULT_WAIT_MS,
					}
				);
				return {
					data: collected.events,
					turnEnded: collected.done,
					...(collected.aborted ? { canceled: true } : {}),
					timedOut: collected.timedOut,
					...approvalWait(collected.events),
				};
			} finally {
				signal?.removeEventListener("abort", cancel);
				controller.abort();
			}
		},
	}),
];
