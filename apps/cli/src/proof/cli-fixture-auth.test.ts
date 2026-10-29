import { describe, expect, it } from "bun:test";
import { inspectCliFixtureRequest } from "./cli-fixture-auth.ts";
import type { FixtureJson } from "./cli-fixture-contract.ts";

const origin = "http://127.0.0.1:43127";
const token = "fixture-exact-node-secret";
const marker = { route: "chat", message: "hello fixture" };

function inspect(
	url = `${origin}/api/chat/stream`,
	headers: Record<string, string> = { authorization: `Bearer ${token}` },
	body: FixtureJson = marker
) {
	return inspectCliFixtureRequest(
		new Request(url, { method: "POST", headers }),
		origin,
		token,
		body
	);
}

describe("merged CLI fixture authority and safe request traces", () => {
	it("accepts only the exact fixture node authority and records its kind", () => {
		const result = inspect(`${origin}/api/chat/stream`, {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"x-ryu-surface": "cli",
		});

		expect(result.authorized).toBe(true);
		expect(result.trace.headers.authorizationKind).toBe("fixture-node");
		expect(result.trace.route).toBe("/api/chat/stream");
		expect(result.trace.headers.surface).toBe("cli");
		expect(result.trace.queryPresent).toBe(false);
	});

	it("allows the no-session identity warmup only on the exact fixture origin and route", () => {
		const result = inspectCliFixtureRequest(
			new Request(`${origin}/api/auth/user-jwt`, {
				headers: { authorization: `Bearer ${token}` },
			}),
			origin,
			token,
			null
		);

		expect(result.authorized).toBe(true);
		expect(result.trace).toMatchObject({
			method: "GET",
			route: "/api/auth/user-jwt",
			queryPresent: false,
			headers: { authorizationKind: "fixture-node" },
			body: { kind: "empty" },
		});
	});

	it.each([
		[
			"wrong bearer",
			`${origin}/api/chat/stream`,
			{ authorization: "Bearer fixture-other-node" },
		],
		["missing bearer", `${origin}/api/chat/stream`, {}],
		[
			"foreign authorization scheme",
			`${origin}/api/chat/stream`,
			{ authorization: "Basic c2VjcmV0" },
		],
		[
			"delegated user JWT",
			`${origin}/api/chat/stream`,
			{
				authorization: `Bearer ${token}`,
				"x-ryu-user-jwt": "foreign-user-jwt",
			},
		],
		[
			"buyer token",
			`${origin}/api/chat/stream`,
			{
				authorization: `Bearer ${token}`,
				"x-ryu-buyer-token": "foreign-buyer-token",
			},
		],
		[
			"foreign origin",
			"http://localhost:43127/api/chat/stream",
			{ authorization: `Bearer ${token}` },
		],
		[
			"query token",
			`${origin}/api/chat/stream?access_token=query-secret`,
			{ authorization: `Bearer ${token}` },
		],
	] as const)("refuses %s", (_name, url, headers) => {
		expect(inspect(url, headers).authorized).toBe(false);
	});

	it("projects only finite safe request fields, excluding arbitrary body, path, and header text", () => {
		const result = inspect(
			`${origin}/private-path-secret?access_token=query-secret&unknown=private-query`,
			{
				authorization: `Bearer ${token}`,
				"content-type": "application/json; private=content-type-secret",
				"x-ryu-surface": "surface-secret",
				"x-ryu-user-jwt": "user-jwt-secret",
				"x-ryu-buyer-token": "buyer-token-secret",
				"x-unknown-private-header": "unknown-header-secret",
			},
			{
				agent_id: "agent-reviewer",
				conversation_id: "conversation-secret",
				enable_long_term: false,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "advertise commands" }],
						privateNested: "nested-body-secret",
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "unlisted-body-secret" }],
					},
				],
				privateTopLevel: "top-level-body-secret",
			}
		);
		const serialized = JSON.stringify(result.trace);

		expect(result.authorized).toBe(false);
		expect(result.trace.route).toBe("other");
		expect(result.trace.queryPresent).toBe(true);
		expect(result.trace.headers.authorizationKind).toBe("fixture-node");
		expect(result.trace.headers.contentType).toBe("application/json");
		expect(result.trace.headers.surface).toBe("other");
		expect(result.trace.headers.userJwtPresent).toBe(true);
		expect(result.trace.headers.buyerTokenPresent).toBe(true);
		expect(result.trace.body.kind).toBe("review-agent-chat");
		expect(result.trace.body.conversationIdPresent).toBe(true);
		expect(result.trace.body.messages).toEqual([
			{ role: "user", text: "advertise commands" },
			{ role: "assistant", text: "other" },
		]);
		for (const secret of [
			token,
			"content-type-secret",
			"surface-secret",
			"user-jwt-secret",
			"buyer-token-secret",
			"unknown-header-secret",
			"query-secret",
			"private-query",
			"private-path-secret",
			"conversation-secret",
			"nested-body-secret",
			"unlisted-body-secret",
			"top-level-body-secret",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});
});
