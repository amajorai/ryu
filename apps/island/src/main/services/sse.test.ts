import { describe, expect, it } from "bun:test";
import { SseFrameTooLargeError } from "@ryuhq/protocol/sse";
import type {
	TextDeltaPart,
	ToolInputAvailablePart,
} from "../../shared/ipc.ts";
import {
	accumulateStreamText,
	DONE_SENTINEL,
	parseSsePart,
	SseDecoder,
} from "./sse.ts";

// A representative Core UI message stream: start, a text block split across two
// deltas, a tool call + result, finish, then the [DONE] terminator. CRLF line
// endings are mixed in to prove the decoder tolerates them.
const FIXTURE_STREAM = [
	'data: {"type":"start"}',
	'data: {"type":"text-start","id":"t1"}',
	'data: {"type":"text-delta","id":"t1","delta":"Hello"}',
	'data: {"type":"text-delta","id":"t1","delta":", world"}',
	'data: {"type":"text-end","id":"t1"}',
	'data: {"type":"tool-input-available","toolCallId":"c1","toolName":"Bash","input":{"command":"ls"},"dynamic":false}',
	'data: {"type":"tool-output-available","toolCallId":"c1","output":{"stdout":"file"},"dynamic":false}',
	'data: {"type":"finish"}',
	`data: ${DONE_SENTINEL}`,
	"",
].join("\r\n\r\n");

describe("parseSsePart", () => {
	it("decodes a text-delta part", () => {
		const event = parseSsePart(' {"type":"text-delta","id":"t1","delta":"hi"}');
		expect(event).toEqual({
			kind: "part",
			part: {
				type: "text-delta",
				id: "t1",
				delta: "hi",
			},
		});
	});

	it("recognizes the [DONE] sentinel", () => {
		expect(parseSsePart(" [DONE]")).toEqual({ kind: "done" });
	});

	it("returns null for blank payloads", () => {
		expect(parseSsePart("   ")).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseSsePart("{not json")).toBeNull();
	});

	it("returns null for JSON without a string type discriminator", () => {
		expect(parseSsePart('{"id":"x"}')).toBeNull();
	});
});

describe("SseDecoder", () => {
	it("parses a full fixture stream into ordered parts then done", () => {
		const decoder = new SseDecoder();
		const events = [...decoder.push(FIXTURE_STREAM), ...decoder.flush()];

		const doneIndex = events.findIndex((e) => e.kind === "done");
		expect(doneIndex).toBeGreaterThan(0);

		const parts = events
			.slice(0, doneIndex)
			.filter((e) => e.kind === "part")
			.map((e) => (e.kind === "part" ? e.part : null));

		expect(parts.map((p) => p?.type)).toEqual([
			"start",
			"text-start",
			"text-delta",
			"text-delta",
			"text-end",
			"tool-input-available",
			"tool-output-available",
			"finish",
		]);

		const assembled = parts
			.filter((p): p is TextDeltaPart => p?.type === "text-delta")
			.map((p) => p.delta)
			.join("");
		expect(assembled).toBe("Hello, world");

		const toolCall = parts.find(
			(p): p is ToolInputAvailablePart => p?.type === "tool-input-available"
		);
		expect(toolCall?.toolName).toBe("Bash");
	});

	it("buffers parts split across chunk boundaries", () => {
		const decoder = new SseDecoder();
		const first = decoder.push('data: {"type":"text-de');
		expect(first).toEqual([]);
		const second = decoder.push('lta","id":"t1","delta":"x"}\n\n');
		expect(second).toEqual([
			{ kind: "part", part: { type: "text-delta", id: "t1", delta: "x" } },
		]);
	});

	it("ignores non-data lines", () => {
		const decoder = new SseDecoder();
		const events = decoder.push(
			': comment\nevent: ping\ndata: {"type":"finish"}\n\n'
		);
		expect(events).toEqual([{ kind: "part", part: { type: "finish" } }]);
	});
});

/** A body that enqueues `chunks`, stays open, and records cancellation. */
function openBody(chunks: string[]) {
	const state = { cancelled: false };
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return { body, state };
}

const delta = (text: string) =>
	`data: ${JSON.stringify({ type: "text-delta", id: "t1", delta: text })}`;

describe("bounded SSE framing", () => {
	it("dispatches a CRLF blank line split between chunks exactly once", () => {
		const frame = `${delta("a")}\r\n\r\n`;
		for (let split = 1; split < frame.length; split++) {
			const decoder = new SseDecoder();
			const events = [
				...decoder.push(frame.slice(0, split)),
				...decoder.push(frame.slice(split)),
			];
			expect(events).toEqual([
				{ kind: "part", part: { type: "text-delta", id: "t1", delta: "a" } },
			]);
		}
	});

	it("rejects a terminated frame over the bound and yields nothing after it", () => {
		const decoder = new SseDecoder();
		expect(decoder.push(`${delta("before")}\n\n`)).toHaveLength(1);
		const oversized = `${delta("x".repeat(300 * 1024))}\n\n${delta("after")}\n\n`;
		expect(() => decoder.push(oversized)).toThrow(SseFrameTooLargeError);
	});

	it("rejects a delimiter-free stream spread over many small chunks", () => {
		const decoder = new SseDecoder();
		const chunk = "y".repeat(1024);
		expect(() => {
			decoder.push("data: ");
			for (let index = 0; index < 300; index++) {
				decoder.push(chunk);
			}
		}).toThrow(SseFrameTooLargeError);
	});
});

describe("accumulateStreamText", () => {
	it("returns the answer at [DONE] and cancels the still-open body", async () => {
		const { body, state } = openBody([
			`${delta("Hel")}\r\n\r`,
			`\n${delta("lo")}\n\n`,
			`data: ${DONE_SENTINEL}\n\n`,
		]);
		expect(await accumulateStreamText(body)).toBe("Hello");
		expect(state.cancelled).toBe(true);
	});

	it("stops past the aggregate answer limit and cancels the body", async () => {
		const { body, state } = openBody([
			`${delta("12345")}\n\n`,
			`${delta("67890")}\n\n`,
			`${delta("never read")}\n\n`,
		]);
		await expect(accumulateStreamText(body, 8)).rejects.toThrow(
			"completion exceeded 8 characters"
		);
		expect(state.cancelled).toBe(true);
	});

	it("cancels the body when a frame overflows", async () => {
		const { body, state } = openBody([`data: ${"z".repeat(300 * 1024)}`]);
		await expect(accumulateStreamText(body)).rejects.toBeInstanceOf(
			SseFrameTooLargeError
		);
		expect(state.cancelled).toBe(true);
	});
});
