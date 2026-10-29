import { afterEach, expect, test } from "bun:test";
import {
	parseModelContext,
	useModelContextStore,
} from "@ryu/app-host/model-context";

const conversation = {
	agent_id: "fixture-agent",
	messages: [{ role: "assistant", content: "Earlier reply", parts: [] }],
};
const { sendChatBroadcastTurn } = await import("./chat-broadcast.ts");
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	useModelContextStore.setState({ entries: {} });
});

test("app messages deliver current scoped context with the user text and governed ticket", async () => {
	const sent: unknown[] = [];
	globalThis.fetch = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			if (!init?.body) {
				return Response.json(conversation);
			}
			sent.push(JSON.parse(String(init?.body)));
			return new Response("accepted");
		},
		{ preconnect: originalFetch.preconnect }
	);
	useModelContextStore.getState().update(
		"http://fixture:conv-1",
		"selected-app",
		parseModelContext({
			content: [
				{
					type: "text",
					text: "Selected hex bolt",
					_meta: { private: "never-send" },
				},
			],
			structuredContent: { part: "bolt" },
		})
	);
	useModelContextStore
		.getState()
		.update("http://fixture:another-conversation", "foreign-app", {
			content: [{ type: "text", text: "foreign selection" }],
		});
	await sendChatBroadcastTurn(
		{ url: "http://fixture", token: null },
		{
			conversationId: "conv-1",
			text: "Explain this part",
			widgetFollowUpTicket: "approved-ticket",
		}
	);
	expect(sent[0]).toMatchObject({
		conversation_id: "conv-1",
		agent_id: "fixture-agent",
		widget_follow_up_ticket: "approved-ticket",
	});
	const serialized = JSON.stringify(sent[0]);
	expect(serialized).toContain("Explain this part");
	expect(serialized).toContain("Earlier reply");
	expect(serialized).toContain("Selected hex bolt");
	expect(serialized).toContain("part");
	expect(serialized).not.toContain("never-send");
	expect(serialized).not.toContain("foreign selection");
});

test("broadcasts without attached app context preserve the existing text-only envelope", async () => {
	let sent: unknown;
	globalThis.fetch = Object.assign(
		async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			if (!init?.body) {
				return Response.json(conversation);
			}
			sent = JSON.parse(String(init?.body));
			return new Response("accepted");
		},
		{ preconnect: originalFetch.preconnect }
	);
	await sendChatBroadcastTurn(
		{ url: "http://fixture", token: null },
		{ conversationId: "conv-1", text: "Hello" }
	);
	expect(sent).toMatchObject({
		messages: [
			{ role: "assistant", content: "Earlier reply", parts: [] },
			{ role: "user", content: "Hello", parts: [] },
		],
	});
});
