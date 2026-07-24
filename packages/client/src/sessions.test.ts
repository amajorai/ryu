// packages/client/src/sessions.test.ts
//
// Tests for SessionsAPI: the ConversationWire → Conversation mapper via mocked
// list (wrapped in { conversations }) and get (unwrapped detail object), and the
// URL-encoding of the id path segment.

import { afterEach, describe, expect, test } from "bun:test";
import { SessionsAPI } from "./sessions.ts";
import type { RyuClientOptions } from "./types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const OPTIONS: RyuClientOptions = { baseUrl: "http://localhost:7980" };

describe("SessionsAPI.list", () => {
	test("maps snake_case conversations, defaulting nullables", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(
				Response.json({
					conversations: [
						{ id: "c1", agent_id: "pi", title: "T", created_at: "t0" },
						{ id: "c2" },
					],
				})
			)) as typeof fetch;
		const list = await new SessionsAPI(OPTIONS).list();
		expect(list[0]).toEqual({
			id: "c1",
			agentId: "pi",
			title: "T",
			createdAt: "t0",
			updatedAt: null,
		});
		expect(list[1]).toEqual({
			id: "c2",
			agentId: null,
			title: null,
			createdAt: null,
			updatedAt: null,
		});
	});

	test("returns [] when conversations is absent", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response("{}"))) as typeof fetch;
		expect(await new SessionsAPI(OPTIONS).list()).toEqual([]);
	});
});

describe("SessionsAPI.get", () => {
	test("maps the unwrapped detail object and encodes the id", async () => {
		let capturedUrl: string | undefined;
		globalThis.fetch = ((url: string) => {
			capturedUrl = url;
			return Promise.resolve(Response.json({ id: "a/b", title: "X" }));
		}) as typeof fetch;
		const conv = await new SessionsAPI(OPTIONS).get("a/b");
		expect(conv).toEqual({
			id: "a/b",
			agentId: null,
			title: "X",
			createdAt: null,
			updatedAt: null,
		});
		expect(capturedUrl).toBe("http://localhost:7980/api/conversations/a%2Fb");
	});
});
