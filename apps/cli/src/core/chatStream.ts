// Hand-rolled streaming client for Core's chat endpoint, the TS port of
// apps/cli/src/chat.rs (stream_chat, ~112-244). core-client/chat only exposes the
// endpoint URL + auth headers (the desktop drives it through the AI SDK transport),
// so the TUI owns the SSE read loop. The wire frames are AI SDK v6 UI Message
// Stream SSE: newline-delimited `data: {json}` with a `type` discriminator
//   text-delta            -> delta text chunk
//   tool-input-available  -> a typed tool call
//   tool-output-available -> a typed tool result (frame isError/error -> error)
//   tool-output-error     -> a failed tool call; .errorText is the message
//   tool-output-denied    -> the tool call was refused by the user
//   reasoning-delta      -> a typed thinking block
//   tool-TodoWrite input  -> a typed todo snapshot
//   error                 -> stream error
//   finish / [DONE]       -> end of stream
//   data-ryu-permission   -> an ACP permission request; .data is surfaced to
//                            the existing permission handler
//   data-plugin_note      -> out-of-band note from a Core server-side plugin
//                            turn-hook (goal/proof/double-check); .data.text is
//                            surfaced separately, NOT appended to the transcript
//   data-ryu-stats        -> local-engine inference stats for the turn (token
//                            counts, duration, tok/s, per-turn cost)
//   data-ryu-usage-stats  -> alias of data-ryu-stats
//   data-acp-usage        -> live ACP usage meter, re-sent under one id; each
//                            frame is a full snapshot (context used/total,
//                            session cost), never a delta to add up
//   data-ryu-usage        -> Core's usage meter; snapshot semantics like
//                            data-acp-usage
// Request body mirrors the Rust exactly: messages carry content as an array of
// {type:"text", text} parts, plus optional agent_id / conversation_id / acp_model
// / team_id / workflow_id / plugin_flags.

import {
	cancelChat,
	chatHeaders,
	chatStreamUrl,
} from "@ryuhq/core-client/chat";
import { type ApiTarget, fetchForTarget } from "@ryuhq/core-client/client";
import { z } from "zod";

export type ChatRole = "user" | "assistant";

export interface ChatTurn {
	content: string;
	role: ChatRole;
}

/** Per-turn routing options (mirrors apps/cli's ChatOptions). */
export interface ChatStreamOptions {
	/** ACP config-option selections, such as reasoning effort. */
	acpConfig?: Record<string, string>;
	/** ACP permission/session mode advertised by the selected agent. */
	acpMode?: string;
	/** ACP session model override for this turn (/model <id>). */
	acpModel?: string;
	/** Agent to route to; omit to let Core pick its default. */
	agentId?: string;
	/** Stable per-chat id sent on every turn so Core persists the conversation;
	 * the server-side plugin turn-hooks (goal/proof/double-check) and sessions all
	 * key off it. */
	conversationId?: string;
	enableLongTerm?: boolean;
	/** Per-turn plugin toggles forwarded as `plugin_flags`; Core's turn-hooks read
	 * them (e.g. `{ "io.ryu.double-check": true }` to arm the review hook). */
	pluginFlags?: Record<string, boolean>;
	/** Route the turn to a group instead of a single agent (/group <id>). */
	teamId?: string;
	/** Run a chat-input workflow with the user's message as its initial input. */
	workflowId?: string;
}

const streamPayloadSchema = z.json();
export type ChatStreamPayload = z.infer<typeof streamPayloadSchema> | undefined;
const streamRecordSchema = z.record(z.string(), streamPayloadSchema);
type StreamRecord = z.infer<typeof streamRecordSchema>;
const streamTextSchema = z.string();
const wireFrameSchema = z.object({
	type: z.string(),
	data: streamPayloadSchema.optional(),
	delta: streamPayloadSchema.optional(),
	error: streamPayloadSchema.optional(),
	errorText: streamPayloadSchema.optional(),
	input: streamPayloadSchema.optional(),
	isError: streamPayloadSchema.optional(),
	output: streamPayloadSchema.optional(),
	reasoning: streamPayloadSchema.optional(),
	status: streamPayloadSchema.optional(),
	toolCallId: streamPayloadSchema.optional(),
	toolName: streamPayloadSchema.optional(),
});
type WireFrame = z.infer<typeof wireFrameSchema>;

/** Where a usage snapshot came from: Core's local-engine stats part
 * (per-turn numbers), or a live usage meter (the ACP agent's or Core's own)
 * whose frames are cumulative snapshots. */
export type TurnUsageSource = "ryu-stats" | "acp-usage" | "ryu-usage";

/** Usage part types Core streams, mapped to how their numbers combine. Core
 * persists all four (server/conversations.rs usage metadata). */
const USAGE_FRAME_SOURCES: Readonly<Record<string, TurnUsageSource>> = {
	"data-acp-usage": "acp-usage",
	"data-ryu-stats": "ryu-stats",
	"data-ryu-usage": "ryu-usage",
	"data-ryu-usage-stats": "ryu-stats",
};

/** True for a meter source whose tokens/cost are session-cumulative
 * snapshots (latest wins) rather than per-turn amounts (they add up). */
export const isUsageSnapshot = (source: TurnUsageSource): boolean =>
	source !== "ryu-stats";

/**
 * Usage numbers Core reported for one assistant turn. Every field is optional
 * because providers report different subsets; an absent field stays absent so
 * the UI can omit it instead of printing a zero.
 */
export interface TurnUsage {
	contextTotal?: number;
	contextUsed?: number;
	costAmount?: number;
	costCurrency?: string;
	done?: boolean;
	durationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	sessionTotalTokens?: number;
	source: TurnUsageSource;
	tokensPerSecond?: number;
	totalTokens?: number;
	ttftMs?: number;
}

const finiteNumberSchema = z.number().refine(Number.isFinite);
const usageNumber = finiteNumberSchema.optional().catch(undefined);
const usageString = z.string().min(1).optional().catch(undefined);
const contextWindowSchema = z
	.looseObject({
		contextLength: usageNumber,
		contextWindowSize: usageNumber,
		context_window_size: usageNumber,
		currentTokens: usageNumber,
		size: usageNumber,
		tokens: usageNumber,
		total: usageNumber,
		used: usageNumber,
		windowSize: usageNumber,
	})
	.optional()
	.catch(undefined);
const usageDataSchema = z.looseObject({
	completionTokens: usageNumber,
	context_window: contextWindowSchema,
	contextWindow: contextWindowSchema,
	costAmount: usageNumber,
	costCurrency: usageString,
	done: z.boolean().optional().catch(undefined),
	durationMs: usageNumber,
	inputTokens: usageNumber,
	outputTokens: usageNumber,
	promptTokens: usageNumber,
	sessionCostAmount: usageNumber,
	sessionCostCurrency: usageString,
	sessionTotalTokens: usageNumber,
	tokensPerSecond: usageNumber,
	total: usageNumber,
	totalTokens: usageNumber,
	ttftMs: usageNumber,
	used: usageNumber,
});

/** Drop undefined fields so a snapshot only carries what Core reported. */
const definedFields = (usage: TurnUsage): TurnUsage =>
	Object.fromEntries(
		Object.entries(usage).filter(([, value]) => value !== undefined)
	) as TurnUsage;

/**
 * Map a usage payload (`data-ryu-stats`, `data-acp-usage`, `data-ryu-usage`)
 * onto {@link TurnUsage}. Returns null for a payload that is not an object.
 * Non-finite or mistyped fields are dropped rather than failing the whole
 * frame. Context occupancy comes from a nested `contextWindow` object when
 * present (local engines), else from a meter's top-level `used`/`total`.
 */
export function parseTurnUsage(
	source: TurnUsageSource,
	data: ChatStreamPayload
): TurnUsage | null {
	const parsed = usageDataSchema.safeParse(data);
	if (!parsed.success) {
		return null;
	}
	const fields = parsed.data;
	const isMeter = isUsageSnapshot(source);
	const contextWindow = fields.contextWindow ?? fields.context_window;
	const windowUsed =
		contextWindow?.used ??
		contextWindow?.tokens ??
		contextWindow?.currentTokens ??
		contextWindow?.contextLength;
	const windowSize =
		contextWindow?.context_window_size ??
		contextWindow?.contextWindowSize ??
		contextWindow?.windowSize ??
		contextWindow?.size ??
		contextWindow?.total;
	return definedFields({
		source,
		inputTokens: fields.inputTokens ?? fields.promptTokens,
		outputTokens: fields.outputTokens ?? fields.completionTokens,
		totalTokens: fields.totalTokens,
		sessionTotalTokens: fields.sessionTotalTokens,
		contextUsed: windowUsed ?? (isMeter ? fields.used : undefined),
		contextTotal: windowSize ?? (isMeter ? fields.total : undefined),
		durationMs: fields.durationMs,
		ttftMs: fields.ttftMs,
		tokensPerSecond: fields.tokensPerSecond,
		costAmount: isMeter
			? (fields.sessionCostAmount ?? fields.costAmount)
			: fields.costAmount,
		costCurrency: isMeter
			? (fields.sessionCostCurrency ?? fields.costCurrency)
			: fields.costCurrency,
		done: fields.done,
	});
}

export interface ChatStreamHandlers {
	/** Full replacement list of slash commands advertised by the active ACP agent. */
	onAcpCommands?: (data: ChatStreamPayload) => void;
	/** The stream finished ([DONE] or body end); called at most once. A
	 * `finish` frame only closes one inner turn, so it does not end the stream. */
	onDone: () => void;
	/** A stream-level error. After this the stream is finished. */
	onError: (message: string) => void;
	/** An ACP tool-permission request that must be answered to unblock the turn. */
	onPermission?: (permission: ChatStreamPayload) => void;
	/** An out-of-band note from a Core plugin turn-hook (goal/proof/double-check). */
	onPluginNote?: (text: string) => void;
	/** A reasoning/thinking text delta. */
	onReasoningDelta?: (delta: string) => void;
	/** A text delta from the assistant. */
	onTextDelta: (delta: string) => void;
	/** A TodoWrite plan snapshot. */
	onTodo?: (input: ChatStreamPayload) => void;
	/** A tool call started (the agent's tool loop). */
	onToolInput?: (
		toolName: string,
		input?: ChatStreamPayload,
		toolCallId?: string
	) => void;
	/** A tool result arrived (status string when present). */
	onToolOutput?: (
		status: string,
		output?: ChatStreamPayload,
		toolCallId?: string
	) => void;
	/** A new inner turn starts after an earlier one finished in the same
	 * response (a goal-loop `continue` turn). Core persists it as a separate
	 * assistant message, so surfaces keep it apart from the previous turn. */
	onTurnBoundary?: () => void;
	/** A usage snapshot for the turn. ACP agents re-send it as the turn runs;
	 * each call replaces the previous snapshot. */
	onUsage?: (usage: TurnUsage) => void;
}

const TRAILING_CR = /\r$/;

const asRecord = (value: ChatStreamPayload): StreamRecord | undefined => {
	const parsed = streamRecordSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
};
const asString = (value: ChatStreamPayload): string | undefined => {
	const parsed = streamTextSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
};

const asNonEmptyString = (value: ChatStreamPayload): string | undefined => {
	const string = asString(value);
	return string && string.length > 0 ? string : undefined;
};

const parseWireFrame = (payload: string): WireFrame | null => {
	try {
		const parsed = wireFrameSchema.safeParse(JSON.parse(payload));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const normalizeQuestionInput = (
	toolName: string,
	input: ChatStreamPayload,
	toolCallId: string | undefined
): ChatStreamPayload => {
	if (toolName !== "Question" || !toolCallId) {
		return input;
	}
	const record = asRecord(input);
	if (!record || streamTextSchema.safeParse(record.toolCallId).success) {
		return input;
	}
	// Restore the stable frame ID on partial Question input before it reaches the question parser.
	return { ...record, toolCallId };
};

interface ToolOutputPayload {
	body: ChatStreamPayload;
	status: string;
}

const toolOutputPayload = (frame: WireFrame): ToolOutputPayload => {
	const rawOutput = frame.output;
	// Match Core's harness: an `error`/`errorText` on the frame is a failure
	// even without an explicit `isError` flag.
	if (
		frame.isError === true ||
		frame.error !== undefined ||
		frame.errorText !== undefined
	) {
		return {
			body: frame.error ?? frame.errorText ?? rawOutput,
			status: "error",
		};
	}
	const frameStatus = asNonEmptyString(frame.status);
	if (frameStatus) {
		return { body: rawOutput, status: frameStatus };
	}

	const outputRecord = asRecord(rawOutput);
	const outputStatus = asNonEmptyString(outputRecord?.status);
	if (outputRecord && outputStatus) {
		return {
			body: Object.hasOwn(outputRecord, "output")
				? outputRecord.output
				: rawOutput,
			status: outputStatus,
		};
	}

	return {
		body: rawOutput,
		status: outputRecord?.isError === true ? "error" : "completed",
	};
};

interface ChatStreamRequest {
	acp_config?: ChatStreamOptions["acpConfig"];
	acp_mode?: string;
	acp_model?: string;
	agent_id?: string;
	conversation_id?: string;
	enable_long_term: boolean;
	messages: { role: ChatRole; content: { type: "text"; text: string }[] }[];
	plugin_flags?: ChatStreamOptions["pluginFlags"];
	team_id?: string;
	workflow_id?: string;
}

const buildBody = (
	turns: ChatTurn[],
	options: ChatStreamOptions
): ChatStreamRequest => {
	const body: ChatStreamRequest = {
		enable_long_term: options.enableLongTerm === true,
		messages: turns.map((turn) => ({
			role: turn.role,
			content: [{ type: "text", text: turn.content }],
		})),
	};
	if (options.agentId) {
		body.agent_id = options.agentId;
	}
	if (options.conversationId) {
		body.conversation_id = options.conversationId;
	}
	if (options.acpModel) {
		body.acp_model = options.acpModel;
	}
	if (options.teamId) {
		body.team_id = options.teamId;
	}
	if (options.workflowId) {
		body.workflow_id = options.workflowId;
	}
	if (options.acpMode) {
		body.acp_mode = options.acpMode;
	}
	if (options.acpConfig && Object.keys(options.acpConfig).length > 0) {
		body.acp_config = options.acpConfig;
	}
	if (options.pluginFlags && Object.keys(options.pluginFlags).length > 0) {
		body.plugin_flags = options.pluginFlags;
	}
	return body;
};

// Dispatch one already-parsed frame. Returns true when the stream is finished.
/** Per-response inner-turn tracking: Core can stream several turns
 * (`start` ... `finish`) into one response before its single `[DONE]`. */
interface StreamTurnState {
	finished: boolean;
}

const dispatchFrame = (
	frame: WireFrame,
	handlers: ChatStreamHandlers,
	turn: StreamTurnState
): boolean => {
	switch (frame.type) {
		case "text-delta": {
			const delta = asString(frame.delta);
			if (delta !== undefined) {
				handlers.onTextDelta(delta);
			}
			return false;
		}
		case "tool-input-available": {
			const toolName = asString(frame.toolName) || "tool";
			const toolCallId = asString(frame.toolCallId);
			const input = normalizeQuestionInput(toolName, frame.input, toolCallId);
			handlers.onToolInput?.(toolName, input, toolCallId);
			if (toolName === "TodoWrite" && input !== undefined) {
				handlers.onTodo?.(input);
			}
			return false;
		}
		case "tool-output-available": {
			const { body, status } = toolOutputPayload(frame);
			handlers.onToolOutput?.(status, body, asString(frame.toolCallId));
			return false;
		}
		case "tool-output-error": {
			handlers.onToolOutput?.(
				"error",
				asNonEmptyString(frame.errorText) ?? frame.output,
				asString(frame.toolCallId)
			);
			return false;
		}
		case "tool-output-denied": {
			handlers.onToolOutput?.(
				"denied",
				frame.output,
				asString(frame.toolCallId)
			);
			return false;
		}
		case "reasoning-delta": {
			const delta = asString(frame.delta) ?? asString(frame.reasoning);
			if (delta !== undefined) {
				handlers.onReasoningDelta?.(delta);
			}
			return false;
		}
		case "data-todo": {
			const data = asRecord(frame.data);
			if (data) {
				handlers.onTodo?.(data);
			}
			return false;
		}
		case "data-plugin_note": {
			const data = asRecord(frame.data);
			const text = asNonEmptyString(data?.text) ?? asNonEmptyString(frame.data);
			if (text !== undefined) {
				handlers.onPluginNote?.(text);
			}
			return false;
		}
		case "data-ryu-permission": {
			const data = asRecord(frame.data);
			if (data) {
				handlers.onPermission?.(data);
			}
			return false;
		}
		case "data-ryu-stats":
		case "data-ryu-usage-stats":
		case "data-ryu-usage":
		case "data-acp-usage": {
			const usage = parseTurnUsage(
				USAGE_FRAME_SOURCES[frame.type] ?? "ryu-stats",
				frame.data
			);
			if (usage) {
				handlers.onUsage?.(usage);
			}
			return false;
		}
		case "data-ryu-acp-commands": {
			handlers.onAcpCommands?.(frame.data);
			return false;
		}
		case "data-ryu-question": {
			const data = asRecord(frame.data);
			if (data && Array.isArray(data.questions)) {
				const toolCallId =
					asString(frame.toolCallId) ?? asString(data.toolCallId);
				handlers.onToolInput?.(
					"Question",
					normalizeQuestionInput("Question", data, toolCallId),
					toolCallId
				);
			}
			return false;
		}
		case "error": {
			handlers.onError(
				asNonEmptyString(frame.errorText) ??
					asNonEmptyString(frame.error) ??
					"stream error"
			);
			return true;
		}
		case "finish": {
			// `finish` closes one inner turn but not the response: Core sends
			// post-turn hook notes, action summaries, and goal-loop continuation
			// turns after it, then one terminal `[DONE]` (or the body ends).
			turn.finished = true;
			return false;
		}
		case "start": {
			if (turn.finished) {
				turn.finished = false;
				handlers.onTurnBoundary?.();
			}
			return false;
		}
		default: {
			// text-start, text-end, tool-input-start, etc. - ignored.
			return false;
		}
	}
};

const dispatchDataLine = (
	line: string,
	handlers: ChatStreamHandlers,
	turn: StreamTurnState
): boolean => {
	if (!line.startsWith("data:")) {
		return false;
	}
	const data = line.slice("data:".length).trim();
	if (data.length === 0) {
		return false;
	}
	if (data === "[DONE]") {
		handlers.onDone();
		return true;
	}
	const frame = parseWireFrame(data);
	return frame ? dispatchFrame(frame, handlers, turn) : false;
};

// Parse complete `\n`-terminated lines out of `buffer`, dispatching each data
// frame. Returns { rest, done } where rest is the unconsumed tail.
interface StreamBufferResult {
	done: boolean;
	rest: string;
}

const drainBuffer = (
	buffer: string,
	handlers: ChatStreamHandlers,
	turn: StreamTurnState,
	flush = false
): StreamBufferResult => {
	let start = 0;
	let newline = buffer.indexOf("\n", start);
	while (newline !== -1) {
		const line = buffer.slice(start, newline).replace(TRAILING_CR, "");
		start = newline + 1;
		if (dispatchDataLine(line, handlers, turn)) {
			return { rest: "", done: true };
		}
		newline = buffer.indexOf("\n", start);
	}

	const rest = buffer.slice(start);
	if (!flush || rest.length === 0) {
		return { rest, done: false };
	}
	if (dispatchDataLine(rest.replace(TRAILING_CR, ""), handlers, turn)) {
		return { rest: "", done: true };
	}
	return { rest: "", done: false };
};

/** Longest a streamed delta waits before the transcript redraws. */
export const STREAM_RENDER_WINDOW_MS = 50;

type DeltaKind = "text" | "reasoning";
type StreamHandler = NonNullable<ChatStreamHandlers[keyof ChatStreamHandlers]>;

/**
 * Coalesce text and reasoning deltas into at most one handler call per window,
 * so a fast stream redraws the terminal transcript a bounded number of times
 * instead of once per token. Every other event flushes pending deltas first,
 * which keeps text, reasoning, and tool parts in their original order.
 */
export function coalesceStreamDeltas(
	handlers: ChatStreamHandlers,
	windowMs = STREAM_RENDER_WINDOW_MS
): ChatStreamHandlers {
	let pendingKind: DeltaKind | null = null;
	let pending = "";
	let timer: ReturnType<typeof setTimeout> | null = null;

	const flush = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		const kind = pendingKind;
		const text = pending;
		pendingKind = null;
		pending = "";
		if (text.length === 0) {
			return;
		}
		if (kind === "text") {
			handlers.onTextDelta(text);
		} else if (kind === "reasoning") {
			handlers.onReasoningDelta?.(text);
		}
	};
	const push = (kind: DeltaKind, delta: string) => {
		if (pendingKind && pendingKind !== kind) {
			flush();
		}
		pendingKind = kind;
		pending += delta;
		timer ??= setTimeout(flush, windowMs);
	};
	const afterFlush =
		<Args extends Parameters<StreamHandler>>(
			handler: (...args: Args) => void
		) =>
		(...args: Args) => {
			flush();
			handler(...args);
		};
	const optional = <Args extends Parameters<StreamHandler>>(
		handler: ((...args: Args) => void) | undefined
	) => (handler ? afterFlush(handler) : undefined);

	return {
		onAcpCommands: optional(handlers.onAcpCommands),
		onTextDelta: (delta) => push("text", delta),
		onReasoningDelta: handlers.onReasoningDelta
			? (delta) => push("reasoning", delta)
			: undefined,
		onDone: afterFlush(handlers.onDone),
		onError: afterFlush(handlers.onError),
		onPermission: optional(handlers.onPermission),
		onPluginNote: optional(handlers.onPluginNote),
		onTodo: optional(handlers.onTodo),
		onTurnBoundary: optional(handlers.onTurnBoundary),
		onToolInput: optional(handlers.onToolInput),
		onToolOutput: optional(handlers.onToolOutput),
		onUsage: optional(handlers.onUsage),
	};
}

/** Longest reason kept from a failed response body (characters). */
export const ERROR_REASON_MAX_CHARS = 200;
/** Bytes read from a failed response body before giving up on the rest. */
const ERROR_BODY_MAX_BYTES = 8192;
/** Longest wait for a failed response body before reporting just the status. */
const ERROR_BODY_TIMEOUT_MS = 2000;

const errorBodySchema = z.looseObject({
	error: z
		.union([z.string(), z.looseObject({ message: z.string() })])
		.optional(),
	message: z.string().optional(),
});

const HTML_TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;

const collapseReason = (value: string): string => {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > ERROR_REASON_MAX_CHARS
		? `${collapsed.slice(0, ERROR_REASON_MAX_CHARS - 1).trimEnd()}…`
		: collapsed;
};

/**
 * Read at most ERROR_BODY_MAX_BYTES of a body, cancelling the rest. A body
 * that stalls past ERROR_BODY_TIMEOUT_MS, or a turn the user aborts, stops the
 * read with whatever arrived so far.
 */
async function readBoundedBody(
	response: Response,
	signal?: AbortSignal
): Promise<string> {
	if (!response.body || signal?.aborted) {
		return "";
	}
	const reader = response.body.getReader();
	const stop = () => {
		reader.cancel().catch(() => undefined);
	};
	const timer = setTimeout(stop, ERROR_BODY_TIMEOUT_MS);
	signal?.addEventListener("abort", stop, { once: true });
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (bytes < ERROR_BODY_MAX_BYTES) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			bytes += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
		stop();
	}
	return text;
}

/**
 * Short human reason from a non-2xx body: a JSON `error`/`message` field when
 * present, otherwise the trimmed text. Empty when the body is unreadable.
 */
export async function readErrorReason(
	response: Response,
	signal?: AbortSignal
): Promise<string> {
	const body = await readBoundedBody(response, signal).catch(() => "");
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return "";
	}
	try {
		const parsed = errorBodySchema.safeParse(JSON.parse(trimmed));
		if (parsed.success) {
			const { error, message } = parsed.data;
			const field = typeof error === "string" ? error : error?.message;
			const reason = field ?? message;
			if (reason !== undefined) {
				return collapseReason(reason);
			}
		}
	} catch {
		// Not JSON: fall through to the raw text.
	}
	// An HTML error page (proxy/load balancer) is markup, not a reason: keep
	// only its <title> when it has one.
	if (trimmed.startsWith("<")) {
		const title = HTML_TITLE_PATTERN.exec(trimmed)?.[1] ?? "";
		return collapseReason(title.replace(/<[^>]*>/g, ""));
	}
	return collapseReason(trimmed);
}

/** Longest unterminated stream line kept while waiting for its newline. */
export const MAX_STREAM_LINE_CHARS = 256 * 1024;

/** Stream one assistant turn. Resolves when the stream finishes (the handlers
 * have already received every event). Honors `signal` for cancellation. */
export async function streamChat(
	target: ApiTarget,
	turns: ChatTurn[],
	options: ChatStreamOptions,
	handlers: ChatStreamHandlers,
	signal?: AbortSignal
): Promise<void> {
	let response: Response;
	try {
		// The target's own transport: a loopback target only carries the node
		// bearer once the listener has proved it is Core.
		response = await fetchForTarget(target)(chatStreamUrl(target), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...chatHeaders(target) },
			body: JSON.stringify(buildBody(turns, options)),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) {
			return;
		}
		handlers.onError(err instanceof Error ? err.message : String(err));
		return;
	}

	if (!response.ok) {
		const reason = await readErrorReason(response, signal);
		if (signal?.aborted) {
			return;
		}
		handlers.onError(
			reason ? `HTTP ${response.status} · ${reason}` : `HTTP ${response.status}`
		);
		return;
	}
	if (!response.body) {
		handlers.onDone();
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const turn: StreamTurnState = { finished: false };
	let buffer = "";

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const result = drainBuffer(buffer, handlers, turn);
			buffer = result.rest;
			if (result.done) {
				// Release the body: frames after [DONE]/error are never read.
				reader.cancel().catch(() => undefined);
				return;
			}
			// A line that never ends would otherwise grow without limit.
			if (buffer.length > MAX_STREAM_LINE_CHARS) {
				buffer = "";
				throw new Error(
					`Chat stream line exceeds ${MAX_STREAM_LINE_CHARS} characters`
				);
			}
		}
		buffer += decoder.decode();
		const result = drainBuffer(buffer, handlers, turn, true);
		if (result.done) {
			return;
		}
	} catch (err) {
		if (signal?.aborted) {
			return;
		}
		handlers.onError(err instanceof Error ? err.message : String(err));
		reader.cancel().catch(() => undefined);
		return;
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}

	handlers.onDone();
}

/** How long a Stop waits for Core to confirm the cancel before moving on. */
export const STOP_CANCEL_TIMEOUT_MS = 3000;

/**
 * Stop an in-flight turn. Core drives a persisted turn (one sent with a
 * `conversation_id`) independently of the request that started it, so aborting
 * the local read alone would leave it generating, persisting, and running any
 * goal/auto-continue loop. This aborts the read and asks Core to cancel the
 * conversation's turn. The returned promise settles once Core has answered, or
 * after {@link STOP_CANCEL_TIMEOUT_MS}; await it before sending the next turn on
 * the same conversation, or the cancel could reach that new turn instead. It
 * never rejects.
 */
export async function stopChatTurn(
	target: ApiTarget,
	conversationId: string | undefined,
	controller: AbortController | null | undefined
): Promise<void> {
	controller?.abort();
	if (!conversationId) {
		return;
	}
	try {
		await cancelChat(
			target,
			conversationId,
			AbortSignal.timeout(STOP_CANCEL_TIMEOUT_MS)
		);
	} catch {
		// No live turn, or Core is unreachable: the local abort above still holds.
	}
}
