import { expect, test } from "bun:test";
import { observeConversationMessageEvent } from "./conversation-message-event.ts";

const temporary = {
	type: "message",
	conversation_id: "conversation",
	message: {
		id: "m1",
		role: "user",
		content: "Hi",
		author_user_id: "human",
		created_at: 1,
		agent_id: null,
	},
} satisfies NonNullable<
	ReturnType<typeof observeConversationMessageEvent>
>["event"];
const appended = {
	...temporary,
	message: {
		...temporary.message,
		client_id: null,
		author_name: "Ada",
		source: null,
		widget_instance_id: null,
		origin_server: null,
		parts: [{ type: "text", text: "Hi", future: { data: [1, null] } }],
		metadata: { future: true },
	},
};

test("both complete native Core publishers are observed without losing raw future values", () => {
	for (const raw of [temporary, appended]) {
		const result = observeConversationMessageEvent(raw);
		expect(result?.raw).toBe(raw);
		expect(result?.event).toEqual(raw);
	}
	const raw = {
		...appended,
		future: ["value"],
		message: { ...appended.message, future: { untouched: true } },
	};
	const result = observeConversationMessageEvent(raw);
	expect(result?.event).toEqual(raw);
	expect(result?.raw).toBe(raw);
	expect(result?.event.message.parts).toBe(raw.message.parts);
	expect(result?.event.message.metadata).toBe(raw.message.metadata);
});

test("full raw JSON parts and metadata are not promoted to UIMessage fields", () => {
	for (const value of [
		null,
		false,
		0,
		"raw",
		[1, { future: true }],
		{ future: null },
	]) {
		const raw = {
			...appended,
			message: { ...appended.message, parts: value, metadata: value },
		};
		expect(observeConversationMessageEvent(raw)?.event.message.parts).toBe(
			value
		);
		expect(observeConversationMessageEvent(raw)?.event.message.metadata).toBe(
			value
		);
	}
});

test("nullable authors, open native roles, empty strings and full native timestamps are retained", () => {
	const raw = {
		...appended,
		message: {
			...appended.message,
			id: "",
			role: "future-role",
			content: "",
			author_user_id: null,
			author_name: null,
			client_id: "",
			created_at: -(2 ** 63),
		},
	};
	expect(observeConversationMessageEvent(raw)?.event).toEqual(raw);
});

test("malformed server or transport message cells are refused before chat insertion", () => {
	for (const message of [
		null,
		[],
		1,
		"message",
		{ ...appended.message, id: 1 },
		{ ...appended.message, content: [] },
		{ ...appended.message, author_user_id: {} },
		{ ...appended.message, author_name: {} },
		{ ...appended.message, client_id: false },
		{ ...appended.message, created_at: "1" },
		{ ...appended.message, source: [] },
	]) {
		expect(
			observeConversationMessageEvent({ ...appended, message })
		).toBeNull();
	}
	expect(
		observeConversationMessageEvent({ ...appended, type: "future-event" })
	).toBeNull();
});

test("raw own prototype-named fields remain available despite native parsed-copy normalization", () => {
	const raw = JSON.parse(
		'{"type":"message","conversation_id":"conversation","__proto__":{"future":true},"message":{"id":"m1","role":"user","content":"Hi","author_user_id":"human","created_at":1,"agent_id":null,"__proto__":{"future":"message"}}}'
	);
	const result = observeConversationMessageEvent(raw);
	expect(result).not.toBeNull();
	if (!result) {
		throw new Error("Expected complete native message publisher");
	}
	expect(result.raw).toBe(raw);
	expect(Object.hasOwn(raw, "__proto__")).toBe(true);
	expect(Object.hasOwn(raw.message, "__proto__")).toBe(true);
	expect(Object.hasOwn(result.event, "__proto__")).toBe(false);
	expect(Object.hasOwn(result.event.message, "__proto__")).toBe(false);
	expect(result.event.message.id).toBe("m1");
	expect(result.event.message.content).toBe("Hi");
});
