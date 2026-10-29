import { afterAll, afterEach, beforeEach, expect, it } from "bun:test";
import type { Entitlement } from "@ryu/auth/lib/plans";
import type { UpsellCard } from "@ryu/auth/lib/upsell";
import {
	type AppJsonValue,
	appJsonValueSchema,
} from "@ryuhq/core-client/app-request-json.ts";
import { TOKEN_KEY } from "@/lib/auth-client.ts";
import type { SubscriptionStatus } from "./billing.ts";
import {
	createCheckout,
	ensureTrialAnchorMs,
	fetchEntitlementSnapshot,
	fetchEntitlementStatus,
	validateLicenseKey,
} from "./billing.ts";
import {
	subscriptionStatusSchema,
	upsellCardsSchema,
} from "./billing-wire-contracts.ts";
import {
	fetchUpsellPitch,
	fetchUpsellState,
	markUpsellConverted,
	markUpsellShown,
} from "./upsell.ts";

interface BillingCall {
	authorization: string | null;
	body: AppJsonValue | null;
	method: string;
	path: string;
}
const calls: BillingCall[] = [];
const idempotencyKeys: string[] = [];
let response: AppJsonValue = {};
let responseStatus = 200;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		// The native identity client can refresh its session after module import.
		// Give that independent endpoint its real signed-out response.
		if (path === "/api/auth/get-session") {
			return Response.json(null);
		}
		const idempotencyKey = request.headers.get("idempotency-key");
		if (idempotencyKey) {
			idempotencyKeys.push(idempotencyKey);
		}
		const body = await request.text();
		calls.push({
			path,
			method: request.method,
			authorization: request.headers.get("authorization"),
			body: body ? appJsonValueSchema.parse(JSON.parse(body)) : null,
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
beforeEach(() => {
	calls.length = 0;
	idempotencyKeys.length = 0;
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
it("keeps signed-out checks separate from a successful un-entitled reply", async () => {
	expect(await fetchEntitlementSnapshot()).toBeNull();
	expect(await fetchEntitlementStatus()).toEqual({
		entitlement: null,
		plan: null,
		subscription: null,
	});
	expect(await ensureTrialAnchorMs()).toBeNull();
	expect(await fetchUpsellState()).toBeNull();
	expect(await fetchUpsellPitch()).toEqual([]);
	await markUpsellShown(["investment"]);
	await expect(createCheckout("pro-monthly")).rejects.toThrow("Sign in");
	await expect(validateLicenseKey("key")).rejects.toThrow("Sign in");
	expect(calls).toEqual([]);
	storage.setItem(TOKEN_KEY, "billing-session");
	expect(await fetchEntitlementSnapshot()).toEqual({
		entitlement: null,
		features: null,
		lifetime: null,
	});
});
it("retains complete financial metadata and an expired update window without revoking a license", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	const entitlement = {
		desktopAccess: true,
		managedInference: false,
		marketplaceApps: false,
		monthlyCreditPoolMicroUsd: 0,
		plan: "desktop-license",
		seats: 1,
	} satisfies Entitlement;
	const lifetime = {
		purchasedAt: "2020-01-01T00:00:00Z",
		updatesExpiresAt: "2021-01-01T00:00:00Z",
		expired: true,
	};
	const statusReply = {
		entitlement,
		lifetime,
		features: { preview: true },
		plan: "desktop-license",
		scope: "user",
		organizationId: null,
		seats: 1,
		subscription: null,
		future: { ledgerRevision: 4 },
	} satisfies SubscriptionStatus & { future: { ledgerRevision: number } };
	response = statusReply;
	expect(await fetchEntitlementSnapshot()).toEqual({
		entitlement,
		lifetime,
		features: { preview: true },
		organizationId: null,
	});
	expect(await fetchEntitlementStatus()).toEqual(statusReply);
	expect(calls[0]).toEqual({
		path: "/api/billing/subscription-status",
		method: "GET",
		authorization: "Bearer billing-session",
		body: null,
	});
	const decoded = subscriptionStatusSchema.parse(response);
	expect(decoded).toBe(response);
	expect(decoded.entitlement).toBe(entitlement);
	expect(decoded.lifetime).toBe(lifetime);
	const withOwnKey = appJsonValueSchema.parse(
		JSON.parse(
			'{"features":{"__proto__":true},"future":{"__proto__":{"retained":true}}}'
		)
	);
	expect(
		Object.is(subscriptionStatusSchema.parse(withOwnKey), withOwnKey)
	).toBe(true);
	expect(
		subscriptionStatusSchema.safeParse(
			JSON.parse('{"features":{"__proto__":"invalid"}}')
		).success
	).toBe(false);
});
it("treats outages and malformed successful gates as failed checks, preserving older omitted fields", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	responseStatus = 503;
	expect(await fetchEntitlementSnapshot()).toBeNull();
	await expect(fetchEntitlementStatus()).rejects.toThrow("503");
	responseStatus = 200;
	response = { features: null, entitlement: null, lifetime: null };
	expect(await fetchEntitlementSnapshot()).toEqual({
		features: null,
		entitlement: null,
		lifetime: null,
	});
	response = { entitlement: { desktopAccess: "yes" } };
	expect(await fetchEntitlementSnapshot()).toBeNull();
	await expect(fetchEntitlementStatus()).rejects.toThrow();
});
it("keeps checkout input/auth and a fresh idempotency key on each attempt", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	response = { url: "https://checkout.test/session" };
	expect(await createCheckout("max-yearly")).toBe(
		"https://checkout.test/session"
	);
	expect(await createCheckout("max-yearly")).toBe(
		"https://checkout.test/session"
	);
	expect(idempotencyKeys).toHaveLength(2);
	expect(idempotencyKeys[0]).not.toBe(idempotencyKeys[1]);
	expect(idempotencyKeys[0]).toMatch(
		/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/
	);
	expect(calls[0]).toEqual({
		path: "/api/billing/checkout",
		method: "POST",
		authorization: "Bearer billing-session",
		body: { slug: "max-yearly" },
	});
	response = {};
	await expect(createCheckout("max-yearly")).rejects.toThrow(
		"did not return a URL"
	);
	responseStatus = 401;
	await expect(createCheckout("max-yearly")).rejects.toThrow("Sign in");
	responseStatus = 503;
	await expect(createCheckout("max-yearly")).rejects.toThrow("not available");
});
it("posts the trial anchor and retains missing/invalid timestamp fallback", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	response = { firstLaunchAt: "2026-10-06T00:00:00Z" };
	expect(await ensureTrialAnchorMs()).toBe(Date.parse("2026-10-06T00:00:00Z"));
	expect(calls[0]?.method).toBe("POST");
	expect(calls[0]?.body).toBeNull();
	response = {};
	expect(await ensureTrialAnchorMs()).toBeNull();
	response = { firstLaunchAt: "not-a-date" };
	expect(await ensureTrialAnchorMs()).toBeNull();
});
it("validates the complete license reply and keeps future Polar status strings", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	const licenseReply = {
		active: true,
		expiresAt: null,
		productId: "product",
		status: "future-granted",
		future: { audited: true },
	};
	response = licenseReply;
	expect(await validateLicenseKey("license")).toEqual(licenseReply);
	expect(calls[0]?.body).toEqual({ key: "license" });
	response = { active: true, expiresAt: null, productId: null };
	await expect(validateLicenseKey("license")).rejects.toThrow();
	responseStatus = 503;
	await expect(validateLicenseKey("license")).rejects.toThrow("not available");
});
it("distinguishes never shown from failed cadence checks across native timestamps", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	response = { lastUpsellShownAt: 0 };
	expect(await fetchUpsellState()).toEqual({ lastUpsellShownAtMs: 0 });
	response = { lastUpsellShownAt: "2026-10-06T00:00:00Z" };
	expect(await fetchUpsellState()).toEqual({
		lastUpsellShownAtMs: Date.parse("2026-10-06T00:00:00Z"),
	});
	response = { lastUpsellShownAt: "invalid" };
	expect(await fetchUpsellState()).toEqual({ lastUpsellShownAtMs: null });
	response = {};
	expect(await fetchUpsellState()).toEqual({ lastUpsellShownAtMs: null });
	responseStatus = 503;
	expect(await fetchUpsellState()).toBeNull();
});
it("retains whole ranked cards and supports both legacy bare and enveloped arrays", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	const card = {
		id: "future-card",
		headline: "Your usage",
		lever: "investment",
		metric: "future-metric",
		subtext: "Upgrade",
		value: 12,
		future: { weight: 0.5 },
	} satisfies UpsellCard & { future: { weight: number } };
	const cards = [card];
	response = { cards };
	expect(await fetchUpsellPitch()).toEqual(cards);
	response = cards;
	expect(await fetchUpsellPitch()).toEqual(cards);
	expect(upsellCardsSchema.parse(cards)).toBe(cards);
	response = { cards: [{ id: "malformed" }] };
	expect(await fetchUpsellPitch()).toEqual([]);
	response = {};
	expect(await fetchUpsellPitch()).toEqual([]);
});
it("keeps shown and click-through events distinct and best effort on HTTP failures", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	responseStatus = 503;
	await markUpsellShown(["one", "two"]);
	await markUpsellConverted(["two"]);
	expect(calls).toEqual([
		{
			path: "/api/upsell/shown",
			method: "POST",
			authorization: "Bearer billing-session",
			body: { cardIds: ["one", "two"] },
		},
		{
			path: "/api/upsell/converted",
			method: "POST",
			authorization: "Bearer billing-session",
			body: { cardIds: ["two"] },
		},
	]);
});
it("preserves network-failure classification and best-effort marketing events", async () => {
	storage.setItem(TOKEN_KEY, "billing-session");
	globalThis.fetch = Object.assign(
		async () => {
			throw new Error("offline");
		},
		{ preconnect: nativeFetch.preconnect }
	);
	expect(await fetchEntitlementSnapshot()).toBeNull();
	expect(await ensureTrialAnchorMs()).toBeNull();
	await expect(createCheckout("pro-monthly")).rejects.toThrow(
		"Could not reach the checkout server"
	);
	await expect(validateLicenseKey("key")).rejects.toThrow(
		"Could not reach the license server"
	);
	expect(await fetchUpsellState()).toBeNull();
	expect(await fetchUpsellPitch()).toEqual([]);
	await expect(markUpsellShown(["one"])).resolves.toBeUndefined();
	await expect(markUpsellConverted(["one"])).resolves.toBeUndefined();
});
