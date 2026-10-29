// packages/services/src/managed-agents/helpers.ts
//
// Composites over the wrapped Managed Agents client:
//
// - `followSession()` streams a session's log and, unlike the client's
//   `sessions.stream()` (which only ends at a terminal status), can also stop
//   when the latest turn ends: at the `idle` status whose `inputSeq` covers
//   the last user event, which is how the events page says to match an idle
//   status to your input. It first reads the log's head (`headSeq`), so an
//   idle that an earlier turn left in the replay never ends the follow: only
//   the turn state at the head, or a later idle, does.
// - `runSession()` is `sessions.run()`: create a session (with an optional
//   first message), follow it until the turn ends (or, with
//   `until: "terminal"`, until the session reaches a terminal status), then
//   re-read the session.
//
// Both run inside one facade call, so they share that call's fetch shim: the
// call's `idempotencyKey` reaches the `POST /sessions`, and its signal stops
// the stream. A `run()` signal also stops the create and the re-read.
//
// Interactive tool approvals (`agent.tool_approval_request`, anthropic only):
// - `answerToolApproval()` is `sessions.approveTool()` / `sessions.denyTool()`
//   (and the wrapped `respondToApproval()`): one `user.tool_approval` with an
//   Idempotency-Key derived from the decision, the toolUseId and the message,
//   so a retried answer replays the first one and any different answer gets
//   `409 tool_result_already_submitted`. A derived key that comes back with
//   `409 unknown_tool_use` is retried once with a fresh key, because the
//   server replays a stored 4xx for 24 hours: an answer sent a moment before
//   the request landed must not lock out every later identical answer.
// - `onToolApproval` on follow and run decides each open request once the
//   follow has caught up with the log's head. Requests at or before `after`
//   are read first (a types-filtered events read), so a follow that resumes
//   after the request still sees it; a request whose answer (yours, another
//   client's, or Ryu's timeout denial) is in the log is never asked about.
//   Without it nothing is answered: the request is yielded, the follow stops
//   at the `requires_action` idle (also with `until: "terminal"`), and
//   `run()` reports it in `pendingApprovals`. The SDK never decides on its
//   own; an unanswered request is denied by Ryu at its `expiresAt`.
// - A request is abandoned the way the server abandons it: by the
//   `interrupted` idle with no pending ids that answers a `user.interrupt`,
//   not by the interrupt itself (a rejected or queued interrupt leaves it
//   open).

import type {
	CreateManagedAgentSessionInput,
	ManagedAgentEvent,
	ManagedAgentSession,
	ManagedAgentsAPI,
} from "@ryuhq/client";
import { RyuConfigurationError, RyuError } from "../errors.ts";
import { newIdempotencyKey } from "../transport/idempotency.ts";

/** An `agent.tool_approval_request` event: a tool call waiting for your decision. */
export type ManagedAgentToolApprovalRequest = Extract<
	ManagedAgentEvent,
	{ type: "agent.tool_approval_request" }
>;

/** An `agent.tool_use` event: a server-executed tool call and its input. */
export type ManagedAgentToolUse = Extract<
	ManagedAgentEvent,
	{ type: "agent.tool_use" }
>;

/** A `user.tool_approval` event: the answer to an approval request. */
export type ManagedAgentToolApproval = Extract<
	ManagedAgentEvent,
	{ type: "user.tool_approval" }
>;

/**
 * What an `onToolApproval` handler decides: `"allow"`, `"deny"`, or the
 * decision with a `message` (shown to the model with a denial). `undefined`
 * leaves the request open (the follow stops at the `requires_action` idle).
 */
export type ManagedAgentToolApprovalDecision =
	| "allow"
	| "deny"
	| { decision: "allow" | "deny"; message?: string | null }
	| undefined;

/** What an `onToolApproval` handler is called with. */
export interface ManagedAgentToolApprovalContext {
	/** The open request. */
	request: ManagedAgentToolApprovalRequest;
	sessionId: string;
	/** The matching `agent.tool_use` with the call's input, or null when it was not seen. */
	toolUse: ManagedAgentToolUse | null;
}

/** Decides one open approval request. Never called for a request whose answer is already in the log. */
export type ManagedAgentToolApprovalHandler = (
	context: ManagedAgentToolApprovalContext
) =>
	| ManagedAgentToolApprovalDecision
	| Promise<ManagedAgentToolApprovalDecision>;

/** Options for `sessions.approveTool()` and `sessions.denyTool()`. */
export interface ManagedAgentToolAnswerOptions {
	/**
	 * Defaults to one derived from the decision, the toolUseId and the
	 * message, so a retry of the same answer replays it. A key you pass is
	 * used as is (and never retried with a fresh one).
	 */
	idempotencyKey?: string;
	/** Shown to the model with a denial; at most 1,024 characters. */
	message?: string | null;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const FNV_OFFSET = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;

/** FNV-1a (32-bit) of the UTF-8 bytes of `text`, as 8 hex digits. Not a security hash. */
function messageDigest(text: string): string {
	let hash = FNV_OFFSET;
	for (const byte of new TextEncoder().encode(text)) {
		hash = Math.imul(hash ^ byte, FNV_PRIME) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * The Idempotency-Key `approveTool` / `denyTool` send by default:
 * `tool-approval-<decision>-<toolUseId>`, plus `-m<fnv1a32(message)>` when a
 * message is sent, or undefined (the SDK then adds a random one) when the
 * toolUseId cannot form a valid key. Including the message means a second
 * answer with another message is a different answer (`409
 * tool_result_already_submitted`), not a key reuse.
 */
export function toolApprovalIdempotencyKey(
	toolUseId: string,
	decision: "allow" | "deny",
	message: string | null = null
): string | undefined {
	const suffix = message === null ? "" : `-m${messageDigest(message)}`;
	const key = `tool-approval-${decision}-${toolUseId}${suffix}`;
	return IDEMPOTENCY_KEY.test(key) ? key : undefined;
}

function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) {
		return null;
	}
	const { code } = error as { code?: unknown };
	return typeof code === "string" ? code : null;
}

async function appendAnswer(
	client: ManagedAgentsAPI,
	sessionId: string,
	event: {
		decision: "allow" | "deny";
		message: string | null;
		toolUseId: string;
	},
	idempotencyKey: string | undefined
): Promise<ManagedAgentEvent[]> {
	return await client.sessions.send(
		sessionId,
		[{ type: "user.tool_approval", ...event }],
		idempotencyKey === undefined ? {} : { idempotencyKey }
	);
}

/** Appends one `user.tool_approval` and resolves to it. */
export async function answerToolApproval(
	client: ManagedAgentsAPI,
	sessionId: string,
	toolUseId: string,
	decision: "allow" | "deny",
	options: ManagedAgentToolAnswerOptions = {}
): Promise<ManagedAgentToolApproval> {
	const message = options.message ?? null;
	const event = { toolUseId, decision, message };
	const derived =
		options.idempotencyKey === undefined
			? toolApprovalIdempotencyKey(toolUseId, decision, message)
			: undefined;
	let appended: ManagedAgentEvent[];
	try {
		appended = await appendAnswer(
			client,
			sessionId,
			event,
			options.idempotencyKey ?? derived
		);
	} catch (error) {
		// The server stores a 4xx under the key for 24 hours and replays it, so a
		// derived-key answer that raced ahead of its request would stay
		// `unknown_tool_use` forever. One retry with a fresh key asks again; the
		// server still records at most one answer per toolUseId.
		if (derived === undefined || errorCode(error) !== "unknown_tool_use") {
			throw error;
		}
		appended = await appendAnswer(
			client,
			sessionId,
			event,
			newIdempotencyKey()
		);
	}
	const answer = appended.find(
		(item): item is ManagedAgentToolApproval =>
			item.type === "user.tool_approval"
	);
	if (answer === undefined) {
		throw new Error(
			"The server accepted the tool approval but returned no user.tool_approval event."
		);
	}
	return answer;
}

/** The event types that decide which approval requests are open. */
export const TOOL_APPROVAL_EVENT_TYPES = [
	"agent.tool_use",
	"agent.tool_approval_request",
	"user.tool_approval",
	"user.interrupt",
	"session.status",
] as const satisfies readonly ManagedAgentEvent["type"][];

/** At most this many filtered pages are read to catch up on approvals before `after`. */
const APPROVAL_SEED_MAX_PAGES = 20;
const APPROVAL_SEED_PAGE_LIMIT = 500;

/**
 * The open approval requests of a log, kept the way the server derives its
 * pending set: a request closes when answered, and every open request is
 * abandoned by the `idle` / `interrupted` status with no pending ids whose
 * `inputSeq` is a `user.interrupt` seen earlier.
 */
class ApprovalLedger {
	readonly open = new Map<string, ManagedAgentToolApprovalRequest>();
	readonly toolUses = new Map<string, ManagedAgentToolUse>();
	/** The pending ids of the latest `requires_action` status, until another status replaces it. */
	waiting: readonly string[] = [];
	private readonly interrupts = new Set<number>();

	/** Whether the session waits on an open approval request that `answered` does not cover. */
	waitsOnApproval(answered: ReadonlySet<string>): boolean {
		return this.waiting.some((id) => this.open.has(id) && !answered.has(id));
	}

	observe(event: ManagedAgentEvent): void {
		if (event.type === "session.status") {
			this.waiting =
				event.stopReason === "requires_action" ? event.pendingToolUseIds : [];
		}
		if (event.type === "agent.tool_use") {
			this.toolUses.set(event.toolUseId, event);
		} else if (event.type === "agent.tool_approval_request") {
			this.open.set(event.toolUseId, event);
		} else if (event.type === "user.tool_approval") {
			this.open.delete(event.toolUseId);
		} else if (event.type === "user.interrupt") {
			this.interrupts.add(event.seq);
		} else if (this.isAbandonStatus(event)) {
			this.open.clear();
		}
	}

	private isAbandonStatus(event: ManagedAgentEvent): boolean {
		if (
			event.type !== "session.status" ||
			event.status !== "idle" ||
			event.stopReason !== "interrupted" ||
			event.pendingToolUseIds.length > 0
		) {
			return false;
		}
		return typeof event.inputSeq === "number"
			? this.interrupts.has(event.inputSeq)
			: this.interrupts.size > 0;
	}
}

/**
 * The approval requests in `events` that are still open at the end: not
 * answered by a `user.tool_approval` and not abandoned by an interrupt (the
 * `interrupted` idle that answers it). In log order.
 */
export function pendingToolApprovals(
	events: readonly ManagedAgentEvent[]
): ManagedAgentToolApprovalRequest[] {
	const ledger = new ApprovalLedger();
	for (const event of events) {
		ledger.observe(event);
	}
	return [...ledger.open.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * Codes that mean the request is already settled: answered (by another
 * client, or by Ryu's timeout denial), abandoned, or answered under the same
 * key with another body.
 */
const SETTLED_ANSWER_CODES: ReadonlySet<string> = new Set([
	"unknown_tool_use",
	"tool_result_already_submitted",
	"idempotency_key_reused",
]);

function normalizeDecision(
	value: ManagedAgentToolApprovalDecision
): { decision: "allow" | "deny"; message: string | null } | null {
	if (value === undefined) {
		return null;
	}
	if (value === "allow" || value === "deny") {
		return { decision: value, message: null };
	}
	if (
		typeof value === "object" &&
		value !== null &&
		(value.decision === "allow" || value.decision === "deny")
	) {
		return { decision: value.decision, message: value.message ?? null };
	}
	throw new RyuConfigurationError({
		service: "managedAgents",
		status: 0,
		code: "invalid_tool_approval_decision",
		message:
			'Ryu Managed Agents: onToolApproval must return "allow", "deny", { decision, message } or undefined (leave the request open).',
	});
}

function handlerFailed(error: unknown): RyuError {
	const reason = error instanceof Error ? error.message : String(error);
	return new RyuError({
		service: "managedAgents",
		status: 0,
		code: "tool_approval_handler_failed",
		message: `Ryu Managed Agents: your onToolApproval handler threw: ${reason}. Nothing was answered; the request stays open until Ryu denies it at its expiresAt.`,
		cause: error,
	});
}

/** When a follow or run stops. */
export type ManagedAgentFollowUntil = "turn" | "terminal";

/** Options for `sessions.follow()`. */
export interface ManagedAgentFollowOptions {
	/** Start after this seq. Default 0 (the whole log). */
	after?: number;
	/**
	 * The log head to replay before a turn end (or an approval request) may
	 * stop the follow. Read with one `GET /events?limit=1` when omitted; pass
	 * the `headSeq` of a session you just created or read to skip that request.
	 */
	headSeq?: number;
	/**
	 * Decides each open `agent.tool_approval_request` (anthropic sessions of
	 * agents with `requireApproval`). Called once per open request after the
	 * follow has caught up with the log's head, including requests at or
	 * before `after` (read first with one types-filtered events read); the
	 * answer is sent with `sessions.approveTool()` / `denyTool()` semantics and
	 * the follow goes on. A throw stops the follow with RyuError
	 * `tool_approval_handler_failed` (its `cause` is your error). Without it,
	 * or when it returns `undefined`, nothing is answered and the follow stops
	 * at the `requires_action` idle, with `until: "terminal"` too.
	 */
	onToolApproval?: ManagedAgentToolApprovalHandler;
	/** Aborting ends the iteration without an error. */
	signal?: AbortSignal;
	/**
	 * `"turn"` (default) stops when the latest turn has ended: at the head of
	 * the log when its last turn is already answered, otherwise at the next
	 * `idle` status that answers the last user event, or at a terminal status.
	 * A session that never got a user event stops at its `provisioned` idle.
	 * `"terminal"` stops at a terminal status, or at a `requires_action` idle
	 * that waits on an approval request nobody answered (Ryu would deny it at
	 * its `expiresAt` while the follow waited).
	 */
	until?: ManagedAgentFollowUntil;
}

/** `sessions.run()` input: the `sessions.create()` body plus an optional first message. */
export interface ManagedAgentSessionRunInput
	extends CreateManagedAgentSessionInput {
	/** Sent as a `user.message` text event after any `initialEvents`. */
	message?: string;
}

/** Options for `sessions.run()`. */
export interface ManagedAgentSessionRunOptions {
	/** For the `POST /sessions`; the SDK adds one when omitted. `.with({ idempotencyKey })` also works. */
	idempotencyKey?: string;
	/** Called with each event as it arrives. */
	onEvent?(event: ManagedAgentEvent): void;
	/**
	 * See {@link ManagedAgentFollowOptions.onToolApproval}. Without it (or when
	 * it returns `undefined`) the run stops at the `requires_action` idle of
	 * the first unanswered request and reports it in `pendingApprovals`, with
	 * either `until`.
	 */
	onToolApproval?: ManagedAgentToolApprovalHandler;
	/** Aborting stops the run with RyuAbortError. */
	signal?: AbortSignal;
	/** See {@link ManagedAgentFollowOptions.until}. Default `"turn"`. */
	until?: ManagedAgentFollowUntil;
}

/** What `sessions.run()` resolves to. */
export interface ManagedAgentSessionRun {
	/** Every event the run received, in log order. */
	events: ManagedAgentEvent[];
	/**
	 * Approval requests still open when the run stopped. Answer each with
	 * `sessions.approveTool()` or `sessions.denyTool()` before its `expiresAt`,
	 * then `sessions.follow(session.id, { after: answer.seq - 1 })` to read
	 * the rest of the turn; Ryu denies an unanswered request.
	 */
	pendingApprovals: ManagedAgentToolApprovalRequest[];
	/** The session as re-read after the run stopped. */
	session: ManagedAgentSession;
	/** The text blocks of every `agent.message` event, joined with blank lines. */
	text: string;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"canceled",
]);

/** Whether `event` is a terminal `session.status`. */
export function isTerminalStatusEvent(event: ManagedAgentEvent): boolean {
	return event.type === "session.status" && TERMINAL_STATUSES.has(event.status);
}

/**
 * Whether `event` is the `idle` status that ends the turn for the user events
 * seen so far (`lastInputSeq`, 0 when none). Without `inputSeq` (an older
 * server) a set `stopReason` marks the end of a turn. A `provisioned` idle
 * only counts while no user event was seen: the server never writes one
 * while input is pending.
 */
export function isTurnEndEvent(
	event: ManagedAgentEvent,
	lastInputSeq: number
): boolean {
	if (event.type !== "session.status" || event.status !== "idle") {
		return false;
	}
	if (lastInputSeq === 0) {
		return true;
	}
	if (event.detail === "provisioned") {
		return false;
	}
	if (typeof event.inputSeq === "number") {
		return event.inputSeq >= lastInputSeq;
	}
	return event.stopReason !== null;
}

/** Reads the approval-related events up to and including `after` into `ledger`. */
async function seedLedger(
	client: ManagedAgentsAPI,
	sessionId: string,
	after: number,
	ledger: ApprovalLedger
): Promise<void> {
	let cursor = 0;
	for (let page = 0; page < APPROVAL_SEED_MAX_PAGES; page += 1) {
		const result = await client.sessions.events(sessionId, {
			after: cursor,
			limit: APPROVAL_SEED_PAGE_LIMIT,
			types: TOOL_APPROVAL_EVENT_TYPES,
		});
		for (const event of result.data) {
			if (event.seq > after) {
				return;
			}
			ledger.observe(event);
		}
		if (
			!result.hasMore ||
			result.nextAfter <= cursor ||
			result.nextAfter >= after
		) {
			return;
		}
		cursor = result.nextAfter;
	}
}

/**
 * Streams `sessionId` until the turn (or the session) ends. See {@link ManagedAgentFollowOptions}.
 *
 * In `"turn"` mode the replay (events up to the head read first) may hold
 * earlier turns, so an idle there only marks the turn as ended until a later
 * user event reopens it; the follow stops at the head if the turn is still
 * ended. After the head, the first idle that ends the turn stops it. In
 * either mode, a `requires_action` idle that still waits on an approval
 * request nobody will answer (no handler, or the handler returned
 * `undefined`) stops the follow once it has caught up with the head.
 */
export async function* followSession(
	client: ManagedAgentsAPI,
	sessionId: string,
	options: ManagedAgentFollowOptions = {}
): AsyncGenerator<ManagedAgentEvent> {
	const until = options.until ?? "turn";
	const after = options.after ?? 0;
	const ledger = new ApprovalLedger();
	const approvals =
		options.onToolApproval === undefined
			? null
			: new ApprovalTracker(client, sessionId, ledger, options.onToolApproval);
	const answeredIds: ReadonlySet<string> = approvals?.answered ?? new Set();
	if (after > 0) {
		await seedLedger(client, sessionId, after, ledger);
		if (options.signal?.aborted) {
			return;
		}
	}
	const headSeq =
		options.headSeq ??
		(await client.sessions.events(sessionId, { after, limit: 1 })).headSeq;
	if (options.signal?.aborted) {
		return;
	}
	let lastInputSeq = 0;
	let turnEnded = false;
	if (after >= headSeq && after > 0) {
		// Already caught up: answer (or stop at) requests the seed read found.
		const answeredSeq = await approvals?.answerOpen(options.signal);
		if (options.signal?.aborted || ledger.waitsOnApproval(answeredIds)) {
			return;
		}
		lastInputSeq = answeredSeq ?? 0;
	}
	const stream = client.sessions.stream(sessionId, {
		after: options.after,
		signal: options.signal,
	});
	for await (const event of stream) {
		yield event;
		if (isTerminalStatusEvent(event)) {
			return;
		}
		ledger.observe(event);
		if (event.type.startsWith("user.")) {
			lastInputSeq = Math.max(lastInputSeq, event.seq);
			turnEnded = false;
		}
		const caughtUp = event.seq >= headSeq;
		if (approvals !== null && caughtUp) {
			const answeredSeq = await approvals.answerOpen(options.signal);
			if (options.signal?.aborted) {
				return;
			}
			if (answeredSeq !== null) {
				lastInputSeq = Math.max(lastInputSeq, answeredSeq);
				turnEnded = false;
			}
		}
		if (caughtUp && ledger.waitsOnApproval(answeredIds)) {
			// Nobody will answer: stop instead of waiting for the timeout denial.
			return;
		}
		if (until !== "turn") {
			continue;
		}
		if (
			!event.type.startsWith("user.") &&
			isTurnEndEvent(event, lastInputSeq) &&
			!approvals?.coversRequiresAction(event)
		) {
			turnEnded = true;
		}
		if (turnEnded && caughtUp) {
			return;
		}
	}
}

/** The `onToolApproval` state of one follow. */
class ApprovalTracker {
	/** Requests this follow answered (or found already settled). */
	readonly answered = new Set<string>();
	/** Requests the handler was called for, so it is asked once per request. */
	private readonly asked = new Set<string>();
	private readonly client: ManagedAgentsAPI;
	private readonly handler: ManagedAgentToolApprovalHandler;
	private readonly ledger: ApprovalLedger;
	private readonly sessionId: string;

	constructor(
		client: ManagedAgentsAPI,
		sessionId: string,
		ledger: ApprovalLedger,
		handler: ManagedAgentToolApprovalHandler
	) {
		this.client = client;
		this.sessionId = sessionId;
		this.ledger = ledger;
		this.handler = handler;
	}

	private async decide(
		request: ManagedAgentToolApprovalRequest
	): Promise<ManagedAgentToolApprovalDecision> {
		try {
			return await this.handler({
				request,
				sessionId: this.sessionId,
				toolUse: this.ledger.toolUses.get(request.toolUseId) ?? null,
			});
		} catch (error) {
			throw handlerFailed(error);
		}
	}

	/**
	 * Asks the handler about every open request it was not asked about yet and
	 * sends each decision. Resolves to the highest seq it appended, or null.
	 * The server's `expiresAt` is not compared with the local clock: a request
	 * Ryu already denied has its denial in the log and is no longer open.
	 */
	async answerOpen(signal: AbortSignal | undefined): Promise<number | null> {
		let highest: number | null = null;
		const open = [...this.ledger.open.values()].sort(
			(left, right) => left.seq - right.seq
		);
		for (const request of open) {
			if (this.asked.has(request.toolUseId)) {
				continue;
			}
			this.asked.add(request.toolUseId);
			const decision = normalizeDecision(await this.decide(request));
			if (decision === null || signal?.aborted) {
				continue;
			}
			try {
				const answer = await answerToolApproval(
					this.client,
					this.sessionId,
					request.toolUseId,
					decision.decision,
					{ message: decision.message }
				);
				highest = Math.max(highest ?? 0, answer.seq);
			} catch (error) {
				if (!SETTLED_ANSWER_CODES.has(errorCode(error) ?? "")) {
					throw error;
				}
			}
			this.answered.add(request.toolUseId);
		}
		return highest;
	}

	/**
	 * Whether `event` is a `requires_action` idle whose pending ids were all
	 * answered by this follow (an older server without `inputSeq` would
	 * otherwise end the turn there).
	 */
	coversRequiresAction(event: ManagedAgentEvent): boolean {
		return (
			event.type === "session.status" &&
			event.stopReason === "requires_action" &&
			event.pendingToolUseIds.length > 0 &&
			event.pendingToolUseIds.every((id) => this.answered.has(id))
		);
	}
}

function agentText(events: readonly ManagedAgentEvent[]): string {
	const parts: string[] = [];
	for (const event of events) {
		if (event.type !== "agent.message") {
			continue;
		}
		for (const block of event.content) {
			if (block.type === "text") {
				parts.push(block.text);
			}
		}
	}
	return parts.join("\n\n");
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if (reason instanceof Error && reason.name === "AbortError") {
		return reason;
	}
	const error = new Error("The run was aborted.");
	error.name = "AbortError";
	return error;
}

/**
 * Settles with `promise`, or rejects with an AbortError as soon as `signal`
 * aborts. The request itself stops with the call's signal; this makes a
 * `run()`-only signal stop waiting for it.
 */
function untilAborted<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined
): Promise<T> {
	if (signal === undefined) {
		return promise;
	}
	if (signal.aborted) {
		promise.catch(() => undefined);
		return Promise.reject(abortError(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			promise.catch(() => undefined);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			}
		);
	});
}

/** Internal hooks the namespace gives `sessions.run()`. */
export interface RunSessionInternals {
	/** Makes every request of the call also stop when `signal` aborts; returns the undo. */
	linkSignal?(signal: AbortSignal): () => void;
}

/** `sessions.run()`: create, follow until the turn (or session) ends, re-read. */
export async function runSession(
	client: ManagedAgentsAPI,
	input: ManagedAgentSessionRunInput,
	options: ManagedAgentSessionRunOptions = {},
	internals: RunSessionInternals = {}
): Promise<ManagedAgentSessionRun> {
	const { signal } = options;
	const unlink =
		signal === undefined ? undefined : internals.linkSignal?.(signal);
	try {
		return await runLinked(client, input, options);
	} finally {
		unlink?.();
	}
}

async function runLinked(
	client: ManagedAgentsAPI,
	input: ManagedAgentSessionRunInput,
	options: ManagedAgentSessionRunOptions
): Promise<ManagedAgentSessionRun> {
	const { signal } = options;
	const { message, ...body } = input;
	const initialEvents =
		message === undefined
			? body.initialEvents
			: [
					...(body.initialEvents ?? []),
					{
						type: "user.message" as const,
						content: [{ type: "text" as const, text: message }],
					},
				];
	const created = await untilAborted(
		client.sessions.create(
			initialEvents === undefined ? body : { ...body, initialEvents },
			options.idempotencyKey === undefined
				? {}
				: { idempotencyKey: options.idempotencyKey }
		),
		signal
	);
	const events: ManagedAgentEvent[] = [];
	for await (const event of followSession(client, created.id, {
		headSeq: created.headSeq,
		onToolApproval: options.onToolApproval,
		signal,
		until: options.until,
	})) {
		events.push(event);
		options.onEvent?.(event);
	}
	if (signal?.aborted) {
		throw abortError(signal);
	}
	const session = await untilAborted(client.sessions.get(created.id), signal);
	return {
		events,
		pendingApprovals: pendingToolApprovals(events),
		session,
		text: agentText(events),
	};
}
