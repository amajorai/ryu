import { expect, test } from "bun:test";
import {
	createChatPageNativeHttpFixture,
	CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
} from "./chat-page-native-http.host.ts";
const origin = "http://owned-transition.test";
const id = "conversation-toolbar-share-fixture";
const old = {
	origin,
	authorization: "Bearer chat-page-native-node-a-token",
	"content-type": "application/json",
};
test("only observed exact retired background tuples receive tagged403; model room/history writes and arbitrary tuples remain strict unknown refusals", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
		port: 0,
		fetch: (req) => fixture.fetch(req, "a"),
	});
	const url = server.url.toString().replace(/\/$/, "");
	try {
		const request = (
			path: string,
			headers: Record<string, string> = old,
			method = "GET",
			body?: unknown,
		) =>
			fetch(url + path, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		const rotate = await fetch(url + "/__proof/control", {
			method: "POST",
			headers: {
				"x-chat-page-proof-control": "owned-local-fixture",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				action: "set_node_authority",
				node: "a",
				token: "current-token",
				userJwt: "current-jwt",
			}),
		});
		expect(rotate.status).toBe(200);
		expect(
			(await request("/api/models/context-window?model=model-proof-b")).status,
		).toBe(403);
		expect(
			(
				await request("/api/ws/ticket", old, "POST", {
					kind: "conversation",
					roomId: id,
					route: "realtime",
				})
			).status,
		).toBe(403);
		let snapshot = fixture.snapshot();
		expect(snapshot.unexpected).toEqual([]);
		expect(snapshot.transitionRefusals).toHaveLength(2);
		for (const call of snapshot.transitionRefusals) {
			expect(call).toMatchObject({
				authorization: old.authorization,
				userJwt: null,
				status: "refused",
				responseStatus: 403,
				transitionRefusal: "retired-background-authority",
			});
		}
		expect(
			(await request("/api/models/context-window?model=foreign")).status,
		).toBe(403);
		expect(
			(await request("/api/models/context-window?model=auto&extra=true"))
				.status,
		).toBe(403);
		expect(
			(
				await request("/api/models/context-window?model=auto", {
					...old,
					authorization: "Bearer arbitrary",
				})
			).status,
		).toBe(403);
		expect(
			(
				await request("/api/ws/ticket", old, "POST", {
					kind: "conversation",
					roomId: "foreign",
					route: "realtime",
				})
			).status,
		).toBe(403);
		const modelPath = `/api/conversations/${id}/model-selection`;
		expect((await request(modelPath)).status).toBe(403);
		expect(
			(
				await request(modelPath, old, "PUT", {
					changeId: "old",
					kind: "change",
					modelId: "model-proof-b",
				})
			).status,
		).toBe(403);
		snapshot = fixture.snapshot();
		expect(snapshot.unexpected).toHaveLength(6);
		expect(snapshot.transitionRefusals).toHaveLength(2);
		const current = {
			...old,
			authorization: "Bearer current-token",
			"x-ryu-user-jwt": "current-jwt",
		};
		expect(
			(await request("/api/models/context-window?model=model-proof-b", current))
				.status,
		).toBe(200);
		expect((await request(modelPath, current)).status).toBe(200);
		expect(fixture.snapshot().calls.at(-1)?.transitionRefusal).toBeUndefined();
		fixture.reset("share");
		expect(fixture.snapshot().transitionRefusals).toEqual([]);
		expect(
			(
				await request("/api/models/context-window?model=auto", {
					...old,
					"x-ryu-user-jwt": "current-jwt",
				})
			).status,
		).toBe(403);
		expect(fixture.snapshot().unexpected).toHaveLength(1);
	} finally {
		fixture.close();
		server.stop(true);
	}
});
