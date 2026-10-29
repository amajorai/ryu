import { afterAll, beforeEach, expect, test } from "bun:test";
import {
	getConversationLearningExclusion,
	setConversationLearningExclusion,
} from "./learn.ts";

// A local Core stand-in proves the per-conversation "Exclude from learning"
// privacy toggle reaches the real `/api/learn/exclude` routes with the exact
// wire shape Core's serde expects, and that the reply is parsed, not trusted.
interface RecordedCall {
	body: unknown;
	method: string;
	path: string;
	token: string | null;
}

let status = 200;
let payload: unknown = {};
const calls: RecordedCall[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const text = await request.text();
		calls.push({
			body: text ? JSON.parse(text) : null,
			method: request.method,
			// The raw (still-encoded) path, so encoding is asserted, not normalised.
			path: request.url.slice(server.url.origin.length).split("?")[0] ?? "",
			token: request.headers.get("authorization"),
		});
		return Response.json(payload, { status });
	},
});
afterAll(() => server.stop(true));
beforeEach(() => {
	calls.length = 0;
	status = 200;
});

const target = { url: server.url.toString(), token: "fixture-node" };

test("excluding a chat POSTs {conversation_id, excluded} and returns the rows Core updated", async () => {
	payload = { conversation_id: "chat-1", excluded: true, rows_updated: 3 };
	const result = await setConversationLearningExclusion(target, "chat-1", true);
	expect(result).toMatchObject({
		conversation_id: "chat-1",
		excluded: true,
		rows_updated: 3,
	});
	expect(calls).toEqual([
		{
			body: { conversation_id: "chat-1", excluded: true },
			method: "POST",
			path: "/api/learn/exclude",
			token: "Bearer fixture-node",
		},
	]);
});

test("re-including a chat sends excluded=false rather than dropping the field", async () => {
	payload = { conversation_id: "chat-1", excluded: false, rows_updated: 0 };
	await setConversationLearningExclusion(target, "chat-1", false);
	expect(calls[0]?.body).toEqual({
		conversation_id: "chat-1",
		excluded: false,
	});
});

test("a reply without rows_updated is rejected instead of reporting a silent success", async () => {
	payload = { conversation_id: "chat-1", excluded: true };
	await expect(
		setConversationLearningExclusion(target, "chat-1", true)
	).rejects.toThrow();
});

test("a failing Core rejects the exclusion write so the row can roll back", async () => {
	status = 500;
	payload = { error: "store unavailable" };
	await expect(
		setConversationLearningExclusion(target, "chat-1", true)
	).rejects.toThrow();
});

test("reading a chat's exclusion GETs its encoded id and returns the stored flag", async () => {
	payload = { conversation_id: "chat/a ?", excluded: true };
	const result = await getConversationLearningExclusion(target, "chat/a ?");
	expect(result.excluded).toBe(true);
	expect(calls).toEqual([
		{
			body: null,
			method: "GET",
			path: "/api/learn/exclude/chat%2Fa%20%3F",
			token: "Bearer fixture-node",
		},
	]);
});

test("a malformed exclusion read rejects instead of defaulting to included", async () => {
	payload = { conversation_id: "chat-1", excluded: "yes" };
	await expect(
		getConversationLearningExclusion(target, "chat-1")
	).rejects.toThrow();
});
