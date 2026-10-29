import { afterAll, expect, test } from "bun:test";
import { regenerateConversationTitle } from "./conversation-flags.ts";

let status = 200;
interface RetitleResponseFixture {
	error?: string;
	title?: string;
}

let payload: RetitleResponseFixture = { title: " New title " };
const calls: {
	path: string;
	method: string;
	token: string | null;
	jwt: string | null;
}[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		calls.push({
			path: new URL(request.url).pathname,
			method: request.method,
			token: request.headers.get("authorization"),
			jwt: request.headers.get("x-ryu-user-jwt"),
		});
		return Response.json(payload, { status });
	},
});
afterAll(() => server.stop(true));
const target = {
	url: server.url.toString(),
	token: "fixture-node",
	userJwt: "fixture-user",
};
test("explicit auto-rename sends delegated identity and an encoded id, and returns the generated title", async () => {
	expect(await regenerateConversationTitle(target, "chat/a ?")).toBe(
		"New title"
	);
	expect(calls[0]).toEqual({
		path: "/api/conversations/chat%2Fa%20%3F/retitle",
		method: "POST",
		token: "Bearer fixture-node",
		jwt: "fixture-user",
	});
});
test("model failures and empty titles reject instead of replacing the current title", async () => {
	status = 422;
	payload = { error: "No title model available" };
	await expect(regenerateConversationTitle(target, "chat")).rejects.toThrow();
	status = 200;
	payload = { title: " " };
	await expect(regenerateConversationTitle(target, "chat")).rejects.toThrow(
		"No title was generated"
	);
});
