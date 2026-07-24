// packages/client/src/agents.test.ts
//
// Tests for AgentsAPI: the snake_case → camelCase mappers (via mocked list/get),
// and the SSE chat stream. The stream parser is distinct from protocol/sse-client:
// it splits on a single "\n" and requires the "data: " prefix (with a space). It
// surfaces AI SDK v6 `text-delta` parts, `error` parts, `[DONE]`, and an
// OpenAI-style `choices[].delta.content` fallback; structural parts yield nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { AgentsAPI } from "./agents.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const OPTIONS: RyuClientOptions = { baseUrl: "http://localhost:7980" };

function jsonOnce(body: unknown): void {
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify(body), { status: 200 })
		)) as typeof fetch;
}

/** A streaming Response whose body enqueues each string as its own chunk. */
function streamOnce(chunks: string[], init?: ResponseInit): void {
	const encoder = new TextEncoder();
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						for (const chunk of chunks) {
							c.enqueue(encoder.encode(chunk));
						}
						c.close();
					},
				}),
				init
			)
		)) as typeof fetch;
}

describe("AgentsAPI.list mapper", () => {
	test("maps wire summary to camelCase, defaulting nullables", async () => {
		jsonOnce({
			agents: [
				{ id: "a", name: "A", transport: "acp", system_prompt: "hi" },
				{ id: "b", name: "B", locked: true, install_hint: "x" },
			],
		});
		const list = await new AgentsAPI(OPTIONS).list();
		expect(list[0]).toEqual({
			id: "a",
			name: "A",
			description: null,
			systemPrompt: "hi",
			engine: null,
			model: null,
			installed: null,
			installHint: null,
			builtIn: true, // transport != null
			createdAt: null,
			version: null,
			locked: false,
		});
		// transport absent → builtIn false; locked passthrough.
		expect(list[1]?.builtIn).toBe(false);
		expect(list[1]?.locked).toBe(true);
		expect(list[1]?.installHint).toBe("x");
	});

	test("returns [] when the agents field is absent", async () => {
		jsonOnce({});
		expect(await new AgentsAPI(OPTIONS).list()).toEqual([]);
	});
});

describe("AgentsAPI.get mapper", () => {
	test("defaults tools to [] and version to 1.0.0", async () => {
		jsonOnce({ agent: { id: "a", name: "A" } });
		const agent = await new AgentsAPI(OPTIONS).get("a");
		expect(agent.tools).toEqual([]);
		expect(agent.version).toBe("1.0.0");
		expect(agent.builtIn).toBe(false);
		expect(agent.locked).toBe(false);
	});

	test("passes through provided tools and version", async () => {
		jsonOnce({
			agent: { id: "a", name: "A", tools: ["t1"], version: "2.3.4" },
		});
		const agent = await new AgentsAPI(OPTIONS).get("a");
		expect(agent.tools).toEqual(["t1"]);
		expect(agent.version).toBe("2.3.4");
	});
});

async function collectStream(api: AgentsAPI) {
	const chunks: { type: string; content?: string }[] = [];
	for await (const c of api.stream("pi", [{ role: "user", content: "hi" }])) {
		chunks.push(c);
	}
	return chunks;
}

describe("AgentsAPI.stream frame parsing", () => {
	test("surfaces text-delta parts and terminates on [DONE]", async () => {
		streamOnce([
			'data: {"type":"text-delta","delta":"He"}\n',
			'data: {"type":"text-delta","delta":"llo"}\n',
			"data: [DONE]\n",
		]);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks).toEqual([
			{ type: "text", content: "He" },
			{ type: "text", content: "llo" },
			{ type: "done" },
		]);
	});

	test("ignores structural parts and blank lines", async () => {
		streamOnce([
			'data: {"type":"start"}\n',
			"\n",
			'data: {"type":"text-start"}\n',
			'data: {"type":"text-delta","delta":"x"}\n',
		]);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		// trailing done appended when stream closes without [DONE]
		expect(chunks).toEqual([{ type: "text", content: "x" }, { type: "done" }]);
	});

	test("surfaces an error part with errorText", async () => {
		streamOnce(['data: {"type":"error","errorText":"nope"}\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks[0]).toEqual({ type: "error", content: "nope" });
	});

	test("falls back to OpenAI-style choices[].delta.content", async () => {
		streamOnce(['data: {"choices":[{"delta":{"content":"hi"}}]}\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks[0]).toEqual({ type: "text", content: "hi" });
	});

	test("stitches a data payload split across two chunks", async () => {
		streamOnce(['data: {"type":"text-delta","del', 'ta":"joined"}\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks[0]).toEqual({ type: "text", content: "joined" });
	});

	test("skips malformed JSON lines", async () => {
		streamOnce(["data: {bad\n", 'data: {"type":"text-delta","delta":"ok"}\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks).toEqual([{ type: "text", content: "ok" }, { type: "done" }]);
	});

	test("throws with status on a non-2xx stream connect", async () => {
		streamOnce([], { status: 500 });
		await expect(collectStream(new AgentsAPI(OPTIONS))).rejects.toThrow(
			"stream failed (500)"
		);
	});
});

describe("AgentsAPI.run", () => {
	test("concatenates only text chunk content", async () => {
		streamOnce([
			'data: {"type":"text-delta","delta":"a"}\n',
			'data: {"type":"error","errorText":"e"}\n',
			'data: {"type":"text-delta","delta":"b"}\n',
			"data: [DONE]\n",
		]);
		const out = await new AgentsAPI(OPTIONS).run("pi", [
			{ role: "user", content: "hi" },
		]);
		expect(out).toBe("ab");
	});
});
