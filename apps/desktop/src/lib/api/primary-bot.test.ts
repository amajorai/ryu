import { afterEach, expect, mock, test } from "bun:test";
import { useAppStore } from "@/src/store/useAppStore.ts";

let verifiedJwt: string | null = "verified-human-jwt";
let jwtPause: Promise<string | null> | null = null;
mock.module("@/src/lib/realtime/jwt.ts", () => ({
	getRealtimeJwt: async () => (jwtPause ? await jwtPause : verifiedJwt),
}));
const { getPrimaryBot, setPrimaryBot, capturePrimaryBotIdentity } =
	await import("./primary-bot.ts");
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	verifiedJwt = "verified-human-jwt";
	jwtPause = null;
	useAppStore.setState({ oidcUser: null });
});

test("Desktop primary reads and CAS writes attach verified caller identity", async () => {
	const calls: { path: string; headers: Headers; body: unknown }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		calls.push({
			path,
			headers: new Headers(init?.headers),
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Response.json({
			agentId: "scout",
			effectiveAgentId: "scout",
			revision: 2,
			source: "selected",
			unavailableReason: null,
		});
	}) as unknown as typeof fetch;
	const target = {
		url: "https://identity-primary.test",
		token: "node-admission-token",
		userJwt: null,
	};
	await getPrimaryBot(target);
	await setPrimaryBot(target, { agentId: "scout", expectedRevision: 1 });
	expect(calls.map((call) => call.path)).toEqual([
		"/api/primary-bot",
		"/api/primary-bot",
	]);
	expect(calls.map((call) => call.headers.get("x-ryu-user-jwt"))).toEqual([
		"verified-human-jwt",
		"verified-human-jwt",
	]);
	expect(calls.map((call) => call.headers.get("authorization"))).toEqual([
		"Bearer node-admission-token",
		"Bearer node-admission-token",
	]);
	expect(calls[1].body).toEqual({ agentId: "scout", expectedRevision: 1 });
});

test("signed-in JWT exchange failure cannot fall back to operator primary scope", async () => {
	verifiedJwt = null;
	useAppStore.setState({ oidcUser: { email: "signed-in@example.test" } });
	let requests = 0;
	globalThis.fetch = (async () => {
		requests += 1;
		return Response.json({});
	}) as unknown as typeof fetch;
	await expect(
		setPrimaryBot(
			{ url: "https://identity-primary.test", token: "node-token" },
			{ agentId: "scout", expectedRevision: 1 }
		)
	).rejects.toThrow("Reconnect your signed-in account");
	await expect(
		getPrimaryBot({ url: "https://identity-primary.test", token: "node-token" })
	).rejects.toThrow("Reconnect your signed-in account");
	expect(requests).toBe(0);
});

test("explicit anonymous local account keeps node-token access without a human JWT", async () => {
	verifiedJwt = null;
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	);
	const values = new Map([
		["ryu_session_token", "anonymous-session"],
		["ryu_active_user_id", "guest"],
		[
			"ryu_accounts",
			JSON.stringify([
				{
					userId: "guest",
					token: "anonymous-session",
					isAnonymous: true,
					email: "",
				},
			]),
		],
	]);
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: (key: string) => values.get(key) ?? null },
	});
	try {
		globalThis.fetch = (async () =>
			Response.json({
				agentId: null,
				effectiveAgentId: "ryu",
				revision: 0,
				source: "default",
				unavailableReason: null,
			})) as unknown as typeof fetch;
		expect(
			(
				await getPrimaryBot({
					url: "https://identity-primary.test",
					token: "node-token",
				})
			).effectiveAgentId
		).toBe("ryu");
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "localStorage", descriptor);
		} else {
			Reflect.deleteProperty(globalThis, "localStorage");
		}
	}
});

test("account changes during JWT acquisition stop primary mutation before fetch", async () => {
	useAppStore.setState({ oidcUser: { email: "account-a@example.test" } });
	let release: (value: string | null) => void = () => undefined;
	jwtPause = new Promise((resolve) => {
		release = resolve;
	});
	let requests = 0;
	globalThis.fetch = (async () => {
		requests += 1;
		return Response.json({});
	}) as unknown as typeof fetch;
	const pending = setPrimaryBot(
		{ url: "https://identity-primary.test", token: "node-token" },
		{ agentId: "scout", expectedRevision: 1 }
	);
	useAppStore.setState({ oidcUser: { email: "account-b@example.test" } });
	release("jwt-account-a");
	await expect(pending).rejects.toThrow("Your account changed");
	expect(requests).toBe(0);
});

test("a stale render identity cannot apply an earlier account's revision to a new account", async () => {
	useAppStore.setState({ oidcUser: { email: "account-a@example.test" } });
	const renderIdentity = capturePrimaryBotIdentity();
	useAppStore.setState({ oidcUser: { email: "account-b@example.test" } });
	let requests = 0;
	globalThis.fetch = (async () => {
		requests += 1;
		return Response.json({});
	}) as unknown as typeof fetch;
	await expect(
		setPrimaryBot(
			{ url: "https://identity-primary.test", token: "node-token" },
			{ agentId: "scout", expectedRevision: 1 },
			renderIdentity
		)
	).rejects.toThrow("Your account changed");
	expect(requests).toBe(0);
});
