import { expect, test } from "bun:test";
import {
	createChatPageNativeHttpFixture,
	CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
} from "./chat-page-native-http.host.ts";
const origin = "http://owned-answer-now.test";
const id = "conversation-toolbar-share-fixture";
const turn = "chat-page-owned-reasoning-turn";
const headers = {
	origin,
	authorization: "Bearer chat-page-native-node-a-token",
	"content-type": "application/json",
};
test("real native HTTP Answer now refuses provider failure, accepts identical target retry, and finishes the same reasoning stream without cancellation", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
		port: 0,
		fetch: (req) => fixture.fetch(req, "a"),
	});
	const url = server.url.toString().replace(/\/$/, "");
	const control = (body: unknown) =>
		fetch(url + "/__proof/control", {
			method: "POST",
			headers: {
				"x-chat-page-proof-control": "owned-local-fixture",
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	const input = { action: "answer_now", conversation_id: id, turn_id: turn };
	try {
		expect(
			(
				await control({
					action: "arm_reasoning_chat",
					node: "a",
					conversationId: id,
				})
			).status,
		).toBe(200);
		const stream = await fetch(url + "/api/chat/stream", {
			method: "POST",
			headers,
			body: JSON.stringify({ conversation_id: id }),
		});
		const reader = stream.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain('"type":"reasoning-delta"');
		expect(first).toContain('"phase":"reasoning"');
		expect(first).toContain(turn);
		await control({
			action: "refuse_next",
			node: "a",
			method: "POST",
			path: "/api/chat/control",
			status: 502,
			message: "Owned provider refused Answer now.",
		});
		const refused = await fetch(url + "/api/chat/control", {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		});
		expect(refused.status).toBe(502);
		expect(await refused.json()).toEqual({
			error: "Owned provider refused Answer now.",
		});
		expect(fixture.snapshot().liveChats[0]).toMatchObject({
			answerNowAccepted: false,
			requestAborted: false,
			executionCancelled: false,
			networkClosed: false,
		});
		const retry = await fetch(url + "/api/chat/control", {
			method: "POST",
			headers,
			body: JSON.stringify(input),
		});
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({
			accepted: true,
			action: "answer_now",
			strategy: "native",
		});
		expect(
			fixture
				.snapshot()
				.calls.filter((c) => c.path === "/api/chat/control")
				.map((c) => c.rawBody),
		).toEqual([JSON.stringify(input), JSON.stringify(input)]);
		expect(
			(
				await fetch(url + "/api/chat/control", {
					method: "POST",
					headers,
					body: JSON.stringify(input),
				})
			).status,
		).toBe(409);
		expect(
			await (
				await control({
					action: "finish_reasoning_answer",
					node: "a",
					conversationId: id,
					turnId: turn,
				})
			).json(),
		).toEqual({ finished: true });
		const final = new TextDecoder().decode((await reader.read()).value);
		expect(final).toContain('"phase":"answering"');
		expect(final).toContain('"delta":"Owned native answer continued."');
		expect(final).toContain("data: [DONE]");
		expect((await reader.read()).done).toBe(true);
		expect(fixture.snapshot().liveChats[0]).toMatchObject({
			completed: true,
			answerNowAccepted: true,
			requestAborted: false,
			readerCancelled: false,
			executionCancelled: false,
			fixtureClosed: false,
		});
		expect(
			fixture.snapshot().calls.some((c) => c.path === "/api/chat/cancel"),
		).toBe(false);
		expect(fixture.snapshot().unexpected).toEqual([]);
	} finally {
		fixture.close();
		server.stop(true);
	}
});

test("native Answer now never accepts wrong authority or a stale turn, and refusal leaves the active stream recoverable", async () => {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
		port: 0,
		fetch: (req) => fixture.fetch(req, "a"),
	});
	const url = server.url.toString().replace(/\/$/, "");
	const request = (body: unknown, auth = headers.authorization) =>
		fetch(url + "/api/chat/control", {
			method: "POST",
			headers: { ...headers, authorization: auth },
			body: JSON.stringify(body),
		});
	try {
		expect(
			(
				await request({
					action: "answer_now",
					conversation_id: id,
					turn_id: turn,
				})
			).status,
		).toBe(404);
		const arm = await fetch(url + "/__proof/control", {
			method: "POST",
			headers: {
				"x-chat-page-proof-control": "owned-local-fixture",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				action: "arm_reasoning_chat",
				node: "a",
				conversationId: id,
			}),
		});
		expect(arm.status).toBe(200);
		const stream = await fetch(url + "/api/chat/stream", {
			method: "POST",
			headers,
			body: JSON.stringify({ conversation_id: id }),
		});
		await stream.body!.getReader().read();
		expect(
			(
				await request({
					action: "answer_now",
					conversation_id: id,
					turn_id: "old-turn",
				})
			).status,
		).toBe(404);

		expect(
			(
				await request(
					{ action: "answer_now", conversation_id: id, turn_id: turn },
					"Bearer foreign",
				)
			).status,
		).toBe(403);
		expect(
			(
				await request({
					action: "answer_now",
					conversation_id: "foreign",
					turn_id: turn,
				})
			).status,
		).toBe(400);
		expect(fixture.snapshot().liveChats[0]).toMatchObject({
			answerNowAccepted: false,
			requestAborted: false,
			executionCancelled: false,
			networkClosed: false,
		});
		expect(
			(
				await request({
					action: "answer_now",
					conversation_id: id,
					turn_id: turn,
				})
			).status,
		).toBe(200);
		expect(fixture.snapshot().liveChats[0]).toMatchObject({
			answerNowAccepted: true,
			requestAborted: false,
			executionCancelled: false,
			networkClosed: false,
		});
		expect(fixture.snapshot().unexpected).toHaveLength(2);
	} finally {
		fixture.close();
		server.stop(true);
	}
});
