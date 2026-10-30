import { describe, expect, test } from "bun:test";
import { Chat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { ChatSession, changesBeyondStreamedText } from "./ChatPage.session.ts";

const user: UIMessage = {
	id: "u1",
	role: "user",
	parts: [{ type: "text", text: "Hello" }],
};

function reply(parts: UIMessage["parts"], metadata?: unknown): UIMessage {
	return { id: "a1", role: "assistant", parts, metadata };
}

describe("changesBeyondStreamedText", () => {
	test("text growth in a streaming text or reasoning part is not a change", () => {
		const before = [
			user,
			reply([
				{ type: "reasoning", text: "Thinking", state: "streaming" },
				{ type: "text", text: "Hi", state: "streaming" },
			]),
		];
		const after = [
			user,
			reply([
				{ type: "reasoning", text: "Thinking harder", state: "streaming" },
				{ type: "text", text: "Hi there", state: "streaming" },
			]),
		];
		expect(changesBeyondStreamedText(before, after)).toBe(false);
	});

	test("shape, state, tool and metadata changes are changes", () => {
		const streaming = [
			user,
			reply([{ type: "text", text: "Hi", state: "streaming" }], { a: 1 }),
		];
		const cases: UIMessage[][] = [
			[user],
			[user, reply([{ type: "text", text: "Hi", state: "done" }], { a: 1 })],
			[
				user,
				reply(
					[
						{ type: "text", text: "Hi", state: "streaming" },
						{ type: "step-start" },
					],
					{ a: 1 }
				),
			],
			[
				user,
				reply([{ type: "text", text: "Hi", state: "streaming" }], { a: 2 }),
			],
			[
				{ ...user, parts: [{ type: "text", text: "Edited" }] },
				reply([{ type: "text", text: "Hi", state: "streaming" }], { a: 1 }),
			],
		];
		for (const next of cases) {
			expect(changesBeyondStreamedText(streaming, next)).toBe(true);
		}
		const tool = (input: unknown) =>
			[
				user,
				reply([
					{
						type: "dynamic-tool",
						toolName: "read",
						toolCallId: "t1",
						state: "input-streaming",
						input,
					},
				]),
			] as UIMessage[];
		expect(changesBeyondStreamedText(tool({ p: "a" }), tool({ p: "ab" }))).toBe(
			true
		);
		// The SDK clones metadata per snapshot: equal fields are not a change.
		expect(
			changesBeyondStreamedText([reply([], { a: 1 })], [reply([], { a: 1 })])
		).toBe(false);
	});
});

/** A transport whose single response stream the test writes chunk by chunk. */
function controlledTransport() {
	let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
	const transport: ChatTransport<UIMessage> = {
		sendMessages: () =>
			Promise.resolve(
				new ReadableStream<UIMessageChunk>({
					start(streamController) {
						controller = streamController;
					},
				})
			),
		reconnectToStream: () => Promise.resolve(null),
	};
	return {
		transport,
		write: (chunk: UIMessageChunk) => controller?.enqueue(chunk),
		end: () => controller?.close(),
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function lastText(messages: UIMessage[]) {
	const part = messages.at(-1)?.parts.at(-1);
	return part?.type === "text" ? part.text : null;
}

describe("ChatSession", () => {
	test("the page view skips text deltas; the live view and turn end do not", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "session-test", transport: stream.transport }),
			undefined
		);
		let pageUpdates = 0;
		let liveUpdates = 0;
		const offPage = session.subscribePage(() => {
			pageUpdates += 1;
		});
		const offLive = session.subscribeLive(() => {
			liveUpdates += 1;
		});
		const offStatus = session.subscribeStatus(() => undefined);
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		expect(session.getPageMessages()).toHaveLength(1);
		stream.write({ type: "start", messageId: "a1" });
		stream.write({ type: "text-start", id: "t" });
		stream.write({ type: "text-delta", id: "t", delta: "One" });
		await settle();
		const pageAtFirstText = pageUpdates;
		const liveAtFirstText = liveUpdates;
		// The page has the reply's text part, with the text it started with.
		const pageText = lastText(session.getPageMessages());
		expect(pageText).not.toBeNull();
		for (const word of [" two", " three", " four"]) {
			stream.write({ type: "text-delta", id: "t", delta: word });
			await settle();
		}
		expect(pageUpdates).toBe(pageAtFirstText);
		expect(liveUpdates).toBe(liveAtFirstText + 3);
		expect(lastText(session.getLiveMessages())).toBe("One two three four");
		expect(lastText(session.getPageMessages())).toBe(pageText);
		expect(pageText).not.toBe("One two three four");

		// Find in chat: the page follows the text again, at once.
		session.setFollowText(true);
		expect(lastText(session.getPageMessages())).toBe("One two three four");
		stream.write({ type: "text-delta", id: "t", delta: " five" });
		await settle();
		expect(lastText(session.getPageMessages())).toBe("One two three four five");
		session.setFollowText(false);

		stream.write({ type: "text-delta", id: "t", delta: " six" });
		stream.write({ type: "text-end", id: "t" });
		stream.write({ type: "finish" });
		stream.end();
		await sent;
		await settle();
		expect(session.getStatus()).toBe("ready");
		expect(session.getPageMessages()).toBe(session.getLiveMessages());
		expect(lastText(session.getPageMessages())).toBe(
			"One two three four five six"
		);
		offPage();
		offLive();
		offStatus();
	});

	test("a part that arrives mid-reply reaches the page, even after the reply was first pushed", async () => {
		const stream = controlledTransport();
		const session = new ChatSession(
			new Chat<UIMessage>({ id: "session-parts", transport: stream.transport }),
			undefined
		);
		let pageUpdates = 0;
		const offPage = session.subscribePage(() => {
			pageUpdates += 1;
		});
		const sent = session.chat.sendMessage({ text: "Hello" });
		await settle();
		// The SDK pushes its working message object here and then mutates it.
		stream.write({ type: "start", messageId: "a1" });
		await settle();
		stream.write({ type: "text-start", id: "t" });
		stream.write({ type: "text-delta", id: "t", delta: "One" });
		stream.write({ type: "text-delta", id: "t", delta: " two" });
		await settle();
		const beforePart = pageUpdates;
		stream.write({ type: "data-progress", data: { step: 1 } });
		await settle();
		expect(pageUpdates).toBe(beforePart + 1);
		expect(
			session
				.getPageMessages()
				.at(-1)
				?.parts.map((part) => part.type)
		).toEqual(["text", "data-progress"]);
		stream.write({ type: "finish" });
		stream.end();
		await sent;
		offPage();
	});
});
