import { afterAll, expect, mock, test } from "bun:test";
import { SseFrameTooLargeError } from "@ryuhq/protocol/sse";

mock.module("./config.ts", () => ({
	loadConfig: () => ({ coreBaseUrl: "http://127.0.0.1:8980" }),
	coreHeaders: (extra: Record<string, string> = {}) => extra,
}));

const { readSseFrames } = await import("./sse-reader.ts");
const { subscribeMeetingEvents } = await import("./meetings.ts");
const { subscribeQuestEvents } = await import("./quests.ts");
const { subscribePreferenceChanges } = await import("./preference-stream.ts");
const { chatStream } = await import("./core.ts");
const { startPluginHostStream } = await import("./plugin-host.ts");

const encoder = new TextEncoder();
const originalFetch = globalThis.fetch;
afterAll(() => {
	globalThis.fetch = originalFetch;
});

interface StreamProbe {
	cancelled: boolean;
	pulls: number;
}

/** A body that serves `chunks` one per pull and records cancellation. */
function probedBody(chunks: string[]): {
	body: ReadableStream<Uint8Array>;
	probe: StreamProbe;
} {
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

test("a delimiter-free stream is cancelled at the frame bound, not at EOF", async () => {
	const { body, probe } = probedBody(DELIMITER_FREE);
	const frames: string[] = [];
	await expect(
		readSseFrames(
			body,
			(frame) => frames.push(frame),
			new AbortController().signal
		)
	).rejects.toBeInstanceOf(SseFrameTooLargeError);
	expect(probe.cancelled).toBe(true);
	expect(probe.pulls).toBeLessThan(DELIMITER_FREE.length);
	expect(frames).toEqual([]);
});

test("nothing after an oversized terminated frame reaches the handler", async () => {
	const { body, probe } = probedBody([
		"data: first\r\n\r",
		"\n",
		`data: ${"y".repeat(300 * 1024)}\n\n`,
		"data: after\n\n",
	]);
	const frames: string[] = [];
	await expect(
		readSseFrames(
			body,
			(frame) => frames.push(frame),
			new AbortController().signal
		)
	).rejects.toBeInstanceOf(SseFrameTooLargeError);
	expect(frames).toEqual(["data: first"]);
	expect(probe.cancelled).toBe(true);
});

/** Serve every subscription one valid event, then an endless unterminated one. */
function stubHostileFeed(event: object): StreamProbe[] {
	const probes: StreamProbe[] = [];
	globalThis.fetch = Object.assign(
		() => {
			const { body, probe } = probedBody([
				`data: ${JSON.stringify(event)}\n\n`,
				...DELIMITER_FREE,
				`data: ${JSON.stringify(event)}\n\n`,
			]);
			probes.push(probe);
			return Promise.resolve(new Response(body));
		},
		{ preconnect: originalFetch.preconnect }
	);
	return probes;
}

async function waitFor(condition: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 2000;
	while (!condition() && Date.now() < deadline) {
		await Bun.sleep(5);
	}
	return condition();
}

test("meeting and quest feeds stop at the bound and forward nothing after it", async () => {
	for (const [subscribe, event] of [
		[
			subscribeMeetingEvents,
			{ meeting_id: "m1", status: "recording", type: "status" },
		],
		[subscribeQuestEvents, { id: "q1", type: "deleted" }],
	] as const) {
		const probes = stubHostileFeed(event);
		const received: unknown[] = [];
		const controller = new AbortController();
		subscribe((value: unknown) => received.push(value), controller.signal);
		expect(await waitFor(() => probes[0]?.cancelled === true)).toBe(true);
		controller.abort();
		expect(received).toHaveLength(1);
		expect(probes[0]?.pulls).toBeLessThan(DELIMITER_FREE.length + 2);
	}
});

test("the preference feed stops at the bound and forwards nothing after it", async () => {
	const probes = stubHostileFeed({ key: "theme", value: "dark" });
	const received: string[] = [];
	const stop = subscribePreferenceChanges("theme", (value) =>
		received.push(value)
	);
	try {
		expect(await waitFor(() => probes[0]?.cancelled === true)).toBe(true);
		expect(received).toEqual(["dark"]);
	} finally {
		stop();
	}
});

test("chat and plugin-host pumps forward no part after an oversized frame", async () => {
	const delta = `data: ${JSON.stringify({ type: "text-delta", delta: "hello" })}\n\n`;
	const probes: StreamProbe[] = [];
	globalThis.fetch = Object.assign(
		() => {
			const { body, probe } = probedBody([
				delta,
				...DELIMITER_FREE,
				delta,
				"data: [DONE]\n\n",
			]);
			probes.push(probe);
			return Promise.resolve(new Response(body));
		},
		{ preconnect: originalFetch.preconnect }
	);

	const chat = await new Promise<{ parts: unknown[]; reason: string }>(
		(resolve) => {
			const parts: unknown[] = [];
			chatStream(
				{ messages: [] },
				{
					part: (event) => parts.push(event.part),
					end: (event) => resolve({ parts, reason: event.reason }),
				}
			);
		}
	);
	expect(chat.parts).toEqual([{ type: "text-delta", delta: "hello" }]);
	expect(chat.reason).toBe("error");

	const host = await new Promise<{ chunks: string[]; reason: string }>(
		(resolve) => {
			const chunks: string[] = [];
			startPluginHostStream(
				"fixture",
				{},
				{
					chunk: (value) => chunks.push(value),
					end: (event) => resolve({ chunks, reason: event.reason }),
				}
			);
		}
	);
	expect(host.chunks).toEqual(["hello"]);
	expect(host.reason).toBe("error");

	for (const probe of probes) {
		expect(probe.cancelled).toBe(true);
		expect(probe.pulls).toBeLessThan(DELIMITER_FREE.length + 2);
	}
});
