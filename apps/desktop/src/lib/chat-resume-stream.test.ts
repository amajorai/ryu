import { describe, expect, it } from "bun:test";
import {
	type ReadResumedTurnOptions,
	type ResumedTurnSnapshot,
	readResumedTurn,
	readResumeReplayHeader,
} from "./chat-resume-stream.ts";

function sse(chunks: unknown[]): ReadableStream<Uint8Array> {
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body).body as ReadableStream<Uint8Array>;
}

async function collect(
	stream: ReadableStream<Uint8Array>,
	options?: ReadResumedTurnOptions
) {
	const snapshots: ResumedTurnSnapshot[] = [];
	for await (const next of readResumedTurn(stream, options)) {
		snapshots.push(next);
	}
	return snapshots;
}

async function last(
	stream: ReadableStream<Uint8Array>,
	options?: ReadResumedTurnOptions
) {
	return (await collect(stream, options)).at(-1);
}

describe("readResumedTurn", () => {
	it("rebuilds tool rows and text from a replayed turn", async () => {
		const snapshot = await last(
			sse([
				{ type: "start" },
				{
					dynamic: false,
					input: { thought: "weighing options" },
					toolCallId: "acp-thought-0",
					toolName: "Thinking",
					type: "tool-input-available",
				},
				{ id: "0-0", type: "text-start" },
				{ delta: "Hello there", id: "0-0", type: "text-delta" },
			])
		);
		expect(snapshot?.replayed).toBe(true);
		const parts = snapshot?.message.parts ?? [];
		expect(parts.some((part) => part.type === "tool-Thinking")).toBe(true);
		expect(parts.find((part) => part.type === "text")).toMatchObject({
			text: "Hello there",
		});
	});

	it("reports a stream that did not start at the turn's first chunk", async () => {
		const snapshot = await last(
			sse([
				{ id: "0-0", type: "text-start" },
				{ delta: "tail only", id: "0-0", type: "text-delta" },
			])
		);
		expect(snapshot?.replayed).toBe(false);
	});

	it("treats a replay whose hook notes precede start as the whole turn", async () => {
		// A pre-turn hook (an expanded prompt, a session-start note) streams its
		// note ahead of the inner turn's `start`; the replay is still complete.
		const snapshot = await last(
			sse([
				{
					data: { text: "Expanded prompt sent" },
					id: "note-1",
					type: "data-plugin_note",
				},
				{ type: "start" },
				{ id: "0-0", type: "text-start" },
				{ delta: "whole reply", id: "0-0", type: "text-delta" },
			])
		);
		expect(snapshot?.replayed).toBe(true);
		expect(snapshot?.message.parts.at(-1)).toMatchObject({
			text: "whole reply",
		});
	});

	it("trusts Core's replay header over the chunks", async () => {
		const chunks = [
			{ type: "start" },
			{ id: "0-0", type: "text-start" },
			{ delta: "open part only", id: "0-0", type: "text-delta" },
		];
		expect((await last(sse(chunks), { replay: "live" }))?.replayed).toBe(false);
		expect(
			(await last(sse(chunks.slice(1)), { replay: "full" }))?.replayed
		).toBe(true);
	});

	it("keeps following a stream that joined in the middle of a part", async () => {
		// Deltas and outputs for parts opened before the reader attached would
		// make the AI SDK reducer throw and silently end the stream.
		const snapshot = await last(
			sse([
				{ delta: "lost", id: "0-0", type: "text-delta" },
				{ id: "0-0", type: "text-end" },
				{ output: "late", toolCallId: "gone", type: "tool-output-available" },
				{ id: "0-1", type: "text-start" },
				{ delta: "still streaming", id: "0-1", type: "text-delta" },
			]),
			{ replay: "live" }
		);
		expect(snapshot?.replayed).toBe(false);
		expect(snapshot?.message.parts).toEqual([
			expect.objectContaining({ text: "still streaming", type: "text" }),
		]);
	});

	it("reads Core's replay header", () => {
		expect(
			readResumeReplayHeader(new Headers({ "x-ryu-resume-replay": "full" }))
		).toBe("full");
		expect(
			readResumeReplayHeader(new Headers({ "x-ryu-resume-replay": "LIVE" }))
		).toBe("live");
		expect(readResumeReplayHeader(new Headers())).toBeUndefined();
		expect(
			readResumeReplayHeader(new Headers({ "x-ryu-resume-replay": "partial" }))
		).toBeUndefined();
	});

	it("skips malformed frames instead of failing the reader", async () => {
		const body = new Response(
			'data: {"type":"start"}\n\ndata: not json\n\ndata: {"type":"text-start","id":"t"}\n\ndata: {"type":"text-delta","id":"t","delta":"ok"}\n\n'
		).body as ReadableStream<Uint8Array>;
		const snapshots = await collect(body);
		expect(snapshots.at(-1)?.message.parts.at(-1)).toMatchObject({
			text: "ok",
		});
	});
});
