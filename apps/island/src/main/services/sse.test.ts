import { describe, expect, it } from "bun:test";
import type {
	TextDeltaPart,
	ToolInputAvailablePart,
} from "../../shared/ipc.ts";
import { DONE_SENTINEL, parseSsePart, SseDecoder } from "./sse.ts";

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
].join("\r\n");

describe("parseSsePart", () => {
	it("decodes a text-delta part", () => {
		const event = parseSsePart(' {"type":"text-delta","id":"t1","delta":"hi"}');
		expect(event).toEqual({
			kind: "part",
			part: {
				type: "text-delta",
				id: "t1",
				delta: "hi",
			} as TextDeltaPart,
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
		const second = decoder.push('lta","id":"t1","delta":"x"}\n');
		expect(second).toEqual([
			{ kind: "part", part: { type: "text-delta", id: "t1", delta: "x" } },
		]);
	});

	it("ignores non-data lines", () => {
		const decoder = new SseDecoder();
		const events = decoder.push(
			': comment\nevent: ping\ndata: {"type":"finish"}\n'
		);
		expect(events).toEqual([{ kind: "part", part: { type: "finish" } }]);
	});
});
