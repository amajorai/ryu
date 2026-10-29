// Pure SSE parser for Core's AI SDK v6 UI Message Stream.
//
// Core emits `text/event-stream` frames where each event is a `data: {json}`
// line (the JSON is one UI message stream part) terminated by a blank line, and
// the whole stream closes with the sentinel `data: [DONE]`. This module is a
// pure incremental parser with NO Electron or network dependency so it is unit
// testable against a fixture string.

import { SseFrameDecoder } from "@ryuhq/protocol/sse";
import { z } from "zod";
import type { CoreStreamPart } from "../../shared/ipc.ts";

const coreStreamPartSchema = z.object({ type: z.string() }).catchall(z.json());

/** The sentinel `data:` payload Core sends to close the stream. */
export const DONE_SENTINEL = "[DONE]";

/** One decoded event from the stream. */
export type SseEvent =
	| { kind: "part"; part: CoreStreamPart }
	| { kind: "done" };

/**
 * Decode a single `data:` payload string into an SseEvent, or `null` when the
 * payload is not a recognizable part (blank line, comment, or malformed JSON).
 *
 * Pure: same input always yields the same output. Tested directly.
 */
export function parseSsePart(dataPayload: string): SseEvent | null {
	const trimmed = dataPayload.trim();
	if (trimmed.length === 0) {
		return null;
	}
	if (trimmed === DONE_SENTINEL) {
		return { kind: "done" };
	}
	try {
		const parsed = coreStreamPartSchema.safeParse(JSON.parse(trimmed));
		if (parsed.success) {
			return { kind: "part", part: parsed.data };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Incremental SSE stream decoder. Feed it raw decoded chunks of the response
 * body; it buffers partial lines across chunk boundaries and yields complete
 * events. Designed for the streaming `fetch` body reader in the main process,
 * but pure enough to drive from a test by feeding the whole fixture at once.
 */
export class SseDecoder {
	private readonly decoder = new SseFrameDecoder();
	private readonly encoder = new TextEncoder();

	/**
	 * Push a chunk and return every event that completed within it.
	 */
	push(chunk: string): SseEvent[] {
		const events: SseEvent[] = [];
		for (const frame of this.decoder.push(this.encoder.encode(chunk))) {
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trimStart())
				.join("\n");
			const event = parseSsePart(data);
			if (event) {
				events.push(event);
			}
		}
		return events;
	}

	/**
	 * Flush any trailing buffered line (a final `data:` line without a trailing
	 * newline). Call once after the body ends.
	 */
	flush(): SseEvent[] {
		this.decoder.finish();
		return [];
	}
}

const textDeltaSchema = z.object({
	type: z.literal("text-delta"),
	delta: z.string(),
});

/** Ceiling on one accumulated completion; frames are bounded separately. */
export const MAX_COMPLETION_TEXT_CHARS = 1_000_000;

/**
 * Drain an AI SDK SSE body, concatenating every `text-delta` into one string.
 * Throws once the answer would pass `maxChars` (or a frame its byte bound),
 * and always cancels and releases the body reader before settling.
 */
export async function accumulateStreamText(
	body: ReadableStream<Uint8Array>,
	maxChars = MAX_COMPLETION_TEXT_CHARS
): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const sse = new SseDecoder();
	let text = "";
	const append = (event: SseEvent): void => {
		if (event.kind !== "part") {
			return;
		}
		const parsed = textDeltaSchema.safeParse(event.part);
		if (!parsed.success) {
			return;
		}
		if (text.length + parsed.data.delta.length > maxChars) {
			throw new Error(`completion exceeded ${maxChars} characters`);
		}
		text += parsed.data.delta;
	};
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			for (const event of sse.push(decoder.decode(value, { stream: true }))) {
				if (event.kind === "done") {
					return text;
				}
				append(event);
			}
		}
		for (const event of sse.flush()) {
			append(event);
		}
		return text;
	} finally {
		sse.flush();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
