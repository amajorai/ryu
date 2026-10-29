import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
} from "bun:test";
import {
	type AppJsonValue,
	appJsonValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { TOKEN_KEY, vaultHydrated } from "@/lib/auth-client.ts";
import {
	fetchSellerStatus,
	hasSellerAuth,
	SellerError,
	type SellerErrorKind,
	startOnboarding,
	toSellerError,
} from "./seller.ts";

interface SellerCall {
	authorization: string | null;
	body: AppJsonValue | null;
	method: string;
	path: string;
}
const calls: SellerCall[] = [];
let response: AppJsonValue = {};
let responseStatus = 200;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		calls.push({
			path,
			method: request.method,
			authorization: request.headers.get("authorization"),
			body:
				request.method === "POST"
					? appJsonValueSchema.parse(await request.json())
					: null,
		});
		return Response.json(response, { status: responseStatus });
	},
});
const nativeFetch = globalThis.fetch;
const storageDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
const values = new Map<string, string>();
const storage: Storage = {
	get length() {
		return values.size;
	},
	clear: () => values.clear(),
	getItem: (key) => values.get(key) ?? null,
	key: (index) => [...values.keys()][index] ?? null,
	removeItem: (key) => {
		values.delete(key);
	},
	setItem: (key, value) => {
		values.set(key, value);
	},
};
const route = (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
	const request = new Request(input, options);
	return nativeFetch(
		new URL(new URL(request.url).pathname, server.url),
		request
	);
};
// Importing auth-client starts vault hydration, which awaits the Tauri store
// before migrating any legacy session token it then finds in localStorage. If
// that lands after a test has stored a token, it fetches the account profile
// through this server and the stray get-session call leaks into a later test.
beforeAll(async () => {
	await vaultHydrated;
});
beforeEach(() => {
	calls.length = 0;
	values.clear();
	response = {};
	responseStatus = 200;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
	});
	globalThis.fetch = Object.assign(route, {
		preconnect: nativeFetch.preconnect,
	});
});
afterEach(() => {
	globalThis.fetch = nativeFetch;
	if (storageDescriptor) {
		Object.defineProperty(globalThis, "localStorage", storageDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});
afterAll(() => server.stop(true));
it("reads the full native seller reply with legacy field defaults and session auth", async () => {
	expect(hasSellerAuth()).toBe(false);
	storage.setItem(TOKEN_KEY, "seller-session");
	expect(hasSellerAuth()).toBe(true);
	response = {
		stripeConnectAccountId: "acct_1",
		payoutsEnabled: true,
		chargesEnabled: true,
		onboardingStatus: "active",
		stripeIdentityStatus: "verified",
		stripeIdentityVerifiedAt: "2026-10-06",
		future: { enabled: true },
	};
	expect(await fetchSellerStatus()).toEqual({
		stripeConnectAccountId: "acct_1",
		payoutsEnabled: true,
		onboardingStatus: "active",
		stripeIdentityStatus: "verified",
	});
	expect(calls[0]).toEqual({
		path: "/api/seller/status",
		method: "GET",
		authorization: "Bearer seller-session",
		body: null,
	});
	response = {};
	expect(await fetchSellerStatus()).toEqual({
		stripeConnectAccountId: null,
		payoutsEnabled: false,
		onboardingStatus: "none",
		stripeIdentityStatus: "none",
	});
	response = {
		payoutsEnabled: 1,
		onboardingStatus: null,
		stripeIdentityStatus: null,
	};
	expect((await fetchSellerStatus()).payoutsEnabled).toBe(true);
});
it("posts only onboarding input and preserves hosted URL/defaulted account fields", async () => {
	const onboardingReply = {
		accountId: "acct_1",
		created: true,
		url: "https://connect.stripe.test/session",
	};
	response = onboardingReply;
	const input = {
		country: "US",
		returnUrl: "https://ryu.test/return",
		refreshUrl: "https://ryu.test/refresh",
	};
	expect(await startOnboarding(input)).toEqual(onboardingReply);
	expect(calls[0]).toEqual({
		path: "/api/seller/onboard",
		method: "POST",
		authorization: null,
		body: input,
	});
	response = { url: "https://connect.stripe.test/legacy" };
	expect(await startOnboarding()).toEqual({
		accountId: "",
		created: false,
		url: "https://connect.stripe.test/legacy",
	});
});
it("classifies actual HTTP failures without losing message precedence", async () => {
	for (const [status, kind] of [
		[401, "auth"],
		[409, "no_org"],
		[403, "admin"],
		[502, "stripe"],
		[503, "stripe"],
		[404, "unknown"],
	] satisfies [number, SellerErrorKind][]) {
		responseStatus = status;
		response = { message: "primary", error: "fallback" };
		let caught: SellerError | null = null;
		try {
			await fetchSellerStatus();
		} catch (error) {
			caught = toSellerError(error);
		}
		expect(caught?.kind).toBe(kind);
		expect(caught?.message).toBe("primary");
		response = { error: "fallback" };
		await expect(startOnboarding()).rejects.toThrow("fallback");
	}
});
it("rejects malformed successful fields and missing onboarding URLs", async () => {
	const malformedStatusReplies: AppJsonValue[] = [
		null,
		[],
		{ stripeConnectAccountId: 4 },
		{ onboardingStatus: "invalid" },
	];
	for (const body of malformedStatusReplies) {
		response = body;
		await expect(fetchSellerStatus()).rejects.toThrow();
	}
	const missingUrlReplies: AppJsonValue[] = [{}, { url: null }, { url: "" }];
	for (const body of missingUrlReplies) {
		response = body;
		await expect(startOnboarding()).rejects.toThrow(
			"Onboarding session has no URL."
		);
	}
});
it("retains classified errors and honestly normalizes unexpected transport failures", () => {
	const classified = new SellerError("auth", "Sign in");
	expect(toSellerError(classified)).toBe(classified);
	const network = toSellerError(new Error("Network unavailable"));
	expect(network.kind).toBe("unknown");
	expect(network.message).toBe("Network unavailable");
	expect(toSellerError(null).kind).toBe("unknown");
});
