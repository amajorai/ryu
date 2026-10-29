import { z } from "zod";

const transcriptValueSchema = z.json();
const chatToolArgumentsSchema = z.record(z.string(), transcriptValueSchema);
export type ChatToolArguments = z.infer<typeof chatToolArgumentsSchema>;
export type ChatToolResult = z.infer<typeof transcriptValueSchema> | undefined;

export type ToolTranscriptStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	/** The turn was aborted (Esc, reset) before the tool reported a result. */
	| "interrupted"
	/** The user rejected the tool's permission request. */
	| "denied";

/** Statuses after which a tool row stops animating and keeps its duration. */
export const isSettledToolStatus = (status: ToolTranscriptStatus): boolean =>
	status !== "pending" && status !== "running";

export interface ChatTodo {
	content: string;
	status: "pending" | "in_progress" | "completed" | string;
}

export type ChatPart =
	| { type: "text"; text: string }
	| {
			type: "tool";
			toolCallId?: string;
			name: string;
			status: ToolTranscriptStatus;
			args?: ChatToolArguments;
			result?: ChatToolResult;
			/** Epoch ms of the first input event; absent on legacy parts. */
			startedAt?: number;
			/** Epoch ms when the tool settled (success or error). */
			endedAt?: number;
	  }
	| {
			type: "reasoning";
			text: string;
			/** Epoch ms of the first reasoning delta; absent on legacy parts. */
			startedAt?: number;
			/** Epoch ms when the model moved past this reasoning block. */
			endedAt?: number;
	  }
	| { type: "todo"; todos: ChatTodo[] }
	/** A failed turn's reason. Display-only: never sent back as model history. */
	| { type: "error"; message: string };

export const asRecord = (
	value: Parameters<typeof chatToolArgumentsSchema.safeParse>[0]
): ChatToolArguments | undefined => {
	const parsed = chatToolArgumentsSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
};
// Timing stamps are display-only and newer than the persisted part shape, so a
// stored part with a missing or mistyped stamp drops just that stamp instead of
// failing the whole transcript (which would flatten it to plain text).
const partTimestampSchema = z.number().optional().catch(undefined);
const chatTodoSchema = z.object({ content: z.string(), status: z.string() });
export const chatPartSchema = z.discriminatedUnion("type", [
	z.looseObject({ type: z.literal("text"), text: z.string() }),
	z.looseObject({
		type: z.literal("reasoning"),
		text: z.string(),
		startedAt: partTimestampSchema,
		endedAt: partTimestampSchema,
	}),
	z.looseObject({ type: z.literal("todo"), todos: z.array(chatTodoSchema) }),
	z.looseObject({ type: z.literal("error"), message: z.string() }),
	z.looseObject({
		type: z.literal("tool"),
		toolCallId: z.string().optional(),
		name: z.string(),
		status: z.enum([
			"pending",
			"running",
			"success",
			"error",
			"interrupted",
			"denied",
		]),
		args: chatToolArgumentsSchema.optional(),
		result: transcriptValueSchema.optional(),
		startedAt: partTimestampSchema,
		endedAt: partTimestampSchema,
	}),
]) satisfies z.ZodType<ChatPart>;
export const chatPartsSchema = z.array(chatPartSchema);

const todoFrameSchema = z.object({
	todos: z.array(chatTodoSchema.nullable().catch(null)).catch([]),
});
export const readTodos = (
	value: Parameters<typeof todoFrameSchema.safeParse>[0]
): ChatTodo[] => {
	const parsed = todoFrameSchema.safeParse(value);
	return parsed.success
		? parsed.data.todos.flatMap((todo) => (todo ? [todo] : []))
		: [];
};

export const toolStatus = (
	status: string | undefined
): ToolTranscriptStatus => {
	switch (status?.toLowerCase()) {
		case "success":
		case "ok":
		case "completed":
		case "complete":
		case "done":
			return "success";
		case "error":
		case "failed":
		case "failure":
			return "error";
		case "denied":
		case "rejected":
			return "denied";
		// A cancelled call was stopped (turn cancel, ACP `cancelled`), not
		// refused by the user, so it reads as interrupted rather than denied.
		case "interrupted":
		case "aborted":
		case "cancelled":
		case "canceled":
			return "interrupted";
		case "pending":
			return "pending";
		default:
			return "running";
	}
};

/**
 * Mark the trailing reasoning part finished. Text, tool, and todo parts call this
 * when they follow reasoning; chat surfaces call it when a turn settles.
 */
export const closeReasoningPart = (
	parts: ChatPart[],
	now: number = Date.now()
): ChatPart[] => {
	const last = parts.at(-1);
	if (last?.type !== "reasoning" || last.endedAt !== undefined) {
		return parts;
	}
	return [...parts.slice(0, -1), { ...last, endedAt: now }];
};

export const appendTextPart = (
	parts: ChatPart[],
	text: string,
	now: number = Date.now()
): ChatPart[] => {
	if (text.length === 0) {
		return parts;
	}
	const closed = closeReasoningPart(parts, now);
	const last = closed.at(-1);
	if (last?.type === "text") {
		return [...closed.slice(0, -1), { type: "text", text: last.text + text }];
	}
	return [...closed, { type: "text", text }];
};

/** Paragraph break between inner turns streamed into one assistant message. */
const TURN_SEPARATOR = "\n\n";

/**
 * Append the first text of a continuation turn (a goal-loop `continue` turn
 * Core streams into the same response). A paragraph break keeps it from
 * running into the previous turn's text; it is only added where earlier text
 * would otherwise touch it.
 */
export const appendContinuationText = (
	message: { content: string; parts: ChatPart[] },
	text: string,
	now: number = Date.now()
): { content: string; parts: ChatPart[] } => {
	if (text.length === 0) {
		return message;
	}
	const { content, parts } = message;
	let lead = "";
	if (content.length > 0 && !content.endsWith(TURN_SEPARATOR)) {
		lead = content.endsWith("\n") ? "\n" : TURN_SEPARATOR;
	}
	const last = closeReasoningPart(parts, now).at(-1);
	const partLead = last?.type === "text" && last.text.length > 0 ? lead : "";
	return {
		content: content + lead + text,
		parts: appendTextPart(parts, partLead + text, now),
	};
};

export const appendReasoningPart = (
	parts: ChatPart[],
	text: string,
	now: number = Date.now()
): ChatPart[] => {
	if (text.length === 0) {
		return parts;
	}
	const last = parts.at(-1);
	if (last?.type === "reasoning" && last.endedAt === undefined) {
		return [...parts.slice(0, -1), { ...last, text: last.text + text }];
	}
	return [...parts, { type: "reasoning", text, startedAt: now }];
};

export const appendToolInputPart = (
	parts: ChatPart[],
	name: string,
	args?: ChatToolArguments,
	toolCallId?: string,
	now: number = Date.now()
): ChatPart[] => {
	const closed = closeReasoningPart(parts, now);
	const existingIndex = toolCallId
		? closed.findIndex(
				(part) => part.type === "tool" && part.toolCallId === toolCallId
			)
		: -1;
	const existing = closed[existingIndex];
	const previous = existing?.type === "tool" ? existing : undefined;
	const next: Extract<ChatPart, { type: "tool" }> = {
		type: "tool",
		name,
		status: "running",
		// A re-emitted input (streamed args, ACP updates) keeps the original
		// start so the settled duration covers the whole call.
		startedAt: previous?.startedAt ?? now,
	};
	if (previous?.endedAt !== undefined) {
		next.endedAt = previous.endedAt;
	}
	if (toolCallId) {
		next.toolCallId = toolCallId;
	}
	// A bare re-emission (no input) must not wipe the args already shown.
	const nextArgs = args ?? previous?.args;
	if (nextArgs) {
		next.args = nextArgs;
	}
	return existingIndex < 0
		? [...closed, next]
		: [
				...closed.slice(0, existingIndex),
				next,
				...closed.slice(existingIndex + 1),
			];
};

export const appendToolOutputPart = (
	parts: ChatPart[],
	status: string,
	result?: ChatToolResult,
	toolCallId?: string,
	now: number = Date.now()
): ChatPart[] => {
	if (!toolCallId) {
		return parts;
	}
	const index = parts.findLastIndex(
		(part) => part.type === "tool" && part.toolCallId === toolCallId
	);
	if (index < 0) {
		return parts;
	}
	const tool = parts[index];
	if (tool.type !== "tool") {
		return parts;
	}
	// A denied call stays denied when the agent then reports the refusal as a
	// tool error; the row keeps its struck-through rendering.
	const reported = toolStatus(status);
	const nextStatus =
		tool.status === "denied" && reported === "error" ? "denied" : reported;
	const updated: Extract<ChatPart, { type: "tool" }> = {
		...tool,
		status: nextStatus,
	};
	if (isSettledToolStatus(nextStatus) && tool.endedAt === undefined) {
		updated.endedAt = now;
	}
	if (result !== undefined) {
		updated.result = result;
	}
	return [...parts.slice(0, index), updated, ...parts.slice(index + 1)];
};

export type ToolSettleOutcome = "interrupted" | "error" | "success";

/**
 * Settle every tool part still pending or running once its turn has ended, so
 * no row keeps spinning: `interrupted` on abort, `error` on a stream error,
 * `success` when the turn finished without the tool reporting output. An
 * existing result is kept; `reason` fills the result only when there is none.
 */
export const settleRunningToolParts = (
	parts: ChatPart[],
	outcome: ToolSettleOutcome,
	reason?: string,
	now: number = Date.now()
): ChatPart[] => {
	let changed = false;
	const next = parts.map((part): ChatPart => {
		if (part.type !== "tool" || isSettledToolStatus(part.status)) {
			return part;
		}
		changed = true;
		const settled: Extract<ChatPart, { type: "tool" }> = {
			...part,
			status: outcome,
		};
		if (part.endedAt === undefined && part.startedAt !== undefined) {
			settled.endedAt = now;
		}
		if (part.result === undefined && reason !== undefined) {
			settled.result = reason;
		}
		return settled;
	});
	return changed ? next : parts;
};

/**
 * Record a turn failure as its own part (closing any open reasoning) so it
 * renders as an error row instead of leaking into the assistant's text.
 */
export const appendErrorPart = (
	parts: ChatPart[],
	message: string,
	now: number = Date.now()
): ChatPart[] => {
	const trimmed = message.trim();
	if (trimmed.length === 0) {
		return parts;
	}
	return [
		...closeReasoningPart(parts, now),
		{ type: "error", message: trimmed },
	];
};

export const replaceTodoPart = (
	parts: ChatPart[],
	todos: ChatTodo[],
	now: number = Date.now()
): ChatPart[] => {
	if (todos.length === 0) {
		return parts;
	}
	const closed = closeReasoningPart(parts, now);
	const index = closed.findLastIndex((part) => part.type === "todo");
	const next: ChatPart = { type: "todo", todos };
	return index < 0
		? [...closed, next]
		: [...closed.slice(0, index), next, ...closed.slice(index + 1)];
};
