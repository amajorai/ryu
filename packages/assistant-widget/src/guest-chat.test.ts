import { afterEach, describe, expect, test } from "bun:test";
import { SseFrameTooLargeError } from "@ryuhq/protocol/sse";
import { runGuestChat } from "./guest-chat.ts";

const encoder = new TextEncoder();
const realFetch = globalThis.fetch;

interface StreamProbe {
	cancelled: boolean;
	pulls: number;
}

/** Serve `chunks` (one per pull) as a successful same-origin SSE response. */
function stubStream(chunks: string[]): StreamProbe {
	const probe: StreamProbe = { cancelled: false, pulls: 0 };
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						const next = chunks[probe.pulls];
						probe.pulls += 1;
						if (next === undefined) {
							controller.close();
							return;
						}
						controller.enqueue(encoder.encode(next));
					},
					cancel() {
						probe.cancelled = true;
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } }
			)
		)) as unknown as typeof fetch;
	return probe;
}

function deltaFrame(content: string, lineEnding = "\n"): string {
	const data = JSON.stringify({ choices: [{ delta: { content } }] });
	return `data: ${data}${lineEnding}${lineEnding}`;
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("runGuestChat stream bounds", () => {
	test("cancels a delimiter-free stream once its pending frame passes the bound", async () => {
		// 64 chunks of 8 KiB with no line ending: 512 KiB of one unterminated event.
		const chunks = [
			`data: {"choices":[{"delta":{"content":"`,
			...Array.from({ length: 64 }, () => "x".repeat(8192)),
		];
		const probe = stubStream(chunks);
		const deltas: string[] = [];
		await expect(
			runGuestChat("hi", {
				onDelta: (delta) => deltas.push(delta),
			})
		).rejects.toBeInstanceOf(SseFrameTooLargeError);
		expect(probe.cancelled).toBe(true);
		// Stops reading right after the bound (256 KiB), not at EOF.
		expect(probe.pulls).toBeLessThan(chunks.length);
		expect(deltas).toEqual([]);
	});

	test("decodes CRLF frames whose line endings are split across chunks", async () => {
		const frame = deltaFrame("Hello", "\r\n");
		const split = frame.indexOf("\r\n") + 1;
		stubStream([
			frame.slice(0, split),
			frame.slice(split, split + 2),
			frame.slice(split + 2),
			"data: [DONE]\r\n\r\n",
		]);
		expect(await runGuestChat("hi")).toBe("Hello");
	});

	test("caps the aggregate answer even when every frame is small", async () => {
		const probe = stubStream(
			Array.from({ length: 30 }, () => deltaFrame("y".repeat(1000)))
		);
		const answer = await runGuestChat("hi");
		expect(answer.length).toBe(12_000);
		expect(probe.pulls).toBeGreaterThan(0);
	});
});
