import { expect, test } from "bun:test";
import { createChatPageNativeHttpFixture } from "./chat-page-native-http.host.ts";
import { REACTION_MESSAGE_ID } from "./chat-page-native-http-reactions.ts";
const origin = "http://127.0.0.1:5590";
const conversation = "conversation-toolbar-share-fixture";
const list = `/api/conversations/${conversation}/reactions`;
const path = `/api/conversations/${conversation}/messages/${REACTION_MESSAGE_ID}/reactions`;
const headers = {
	origin,
	authorization: "Bearer chat-page-native-node-a-token",
	"content-type": "application/json",
};
async function withServer(
	run: (
		url: string,
		fixture: ReturnType<typeof createChatPageNativeHttpFixture>
	) => Promise<void>
) {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => fixture.fetch(req, "a"),
	});
	const url = `http://127.0.0.1:${server.port}`;
	try {
		await control(url, {
			action: "reset",
			scenario: "message-reactions-caller",
		});
		await run(url, fixture);
	} finally {
		fixture.close();
		server.stop(true);
	}
}
async function control(url: string, body: unknown) {
	const r = await fetch(url + "/__proof/control", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-chat-page-proof-control": "owned-local-fixture",
		},
		body: JSON.stringify(body),
	});
	expect(r.status).toBe(200);
}
const write = (url: string, method: string, body: unknown) =>
	fetch(url + path, { method, headers, body: JSON.stringify(body) });
test("native reaction fixture persists exact body, idempotent add, remove and independent bulk GET", () =>
	withServer(async (url, fixture) => {
		expect(await (await fetch(url + list, { headers })).json()).toEqual({
			reactions: [],
		});
		for (let i = 0; i < 2; i++)
			expect(await (await write(url, "POST", { emoji: "🎉" })).json()).toEqual({
				ok: true,
				message_id: REACTION_MESSAGE_ID,
				emoji: "🎉",
			});
		expect(await (await fetch(url + list, { headers })).json()).toEqual({
			reactions: [
				{
					message_id: REACTION_MESSAGE_ID,
					emoji: "🎉",
					count: 1,
					reacted_by_me: true,
				},
			],
		});
		expect((await write(url, "DELETE", { emoji: "🎉" })).status).toBe(200);
		expect(await (await fetch(url + list, { headers })).json()).toEqual({
			reactions: [],
		});
		expect(fixture.snapshot().unexpected).toEqual([]);
	}));
test("real held refused HTTP save cannot mutate reaction storage, and identical retry persists", () =>
	withServer(async (url, fixture) => {
		await control(url, {
			action: "hold_next",
			node: "a",
			method: "POST",
			path,
			status: 503,
		});
		const pending = write(url, "POST", { emoji: "👍" });
		await new Promise<void>((resolve, reject) => {
			let remaining = 100;
			const tick = () => {
				if (fixture.snapshot().heldRequestIds.length) resolve();
				else if (remaining-- > 0) setTimeout(tick, 1);
				else reject(new Error("HTTP hold not reached"));
			};
			tick();
		});
		expect(fixture.snapshot().reactions).toEqual({});
		const id = fixture.snapshot().heldRequestIds[0];
		if (id === undefined) throw new Error("missing held ID");
		await control(url, { action: "release", requestId: id, accept: false });
		expect((await pending).status).toBe(503);
		expect(await (await fetch(url + list, { headers })).json()).toEqual({
			reactions: [],
		});
		expect((await write(url, "POST", { emoji: "👍" })).status).toBe(200);
		expect(await (await fetch(url + list, { headers })).json()).toEqual({
			reactions: [
				{
					message_id: REACTION_MESSAGE_ID,
					emoji: "👍",
					count: 1,
					reacted_by_me: true,
				},
			],
		});
		expect(fixture.snapshot().unexpected).toEqual([]);
	}));
test("wrong message, unsupported method, spoofed actor and wrong auth remain refused in persistent ledger", () =>
	withServer(async (url, fixture) => {
		for (const [endpoint, method, body, auth] of [
			[
				path.replace(REACTION_MESSAGE_ID, "wrong-message"),
				"POST",
				{ emoji: "👍" },
				headers.authorization,
			],
			[path, "PUT", { emoji: "👍" }, headers.authorization],
			[path, "POST", { emoji: "👍", user_id: "other" }, headers.authorization],
			[path, "POST", { emoji: "👍" }, "Bearer wrong"],
		] as const) {
			expect(
				(
					await fetch(url + endpoint, {
						method,
						headers: { ...headers, authorization: auth },
						body: JSON.stringify(body),
					})
				).ok
			).toBe(false);
		}
		expect(fixture.snapshot().unexpected).toHaveLength(4);
		expect(fixture.snapshot().reactions).toEqual({});
	}));
