import type { z } from "zod";
// packages/client/src/agents.test.ts
//
// Tests for AgentsAPI: the snake_case → camelCase mappers (via mocked list/get),
// and the SSE chat stream. Framing is the shared bounded decoder from
// @ryuhq/protocol/sse: an event ends at a blank line (LF, CRLF, or CR). It
// surfaces AI SDK v6 `text-delta` parts, `error` parts, `[DONE]`, and an
// OpenAI-style `choices[].delta.content` fallback; structural parts yield nothing.

import { afterEach, describe, expect, test } from "bun:test";
import { SseFrameTooLargeError } from "@ryuhq/protocol/sse";
import { AgentsAPI, agentIdentityMode } from "./agents.ts";
import { installFetch } from "./test-fetch.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const OPTIONS: RyuClientOptions = { baseUrl: "http://localhost:7980" };

function jsonOnce(body: z.core.util.JSONType): void {
	installFetch(() =>
		Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
	);
}

/** A streaming Response whose body enqueues each string as its own chunk. */
function streamOnce(chunks: string[], init?: ResponseInit): void {
	const encoder = new TextEncoder();
	installFetch(() =>
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
		)
	);
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
			title: "",
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

	test("passes a costumed ghost persona through unchanged", async () => {
		const persona = {
			display_name: null,
			tone: null,
			expressive: {
				expression: "happy",
				variant: "costume",
				costume: { palette: "green", headwear: "witch" },
			},
		};
		jsonOnce({ agent: { id: "a", name: "A", persona } });
		const agent = await new AgentsAPI(OPTIONS).get("a");
		expect(agent.persona).toEqual(persona);
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

describe("AgentsAPI identity mode and account access", () => {
	test("a legacy record reads as managed and unrestricted", async () => {
		jsonOnce({ agent: { id: "a", name: "A" } });
		const agent = await new AgentsAPI(OPTIONS).get("a");
		expect(agent.identityMode).toBe("managed");
		expect(agent.accountAccess).toBeNull();
	});

	test("keeps null (unrestricted) distinct from [] (no accounts)", async () => {
		jsonOnce({
			agent: { id: "a", name: "A", identity_mode: "mixed", account_access: [] },
		});
		const agent = await new AgentsAPI(OPTIONS).get("a");
		expect(agent.identityMode).toBe("mixed");
		expect(agent.accountAccess).toEqual([]);

		jsonOnce({
			agent: {
				id: "a",
				name: "A",
				identity_mode: "individual",
				account_access: null,
			},
		});
		const unrestricted = await new AgentsAPI(OPTIONS).get("a");
		expect(unrestricted.identityMode).toBe("individual");
		expect(unrestricted.accountAccess).toBeNull();
	});

	test("an unknown identity mode fails closed to individual", () => {
		expect(agentIdentityMode("delegated")).toBe("individual");
		expect(agentIdentityMode("managed")).toBe("managed");
		expect(agentIdentityMode("")).toBe("managed");
		expect(agentIdentityMode(null)).toBe("managed");
		expect(agentIdentityMode(undefined)).toBe("managed");
	});
});

function captureWrite(response: z.core.util.JSONType) {
	const captured: { url?: string; method?: string; body?: unknown } = {};
	installFetch((input, init) => {
		captured.url = String(input);
		captured.method = init?.method;
		captured.body = JSON.parse(String(init?.body ?? "{}"));
		return Promise.resolve(
			new Response(JSON.stringify(response), { status: 200 })
		);
	});
	return captured;
}

describe("AgentsAPI.create", () => {
	test("posts snake_case fields and maps the saved record", async () => {
		const captured = captureWrite({
			agent: {
				id: "agent-1",
				name: "Researcher",
				identity_mode: "individual",
				account_access: ["provider:openai"],
			},
		});
		const agent = await new AgentsAPI(OPTIONS).create({
			name: "Researcher",
			systemPrompt: "Research things.",
			identityMode: "individual",
			accountAccess: ["provider:openai"],
		});
		expect(captured.method).toBe("POST");
		expect(captured.url).toBe("http://localhost:7980/api/agents");
		expect(captured.body).toEqual({
			name: "Researcher",
			system_prompt: "Research things.",
			identity_mode: "individual",
			account_access: ["provider:openai"],
		});
		expect(agent.id).toBe("agent-1");
		expect(agent.identityMode).toBe("individual");
		expect(agent.accountAccess).toEqual(["provider:openai"]);
	});

	test("omits identity fields the caller did not set", async () => {
		const captured = captureWrite({ agent: { id: "a", name: "A" } });
		await new AgentsAPI(OPTIONS).create({ name: "A" });
		expect(captured.body).toEqual({ name: "A" });
	});
});

describe("AgentsAPI.update", () => {
	test("sends an explicit null to clear the allowlist", async () => {
		const captured = captureWrite({ agent: { id: "a b", name: "A" } });
		await new AgentsAPI(OPTIONS).update("a b", {
			accountAccess: null,
			expectedUpdatedAt: "2026-10-01T00:00:00Z",
		});
		expect(captured.method).toBe("PUT");
		expect(captured.url).toBe("http://localhost:7980/api/agents/a%20b");
		expect(captured.body).toEqual({
			account_access: null,
			expected_updated_at: "2026-10-01T00:00:00Z",
		});
	});

	test("sends [] to allow no accounts and patches only set fields", async () => {
		const captured = captureWrite({ agent: { id: "a", name: "A" } });
		await new AgentsAPI(OPTIONS).update("a", {
			identityMode: "mixed",
			accountAccess: [],
		});
		expect(captured.body).toEqual({
			identity_mode: "mixed",
			account_access: [],
		});
	});

	test("an omitted allowlist is not sent, leaving it unchanged", async () => {
		const captured = captureWrite({ agent: { id: "a", name: "A" } });
		await new AgentsAPI(OPTIONS).update("a", { name: "Renamed" });
		expect(captured.body).toEqual({ name: "Renamed" });
		expect(captured.body).not.toHaveProperty("account_access");
	});
});

async function collectStream(api: AgentsAPI) {
	const chunks: { type: string; content?: string }[] = [];
	for await (const c of api.stream("pi", [{ role: "user", content: "hi" }])) {
		chunks.push(c);
	}
	return chunks;
}

describe("AgentsAPI.stream request options", () => {
	test("uses an injected fetch implementation for streaming", async () => {
		let called = false;
		const fetchImpl: NonNullable<RyuClientOptions["fetch"]> = async () => {
			called = true;
			return new Response("data: [DONE]\n\n", { status: 200 });
		};
		const stream = new AgentsAPI({
			...OPTIONS,
			fetch: fetchImpl,
		}).stream("pi", [{ role: "user", content: "hi" }]);

		await stream.next();
		expect(called).toBe(true);
	});

	test("sends the developer response mode when requested", async () => {
		let capturedBody: string | undefined;
		installFetch((_input, init) => {
			capturedBody = String(init?.body ?? "");
			return Promise.resolve(new Response("data: [DONE]\n\n"));
		});

		await new AgentsAPI(OPTIONS)
			.stream("ryu", [{ role: "user", content: "Build a plugin" }], {
				responseMode: "developer",
			})
			.next();

		expect(JSON.parse(capturedBody ?? "{}")).toMatchObject({
			agent_id: "ryu",
			response_mode: "developer",
		});
	});

	test("omits response mode when no option is supplied", async () => {
		let capturedBody: string | undefined;
		installFetch((_input, init) => {
			capturedBody = String(init?.body ?? "");
			return Promise.resolve(new Response("data: [DONE]\n\n"));
		});

		await new AgentsAPI(OPTIONS)
			.stream("ryu", [{ role: "user", content: "Build a plugin" }])
			.next();

		expect(JSON.parse(capturedBody ?? "{}")).not.toHaveProperty(
			"response_mode"
		);
	});
});

describe("AgentsAPI.stream frame parsing", () => {
	test("surfaces text-delta parts and terminates on [DONE]", async () => {
		streamOnce([
			'data: {"type":"text-delta","delta":"He"}\n\n',
			'data: {"type":"text-delta","delta":"llo"}\r\n\r\n',
			"data: [DONE]\r\r",
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
			'data: {"type":"start"}\n\n',
			'data: {"type":"text-start"}\n\n',
			'data: {"type":"text-delta","delta":"x"}\n\n',
		]);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		// trailing done appended when stream closes without [DONE]
		expect(chunks).toEqual([{ type: "text", content: "x" }, { type: "done" }]);
	});

	test("surfaces an error part with errorText", async () => {
		streamOnce(['data: {"type":"error","errorText":"nope"}\n\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks[0]).toEqual({ type: "error", content: "nope" });
	});

	test("falls back to OpenAI-style choices[].delta.content", async () => {
		streamOnce(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks[0]).toEqual({ type: "text", content: "hi" });
	});

	test("stitches a data payload split across two chunks", async () => {
		streamOnce(['data: {"type":"text-delta","del', 'ta":"joined"}\n\n']);
		const chunks = await collectStream(new AgentsAPI(OPTIONS));
		expect(chunks[0]).toEqual({ type: "text", content: "joined" });
	});

	test("skips malformed JSON lines", async () => {
		streamOnce([
			"data: {bad\n\n",
			'data: {"type":"text-delta","delta":"ok"}\n\n',
		]);
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
	test("concatenates text chunk content", async () => {
		streamOnce([
			'data: {"type":"text-delta","delta":"a"}\n\n',
			'data: {"type":"text-delta","delta":"b"}\n\n',
			"data: [DONE]\n\n",
		]);
		const out = await new AgentsAPI(OPTIONS).run("pi", [
			{ role: "user", content: "hi" },
		]);
		expect(out).toBe("ab");
	});

	test("rejects on an in-band error part instead of returning partial text", async () => {
		streamOnce([
			'data: {"type":"text-delta","delta":"a"}\n\n',
			'data: {"type":"error","errorText":"e"}\n\n',
			'data: {"type":"text-delta","delta":"b"}\n\n',
			"data: [DONE]\n\n",
		]);
		await expect(
			new AgentsAPI(OPTIONS).run("pi", [{ role: "user", content: "hi" }])
		).rejects.toThrow("agent stream error: e");
	});

	test("rejects when the turn fails before any text", async () => {
		streamOnce(['data: {"type":"error","errorText":"rate limited"}\n\n']);
		await expect(
			new AgentsAPI(OPTIONS).run("pi", [{ role: "user", content: "hi" }])
		).rejects.toThrow("agent stream error: rate limited");
	});
});

/** An open body (never closed by the server) that records cancellation. */
function openStream(chunks: string[]) {
	const state = { cancelled: false, signal: null as AbortSignal | null };
	const encoder = new TextEncoder();
	installFetch((_input, init) => {
		state.signal = init?.signal ?? null;
		return Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						for (const chunk of chunks) {
							c.enqueue(encoder.encode(chunk));
						}
					},
					cancel() {
						state.cancelled = true;
					},
				})
			)
		);
	});
	return state;
}

const delta = (text: string) =>
	`data: ${JSON.stringify({ type: "text-delta", id: "t", delta: text })}`;

describe("AgentsAPI.stream bounds", () => {
	test("a CRLF blank line split across chunks ends the frame", async () => {
		openStream([`${delta("a")}\r\n\r`, `\n${delta("b")}\r`, "\n\r\n"]);
		const chunks: { type: string; content?: string }[] = [];
		for await (const chunk of new AgentsAPI(OPTIONS).stream("pi", [])) {
			chunks.push(chunk);
			if (chunks.length === 2) {
				break;
			}
		}
		expect(chunks).toEqual([
			{ type: "text", content: "a" },
			{ type: "text", content: "b" },
		]);
	});

	test("an oversized terminated frame throws, cancels, and yields nothing after it", async () => {
		const state = openStream([
			`${delta("before")}\n\n`,
			`${delta("x".repeat(300 * 1024))}\n\n${delta("after")}\n\n`,
		]);
		const chunks: { type: string; content?: string }[] = [];
		const consume = async () => {
			for await (const chunk of new AgentsAPI(OPTIONS).stream("pi", [])) {
				chunks.push(chunk);
			}
		};
		await expect(consume()).rejects.toBeInstanceOf(SseFrameTooLargeError);
		expect(chunks).toEqual([{ type: "text", content: "before" }]);
		expect(state.cancelled).toBe(true);
	});

	test("forwards the caller's AbortSignal to the request", async () => {
		const state = openStream(["data: [DONE]\n\n"]);
		const controller = new AbortController();
		await new AgentsAPI(OPTIONS)
			.stream("pi", [], { signal: controller.signal })
			.next();
		expect(state.signal).toBe(controller.signal);
	});

	test("run() stops past its output limit and cancels the stream", async () => {
		const state = openStream([
			`${delta("12345")}\n\n`,
			`${delta("67890")}\n\n`,
		]);
		await expect(
			new AgentsAPI(OPTIONS).run("pi", [], { maxOutputChars: 8 })
		).rejects.toThrow("agent reply exceeded 8 characters");
		expect(state.cancelled).toBe(true);
	});
});
