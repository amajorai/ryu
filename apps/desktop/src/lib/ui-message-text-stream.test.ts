import { describe, expect, it } from "bun:test";
import { readUiMessageText } from "./ui-message-text-stream.ts";

/** Frame chunks the way Core's `ui_chunk` writes them. */
function frames(chunks: unknown[]): string {
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A body delivered as the given network reads. */
function bodyOf(parts: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) {
				controller.enqueue(encoder.encode(part));
			}
			controller.close();
		},
	});
}

const TURN = [
	{ type: "start" },
	{ type: "start-step" },
	{ id: "t1", type: "text-start" },
	{ delta: "Hello", id: "t1", type: "text-delta" },
	{ delta: ", world", id: "t1", type: "text-delta" },
	{ id: "t1", type: "text-end" },
	{ type: "finish-step" },
	{ type: "finish" },
];

describe("readUiMessageText", () => {
	it("accumulates text-delta frames from Core's UI-message stream", async () => {
		const seen: string[] = [];
		const result = await readUiMessageText(bodyOf([frames(TURN)]), (text) =>
			seen.push(text)
		);
		expect(result).toEqual({ error: null, text: "Hello, world" });
		expect(seen).toEqual(["Hello", "Hello, world"]);
	});

	it("keeps a frame split across two network reads", async () => {
		const wire = frames(TURN);
		const cut = wire.indexOf(", world") + 3;
		const result = await readUiMessageText(
			bodyOf([wire.slice(0, cut), wire.slice(cut)])
		);
		expect(result.text).toBe("Hello, world");
	});

	it("reports an error chunk instead of ending silently", async () => {
		const result = await readUiMessageText(
			bodyOf([
				frames([{ type: "start" }, { errorText: "boom", type: "error" }]),
			])
		);
		expect(result).toEqual({ error: "boom", text: "" });
	});

	it("ignores the retired v4 `0:` text lines", async () => {
		const result = await readUiMessageText(bodyOf(['0:"Hello"\n']));
		expect(result.text).toBe("");
	});
});
