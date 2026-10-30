import { describe, expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { ChatSession } from "./ChatPage.session.ts";

/** A transport whose response streams the test writes chunk by chunk. */
function controlledTransport() {
	let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
	let requests = 0;
	const transport: ChatTransport<UIMessage> = {
		sendMessages: ({ abortSignal }) => {
			requests += 1;
			return Promise.resolve(
				new ReadableStream<UIMessageChunk>({
					start(streamController) {
						controller = streamController;
						abortSignal?.addEventListener("abort", () => {
							try {
								streamController.error(
									new DOMException("aborted", "AbortError")
								);
							} catch {
								// Already closed.
							}
						});
					},
				})
			);
		},
		reconnectToStream: () => Promise.resolve(null),
	};
	return {
		transport,
		requests: () => requests,
		write: (chunk: UIMessageChunk) => controller?.enqueue(chunk),
		end: () => controller?.close(),
		fail: (error: Error) => controller?.error(error),
	};
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function lastText(messages: readonly UIMessage[]) {
	const parts = messages.at(-1)?.parts ?? [];
	for (let index = parts.length - 1; index >= 0; index -= 1) {
		const part = parts[index];
		if (part?.type === "text") {
			return part.text;
		}
	}
	return null;
}

/** Counts the Chat callbacks the session holds, to catch leaked subscriptions. */
function countRegistrations(chat: Chat<UIMessage>) {
	let active = 0;
	for (const key of [
		"~registerMessagesCallback",
		"~registerStatusCallback",
		"~registerErrorCallback",
	] as const) {
		const register = chat[key] as (...args: unknown[]) => () => void;
		(chat as unknown as Record<string, unknown>)[key] = (
			...args: unknown[]
		) => {
			active += 1;
			const off = register(...args);
			let done = false;
			return () => {
				if (!done) {
					done = true;
					active -= 1;
				}
				off();
			};
		};
	}
	return () => active;
}

/** Subscribes like ChatPage plus the transcript: page, live, status, error. */
function mount(session: ChatSession) {
	const seen = { page: 0, live: 0, status: [] as string[], error: 0 };
	const offs = [
		session.subscribePage(() => {
			seen.page += 1;
		}),
		session.subscribeLive(() => {
			seen.live += 1;
		}),
		session.subscribeStatus(() => {
			seen.status.push(session.getStatus());
		}),
		session.subscribeError(() => {
			seen.error += 1;
		}),
	];
	return {
		seen,
		unmount: () => {
			for (const off of offs) {
				off();
			}
		},
	};
}

function startReply(stream: ReturnType<typeof controlledTransport>) {
	stream.write({ type: "start", messageId: "a1" });
	stream.write({ type: "text-start", id: "t" });
	stream.write({ type: "text-delta", id: "t", delta: "One" });
}

describe("ChatSession under turn lifecycle edges", () => {
	test("stop mid-stream publishes the stopped text to the page at once", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "stop", transport: stream.transport }),
			undefined
		);
		const view = mount(session);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		startReply(stream);
		await settle();
		stream.write({ type: "text-delta", id: "t", delta: " two" });
		await settle();
		expect(lastText(session.getPageMessages())).not.toBe("One two");
		await session.chat.stop();
		await sent;
		await settle();
		expect(session.getStatus()).toBe("ready");
		expect(view.seen.status).toEqual(["submitted", "streaming", "ready"]);
		expect(session.getPageMessages()).toBe(session.getLiveMessages());
		expect(lastText(session.getPageMessages())).toBe("One two");
		view.unmount();
	});

	test("stop before the first chunk returns to ready with the user message", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "stop-early", transport: stream.transport }),
			undefined
		);
		const view = mount(session);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		expect(session.getStatus()).toBe("submitted");
		await session.chat.stop();
		await sent;
		await settle();
		expect(session.getStatus()).toBe("ready");
		expect(session.getPageMessages().map((m) => m.role)).toEqual(["user"]);
		view.unmount();
	});

	test("an error mid-stream reaches the page with its partial text, and a retry restarts cleanly", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "error", transport: stream.transport }),
			undefined
		);
		const view = mount(session);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		startReply(stream);
		await settle();
		stream.write({ type: "text-delta", id: "t", delta: " two" });
		await settle();
		stream.fail(new Error("boom"));
		await sent;
		await settle();
		expect(session.getStatus()).toBe("error");
		expect(session.getError()?.message).toBe("boom");
		expect(view.seen.error).toBeGreaterThan(0);
		expect(session.getPageMessages()).toBe(session.getLiveMessages());
		expect(lastText(session.getPageMessages())).toBe("One two");

		// Retry: regenerate drops the failed reply, and the new one streams.
		const retried = session.chat.regenerate();
		await settle();
		expect(session.getStatus()).toBe("submitted");
		expect(session.getError()).toBeUndefined();
		expect(session.getPageMessages().map((m) => m.role)).toEqual(["user"]);
		stream.write({ type: "start", messageId: "a2" });
		stream.write({ type: "text-start", id: "t" });
		stream.write({ type: "text-delta", id: "t", delta: "Retry" });
		stream.write({ type: "text-delta", id: "t", delta: " ok" });
		stream.write({ type: "text-end", id: "t" });
		stream.write({ type: "finish" });
		stream.end();
		await retried;
		await settle();
		expect(session.getStatus()).toBe("ready");
		expect(session.getPageMessages().map((m) => m.id)).toEqual([
			session.getPageMessages()[0]?.id,
			"a2",
		]);
		expect(lastText(session.getPageMessages())).toBe("Retry ok");
		view.unmount();
	});

	test("an edit of the last user message replaces the turn on the page", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "edit", transport: stream.transport }),
			undefined
		);
		const view = mount(session);
		const first = session.chat.sendMessage({ text: "Hello" });
		await settle();
		startReply(stream);
		stream.write({ type: "text-end", id: "t" });
		stream.write({ type: "finish" });
		stream.end();
		await first;
		await settle();
		const userId = session.getPageMessages()[0]?.id as string;
		const edited = session.chat.sendMessage({
			text: "Hello again",
			messageId: userId,
		});
		await settle();
		expect(session.getPageMessages()).toHaveLength(1);
		const userPart = session.getPageMessages()[0]?.parts[0];
		expect(userPart?.type === "text" ? userPart.text : null).toBe(
			"Hello again"
		);
		stream.write({ type: "start", messageId: "a2" });
		stream.write({ type: "finish" });
		stream.end();
		await edited;
		view.unmount();
	});

	test("tool and data part updates mid-reply reach the page, including in-place reconciliation", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "tools", transport: stream.transport }),
			undefined
		);
		const view = mount(session);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		// Right after the SDK pushed its working message.
		stream.write({ type: "start", messageId: "a1" });
		stream.write({ type: "data-status", id: "s", data: { step: 1 } });
		await settle();
		stream.write({ type: "data-status", id: "s", data: { step: 2 } });
		await settle();
		const status = session.getPageMessages().at(-1)?.parts[0] as {
			data: { step: number };
		};
		expect(status.data.step).toBe(2);
		stream.write({
			type: "tool-input-available",
			toolCallId: "c1",
			toolName: "read",
			input: { path: "a" },
			dynamic: true,
		});
		await settle();
		stream.write({
			type: "tool-output-available",
			toolCallId: "c1",
			output: 1,
		});
		await settle();
		const tool = session.getPageMessages().at(-1)?.parts.at(-1) as {
			state: string;
		};
		expect(tool.state).toBe("output-available");
		stream.write({ type: "finish" });
		stream.end();
		await sent;
		view.unmount();
	});
});

describe("ChatSession subscriptions", () => {
	test("unmounting mid-stream (throttled, after a throttle change) leaves no Chat callbacks and notifies no one", async () => {
		const stream = controlledTransport();
		const chat = new Chat<UIMessage>({
			id: "unmount",
			transport: stream.transport,
		});
		const active = countRegistrations(chat);
		const session = new ChatSession(chat, 30);
		const view = mount(session);
		expect(active()).toBe(3);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		startReply(stream);
		await settle();
		// The tab goes to the background mid-stream.
		session.setThrottle(80);
		expect(active()).toBe(3);
		stream.write({ type: "text-delta", id: "t", delta: " two" });
		await settle();
		view.unmount();
		expect(active()).toBe(0);
		const after = { ...view.seen, status: view.seen.status.length };
		stream.write({ type: "text-delta", id: "t", delta: " three" });
		stream.write({ type: "text-end", id: "t" });
		stream.write({ type: "finish" });
		stream.end();
		await sent;
		await settle(120);
		expect({ ...view.seen, status: view.seen.status.length }).toEqual(after);
		// A remount (StrictMode, tab restore) catches up with the finished turn.
		const again = mount(session);
		expect(lastText(session.getPageMessages())).toBe("One two three");
		expect(session.getLiveMessages()).toBe(session.getPageMessages());
		again.unmount();
		expect(active()).toBe(0);
	});

	test("two sessions streaming at once do not cross-talk", async () => {
		const left = controlledTransport();
		const right = controlledTransport();
		const a = new ChatSession(
			new Chat<UIMessage>({ id: "left", transport: left.transport }),
			undefined
		);
		const b = new ChatSession(
			new Chat<UIMessage>({ id: "right", transport: right.transport }),
			undefined
		);
		const va = mount(a);
		const vb = mount(b);
		const sentA = a.chat.sendMessage({ text: "A" });
		const sentB = b.chat.sendMessage({ text: "B" });
		await settle();
		startReply(left);
		await settle();
		const bLive = vb.seen.live;
		for (const word of [" a1", " a2", " a3"]) {
			left.write({ type: "text-delta", id: "t", delta: word });
			await settle();
		}
		expect(vb.seen.live).toBe(bLive);
		expect(b.getStatus()).toBe("submitted");
		await a.chat.stop();
		await sentA;
		await settle();
		expect(a.getStatus()).toBe("ready");
		expect(b.getStatus()).toBe("submitted");
		right.write({ type: "start", messageId: "b1" });
		right.write({ type: "finish" });
		right.end();
		await sentB;
		await settle();
		expect(lastText(a.getPageMessages())).toBe("One a1 a2 a3");
		expect(
			b
				.getPageMessages()
				.map((m) => m.id)
				.at(-1)
		).toBe("b1");
		va.unmount();
		vb.unmount();
	});
});

describe("ChatSession setMessages edits", () => {
	test("an edit to the text of a part left streaming (a stopped reply) reaches the page", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "edit-text", transport: stream.transport }),
			undefined
		);
		const view = mount(session);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		startReply(stream);
		await settle();
		await session.chat.stop();
		await sent;
		await settle();
		// The stopped reply keeps its text part in state "streaming".
		const stopped = session.getPageMessages().at(-1)?.parts.at(-1) as {
			state?: string;
		};
		expect(stopped.state).toBe("streaming");
		// A host edit (history reload, resumed reader) rewrites only that text.
		session.chat.messages = session.chat.messages.map((message) =>
			message.id === "a1"
				? {
						...message,
						parts: message.parts.map((part) =>
							part.type === "text" ? { ...part, text: "Rewritten" } : part
						),
					}
				: message
		);
		await settle();
		expect(lastText(session.getLiveMessages())).toBe("Rewritten");
		expect(lastText(session.getPageMessages())).toBe("Rewritten");
		view.unmount();
	});
});
