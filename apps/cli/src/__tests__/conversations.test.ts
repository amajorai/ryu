import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	deleteConversation,
	forkConversation,
	renameConversation,
	resumeConversation,
	setConversationPinned,
} from "../core/conversations.ts";

const target: ApiTarget = { url: "http://node:7980", token: "node-secret" };
const realFetch = globalThis.fetch;
const servers: ReturnType<typeof Bun.serve>[] = [];
type ResponseProvider = (
	...args: Parameters<typeof realFetch>
) => Response | Promise<Response>;

function installResponse(provide: ResponseProvider): void {
	const pending = new Map<string, () => Response | Promise<Response>>();
	let nextRequestId = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const id = request.headers.get("x-ryu-fixture-request") ?? "";
			const respond = pending.get(id);
			pending.delete(id);
			if (!respond) {
				throw new Error("Unexpected conversation fixture request");
			}
			return respond();
		},
	});
	servers.push(server);
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof realFetch>[0],
			init?: Parameters<typeof realFetch>[1]
		) => {
			const request = new Request(input, init);
			const id = String(nextRequestId++);
			pending.set(id, () => provide(input, init));
			const destination = new URL(request.url);
			destination.host = server.url.host;
			destination.protocol = server.url.protocol;
			const forwarded = new Request(destination, request);
			forwarded.headers.set("x-ryu-fixture-request", id);
			return realFetch(forwarded).finally(() => pending.delete(id));
		},
		{ preconnect: realFetch.preconnect }
	);
}

afterEach(() => {
	globalThis.fetch = realFetch;
	for (const server of servers.splice(0)) {
		server.stop(true);
	}
});

test("forks a whole conversation without inventing a request body", async () => {
	let url = "";
	let init: RequestInit | undefined;
	installResponse((requestUrl, requestInit) => {
		url = String(requestUrl);
		init = requestInit;
		return Promise.resolve(
			new Response(JSON.stringify({ conversation: { id: "forked-1" } }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			})
		);
	});

	await expect(forkConversation(target, "conversation/1")).resolves.toBe(
		"forked-1"
	);
	expect(url).toBe("http://node:7980/api/conversations/conversation%2F1/fork");
	expect(init?.method).toBe("POST");
	expect(init?.body).toBeUndefined();
	expect(new Headers(init?.headers).get("Authorization")).toBe(
		"Bearer node-secret"
	);
});

test("sends an optional message id when forking from a branch point", async () => {
	let body = "";
	installResponse((_url, init) => {
		body = String(init?.body);
		return Promise.resolve(
			new Response(JSON.stringify({ conversation: { id: "forked-2" } }), {
				status: 201,
			})
		);
	});

	await expect(
		forkConversation(target, "conversation-1", "message-7")
	).resolves.toBe("forked-2");
	expect(JSON.parse(body)).toEqual({ message_id: "message-7" });
});

test("rejects unsuccessful responses and malformed fork results", async () => {
	installResponse(() => Promise.resolve(new Response("", { status: 404 })));
	await expect(forkConversation(target, "conversation-1")).rejects.toThrow(
		"Fork conversation failed: 404"
	);

	installResponse(() =>
		Promise.resolve(
			new Response(JSON.stringify({ conversation: {} }), { status: 201 })
		)
	);
	await expect(forkConversation(target, "conversation-1")).rejects.toThrow(
		"Fork conversation returned no conversation id"
	);
});

test("sets the server-backed pinned state", async () => {
	let url = "";
	let init: RequestInit | undefined;
	installResponse((requestUrl, requestInit) => {
		url = String(requestUrl);
		init = requestInit;
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);
	});

	await expect(
		setConversationPinned(target, "conversation/1", true)
	).resolves.toBeUndefined();
	expect(url).toBe(
		"http://node:7980/api/conversations/conversation%2F1/pinned"
	);
	expect(init?.method).toBe("POST");
	expect(JSON.parse(String(init?.body))).toEqual({ value: true });
	expect(new Headers(init?.headers).get("Content-Type")).toBe(
		"application/json"
	);
});

test("reports pinning failures", async () => {
	installResponse(() => Promise.resolve(new Response("", { status: 404 })));
	await expect(
		setConversationPinned(target, "conversation-1", false)
	).rejects.toThrow("Unpin conversation failed: 404");
});

test("resumes a conversation and preserves structured message parts", async () => {
	let url = "";
	installResponse((requestUrl) => {
		url = String(requestUrl);
		return Promise.resolve(
			new Response(
				JSON.stringify({
					id: "conversation-1",
					title: "Saved chat",
					messages: [
						{ id: "m1", role: "user", content: "hello" },
						{
							id: "m2",
							role: "assistant",
							content: "hi",
							parts: [{ type: "text", text: "hi" }],
						},
					],
				}),
				{ status: 200 }
			)
		);
	});

	await expect(resumeConversation(target, "conversation/1")).resolves.toEqual({
		id: "conversation-1",
		title: "Saved chat",
		messages: [
			{ id: "m1", role: "user", content: "hello", parts: undefined },
			{
				id: "m2",
				role: "assistant",
				content: "hi",
				parts: [{ type: "text", text: "hi" }],
			},
		],
	});
	expect(url).toBe("http://node:7980/api/conversations/conversation%2F1");
});

test("renames with a trimmed title and rejects blank titles", async () => {
	let body = "";
	installResponse((_url, init) => {
		body = String(init?.body);
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true, title: "New title" }), {
				status: 200,
			})
		);
	});

	await expect(
		renameConversation(target, "conversation-1", "  New title ")
	).resolves.toBe("New title");
	expect(JSON.parse(body)).toEqual({ title: "New title" });
	await expect(
		renameConversation(target, "conversation-1", "   ")
	).rejects.toThrow("Conversation title must not be empty");
});

test("deletes a conversation and reports Core failures", async () => {
	let method = "";
	installResponse((_url, init) => {
		method = String(init?.method);
		return Promise.resolve(
			new Response(JSON.stringify({ success: true, removed: true }), {
				status: 200,
			})
		);
	});
	await expect(deleteConversation(target, "conversation-1")).resolves.toBe(
		true
	);
	expect(method).toBe("DELETE");

	installResponse(() => Promise.resolve(new Response("", { status: 403 })));
	await expect(deleteConversation(target, "conversation-1")).rejects.toThrow(
		"Delete conversation failed: 403"
	);
});
