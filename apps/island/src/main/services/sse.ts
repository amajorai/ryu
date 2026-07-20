// Pure SSE parser for Core's AI SDK v6 UI Message Stream.
//
// Core emits `text/event-stream` frames where each event is a `data: {json}`
// line (the JSON is one UI message stream part) terminated by a blank line, and
// the whole stream closes with the sentinel `data: [DONE]`. This module is a
// pure incremental parser with NO Electron or network dependency so it is unit
// testable against a fixture string.

import type { CoreStreamPart } from "../../shared/ipc.ts";

/** The sentinel `data:` payload Core sends to close the stream. */
export const DONE_SENTINEL = "[DONE]";

/** Trailing carriage return left by CRLF line endings. */
const TRAILING_CR = /\r$/;

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
		const value = JSON.parse(trimmed) as unknown;
		if (
			value &&
			typeof value === "object" &&
			typeof (value as { type?: unknown }).type === "string"
		) {
			return { kind: "part", part: value as CoreStreamPart };
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
	private buffer = "";

	/**
	 * Push a chunk and return every event that completed within it. Lines are
	 * split on `\n`; only `data:` lines are interpreted, matching SSE framing.
	 */
	push(chunk: string): SseEvent[] {
		this.buffer += chunk;
		const events: SseEvent[] = [];
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const rawLine = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			const line = rawLine.replace(TRAILING_CR, "");
			if (line.startsWith("data:")) {
				const event = parseSsePart(line.slice("data:".length));
				if (event) {
					events.push(event);
				}
			}
			newlineIndex = this.buffer.indexOf("\n");
		}
		return events;
	}

	/**
	 * Flush any trailing buffered line (a final `data:` line without a trailing
	 * newline). Call once after the body ends.
	 */
	flush(): SseEvent[] {
		const remaining = this.buffer;
		this.buffer = "";
		if (!remaining.startsWith("data:")) {
			return [];
		}
		const event = parseSsePart(remaining.slice("data:".length));
		return event ? [event] : [];
	}
}
