import { afterAll, afterEach, expect, test } from "bun:test";
import { createChatPageNativeHttpFixture } from "./chat-page-native-http.host.ts";
import {
	CONTEXT_PANEL_BREAKDOWN,
	CONTEXT_PANEL_STATS,
} from "./chat-page-native-http-context.ts";
const origin = "http://owned-context-browser.fixture";
const fixture = createChatPageNativeHttpFixture(origin);
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 0,
	fetch: (request: Request) => fixture.fetch(request, "a"),
});
const path = "/api/conversations/conversation-toolbar-share-fixture/context";
const headers = {
	Origin: origin,
	Authorization: "Bearer chat-page-native-node-a-token",
};
const read = (suffix = path, authority = headers) =>
	fetch(new URL(suffix, server.url), { headers: authority });
afterEach(() => fixture.reset("share"));
afterAll(() => {
	fixture.close();
	server.stop(true);
});
test("actual native HTTP context envelope and saved stats preserve Core camelCase contract", async () => {
	fixture.reset("context-breakdown-caller");
	const response = await read();
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ breakdown: CONTEXT_PANEL_BREAKDOWN });
	const history = await read(
		"/api/conversations/conversation-toolbar-share-fixture"
	);
	expect(history.status).toBe(200);
	expect(JSON.stringify(await history.json())).toContain(
		JSON.stringify(CONTEXT_PANEL_STATS)
	);
	expect(fixture.snapshot().unexpected).toEqual([]);
});
test("unset snapshot is null; one-shot real503 leaves owned snapshot intact for next physical GET", async () => {
	fixture.reset("context-breakdown-empty");
	expect(await (await read()).json()).toEqual({ breakdown: null });
	fixture.reset("context-breakdown-caller");
	await fetch(new URL("/__proof/control", server.url), {
		method: "POST",
		headers: {
			"x-chat-page-proof-control": "owned-local-fixture",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			action: "refuse_next",
			node: "a",
			method: "GET",
			path,
			status: 503,
			message: "Owned context read unavailable.",
		}),
	});
	expect((await read()).status).toBe(503);
	expect(await (await read()).json()).toEqual({
		breakdown: CONTEXT_PANEL_BREAKDOWN,
	});
	expect(fixture.snapshot().calls.map((call) => call.responseStatus)).toEqual([
		503, 200,
	]);
	expect(fixture.snapshot().unexpected).toEqual([]);
});
test("foreign conversation, query variant and invalid bearer remain refused rather than wildcard context success", async () => {
	fixture.reset("context-breakdown-caller");
	expect((await read("/api/conversations/foreign/context")).status).toBe(503);
	expect((await read(path + "?foreign=true")).status).toBe(503);
	expect(
		(await read(path, { ...headers, Authorization: "Bearer wrong" })).status
	).toBe(403);
	expect(fixture.snapshot().unexpected).toHaveLength(3);
	expect(
		fixture.snapshot().calls.every((call) => call.status === "refused")
	).toBe(true);
});
