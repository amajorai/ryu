import { expect, test } from "bun:test";
import {
	CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
	createChatPageNativeHttpFixture,
} from "./chat-page-native-http.host.ts";

const origin = "http://127.0.0.1:5590";
const oldToken = "chat-page-native-node-a-token";
const background = "/api/background/processes?running_only=true";
async function own(
	run: (
		url: string,
		fixture: ReturnType<typeof createChatPageNativeHttpFixture>
	) => Promise<void>
) {
	const fixture = createChatPageNativeHttpFixture(origin);
	const server = Bun.serve({
		...CHAT_PAGE_NATIVE_HTTP_SERVER_OPTIONS,
		port: 0,
		fetch: (request) => fixture.fetch(request, "a"),
	});
	try {
		await run(`http://127.0.0.1:${server.port}`, fixture);
	} finally {
		fixture.close();
		server.stop(true);
	}
}
async function command(url: string, action: string) {
	const response = await fetch(`${url}/__proof/control`, {
		method: "POST",
		headers: {
			"x-chat-page-proof-control": "owned-local-fixture",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			action,
			node: "a",
			...(action === "set_node_authority"
				? { token: "rotated-owned-token", userJwt: "rotated-owned-jwt" }
				: {}),
		}),
	});
	// biome-ignore lint/suspicious/noMisplacedAssertion: every caller awaits this control helper inside its actual test.
	expect(response.status).toBe(200);
	return response.json();
}
const request = (
	url: string,
	path = background,
	token = oldToken,
	jwt: string | null = null,
	method = "GET"
) =>
	fetch(url + path, {
		method,
		headers: {
			origin,
			authorization: `Bearer ${token}`,
			...(jwt ? { "x-ryu-user-jwt": jwt } : {}),
		},
	});
test("bounded actual HTTP rotation denies exact captured background authority and preserves current authority success", async () =>
	own(async (url, fixture) => {
		await command(url, "begin_authority_rotation");
		await command(url, "set_node_authority");
		expect((await request(url)).status).toBe(403);
		expect(
			(
				await request(
					url,
					background,
					"rotated-owned-token",
					"rotated-owned-jwt"
				)
			).status
		).toBe(200);
		const completed = await command(url, "end_authority_rotation");
		expect(completed.denials).toHaveLength(1);
		expect(completed.denials[0]).toMatchObject({
			method: "GET",
			path: background,
			authorization: `Bearer ${oldToken}`,
			userJwt: null,
			status: "refused",
			responseStatus: 403,
			transitionRefusal: "bounded-authority-rotation",
		});
		expect(completed.denials[0].rotationDeniedAtMs).toBeGreaterThanOrEqual(
			completed.window.startedAtMs
		);
		expect(completed.denials[0].rotationDeniedAtMs).toBeLessThanOrEqual(
			completed.window.endedAtMs
		);
		expect(fixture.snapshot().unexpected).toEqual([]);
	}));
test("closed rotation cannot classify an old background read as expected", async () =>
	own(async (url, fixture) => {
		await command(url, "begin_authority_rotation");
		await command(url, "set_node_authority");
		await command(url, "end_authority_rotation");
		expect((await request(url)).status).toBe(403);
		expect(fixture.snapshot().unexpected).toHaveLength(1);
		expect(fixture.snapshot().calls[0]?.transitionRefusal).toBeUndefined();
	}));
test("open window refuses wrong tuple, extra query, model reads and writes as strict unexpected", async () =>
	own(async (url, fixture) => {
		await command(url, "begin_authority_rotation");
		await command(url, "set_node_authority");
		for (const [path, token, jwt, method] of [
			[background, "invented-token", null, "GET"],
			[background, oldToken, "invented-jwt", "GET"],
			[`${background}&invented=true`, oldToken, null, "GET"],
			[
				"/api/conversations/conversation-toolbar-share-fixture/model-selection",
				oldToken,
				null,
				"GET",
			],
			[background, oldToken, null, "POST"],
		] as const) {
			expect((await request(url, path, token, jwt, method)).status).toBe(403);
		}
		expect(fixture.snapshot().unexpected).toHaveLength(5);
		expect(
			fixture
				.snapshot()
				.calls.every((call) => call.transitionRefusal === undefined)
		).toBe(true);
		await command(url, "end_authority_rotation");
	}));
test("unclosed rotation expires after its fixed two-second deadline", async () =>
	own(async (url, fixture) => {
		await command(url, "begin_authority_rotation");
		await command(url, "set_node_authority");
		await new Promise((resolve) => setTimeout(resolve, 2050));
		expect((await request(url)).status).toBe(403);
		expect(fixture.snapshot().unexpected).toHaveLength(1);
		expect(fixture.snapshot().calls[0]?.transitionRefusal).toBeUndefined();
		await command(url, "end_authority_rotation");
	}));
