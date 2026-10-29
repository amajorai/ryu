// Bounded reader for Core's long-lived `text/event-stream` feeds (meetings,
// quests, preferences).
//
// Every frame goes through the shared byte-bounded SseFrameDecoder, so a peer
// that keeps a 2xx stream open without ever ending an event is cut off at the
// frame limit instead of growing the main process's memory. On overflow the
// decoder throws before any later frame is handed out; the body is always
// cancelled and released before this settles.

import { SseFrameDecoder } from "@ryuhq/protocol/sse";

const DATA_PREFIX = "data:";

/** The `data:` lines of one SSE frame, each trimmed. */
export function sseDataLines(frame: string): string[] {
	return frame
		.split("\n")
		.filter((line) => line.startsWith(DATA_PREFIX))
		.map((line) => line.slice(DATA_PREFIX.length).trim());
}

/**
 * Hand each complete frame of `body` to `onFrame` until the body ends or
 * `signal` aborts. Throws `SseFrameTooLargeError` (from `@ryuhq/protocol/sse`)
 * when one event passes the frame bound.
 */
export async function readSseFrames(
	body: ReadableStream<Uint8Array>,
	onFrame: (frame: string) => void,
	signal: AbortSignal
): Promise<void> {
	const reader = body.getReader();
	const frames = new SseFrameDecoder();
	try {
		while (!signal.aborted) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			for (const frame of frames.push(value)) {
				if (signal.aborted) {
					return;
				}
				onFrame(frame);
			}
		}
	} finally {
		frames.finish();
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
