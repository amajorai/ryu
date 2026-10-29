import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
	GET,
	GUEST_UNAVAILABLE_MESSAGE,
	guestBucketKey,
	guestChatConfig,
	handleGuestChatPost,
	resetGuestChatLimits,
} from "./guest-route.ts";

const ENV: NodeJS.ProcessEnv = {
	NODE_ENV: "production",
	RYU_GUEST_CHAT_CLIENT_IP_HEADER: "cf-connecting-ip",
	RYU_GUEST_CHAT_GATEWAY_KEY: "rgw_guest_chat_test",
	RYU_GUEST_CHAT_GATEWAY_URL: "https://gateway.test/",
};
const upstreamRequestSchema = z.strictObject({
	model: z.string(),
	messages: z.tuple([
		z.object({ role: z.literal("system"), content: z.string() }),
		z.object({ role: z.literal("user"), content: z.string() }),
	]),
	max_tokens: z.literal(1200),
	stream: z.literal(true),
});
const errorSchema = z.object({ error: z.object({ message: z.string() }) });

interface Call {
	body: string;
	headers: Headers;
	url: string;
}

let calls: Call[];
let reply: () => Response;

function sse(...frames: string[]): Response {
	return new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function fetcher(url: string, init: RequestInit): Promise<Response> {
	calls.push({
		body: String(init.body),
		headers: new Headers(init.headers),
		url,
	});
	return reply();
}

function post(
	headers: Record<string, string> = {},
	body: string = JSON.stringify({ question: "What is Ryu?" })
): Request {
	return new Request("https://widget.example/api/assistant/guest", {
		body,
		headers: {
			"Content-Type": "application/json",
			"cf-connecting-ip": "198.51.100.10",
			Origin: "https://widget.example",
			...headers,
		},
		method: "POST",
	});
}

async function message(response: Response): Promise<string> {
	return errorSchema.parse(await response.json()).error.message;
}

beforeEach(() => {
	calls = [];
	reply = () => sse("[DONE]");
	resetGuestChatLimits();
});

afterEach(() => {
	resetGuestChatLimits();
});

describe("guest chat route", () => {
	test("reports availability without exposing any configuration", async () => {
		const saved = {
			key: process.env.RYU_GUEST_CHAT_GATEWAY_KEY,
			url: process.env.RYU_GUEST_CHAT_GATEWAY_URL,
		};
		try {
			process.env.RYU_GUEST_CHAT_GATEWAY_URL = "https://gateway.test";
			process.env.RYU_GUEST_CHAT_GATEWAY_KEY = "rgw_status";
			const on = GET();
			expect(await on.json()).toEqual({ available: true });
			expect(on.headers.get("cache-control")).toBe("no-store");
			process.env.RYU_GUEST_CHAT_GATEWAY_KEY = "sk-or-provider-key";
			expect(await GET().json()).toEqual({ available: false });
		} finally {
			for (const [name, value] of [
				["RYU_GUEST_CHAT_GATEWAY_KEY", saved.key],
				["RYU_GUEST_CHAT_GATEWAY_URL", saved.url],
			] as const) {
				if (value === undefined) {
					delete process.env[name];
				} else {
					process.env[name] = value;
				}
			}
		}
	});

	test("fails closed with a friendly notice when the Gateway is not configured", async () => {
		for (const env of [
			{ NODE_ENV: "production" },
			{ ...ENV, RYU_GUEST_CHAT_GATEWAY_KEY: "sk-provider" },
			{ ...ENV, RYU_GUEST_CHAT_GATEWAY_URL: "http://gateway.test" },
			{ ...ENV, RYU_GUEST_CHAT_CLIENT_IP_HEADER: undefined },
			{ ...ENV, RYU_GUEST_CHAT_CLIENT_IP_HEADER: "x-client-ip" },
		]) {
			expect(guestChatConfig(env)).toBeNull();
			const response = await handleGuestChatPost(post(), { env, fetcher });
			expect(response.status).toBe(503);
			expect(await message(response)).toBe(GUEST_UNAVAILABLE_MESSAGE);
		}
		expect(calls).toHaveLength(0);
	});

	test("allows an unnamed client header only outside production", () => {
		const development = guestChatConfig({
			...ENV,
			NODE_ENV: "development",
			RYU_GUEST_CHAT_CLIENT_IP_HEADER: undefined,
		});
		expect(development?.clientIpHeader).toBeNull();
		expect(guestChatConfig(ENV)?.clientIpHeader).toBe("cf-connecting-ip");
	});

	test("sends the turn to the hosted Gateway with an honest Ryu identity", async () => {
		const response = await handleGuestChatPost(post(), { env: ENV, fetcher });
		expect(response.status).toBe(200);
		await response.text();
		const [call] = calls;
		expect(call?.url).toBe("https://gateway.test/v1/chat/completions");
		expect(call?.headers.get("authorization")).toBe(
			"Bearer rgw_guest_chat_test"
		);
		expect(call?.headers.get("x-ryu-end-user")).toMatch(/^gc1\.[0-9a-f]{32}$/u);
		expect(call?.headers.get("user-agent")).toBeNull();
		for (const name of call?.headers.keys() ?? []) {
			expect(name.startsWith("x-opencode")).toBe(false);
		}
		const sent = upstreamRequestSchema.parse(JSON.parse(call?.body ?? ""));
		expect(sent.model).toBe("openrouter/free");
		expect(sent.messages[1]).toEqual({ content: "What is Ryu?", role: "user" });
		expect(JSON.stringify(call)).not.toContain("198.51.100.10");
	});

	test("never forwards the visitor's credentials", async () => {
		const secret = "visitor-session-7f3a";
		const response = await handleGuestChatPost(
			post({
				Authorization: `Bearer ${secret}`,
				Cookie: `better-auth.session_token=${secret}`,
				"X-Api-Key": secret,
			}),
			{ env: ENV, fetcher }
		);
		expect(response.status).toBe(200);
		const [call] = calls;
		expect(call?.headers.get("cookie")).toBeNull();
		expect(call?.headers.get("x-api-key")).toBeNull();
		expect(
			JSON.stringify([...(call?.headers ?? [])]) + call?.body
		).not.toContain(secret);
	});

	test("rejects cross-origin, missing-origin and cross-site requests", async () => {
		const refused = await Promise.all([
			handleGuestChatPost(post({ Origin: "https://attacker.example" }), {
				env: ENV,
				fetcher,
			}),
			handleGuestChatPost(post({ "Sec-Fetch-Site": "cross-site" }), {
				env: ENV,
				fetcher,
			}),
			handleGuestChatPost(
				new Request("https://widget.example/api/assistant/guest", {
					body: "{}",
					headers: { "Content-Type": "application/json" },
					method: "POST",
				}),
				{ env: ENV, fetcher }
			),
		]);
		expect(refused.map((response) => response.status)).toEqual([403, 403, 403]);
		expect(calls).toHaveLength(0);
	});

	test("uses the configured origin allowlist instead of the request host", async () => {
		const env = {
			...ENV,
			RYU_GUEST_CHAT_ALLOWED_ORIGINS: "https://docs.example, not a url",
		};
		const allowed = await handleGuestChatPost(
			post({ Origin: "https://docs.example" }),
			{ env, fetcher }
		);
		const hostOnly = await handleGuestChatPost(
			post({ "cf-connecting-ip": "198.51.100.11" }),
			{ env, fetcher }
		);
		expect(allowed.status).toBe(200);
		expect(hostOnly.status).toBe(403);
	});

	test("checks the public origin behind a forwarded Next.js host", async () => {
		const forwarded = new Request("http://0.0.0.0:3011/api/assistant/guest", {
			body: JSON.stringify({ question: "Hi" }),
			headers: {
				"Content-Type": "application/json",
				"cf-connecting-ip": "198.51.100.16",
				host: "0.0.0.0:3011",
				Origin: "https://widget.example",
				"x-forwarded-host": "widget.example",
				"x-forwarded-proto": "https",
			},
			method: "POST",
		});
		const response = await handleGuestChatPost(forwarded, {
			env: ENV,
			fetcher,
		});
		expect(response.status).toBe(200);
	});

	test("validates the prompt before contacting the Gateway", async () => {
		const statuses = await Promise.all(
			[
				post({ "Content-Type": "text/plain" }),
				post({}, "{not json"),
				post({}, JSON.stringify({ question: "   " })),
				post({}, JSON.stringify({ question: "x".repeat(4001) })),
				post({}, JSON.stringify({ question: "x".repeat(17 * 1024) })),
			].map(async (request) => {
				const response = await handleGuestChatPost(request, {
					env: ENV,
					fetcher,
				});
				return response.status;
			})
		);
		expect(statuses).toEqual([415, 400, 400, 400, 413]);
		expect(calls).toHaveLength(0);
	});

	test("refuses unattributed or spoofed client addresses instead of pooling them", async () => {
		const refused = [
			post({ "cf-connecting-ip": "" }),
			post({ "cf-connecting-ip": "unknown" }),
			post({ "cf-connecting-ip": "203.0.113.5, 198.51.100.7" }),
		];
		for (const request of refused) {
			const response = await handleGuestChatPost(request, {
				env: ENV,
				fetcher,
			});
			expect(response.status).toBe(503);
		}
		const unnamed = await handleGuestChatPost(post(), {
			env: { ...ENV, RYU_GUEST_CHAT_CLIENT_IP_HEADER: undefined },
			fetcher,
		});
		expect(unnamed.status).toBe(503);
		const wrongHeader = await handleGuestChatPost(
			post({ "cf-connecting-ip": "", "x-real-ip": "203.0.113.9" }),
			{ env: ENV, fetcher }
		);
		expect(wrongHeader.status).toBe(503);
		expect(calls).toHaveLength(0);
	});

	test("reads the right-most hop of x-forwarded-for when that header is named", async () => {
		const env = { ...ENV, RYU_GUEST_CHAT_CLIENT_IP_HEADER: "x-forwarded-for" };
		const response = await handleGuestChatPost(
			post({ "x-forwarded-for": "10.9.9.9, 203.0.113.44" }),
			{ env, fetcher }
		);
		expect(response.status).toBe(200);
		expect(guestBucketKey("2001:db8:1:2::1")).toBe(
			guestBucketKey("2001:db8:1:2:ffff::9")
		);
		expect(guestBucketKey("::ffff:203.0.113.9")).toBe("v4:203.0.113.9");
	});

	test("rate-limits each visitor after ten turns, and IPv6 by its /64", async () => {
		for (let count = 0; count < 10; count += 1) {
			const response = await handleGuestChatPost(
				post({ "cf-connecting-ip": `2001:db8:5:6::${count + 1}` }),
				{ env: ENV, fetcher }
			);
			expect(response.status).toBe(200);
		}
		const limited = await handleGuestChatPost(
			post({ "cf-connecting-ip": "2001:db8:5:6::ff" }),
			{ env: ENV, fetcher }
		);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBe("600");
		expect(calls).toHaveLength(10);
	});

	test("caps the whole process however requests are attributed", async () => {
		let last = new Response();
		for (let count = 0; count < 301; count += 1) {
			last = await handleGuestChatPost(
				post({
					"cf-connecting-ip": `198.18.${Math.floor(count / 200)}.${count % 200}`,
				}),
				{ env: ENV, fetcher }
			);
		}
		expect(last.status).toBe(429);
		expect(calls).toHaveLength(300);
	});

	test("re-emits only text deltas and hides mid-stream Gateway errors", async () => {
		reply = () =>
			sse(
				JSON.stringify({
					id: "gen-123",
					choices: [{ delta: { content: "Ryu", role: "assistant" } }],
					usage: { cost: 0.01 },
				}),
				JSON.stringify({
					error: {
						type: "policy_violation",
						code: "platform_floor",
						message: "Blocked: S4 lexicon match",
					},
				}),
				JSON.stringify({ choices: [{ delta: { content: "never" } }] })
			);
		const response = await handleGuestChatPost(post(), { env: ENV, fetcher });
		const text = await response.text();
		expect(text).toBe(
			[
				`data: ${JSON.stringify({ choices: [{ delta: { content: "Ryu" } }] })}`,
				`data: ${JSON.stringify({ error: { message: "Guest chat stopped before finishing this answer." } })}`,
				"data: [DONE]",
			]
				.map((frame) => `${frame}\n\n`)
				.join("")
		);
		expect(text).not.toContain("S4");
		expect(text).not.toContain("gen-123");
	});

	test("maps Gateway refusals to fixed messages", async () => {
		const cases: [() => Response, number, string, string | null][] = [
			[
				() =>
					Response.json(
						{
							error: {
								type: "policy_violation",
								code: "platform_floor",
								message: "S4",
							},
						},
						{ status: 403 }
					),
				403,
				"Guest chat can't help with that request. It only answers questions about Ryu.",
				null,
			],
			[
				() =>
					Response.json(
						{ error: { type: "policy_violation", code: "end_user_blocked" } },
						{ status: 403 }
					),
				403,
				"Guest chat is paused for this connection.",
				null,
			],
			[
				() =>
					Response.json(
						{ error: { message: "slow down" } },
						{ headers: { "Retry-After": "120" }, status: 429 }
					),
				429,
				"Guest chat is busy right now. Try again in a few minutes.",
				"120",
			],
			[
				() =>
					new Response("<html>OPENCODE_INTERNAL_KEY</html>", { status: 500 }),
				503,
				GUEST_UNAVAILABLE_MESSAGE,
				null,
			],
			[
				() => Response.json({ error: {} }, { status: 402 }),
				503,
				GUEST_UNAVAILABLE_MESSAGE,
				null,
			],
		];
		let index = 0;
		for (const [next, status, text, retryAfter] of cases) {
			reply = next;
			index += 1;
			const response = await handleGuestChatPost(
				post({ "cf-connecting-ip": `198.51.100.${100 + index}` }),
				{ env: ENV, fetcher }
			);
			expect(response.status).toBe(status);
			expect(response.headers.get("retry-after")).toBe(retryAfter);
			expect(await message(response)).toBe(text);
		}
	});

	test("reports credential-level Gateway blocks as the lane being unavailable", async () => {
		// Every guest shares the credential subject until the key is flagged as
		// serving end users, so a block on it is never "paused for this connection".
		let index = 0;
		for (const code of [
			"key_suspended_abuse",
			"principal_blocked",
			"user_banned",
			"org_suspended",
		]) {
			reply = () =>
				Response.json(
					{ error: { type: "policy_violation", code } },
					{ status: 403 }
				);
			index += 1;
			const response = await handleGuestChatPost(
				post({ "cf-connecting-ip": `198.51.100.${200 + index}` }),
				{ env: ENV, fetcher }
			);
			expect(response.status).toBe(503);
			expect(await message(response)).toBe(GUEST_UNAVAILABLE_MESSAGE);
		}
	});

	test("answers with a fixed message when the Gateway cannot be reached", async () => {
		const response = await handleGuestChatPost(post(), {
			env: ENV,
			fetcher: () => Promise.reject(new TypeError("fetch failed")),
		});
		expect(response.status).toBe(503);
		expect(await message(response)).toBe(GUEST_UNAVAILABLE_MESSAGE);
	});
});
