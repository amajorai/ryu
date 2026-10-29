import { beforeEach, expect, mock, test } from "bun:test";
import type { ChatStreamHandlers } from "@ryu/command/types";
import type { CoreStreamEndEvent, CoreStreamPartEvent } from "../shared/ipc.ts";
import { createCommandTransport } from "./command-transport.ts";

type PartListener = (event: CoreStreamPartEvent) => void;
type EndListener = (event: CoreStreamEndEvent) => void;

let partListeners: Set<PartListener>;
let endListeners: Set<EndListener>;
let chatStream: ReturnType<typeof mock>;
let abortStream: ReturnType<typeof mock>;

function emitPart(streamId: string, part: unknown): void {
	for (const listener of [...partListeners]) {
		listener({ part, streamId } as CoreStreamPartEvent);
	}
}

function emitEnd(event: CoreStreamEndEvent): void {
	for (const listener of [...endListeners]) {
		listener(event);
	}
}

function recordingHandlers() {
	const events: string[] = [];
	const handlers: ChatStreamHandlers = {
		onDelta: (delta) => events.push(`delta:${delta}`),
		onDone: () => events.push("done"),
		onError: (message) => events.push(`error:${message}`),
	};
	return { events, handlers };
}

async function flush(): Promise<void> {
	for (let tick = 0; tick < 5; tick += 1) {
		await Promise.resolve();
	}
}

beforeEach(() => {
	partListeners = new Set();
	endListeners = new Set();
	chatStream = mock(async () => ({ streamId: "s1" }));
	abortStream = mock(async () => undefined);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			island: {
				core: {
					abortStream,
					chatStream,
					onStreamEnd: (listener: EndListener) => {
						endListeners.add(listener);
						return () => endListeners.delete(listener);
					},
					onStreamPart: (listener: PartListener) => {
						partListeners.add(listener);
						return () => partListeners.delete(listener);
					},
				},
			},
		},
	});
});

const send = createCommandTransport({
	agentId: "claude",
	conversationId: "conv-1",
});

test("starts the turn for the bound agent and conversation", async () => {
	const { handlers } = recordingHandlers();
	send([{ content: "hi", id: "m1", role: "user" }], handlers);
	await flush();
	expect(chatStream).toHaveBeenCalledWith({
		agent_id: "claude",
		conversation_id: "conv-1",
		enable_long_term: false,
		messages: [{ content: "hi", role: "user" }],
	});
});

test("only parts and ends for the returned stream id reach the handlers", async () => {
	const { events, handlers } = recordingHandlers();
	send([], handlers);
	await flush();
	emitPart("other", { delta: "leak", type: "text-delta" });
	emitPart("s1", { delta: "Hel", type: "text-delta" });
	emitPart("s1", { type: "tool-input-start" });
	emitPart("s1", { delta: "lo", type: "text-delta" });
	emitPart("s1", { errorText: "tool failed", type: "error" });
	emitEnd({ reason: "done", streamId: "other" });
	emitEnd({ reason: "done", streamId: "s1" });
	emitEnd({ reason: "done", streamId: "s1" });
	expect(events).toEqual([
		"delta:Hel",
		"delta:lo",
		"error:tool failed",
		"done",
	]);
	expect(partListeners.size).toBe(0);
	expect(endListeners.size).toBe(0);
});

test("an error end surfaces the Core message, or a default", async () => {
	const first = recordingHandlers();
	send([], first.handlers);
	await flush();
	emitEnd({ error: "model offline", reason: "error", streamId: "s1" });
	expect(first.events).toEqual(["error:model offline"]);

	const second = recordingHandlers();
	send([], second.handlers);
	await flush();
	emitEnd({ reason: "error", streamId: "s1" });
	expect(second.events).toEqual(["error:Stream failed."]);
});

test("a failed send is surfaced once and unsubscribes", async () => {
	chatStream.mockImplementation(async () => {
		throw new Error("Core unreachable");
	});
	const { events, handlers } = recordingHandlers();
	send([], handlers);
	await flush();
	expect(events).toEqual(["error:Core unreachable"]);
	expect(partListeners.size).toBe(0);
	expect(endListeners.size).toBe(0);

	chatStream.mockImplementation(() => Promise.reject("nope"));
	const fallback = recordingHandlers();
	send([], fallback.handlers);
	await flush();
	expect(fallback.events).toEqual(["error:Could not reach Core."]);
});

test("abort before the stream id resolves is applied once it lands", async () => {
	let resolveStart: (handle: { streamId: string }) => void = () => undefined;
	chatStream.mockImplementation(
		() =>
			new Promise<{ streamId: string }>((resolve) => {
				resolveStart = resolve;
			})
	);
	const { events, handlers } = recordingHandlers();
	const handle = send([], handlers);
	handle.abort();
	expect(abortStream).not.toHaveBeenCalled();
	resolveStart({ streamId: "late" });
	await flush();
	expect(abortStream).toHaveBeenCalledWith("late");
	// Abort only requests; the terminal end event still settles the view.
	emitEnd({ reason: "aborted", streamId: "late" });
	expect(events).toEqual(["done"]);
});

test("abort after start forwards the stream id immediately", async () => {
	const { handlers } = recordingHandlers();
	const handle = send([], handlers);
	await flush();
	handle.abort();
	expect(abortStream).toHaveBeenCalledWith("s1");
	expect(endListeners.size).toBe(1);
});
