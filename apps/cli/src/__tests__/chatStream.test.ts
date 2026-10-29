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
import {
	type appRequestValueSchema,
	appResponseValueSchema,
} from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { z } from "zod";
import {
	type ChatStreamHandlers,
	type ChatStreamOptions,
	type ChatTurn,
	coalesceStreamDeltas,
	ERROR_REASON_MAX_CHARS,
	MAX_STREAM_LINE_CHARS,
	stopChatTurn,
	streamChat,
	type TurnUsage,
} from "../core/chatStream.ts";

const chatRequestFieldsSchema = z.looseObject({
	acp_config: z.record(z.string(), z.string()).optional(),
	acp_mode: z.string().optional(),
	acp_model: z.string().optional(),
	agent_id: z.string().optional(),
	conversation_id: z.string().optional(),
	enable_long_term: z.boolean(),
	messages: z.array(
		z.looseObject({
			role: z.enum(["user", "assistant"]),
			content: z.array(
				z.looseObject({ type: z.literal("text"), text: z.string() })
			),
		})
	),
	plugin_flags: z.record(z.string(), z.boolean()).optional(),
	team_id: z.string().optional(),
	workflow_id: z.string().optional(),
});
type ChatRequestObservation = z.infer<typeof chatRequestFieldsSchema>;
const chatRequestObservationSchema = z.custom<ChatRequestObservation>(
	(value) =>
		appResponseValueSchema.safeParse(value).success &&
		chatRequestFieldsSchema.safeParse(value).success
);

type StreamFetchRequest = (
	...args: Parameters<typeof realFetch>
) => ReturnType<typeof realFetch>;
function installResponse(provide: StreamFetchRequest): void {
	globalThis.fetch = Object.assign(provide, {
		preconnect: realFetch.preconnect,
	});
}
type HandlerInput<K extends "onTextDelta" | "onAcpCommands" | "onError"> =
	Parameters<NonNullable<ChatStreamHandlers[K]>>[0];
type StreamOrder =
	| string
	| { text: HandlerInput<"onTextDelta"> }
	| { commands: HandlerInput<"onAcpCommands"> }
	| { error: HandlerInput<"onError"> };
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
	const toolInputs: Parameters<
		NonNullable<ChatStreamHandlers["onToolInput"]>
	>[1][] = [];
	const toolInputIds: Array<string | undefined> = [];
	const outputs: string[] = [];
	const outputBodies: Parameters<
		NonNullable<ChatStreamHandlers["onToolOutput"]>
	>[1][] = [];
	const toolOutputIds: Array<string | undefined> = [];
	const reasoning: string[] = [];
	const todos: Parameters<NonNullable<ChatStreamHandlers["onTodo"]>>[0][] = [];
	const permissions: Parameters<
		NonNullable<ChatStreamHandlers["onPermission"]>
	>[0][] = [];
	const acpCommands: Parameters<
		NonNullable<ChatStreamHandlers["onAcpCommands"]>
	>[0][] = [];
	const notes: string[] = [];
	const errors: string[] = [];
	let doneCount = 0;
	const handlers: ChatStreamHandlers = {
		onAcpCommands: (commands) => acpCommands.push(commands),
		onTextDelta: (d) => deltas.push(d),
		onToolInput: (t, input, id) => {
			tools.push(t);
			toolInputs.push(input);
			toolInputIds.push(id);
		},
		onToolOutput: (s, output, id) => {
			outputs.push(s);
			outputBodies.push(output);
			toolOutputIds.push(id);
		},
		onReasoningDelta: (d) => reasoning.push(d),
		onTodo: (input) => todos.push(input),
		onPermission: (input) => permissions.push(input),
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
		toolInputs,
		outputs,
		outputBodies,
		toolInputIds,
		toolOutputIds,
		reasoning,
		todos,
		permissions,
		acpCommands,
		notes,
		errors,
		done: () => doneCount,
	};
}

const noTurns: ChatTurn[] = [{ role: "user", content: "hi" }];
const noOpts: ChatStreamOptions = {};

const frame = (obj: z.infer<typeof appRequestValueSchema>): string =>
	`data: ${JSON.stringify(obj)}\n`;

// ── happy-path frame dispatch ────────────────────────────────────────────────

test("streams text-delta frames in order, then finish → onDone once", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "start" }),
				frame({ type: "text-delta", delta: "Hello " }),
				frame({ type: "text-delta", delta: "world" }),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["Hello ", "world"]);
	expect(c.done()).toBe(1);
	expect(c.errors).toEqual([]);
});

test("dispatches ACP available-command updates as replacement data", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "data-ryu-acp-commands",
					data: {
						commands: [{ name: "review", description: "Review this change." }],
					},
				}),
				frame({ type: "data-ryu-acp-commands", data: { commands: [] } }),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.acpCommands).toEqual([
		{ commands: [{ name: "review", description: "Review this change." }] },
		{ commands: [] },
	]);
	expect(c.done()).toBe(1);
});

test("maps data-ryu-stats and data-acp-usage frames onto onUsage and skips malformed data", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "data-ryu-stats",
					data: {
						promptTokens: 900,
						completionTokens: 300,
						totalTokens: 1200,
						durationMs: 12_400,
						ttftMs: 350,
						tokensPerSecond: 38.2,
						costAmount: 0.01,
						costCurrency: "USD",
					},
				}),
				frame({
					type: "data-acp-usage",
					data: {
						id: "acp-usage",
						done: false,
						used: 12_300,
						total: 153_750,
						inputTokens: 40,
						outputTokens: "many",
						sessionCostAmount: 0.42,
						sessionCostCurrency: "USD",
						durationMs: 2000,
					},
				}),
				frame({ type: "data-acp-usage", data: "not an object" }),
				frame({ type: "data-ryu-stats" }),
				frame({ type: "finish" }),
			])
		)
	);
	const usages: TurnUsage[] = [];
	const c = collector();
	await streamChat(target, noTurns, noOpts, {
		...c.handlers,
		onUsage: (usage) => usages.push(usage),
	});
	expect(usages).toEqual([
		{
			source: "ryu-stats",
			inputTokens: 900,
			outputTokens: 300,
			totalTokens: 1200,
			durationMs: 12_400,
			ttftMs: 350,
			tokensPerSecond: 38.2,
			costAmount: 0.01,
			costCurrency: "USD",
		},
		{
			source: "acp-usage",
			inputTokens: 40,
			contextUsed: 12_300,
			contextTotal: 153_750,
			durationMs: 2000,
			costAmount: 0.42,
			costCurrency: "USD",
			done: false,
		},
	]);
	expect(c.done()).toBe(1);
	expect(c.errors).toEqual([]);
});

test("maps data-ryu-usage, data-ryu-usage-stats and nested context windows onto onUsage", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "data-ryu-usage",
					data: {
						used: 12_300,
						total: 153_750,
						promptTokens: 900,
						completionTokens: 300,
						sessionCostAmount: 0.42,
					},
				}),
				frame({
					type: "data-ryu-usage-stats",
					data: { totalTokens: 50, used: 999, total: 1000 },
				}),
				frame({
					type: "data-ryu-stats",
					data: {
						totalTokens: 1200,
						contextWindow: { used: 4000, context_window_size: 32_000 },
					},
				}),
				frame({ type: "finish" }),
			])
		)
	);
	const usages: TurnUsage[] = [];
	await streamChat(target, noTurns, noOpts, {
		...collector().handlers,
		onUsage: (usage) => usages.push(usage),
	});
	expect(usages).toEqual([
		{
			source: "ryu-usage",
			inputTokens: 900,
			outputTokens: 300,
			contextUsed: 12_300,
			contextTotal: 153_750,
			costAmount: 0.42,
		},
		// A per-turn stats part's top-level used/total are not a context meter.
		{ source: "ryu-stats", totalTokens: 50 },
		{
			source: "ryu-stats",
			totalTokens: 1200,
			contextUsed: 4000,
			contextTotal: 32_000,
		},
	]);
});

test("coalescing forwards usage snapshots after flushing pending text", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-delta", delta: "answer" }),
				frame({ type: "data-acp-usage", data: { used: 10, total: 100 } }),
				frame({ type: "data-acp-usage", data: { used: 20, total: 100 } }),
				frame({ type: "finish" }),
			])
		)
	);
	const order: Array<string | TurnUsage> = [];
	await streamChat(
		target,
		noTurns,
		noOpts,
		coalesceStreamDeltas(
			{
				onTextDelta: (text) => order.push(text),
				onUsage: (usage) => order.push(usage),
				onError: (error) => order.push(error),
				onDone: () => order.push("done"),
			},
			1000
		)
	);
	expect(order).toEqual([
		"answer",
		{ source: "acp-usage", contextUsed: 10, contextTotal: 100 },
		{ source: "acp-usage", contextUsed: 20, contextTotal: 100 },
		"done",
	]);
});

test("carries a frame split across two body chunks (buffer tail carry-over)", async () => {
	// The single `data:` line is cut mid-JSON: chunk one has no newline, so
	// drainBuffer must return it as the unconsumed tail and re-parse once chunk two
	// completes the line. This is the load-bearing branch a single-string body skips.
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				'data: {"type":"text-de',
				'lta","delta":"joined"}\n',
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["joined"]);
	expect(c.done()).toBe(1);
});

test("tolerates CRLF line endings and multiple frames per chunk", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				'data: {"type":"text-delta","delta":"a"}\r\ndata: {"type":"text-delta","delta":"b"}\r\n',
				'data: {"type":"finish"}\r\n',
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["a", "b"]);
	expect(c.done()).toBe(1);
});

test("dispatches tool-input, tool-output, and plugin-note frames", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "tool-input-available",
					toolName: "search",
					toolCallId: "call-1",
				}),
				// toolName omitted → defaults to "tool".
				frame({ type: "tool-input-available" }),
				frame({
					type: "tool-output-available",
					toolCallId: "call-1",
					output: { status: "ok", output: { stdout: "file" } },
				}),
				// Raw AI SDK output bodies have no status envelope.
				frame({
					type: "tool-output-available",
					toolCallId: "call-raw",
					output: { stdout: "raw", isError: false },
				}),
				frame({ type: "reasoning-delta", delta: "think" }),
				frame({
					type: "tool-input-available",
					toolName: "TodoWrite",
					input: { todos: [{ content: "ship", status: "pending" }] },
				}),
				frame({
					type: "data-todo",
					data: { todos: [{ content: "test", status: "completed" }] },
				}),
				frame({ type: "data-plugin_note", data: { text: "goal set" } }),
				frame({
					type: "data-ryu-permission",
					data: {
						requestId: "perm-1",
						options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
					},
				}),
				// A malformed permission payload is ignored by the stream layer.
				frame({ type: "data-ryu-permission", data: null }),
				// text absent → onPluginNote NOT called.
				frame({ type: "data-plugin_note", data: {} }),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.tools).toEqual(["search", "tool", "TodoWrite"]);
	expect(c.outputs).toEqual(["ok", "completed"]);
	expect(c.outputBodies).toEqual([
		{ stdout: "file" },
		{ stdout: "raw", isError: false },
	]);
	expect(c.reasoning).toEqual(["think"]);
	expect(c.todos).toEqual([
		{ todos: [{ content: "ship", status: "pending" }] },
		{ todos: [{ content: "test", status: "completed" }] },
	]);
	expect(c.notes).toEqual(["goal set"]);
	expect(c.permissions).toEqual([
		{
			requestId: "perm-1",
			options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
		},
	]);
	expect(c.done()).toBe(1);
});

test("keeps Question tool inputs answerable across frame shapes", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "tool-input-available",
					toolCallId: "question-1",
					toolName: "Question",
					input: {
						questions: [
							{
								id: "q-1",
								title: "Pick one",
								kind: "single",
								options: [{ id: "yes", label: "Yes" }],
							},
						],
					},
				}),
				frame({
					type: "data-ryu-question",
					data: {
						questions: [
							{
								id: "q-2",
								title: "Confirm",
								kind: "text",
								options: [],
							},
						],
					},
					toolCallId: "question-2",
				}),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.tools).toEqual(["Question", "Question"]);
	expect(c.toolInputIds).toEqual(["question-1", "question-2"]);
	expect(c.toolInputs[0]).toMatchObject({ toolCallId: "question-1" });
	expect(c.toolInputs[1]).toMatchObject({ toolCallId: "question-2" });
	expect(c.done()).toBe(1);
});

test("preserves tool call IDs across interleaved tool frames", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "tool-input-available",
					toolName: "first",
					toolCallId: "call-1",
				}),
				frame({
					type: "tool-input-available",
					toolName: "second",
					toolCallId: "call-2",
				}),
				frame({
					type: "tool-output-available",
					toolCallId: "call-1",
					output: { status: "ok" },
				}),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.toolInputIds).toEqual(["call-1", "call-2"]);
	expect(c.toolOutputIds).toEqual(["call-1"]);
});

test("tool-output-error, frame-level errors, and denial settle the tool", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({
					type: "tool-output-error",
					toolCallId: "call-1",
					errorText: "command not found",
				}),
				frame({
					type: "tool-output-available",
					toolCallId: "call-2",
					isError: true,
					output: "exit 1",
				}),
				frame({ type: "tool-output-denied", toolCallId: "call-3" }),
				frame({
					type: "tool-output-available",
					toolCallId: "call-4",
					errorText: "timed out",
				}),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.outputs).toEqual(["error", "error", "denied", "error"]);
	expect(c.outputBodies).toEqual([
		"command not found",
		"exit 1",
		undefined,
		"timed out",
	]);
	expect(c.toolOutputIds).toEqual(["call-1", "call-2", "call-3", "call-4"]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

test("ignores unrecognized frame types and non-string deltas", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-start" }),
				frame({ type: "tool-input-start" }),
				frame(null),
				frame([]),
				frame({}),
				// text-delta with a non-string delta is a no-op.
				frame({ type: "text-delta", delta: 42 }),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual([]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

test("accepts data: without a space and flushes an unterminated frame", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				": keep-alive\n",
				'data:{"type":"text-delta","delta":"recovered"}\n',
				"data: null\n",
				"data: [1, 2]\n",
				'data: {"type":123,"delta":"ignored"}\n',
				"data: {not valid json\n",
				'data: {"type":"finish"}',
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["recovered"]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

// ── stream terminators ───────────────────────────────────────────────────────

test("[DONE] sentinel ends the stream and stops later frames", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-delta", delta: "before" }),
				"data: [DONE]\n",
				// Anything after [DONE] must never be dispatched.
				frame({ type: "text-delta", delta: "after" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["before"]);
	expect(c.done()).toBe(1);
});

test("finish closes an inner turn only: post-turn notes and continuation turns before [DONE] still dispatch", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "start" }),
				frame({ type: "text-delta", delta: "first" }),
				frame({ type: "finish" }),
				// post_assistant_turn hook output (e.g. /check's review).
				frame({ type: "data-plugin_note", data: { text: "review" } }),
				// A goal-loop `continue` turn streamed into the same response.
				frame({ type: "start" }),
				frame({ type: "text-delta", delta: "second" }),
				frame({ type: "finish" }),
				"data: [DONE]\n",
				frame({ type: "text-delta", delta: "never" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["first", "second"]);
	expect(c.notes).toEqual(["review"]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

test("a start after finish signals a turn boundary, in order, through coalescing", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "start" }),
				frame({ type: "text-delta", delta: "Done " }),
				frame({ type: "text-delta", delta: "step A." }),
				frame({ type: "finish" }),
				frame({ type: "data-plugin_note", data: { text: "goal: continue" } }),
				frame({ type: "start" }),
				frame({ type: "text-delta", delta: "Now step B" }),
				frame({ type: "finish" }),
				"data: [DONE]\n",
			])
		)
	);

	const events: string[] = [];
	await streamChat(
		target,
		noTurns,
		noOpts,
		coalesceStreamDeltas(
			{
				onTextDelta: (delta) => events.push(`text:${delta}`),
				onPluginNote: (text) => events.push(`note:${text}`),
				onTurnBoundary: () => events.push("boundary"),
				onError: (message) => events.push(`error:${message}`),
				onDone: () => events.push("done"),
			},
			1000
		)
	);
	// The opening `start` is not a boundary; only the continuation turn's is.
	expect(events).toEqual([
		"text:Done step A.",
		"note:goal: continue",
		"boundary",
		"text:Now step B",
		"done",
	]);
});

test("an error frame surfaces its text and terminates the stream", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "error", errorText: "model overloaded" }),
				frame({ type: "text-delta", delta: "never" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["model overloaded"]);
	expect(c.deltas).toEqual([]);
	expect(c.done()).toBe(0);
});

test("an error frame without errorText falls back to a generic message", async () => {
	installResponse(() =>
		Promise.resolve(streamResponse([frame({ type: "error" })]))
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["stream error"]);
});

test("a malformed JSON data line is skipped, not fatal", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				"data: {not valid json\n",
				frame({ type: "text-delta", delta: "recovered" }),
				frame({ type: "finish" }),
			])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["recovered"]);
	expect(c.errors).toEqual([]);
	expect(c.done()).toBe(1);
});

test("a body that ends without a finish frame still resolves via onDone", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([frame({ type: "text-delta", delta: "trailing" })])
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["trailing"]);
	// No finish/[DONE], but the reader draining triggers the terminal onDone.
	expect(c.done()).toBe(1);
});

// ── HTTP / transport error paths ─────────────────────────────────────────────

test("a non-2xx response reports HTTP <status> with the body's reason", async () => {
	installResponse(() =>
		Promise.resolve(new Response("  upstream\n overloaded ", { status: 503 }))
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["HTTP 503 · upstream overloaded"]);
	expect(c.done()).toBe(0);
});

test("a non-2xx JSON body reports its error or message field", async () => {
	const bodies = [
		{ error: "model not found" },
		{ error: { message: "rate limited" } },
		{ message: "bad request" },
	];
	const errors: string[] = [];
	for (const body of bodies) {
		installResponse(() =>
			Promise.resolve(Response.json(body, { status: 400 }))
		);
		const c = collector();
		await streamChat(target, noTurns, noOpts, c.handlers);
		errors.push(...c.errors);
	}
	expect(errors).toEqual([
		"HTTP 400 · model not found",
		"HTTP 400 · rate limited",
		"HTTP 400 · bad request",
	]);
});

test("a non-2xx response with an empty or huge body stays bounded", async () => {
	installResponse(() => Promise.resolve(new Response(null, { status: 502 })));
	const empty = collector();
	await streamChat(target, noTurns, noOpts, empty.handlers);
	expect(empty.errors).toEqual(["HTTP 502"]);

	installResponse(() =>
		Promise.resolve(new Response("x".repeat(100_000), { status: 500 }))
	);
	const huge = collector();
	await streamChat(target, noTurns, noOpts, huge.handlers);
	const [message] = huge.errors;
	expect(message?.startsWith("HTTP 500 · xxx")).toBe(true);
	expect(message?.endsWith("…")).toBe(true);
	expect(message?.length).toBe("HTTP 500 · ".length + ERROR_REASON_MAX_CHARS);
});

test("a 200 with a null body resolves immediately via onDone", async () => {
	installResponse(() => Promise.resolve(new Response(null, { status: 200 })));

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.done()).toBe(1);
	expect(c.errors).toEqual([]);
});

test("a fetch rejection is reported through onError, not thrown", async () => {
	installResponse(() => Promise.reject(new Error("ECONNREFUSED")));

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["ECONNREFUSED"]);
	expect(c.done()).toBe(0);
});

test("a non-Error fetch rejection is stringified", async () => {
	installResponse(() => Promise.reject("string failure"));

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["string failure"]);
});

// ── request shaping ──────────────────────────────────────────────────────────

test("request body maps turns to typed content parts and carries the bearer", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	installResponse((url, init) => {
		capturedUrl = String(url);
		capturedInit = init;
		return Promise.resolve(streamResponse([frame({ type: "finish" })]));
	});

	const turns: ChatTurn[] = [
		{ role: "user", content: "one" },
		{ role: "assistant", content: "two" },
	];
	const c = collector();
	await streamChat(target, turns, noOpts, c.handlers);

	expect(capturedUrl).toBe("http://node:7980/api/chat/stream");
	expect(capturedInit?.method).toBe("POST");
	const headers = new Headers(capturedInit?.headers);
	expect(headers.get("Content-Type")).toBe("application/json");
	expect(headers.get("Authorization")).toBe("Bearer node-secret");

	const body = chatRequestObservationSchema.parse(
		JSON.parse(z.string().parse(capturedInit?.body))
	);
	expect(body.messages).toEqual([
		{ role: "user", content: [{ type: "text", text: "one" }] },
		{ role: "assistant", content: [{ type: "text", text: "two" }] },
	]);
});

test("routing options are attached only when set, snake_cased on the wire", async () => {
	let body: Partial<ChatRequestObservation> = {};
	installResponse((_url, init) => {
		body = chatRequestObservationSchema.parse(
			JSON.parse(z.string().parse(init?.body))
		);
		return Promise.resolve(streamResponse([frame({ type: "finish" })]));
	});

	const c = collector();
	await streamChat(
		target,
		noTurns,
		{
			agentId: "agent-1",
			conversationId: "conv-9",
			acpModel: "sonnet",
			acpMode: "acceptEdits",
			acpConfig: { thought_level: "high" },
			teamId: "team-3",
			pluginFlags: { "io.ryu.double-check": true },
		},
		c.handlers
	);
	expect(body.agent_id).toBe("agent-1");
	expect(body.conversation_id).toBe("conv-9");
	expect(body.acp_model).toBe("sonnet");
	expect(body.acp_mode).toBe("acceptEdits");
	expect(body.acp_config).toEqual({ thought_level: "high" });
	expect(body.team_id).toBe("team-3");
	expect(body.plugin_flags).toEqual({ "io.ryu.double-check": true });
});

test("an empty pluginFlags map is omitted from the body", async () => {
	let body: Partial<ChatRequestObservation> = {};
	installResponse((_url, init) => {
		body = chatRequestObservationSchema.parse(
			JSON.parse(z.string().parse(init?.body))
		);
		return Promise.resolve(streamResponse([frame({ type: "finish" })]));
	});

	const c = collector();
	await streamChat(target, noTurns, { pluginFlags: {} }, c.handlers);
	expect("plugin_flags" in body).toBe(false);
	expect("agent_id" in body).toBe(false);
});

// ── render coalescing ────────────────────────────────────────────────────────

test("coalesces a burst of deltas into one render, flushing before other events", async () => {
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-delta", delta: "Hel" }),
				frame({ type: "text-delta", delta: "lo " }),
				frame({ type: "reasoning-delta", delta: "think" }),
				frame({ type: "text-delta", delta: "world" }),
				frame({
					type: "tool-input-available",
					toolName: "search",
					toolCallId: "t1",
					input: {},
				}),
				frame({ type: "text-delta", delta: "!" }),
				frame({ type: "finish" }),
			])
		)
	);

	const order: string[] = [];
	const c = collector();
	const handlers: ChatStreamHandlers = {
		...c.handlers,
		onTextDelta: (d) => order.push(`text:${d}`),
		onReasoningDelta: (d) => order.push(`reasoning:${d}`),
		onToolInput: (name) => order.push(`tool:${name}`),
		onDone: () => order.push("done"),
	};
	await streamChat(
		target,
		noTurns,
		noOpts,
		coalesceStreamDeltas(handlers, 1000)
	);
	expect(order).toEqual([
		"text:Hello ",
		"reasoning:think",
		"text:world",
		"tool:search",
		"text:!",
		"done",
	]);
});

test("a quiet stream still renders pending text after the window", async () => {
	const seen: string[] = [];
	const handlers = coalesceStreamDeltas(
		{ onTextDelta: (d) => seen.push(d), onDone: () => {}, onError: () => {} },
		10
	);
	handlers.onTextDelta("a");
	handlers.onTextDelta("b");
	expect(seen).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(seen).toEqual(["ab"]);
});

test("coalescing preserves advertised ACP command replacements and flushes prior text before each update", async () => {
	const advertised = {
		commands: [
			{ name: "acp-review", description: "Review changes", hint: "changes" },
		],
	};
	const cleared = { commands: [] };
	installResponse(() =>
		Promise.resolve(
			streamResponse([
				frame({ type: "text-delta", delta: "before " }),
				frame({ type: "text-delta", delta: "commands" }),
				frame({ type: "data-ryu-acp-commands", data: advertised }),
				frame({ type: "text-delta", delta: "before removal" }),
				frame({ type: "data-ryu-acp-commands", data: cleared }),
				frame({ type: "finish" }),
			])
		)
	);
	const order: StreamOrder[] = [];
	const handlers: ChatStreamHandlers = {
		onTextDelta: (text) => order.push({ text }),
		onAcpCommands: (commands) => order.push({ commands }),
		onError: (error) => order.push({ error }),
		onDone: () => order.push("done"),
	};
	await streamChat(
		target,
		noTurns,
		noOpts,
		coalesceStreamDeltas(handlers, 1000)
	);
	expect(order).toEqual([
		{ text: "before commands" },
		{ commands: advertised },
		{ text: "before removal" },
		{ commands: cleared },
		"done",
	]);
});

test("stopping a turn aborts the read and cancels the persisted turn on Core", async () => {
	// Core drives a persisted turn detached from its request, so the abort alone
	// would leave it generating; Stop must also call /api/chat/cancel.
	const requests: { body: string; method: string; url: string }[] = [];
	installResponse((input, init) => {
		requests.push({
			body: String(init?.body ?? ""),
			method: init?.method ?? "GET",
			url: String(input),
		});
		return Promise.resolve(Response.json({ cancelled: true }));
	});
	const controller = new AbortController();
	await stopChatTurn(target, "conv-1", controller);
	expect(controller.signal.aborted).toBe(true);
	expect(requests).toEqual([
		{
			body: JSON.stringify({ conversation_id: "conv-1" }),
			method: "POST",
			url: "http://node:7980/api/chat/cancel",
		},
	]);
});

test("stopping a turn never rejects and skips Core without a conversation", async () => {
	let calls = 0;
	installResponse(() => {
		calls += 1;
		return Promise.reject(new Error("Core is down"));
	});
	const controller = new AbortController();
	await stopChatTurn(target, undefined, controller);
	expect(controller.signal.aborted).toBe(true);
	expect(calls).toBe(0);
	await expect(stopChatTurn(target, "conv-2", null)).resolves.toBeUndefined();
	expect(calls).toBe(1);
});

test("a non-2xx HTML error page reports only its title", async () => {
	installResponse(() =>
		Promise.resolve(
			new Response(
				"<html><head><title>502 Bad Gateway</title></head><body><h1>nginx</h1></body></html>",
				{ status: 502, headers: { "content-type": "text/html" } }
			)
		)
	);
	const titled = collector();
	await streamChat(target, noTurns, noOpts, titled.handlers);
	expect(titled.errors).toEqual(["HTTP 502 · 502 Bad Gateway"]);

	installResponse(() =>
		Promise.resolve(
			new Response("<html><body>down</body></html>", { status: 503 })
		)
	);
	const untitled = collector();
	await streamChat(target, noTurns, noOpts, untitled.handlers);
	expect(untitled.errors).toEqual(["HTTP 503"]);
});

test("aborting while a non-2xx body is read reports no error", async () => {
	const controller = new AbortController();
	installResponse(() =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						controller.abort();
						return new Promise(() => undefined);
					},
				}),
				{ status: 503 }
			)
		)
	);
	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers, controller.signal);
	expect(c.errors).toEqual([]);
});

test("a non-2xx body that stalls still reports the status", async () => {
	const encoder = new TextEncoder();
	installResponse(() =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode("partial reason"));
					},
					pull() {
						return new Promise(() => undefined);
					},
				}),
				{ status: 503 }
			)
		)
	);
	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.errors).toEqual(["HTTP 503 · partial reason"]);
});

test("a stream line that never ends is cancelled at the bound, not at EOF", async () => {
	const encoder = new TextEncoder();
	const chunks = [
		frame({ type: "text-delta", delta: "before" }),
		'data: {"type":"text-delta","delta":"',
		...Array.from({ length: 64 }, () => "x".repeat(8192)),
		'"}\n',
		frame({ type: "text-delta", delta: "after" }),
	];
	const probe = { cancelled: false, pulls: 0 };
	installResponse(() =>
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
				})
			)
		)
	);

	const c = collector();
	await streamChat(target, noTurns, noOpts, c.handlers);
	expect(c.deltas).toEqual(["before"]);
	expect(c.errors).toEqual([
		`Chat stream line exceeds ${MAX_STREAM_LINE_CHARS} characters`,
	]);
	expect(c.done()).toBe(0);
	expect(probe.cancelled).toBe(true);
	expect(probe.pulls).toBeLessThan(chunks.length);
});
