import { afterAll, afterEach, expect, test } from "bun:test";
import { createChatPageNativeHttpFixture } from "./chat-page-native-http.host.ts";

const origin = "http://owned-browser.fixture";
const fixture = createChatPageNativeHttpFixture(origin);
const server: Bun.Server<undefined> = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request: Request) => fixture.fetch(request, "a"),
});
const id = "conversation-toolbar-share-fixture";
const headers = {
	Origin: origin,
	Authorization: "Bearer chat-page-native-node-a-token",
	"Content-Type": "application/json",
};
const controllers = new Set<AbortController>();
async function control(command: unknown) {
	return fetch(new URL("/__proof/control", server.url), {
		method: "POST",
		headers: {
			"x-chat-page-proof-control": "owned-local-fixture",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(command),
	});
}
async function until(predicate: () => boolean) {
	for (let i = 0; i < 100 && !predicate(); i++) {
		await Bun.sleep(5);
	}
	return predicate();
}
afterEach(() => {
	for (const controller of controllers) {
		controller.abort();
	}
	controllers.clear();
	fixture.reset("worktree-handoff");
});
afterAll(() => {
	fixture.close();
	server.stop(true);
});
test("genuine client SSE abort is observed independently from actual authenticated execution cancel", async () => {
	expect(
		(await control({ action: "arm_live_chat", node: "a", conversationId: id }))
			.status
	).toBe(200);
	const abort = new AbortController();
	controllers.add(abort);
	const response = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
		signal: abort.signal,
	});
	expect(response.status).toBe(200);
	expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
	const reader = response.body!.getReader();
	const chunk = await reader.read();
	expect(new TextDecoder().decode(chunk.value)).toContain(
		'"delta":"Owned live response in progress."'
	);
	expect(fixture.snapshot().liveChats[0]).toMatchObject({
		requestAborted: false,
		networkClosed: false,
		executionCancelled: false,
		fixtureClosed: false,
	});
	abort.abort();
	expect(
		await until(() => fixture.snapshot().liveChats[0]?.requestAborted === true)
	).toBe(true);
	expect(fixture.snapshot().liveChats[0]).toMatchObject({
		requestAborted: true,
		networkClosed: true,
		executionCancelled: false,
		fixtureClosed: false,
	});
	const cancelled = await fetch(new URL("/api/chat/cancel", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	expect(await cancelled.json()).toEqual({ cancelled: true });
	expect(fixture.snapshot().liveChats[0]).toMatchObject({
		requestAborted: true,
		executionCancelled: true,
		fixtureClosed: false,
	});
	expect(
		await (
			await fetch(new URL("/api/chat/cancel", server.url), {
				method: "POST",
				headers,
				body: JSON.stringify({ conversation_id: id }),
			})
		).json()
	).toEqual({ cancelled: false });
	expect(fixture.snapshot().unexpected).toEqual([]);
});
test("arming is consumed only by exact owned conversation and unarmed next turn remains honest503", async () => {
	const refused = await control({
		action: "arm_live_chat",
		node: "a",
		conversationId: "foreign-conversation",
	});
	expect(refused.status).toBe(409);
	const inactive = await fetch(new URL("/api/chat/cancel", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	expect(await inactive.json()).toEqual({ cancelled: false });
	const response = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	expect(response.status).toBe(503);
	expect(fixture.snapshot().liveChats).toEqual([]);
	expect(fixture.snapshot().unexpected).toEqual([]);
});
test("closing a live fixture is distinguished from a genuine client network abort", async () => {
	await control({ action: "arm_live_chat", node: "a", conversationId: id });
	const abort = new AbortController();
	controllers.add(abort);
	const response = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
		signal: abort.signal,
	});
	const reader = response.body!.getReader();
	await reader.read();
	fixture.close();
	expect(await reader.read()).toMatchObject({ done: true });
	expect(fixture.snapshot().liveChats[0]).toMatchObject({
		requestAborted: false,
		networkClosed: true,
		executionCancelled: false,
		fixtureClosed: true,
	});
});
test("finishing an ordinary live turn completes its SSE once, and only for the exact known conversation", async () => {
	expect(
		(
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: "foreign-conversation",
			})
		).status
	).toBe(409);
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: id,
			})
		).json()
	).toEqual({ finished: false });
	await control({ action: "arm_live_chat", node: "a", conversationId: id });
	const response = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = decoder.decode((await reader.read()).value);
	expect(text).toContain('"delta":"Owned live response in progress."');
	expect(fixture.snapshot().liveChats[0]).not.toHaveProperty("completed");
	// Another node's stream for the same conversation is not this turn.
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "b",
				conversationId: id,
			})
		).json()
	).toEqual({ finished: false });
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: id,
			})
		).json()
	).toEqual({ finished: true });
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		text += decoder.decode(chunk.value);
	}
	const events = text
		.split("\n\n")
		.filter(Boolean)
		.map((event) => event.replace(/^data: /, ""));
	const requestId = fixture.snapshot().liveChats[0]?.requestId;
	expect(events).toEqual([
		JSON.stringify({ type: "start", messageId: `live-${requestId}` }),
		JSON.stringify({ type: "text-start", id: "live-text" }),
		JSON.stringify({
			type: "text-delta",
			id: "live-text",
			delta: "Owned live response in progress.",
		}),
		JSON.stringify({ type: "text-end", id: "live-text" }),
		JSON.stringify({ type: "finish", finishReason: "stop" }),
		"[DONE]",
	]);
	expect(fixture.snapshot().liveChats).toEqual([
		expect.objectContaining({
			node: "a",
			conversationId: id,
			completed: true,
			requestAborted: false,
			readerCancelled: false,
			networkClosed: true,
			executionCancelled: false,
			fixtureClosed: false,
		}),
	]);
	// A finished turn cannot finish again, and finishing never arms a new one.
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: id,
			})
		).json()
	).toEqual({ finished: false });
	expect(
		(
			await fetch(new URL("/api/chat/stream", server.url), {
				method: "POST",
				headers,
				body: JSON.stringify({ conversation_id: id }),
			})
		).status
	).toBe(503);
	expect(fixture.snapshot().unexpected).toEqual([]);
});
test("a turn armed to suggest a task completes the tasks.suggest call before it answers, and a plain turn never does", async () => {
	await control({
		action: "arm_live_chat",
		node: "a",
		conversationId: id,
		suggestTask: true,
	});
	const response = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let text = decoder.decode((await reader.read()).value);
	// The call is complete while the turn is still open: the stream has not
	// finished and nothing after the answer's first delta has been sent.
	expect(fixture.snapshot().liveChats[0]).not.toHaveProperty("completed");
	expect(text).not.toContain('"type":"finish"');
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: id,
			})
		).json()
	).toEqual({ finished: true });
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		text += decoder.decode(chunk.value);
	}
	const events = text
		.split("\n\n")
		.filter(Boolean)
		.map((event) => event.replace(/^data: /, ""))
		.filter((event) => event !== "[DONE]")
		.map((event) => JSON.parse(event) as Record<string, unknown>);
	expect(events.map((event) => event.type)).toEqual([
		"start",
		"tool-input-available",
		"tool-output-available",
		"text-start",
		"text-delta",
		"text-end",
		"finish",
	]);
	expect(events[1]).toEqual({
		type: "tool-input-available",
		toolCallId: "suggest-call-live-fixture",
		toolName: "tasks.suggest",
		input: {
			description: "The cooldown copy is missing from the sign-in email.",
			prompt:
				"Add the cooldown wait time to the step-up email body and a test.",
			title: "Show the cooldown wait in the step-up email",
		},
	});
	// The next armed turn is plain again: the flag is consumed with the turn.
	await control({ action: "arm_live_chat", node: "a", conversationId: id });
	const plain = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	const plainText = decoder.decode(
		(await plain.body!.getReader().read()).value
	);
	expect(plainText).not.toContain("tasks.suggest");
});
test("a turn armed without an id is refused outside the new-chat scenarios and goes to the next stream on that computer, once", async () => {
	// A temporary chat's draft id is minted by the browser, so a scenario that
	// mints none has nothing to arm by.
	expect(
		(await control({ action: "arm_next_live_chat", node: "a" })).status
	).toBe(409);
	fixture.reset("task-suggestion-temporary");
	expect(
		(
			await control({
				action: "arm_next_live_chat",
				node: "a",
				suggestTask: true,
			})
		).status
	).toBe(200);
	const minted = "conv-1760000000001";
	const first = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: minted }),
	});
	expect(first.status).toBe(200);
	const reader = first.body!.getReader();
	const text = new TextDecoder().decode((await reader.read()).value);
	expect(text).toContain("tasks.suggest");
	expect(fixture.snapshot().liveChats).toHaveLength(1);
	expect(fixture.snapshot().liveChats[0]?.conversationId).toBe(minted);
	// Armed once: the next stream, under another id, is the honest 503 again.
	const second = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: "conv-1760000000002" }),
	});
	expect(second.status).toBe(503);
	expect(fixture.snapshot().liveChats).toHaveLength(1);
	await reader.cancel();
});
test("a minted conversation id can be finished only once a stream for it has started", async () => {
	fixture.reset("task-suggestion-temporary");
	const minted = "conv-1760000000003";
	// Nothing has been served under this id yet, so it is as foreign as any other.
	expect(
		(
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: minted,
			})
		).status
	).toBe(409);
	await control({ action: "arm_next_live_chat", node: "a" });
	const response = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: minted }),
	});
	const reader = response.body!.getReader();
	await reader.read();
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: minted,
			})
		).json()
	).toEqual({ finished: true });
	// Another id the browser never used is still refused.
	expect(
		(
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: "conv-1760000000004",
			})
		).status
	).toBe(409);
	await reader.cancel();
});
const resumeUrl = () => new URL(`/api/chat/stream/resume/${id}`, server.url);
async function readEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		text += decoder.decode(chunk.value);
	}
	return text
		.split("\n\n")
		.filter(Boolean)
		.map((event) => event.replace(/^data: /, ""))
		.filter((event) => event !== "[DONE]")
		.map((event) => JSON.parse(event) as Record<string, unknown>);
}
test("the resume route answers 404 until a running turn is armed, then replays that turn whole, once, and finishing it ends the stream", async () => {
	// Idle Core: the 404 the page probes for.
	const idle = await fetch(resumeUrl(), { headers });
	expect(idle.status).toBe(404);
	expect(await idle.json()).toEqual({ error: "no running turn" });
	// Only a conversation the scenario declares has a route that could serve it.
	expect(
		(
			await control({
				action: "arm_resumed_turn",
				node: "a",
				conversationId: "foreign-conversation",
			})
		).status
	).toBe(409);
	expect(
		(
			await control({
				action: "arm_resumed_turn",
				node: "a",
				conversationId: id,
				suggestTask: true,
			})
		).status
	).toBe(200);
	const served = await fetch(resumeUrl(), { headers });
	expect(served.status).toBe(200);
	// Core states that the replay is the whole turn, from its first chunk.
	expect(served.headers.get("x-ryu-resume-replay")).toBe("full");
	const reader = served.body!.getReader();
	const first = new TextDecoder().decode((await reader.read()).value);
	expect(first.startsWith('data: {"type":"start"')).toBe(true);
	expect(fixture.snapshot().liveChats).toHaveLength(1);
	expect(fixture.snapshot().liveChats[0]).toMatchObject({
		conversationId: id,
		node: "a",
		resumed: true,
		networkClosed: false,
	});
	expect(fixture.snapshot().liveChats[0]).not.toHaveProperty("completed");
	// Served once: a second probe while it runs is idle again, as it is after it ends.
	expect((await fetch(resumeUrl(), { headers })).status).toBe(404);
	expect(
		await (
			await control({
				action: "finish_live_chat",
				node: "a",
				conversationId: id,
			})
		).json()
	).toEqual({ finished: true });
	const events = await readEvents(reader);
	// The first read held the whole opening burst, so the rest is the ending.
	expect(events.map((event) => event.type)).toEqual(["text-end", "finish"]);
	expect(fixture.snapshot().liveChats[0]).toMatchObject({ completed: true });
	expect((await fetch(resumeUrl(), { headers })).status).toBe(404);
});
test("a resumed turn calls tasks.suggest only when armed to, and arming one does not make the next send a resumed turn", async () => {
	await control({ action: "arm_resumed_turn", node: "a", conversationId: id });
	const plain = await fetch(resumeUrl(), { headers });
	const reader = plain.body!.getReader();
	const opening = new TextDecoder().decode((await reader.read()).value);
	expect(opening).toContain('"delta":"Owned live response in progress."');
	expect(opening).not.toContain("tasks.suggest");
	await reader.cancel();
	// A resume armed for the tab to find is not a send's stream: the page's own
	// sends are still the honest 503 until a live turn is armed for them.
	await control({
		action: "arm_resumed_turn",
		node: "a",
		conversationId: id,
		suggestTask: true,
	});
	const send = await fetch(new URL("/api/chat/stream", server.url), {
		method: "POST",
		headers,
		body: JSON.stringify({ conversation_id: id }),
	});
	expect(send.status).toBe(503);
	expect(fixture.snapshot().liveChats).toHaveLength(1);
	const suggesting = await fetch(resumeUrl(), { headers });
	const suggestingReader = suggesting.body!.getReader();
	const suggestingOpening = new TextDecoder().decode(
		(await suggestingReader.read()).value
	);
	expect(suggestingOpening).toContain('"toolName":"tasks.suggest"');
	expect(fixture.snapshot().liveChats[1]).toMatchObject({ resumed: true });
	await suggestingReader.cancel();
});
