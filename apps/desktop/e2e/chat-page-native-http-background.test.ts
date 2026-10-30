import { expect, test } from "bun:test";
import {
	CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
	createChatPageNativeHttpFixture,
} from "./chat-page-native-http.host.ts";

const origin = "http://127.0.0.1:5590";

test("Core's session-Box status answers 404 session_box_not_found for listed and browser-minted conversations", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
		port: 0,
		fetch: (request) => fixture.fetch(request, "a"),
	});
	try {
		for (const id of [
			"conversation-toolbar-share-fixture",
			"conv-1793255433522",
		]) {
			const response = await fetch(
				`http://127.0.0.1:${server.port}/api/session-boxes/${id}`,
				{
					headers: {
						origin,
						authorization: "Bearer chat-page-native-node-a-token",
					},
				}
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: {
					code: "session_box_not_found",
					message: "This conversation has no session Box.",
				},
			});
		}
		// Only the status read is Core's idle answer; Box actions stay refused.
		const screen = await fetch(
			`http://127.0.0.1:${server.port}/api/session-boxes/conv-1/screen`,
			{
				method: "POST",
				headers: {
					origin,
					authorization: "Bearer chat-page-native-node-a-token",
					"content-type": "application/json",
				},
				body: "{}",
			}
		);
		expect(screen.status).toBe(503);
		expect(fixture.snapshot().unexpected).toHaveLength(1);
	} finally {
		fixture.close();
		server.stop(true);
	}
});
