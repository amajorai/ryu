/**
 * Reader for Core's `GET /api/chat/stream/resume/:conversationId`.
 *
 * Core answers that request with the running turn REPLAYED from its first frame
 * (compacted UI message chunks), followed by live frames until the turn ends. So
 * the reader rebuilds the whole assistant message with the AI SDK's own
 * reducer — text, Thinking traces, tool rows and data parts all keep streaming
 * after a reload or a return to the tab, not just the text. Chunks are parsed
 * with the same schema `DefaultChatTransport` uses for the live turn.
 */

import {
	parseJsonEventStream,
	readUIMessageStream,
	type UIMessage,
	type UIMessageChunk,
	uiMessageChunkSchema,
} from "ai";

/**
 * Response header in which Core states what the replay holds: `full` (the whole
 * turn from its first chunk) or `live` (only the still-open parts of a turn too
 * large to replay, so earlier output is missing).
 */
export const RESUME_REPLAY_HEADER = "x-ryu-resume-replay";

/** What a resume stream's replay covers. */
export type ResumeReplay = "full" | "live";

/** Read {@link RESUME_REPLAY_HEADER}; `undefined` when Core did not send it. */
export function readResumeReplayHeader(
	headers: Pick<Headers, "get">
): ResumeReplay | undefined {
	const value = headers.get(RESUME_REPLAY_HEADER)?.trim().toLowerCase();
	return value === "full" || value === "live" ? value : undefined;
}

/** One snapshot of the resumed assistant message. */
export interface ResumedTurnSnapshot {
	message: UIMessage;
	/**
	 * Whether the stream carries the whole turn, so `message.parts` supersede the
	 * persisted parts. `false` when Core could replay only the open parts of an
	 * oversized turn: the parts then cover just what streams after reattaching.
	 */
	replayed: boolean;
}

/** Options for {@link readResumedTurn}. */
export interface ReadResumedTurnOptions {
	/**
	 * Core's own statement of what the replay holds (the response's
	 * {@link RESUME_REPLAY_HEADER}). Without it — an older Core, or a proxy that
	 * stripped the header — the reader infers it from the chunks.
	 */
	replay?: ResumeReplay;
}

type ParsedChunk =
	| { success: true; value: UIMessageChunk }
	| { success: false };

/**
 * Infer a replay's completeness when Core did not state it: the stream is the
 * whole turn when its `start` chunk arrives before any part content. Leading
 * data chunks do not decide it — a plugin hook note (session start, an expanded
 * prompt) is streamed ahead of the turn's `start`.
 */
function createReplayInference() {
	let decided: boolean | undefined;
	return {
		observe(chunk: UIMessageChunk) {
			if (decided !== undefined) {
				return;
			}
			if (chunk.type === "start") {
				decided = true;
			} else if (!chunk.type.startsWith("data-")) {
				decided = false;
			}
		},
		get replayed() {
			return decided ?? false;
		},
	};
}

/**
 * Drop chunks that refer to a part the reader never saw open. The AI SDK reducer
 * throws on such a chunk (a `text-delta` without its `text-start`, a tool output
 * without its call), which silently ends `readUIMessageStream`; a stream that
 * joined mid-part must instead keep following the parts it can see.
 */
function createOpenPartGuard() {
	const text = new Set<string>();
	const reasoning = new Set<string>();
	const streamingInputs = new Set<string>();
	const tools = new Set<string>();
	const approvals = new Set<string>();
	return (chunk: UIMessageChunk): boolean => {
		switch (chunk.type) {
			case "text-start":
				text.add(chunk.id);
				return true;
			case "text-delta":
				return text.has(chunk.id);
			case "text-end":
				return text.delete(chunk.id);
			case "reasoning-start":
				reasoning.add(chunk.id);
				return true;
			case "reasoning-delta":
				return reasoning.has(chunk.id);
			case "reasoning-end":
				return reasoning.delete(chunk.id);
			case "tool-input-start":
				streamingInputs.add(chunk.toolCallId);
				tools.add(chunk.toolCallId);
				return true;
			case "tool-input-delta":
				return streamingInputs.has(chunk.toolCallId);
			case "tool-input-available":
			case "tool-input-error":
				tools.add(chunk.toolCallId);
				return true;
			case "tool-approval-request":
				if (!tools.has(chunk.toolCallId)) {
					return false;
				}
				approvals.add(chunk.approvalId);
				return true;
			case "tool-approval-response":
				return approvals.has(chunk.approvalId);
			case "tool-output-available":
			case "tool-output-error":
			case "tool-output-denied":
				return tools.has(chunk.toolCallId);
			case "finish-step":
				text.clear();
				reasoning.clear();
				return true;
			case "reset-step":
				text.clear();
				reasoning.clear();
				streamingInputs.clear();
				tools.clear();
				approvals.clear();
				return true;
			default:
				return true;
		}
	};
}

/** Yield the resumed assistant message after every chunk until the turn ends. */
export async function* readResumedTurn(
	body: ReadableStream<Uint8Array>,
	options: ReadResumedTurnOptions = {}
): AsyncGenerator<ResumedTurnSnapshot> {
	const inference = createReplayInference();
	const accepts = createOpenPartGuard();
	const chunks = parseJsonEventStream({
		schema: uiMessageChunkSchema,
		stream: body,
	}).pipeThrough(
		new TransformStream<ParsedChunk, UIMessageChunk>({
			transform(result, controller) {
				// A malformed frame is skipped, exactly as before; the final
				// re-fetch of persisted history repairs anything it carried.
				if (!result.success) {
					return;
				}
				inference.observe(result.value);
				if (accepts(result.value)) {
					controller.enqueue(result.value);
				}
			},
		})
	);
	for await (const message of readUIMessageStream({ stream: chunks })) {
		yield {
			message,
			replayed: options.replay ? options.replay === "full" : inference.replayed,
		};
	}
}
