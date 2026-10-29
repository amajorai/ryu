/**
 * Text-only reader for Core's `POST /api/chat/stream` response.
 *
 * Core answers with the AI SDK UI-message SSE stream
 * (`x-vercel-ai-ui-message-stream: v1`): `data: {"type":"text-delta",...}`
 * frames separated by blank lines. One-shot callers that only want the answer
 * text (the Companion's ask-about-my-screen, agent name generation) read it
 * here instead of rebuilding the whole message. Frames are parsed with the same
 * schema `DefaultChatTransport` uses, so a frame split across network reads is
 * buffered rather than dropped.
 */

import { parseJsonEventStream, uiMessageChunkSchema } from "ai";

/** What a finished UI-message stream carried. */
export interface UiMessageTextResult {
	/** Error text from an `error` chunk, or `null` when the turn reported none. */
	error: string | null;
	/** Every `text-delta` concatenated in arrival order. */
	text: string;
}

/**
 * Read a UI-message SSE body to its end, calling `onText` with the text so far
 * after every delta. Malformed frames are skipped.
 */
export async function readUiMessageText(
	body: ReadableStream<Uint8Array>,
	onText?: (text: string) => void
): Promise<UiMessageTextResult> {
	const reader = parseJsonEventStream({
		schema: uiMessageChunkSchema,
		stream: body,
	}).getReader();
	let text = "";
	let error: string | null = null;
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		if (!value.success) {
			continue;
		}
		const chunk = value.value;
		if (chunk.type === "text-delta") {
			text += chunk.delta;
			onText?.(text);
		} else if (chunk.type === "error") {
			error = chunk.errorText;
		}
	}
	return { error, text };
}
