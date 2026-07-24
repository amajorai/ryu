// Unit tests for the hand-rolled SSE chat client (core/chatStream.ts) — the TUI's
// own read loop over Core's `/api/chat/stream` (the TS port of apps/cli's
// stream_chat). cli.dispatch.test.ts injects a FAKE CoreApi, so the real streaming
// impl (frame discriminator, `\n`-delimited buffering with cross-chunk carry-over,
// request-body shaping, and the HTTP/network error paths) is never exercised there.
// These tests drive `streamChat` against a swapped `globalThis.fetch` returning
// real Response objects (a ReadableStream body for the happy paths), restoring the
// real fetch in afterEach so the swap never leaks into the shared-process smoke
// tests. No Core node is contacted.

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	type ChatStreamHandlers,
	type ChatStreamOptions,
	type ChatTurn,
	streamChat,
} from "../core/chatStream.ts";

const target: ApiTarget = { url: "http://node:7980", token: "node-secret" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

// A real Response whose body streams the given chunks in order — exercises the
// getReader() path (and, with a split frame, the cross-chunk buffer carry-over).
function streamResponse(chunks: string[], status = 200): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
	return new Response(body, { status });
}

function collector() {
	const deltas: string[] = [];
	const tools: string[] = [];
	const outputs: string[] = [];
	const notes: string[] = [];
	const errors: string[] = [];
	let doneCount = 0;
	const handlers: ChatStreamHandlers = {
		onTextDelta: (d) => deltas.push(d),
		onToolInput: (t) => tools.push(t),
		onToolOutput: (s) => outputs.push(s),
		onPluginNote: (t) => notes.push(t),
		onError: (m) => errors.push(m),
		onDone: () => {
			doneCount += 1;
		},
	};
	return {
		handlers,
		deltas,
		tools,
		outputs,
		notes,
		errors,
		done: () => doneCount,
	};
}

const noTurns: ChatTurn[] = [{ role: "user", content: "hi" }];
const noOpts: ChatStreamOptions = {};

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n`;

// ── happy-path frame dispatch ────────────────────────────────────────────────

test("streams text-delta frames in order, then finish → onDone once", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "start" }),
				frame({ type: "text-delta", delta: "Hello " }),
				frame({ type: "text-delta", delta: "world" }),
				frame({ type: "finish" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["Hello ", "world"]);
	expect(c.done()).toBe(1);
	expect(c.errors).toEqual([]);
});

test("carries a frame split across two body chunks (buffer tail carry-over)", async () => {
	// The single `data:` line is cut mid-JSON: chunk one has no newline, so
	// drainBuffer must return it as the unconsumed tail and re-parse once chunk two
	// completes the line. This is the load-bearing branch a single-string body skips.
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				'data: {"type":"text-de',
				'lta","delta":"joined"}\n',
				frame({ type: "finish" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["joined"]);
	expect(c.done()).toBe(1);
});

test("tolerates CRLF line endings and multiple frames per chunk", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				'data: {"type":"text-delta","delta":"a"}\r\ndata: {"type":"text-delta","delta":"b"}\r\n',
				'data: {"type":"finish"}\r\n',
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["a", "b"]);
	expect(c.done()).toBe(1);
});

test("dispatches tool-input, tool-output, and plugin-note frames", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "tool-input-available", toolName: "search" }),
				// toolName omitted → defaults to "tool".
				frame({ type: "tool-input-available" }),
				frame({ type: "tool-output-available", output: { status: "ok" } }),
				// status absent → onToolOutput NOT called.
				frame({ type: "tool-output-available", output: {} }),
				frame({ type: "data-plugin_note", data: { text: "goal set" } }),
				// text absent → onPluginNote NOT called.
				frame({ type: "data-plugin_note", data: {} }),
				frame({ type: "finish" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.tools).toEqual(["search", "tool"]);
	expect(c.outputs).toEqual(["ok"]);
	expect(c.notes).toEqual(["goal set"]);
	expect(c.done()).toBe(1);
});

test("ignores unrecognized frame types and non-string deltas", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-start" }),
				frame({ type: "tool-input-start" }),
				// text-delta with a non-string delta is a no-op.
				frame({ type: "text-delta", delta: 42 }),
				frame({ type: "finish" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual([]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

// ── stream terminators ───────────────────────────────────────────────────────

test("[DONE] sentinel ends the stream and stops later frames", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-delta", delta: "before" }),
				"data: [DONE]\n",
				// Anything after [DONE] must never be dispatched.
				frame({ type: "text-delta", delta: "after" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["before"]);
	expect(c.done()).toBe(1);
});

test("an error frame surfaces its text and terminates the stream", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "error", errorText: "model overloaded" }),
				frame({ type: "text-delta", delta: "never" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["model overloaded"]);
	expect(c.deltas).toEqual([]);
	expect(c.done()).toBe(0);
});

test("an error frame without errorText falls back to a generic message", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([frame({ type: "error" })])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["stream error"]);
});

test("a malformed JSON data line is skipped, not fatal", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([
				"data: {not valid json\n",
				frame({ type: "text-delta", delta: "recovered" }),
				frame({ type: "finish" }),
			])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["recovered"]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

test("a body that ends without a finish frame still resolves via onDone", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			streamResponse([frame({ type: "text-delta", delta: "trailing" })])
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["trailing"]);
	// No finish/[DONE], but the reader draining triggers the terminal onDone.
	expect(c.done()).toBe(1);
});

// ── HTTP / transport error paths ─────────────────────────────────────────────

test("a non-2xx response reports HTTP <status> and reads no body", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response("nope", { status: 503 })
		)) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["HTTP 503"]);
	expect(c.done()).toBe(0);
});

test("a 200 with a null body resolves immediately via onDone", async () => {
	globalThis.fetch = (() =>
		Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.done()).toBe(1);
	expect(c.errors).toEqual([]);
});

test("a fetch rejection is reported through onError, not thrown", async () => {
	globalThis.fetch = (() =>
		Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["ECONNREFUSED"]);
	expect(c.done()).toBe(0);
});

test("a non-Error fetch rejection is stringified", async () => {
	globalThis.fetch = (() =>
		Promise.reject("string failure")) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["string failure"]);
});

// ── request shaping ──────────────────────────────────────────────────────────

test("request body maps turns to typed content parts and carries the bearer", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
		capturedUrl = String(url);
		capturedInit = init;
		return Promise.resolve(streamResponse([frame({ type: "finish" })]));
	}) as unknown as typeof fetch;

	const turns: ChatTurn[] = [
		{ role: "user", content: "one" },
		{ role: "assistant", content: "two" },
	];
	const c = collector();
	await streamChat(target, turns, noOpts, c.handlers);

	expect(capturedUrl).toBe("http://node:7980/api/chat/stream");
	expect(capturedInit?.method).toBe("POST");
	const headers = capturedInit?.headers as Record<string, string>;
	expect(headers["Content-Type"]).toBe("application/json");
	expect(headers.Authorization).toBe("Bearer node-secret");

	const body = JSON.parse(capturedInit?.body as string) as {
		messages: { role: string; content: { type: string; text: string }[] }[];
	};
	expect(body.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "one" }] },
		{ role: "assistant", content: [{ type: "text", text: "two" }] },
	]);
});

test("routing options are attached only when set, snake_cased on the wire", async () => {
	let body: Record<string, unknown> = {};
	globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
		body = JSON.parse(init?.body as string) as Record<string, unknown>;
		return Promise.resolve(streamResponse([frame({ type: "finish" })]));
	}) as unknown as typeof fetch;

	const c = collector();
	await streamChat(
		target,
		noTurns,
		{
			agentId: "agent-1",
			conversationId: "conv-9",
			acpModel: "sonnet",
			teamId: "team-3",
			pluginFlags: { "io.ryu.double-check": true },
		},
		c.handlers
	);
	expect(body.agent_id).toBe("agent-1");
	expect(body.conversation_id).toBe("conv-9");
	expect(body.acp_model).toBe("sonnet");
	expect(body.team_id).toBe("team-3");
	expect(body.plugin_flags).toEqual({ "io.ryu.double-check": true });
});

test("an empty pluginFlags map is omitted from the body", async () => {
	let body: Record<string, unknown> = {};
	globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
		body = JSON.parse(init?.body as string) as Record<string, unknown>;
		return Promise.resolve(streamResponse([frame({ type: "finish" })]));
	}) as unknown as typeof fetch;

	const c = collector();
	await streamChat(target, noTurns, { pluginFlags: {} }, c.handlers);
	expect("plugin_flags" in body).toBe(false);
	expect("agent_id" in body).toBe(false);
});
