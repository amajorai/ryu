import { describe, expect, test } from "bun:test";
import { SseFrameTooLargeError } from "@ryuhq/protocol/sse";
import { readServerSentEvents } from "./box.ts";
import { createRyuClient } from "./client.ts";
import { NotifyAPI } from "./notify.ts";

interface StreamProbe {
	cancelled: boolean;
	pulls: number;
}

/** A body serving `chunks` one per pull that records cancellation. */
function probedBody(chunks: string[]): {
	body: ReadableStream<Uint8Array>;
	probe: StreamProbe;
} {
	const encoder = new TextEncoder();
	const probe: StreamProbe = { cancelled: false, pulls: 0 };
	const body = new ReadableStream<Uint8Array>({
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
	});
	return { body, probe };
}

/** 64 chunks of 8 KiB with no line ending: 512 KiB of one unterminated event. */
const DELIMITER_FREE = [
	"data: ",
	...Array.from({ length: 64 }, () => "x".repeat(8192)),
];

async function drain<T>(stream: AsyncIterable<T>, into: T[]): Promise<void> {
	for await (const item of stream) {
		into.push(item);
	}
}

describe("client SDK SSE readers are bounded", () => {
	test("Box streams refuse a delimiter-free event at the bound", async () => {
		const { body, probe } = probedBody([
			'event: stdout\nid: 1\r\ndata: {"data":"ok"}\r\n\r\n',
			...DELIMITER_FREE,
			'data: {"data":"after"}\n\n',
		]);
		const frames: unknown[] = [];
		await expect(
			drain(readServerSentEvents(body), frames)
		).rejects.toBeInstanceOf(SseFrameTooLargeError);
		expect(frames).toEqual([
			{ data: { data: "ok" }, event: "stdout", id: "1" },
		]);
		expect(probe.cancelled).toBe(true);
		expect(probe.pulls).toBeLessThan(DELIMITER_FREE.length + 2);
	});

	test("Notify streams refuse a delimiter-free event at the bound", async () => {
		const { body, probe } = probedBody(DELIMITER_FREE);
		const client = new NotifyAPI({
			apiKey: "secret",
			baseUrl: "https://notify.example",
			fetch: async () =>
				new Response(body, {
					headers: { "content-type": "text/event-stream" },
				}),
		});
		const items: unknown[] = [];
		await expect(drain(client.stream(), items)).rejects.toBeInstanceOf(
			SseFrameTooLargeError
		);
		expect(items).toEqual([]);
		expect(probe.cancelled).toBe(true);
		expect(probe.pulls).toBeLessThan(DELIMITER_FREE.length);
	});

	test("harness run events refuse a delimiter-free event at the bound", async () => {
		const { body, probe } = probedBody(DELIMITER_FREE);
		const client = createRyuClient({
			baseUrl: "http://localhost:7980",
			fetch: async () =>
				new Response(body, {
					headers: { "content-type": "text/event-stream" },
				}),
			token: "node",
		});
		const events: unknown[] = [];
		await expect(
			drain(client.harness.events("run-1"), events)
		).rejects.toBeInstanceOf(SseFrameTooLargeError);
		expect(events).toEqual([]);
		expect(probe.cancelled).toBe(true);
		expect(probe.pulls).toBeLessThan(DELIMITER_FREE.length);
	});
});
