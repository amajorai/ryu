import { afterAll, afterEach, expect, test } from "bun:test";
import {
	completeGithubInstallation,
	fetchDetail,
	fetchLikeCounts,
	previewPrivatePackageShareCode,
	startPurchase,
} from "./marketplace.ts";
import {
	catalogEnvelopeSchema,
	marketplaceKindSchema,
	ownedLicenseSchema,
	parseMarketplaceResponse,
	portablePackageEnvelopeSchema,
	pricingViewSchema,
	reviewsPageSchema,
} from "./marketplace-response-contracts.ts";
import {
	marketplaceDocumentSchema,
	marketplaceNonemptyStrings,
	marketplaceStringList,
} from "./marketplace-wire-values.ts";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
let response: ReturnType<typeof Response.json> = Response.json({});
interface ReceivedRequest {
	body: string;
	headers: Headers;
}
const received: ReceivedRequest[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		received.push({
			headers: new Headers(request.headers),
			body: await request.text(),
		});
		return response;
	},
});
function serve(value: Parameters<typeof Response.json>[0], status = 200) {
	response = Response.json(value, { status });
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			const url = new URL(
				input instanceof Request ? input.url : input.toString()
			);
			url.hostname = "127.0.0.1";
			url.port = String(server.port);
			url.protocol = "http:";
			return originalFetch(url, init);
		},
		{ preconnect: originalFetch.preconnect }
	);
}
afterEach(() => {
	globalThis.fetch = originalFetch;
	received.length = 0;
	if (originalStorage) {
		Object.defineProperty(globalThis, "localStorage", originalStorage);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
});
afterAll(() => {
	server.stop(true);
});
const card = {
	author: null,
	category: null,
	description: null,
	firstParty: false,
	iconUrl: null,
	id: "sample",
	installSource: null,
	kind: "plugin",
	name: "Sample",
	pricing: null,
	ratingAverage: 0,
	ratingCount: 0,
	version: "1.0",
};

test("catalog validates all declared fields and retains future JSON documents and identity", () => {
	const input = JSON.parse(
		'{"future":{"__proto__":{"retained":true}},"items":[]}'
	);
	input.items.push({ ...card, future: [{ version: 2 }], verified: false });
	const output = parseMarketplaceResponse(catalogEnvelopeSchema, input);
	expect(output).toBe(input);
	expect(JSON.stringify(output)).toBe(JSON.stringify(input));
	expect(
		catalogEnvelopeSchema.safeParse({
			items: [{ ...card, kind: "unpublished_kind" }],
		}).success
	).toBe(false);
	expect(
		catalogEnvelopeSchema.safeParse({ items: [{ ...card, ratingCount: "10" }] })
			.success
	).toBe(false);
	expect(
		catalogEnvelopeSchema.safeParse({
			items: [{ ...card, pricing: { amountMinor: 100 } }],
		}).success
	).toBe(false);
});
test("closed marketplace kinds include every published legacy kind", () => {
	expect(marketplaceKindSchema.options).toHaveLength(15);
	for (const kind of [
		"knowledge",
		"stack_template",
		"output_style",
		"language_pack",
		"bundle",
	]) {
		expect(marketplaceKindSchema.parse(kind) === kind).toBe(true);
	}
});
test("money, review, and installed-package codecs reject malformed nested owner fields", () => {
	expect(
		pricingViewSchema.safeParse({
			amountMinor: 100,
			currency: "usd",
			interval: "month",
			maxUpdates: null,
			model: "one_time",
			platformFeeBps: 500,
			sellerOrgId: "seller",
		}).success
	).toBe(true);
	expect(
		ownedLicenseSchema.safeParse({ id: "license", status: "active" }).success
	).toBe(false);
	expect(
		reviewsPageSchema.safeParse({ reviews: [{ id: "r", rating: "5" }] }).success
	).toBe(false);
	expect(
		portablePackageEnvelopeSchema.safeParse({
			package: {
				enabled: true,
				id: "p",
				installed_at_unix_ms: 1,
				kind: "plugin",
				package_digest: "digest",
				version: "1",
			},
		}).success
	).toBe(true);
	expect(
		portablePackageEnvelopeSchema.safeParse({ package: { enabled: "true" } })
			.success
	).toBe(false);
});
test("JSON metadata and two string-list normalization policies preserve their separate legacy behavior", () => {
	const value = JSON.parse(
		'{"__proto__":{"safe":true},"nested":[null,3,false]}'
	);
	expect(marketplaceDocumentSchema.parse(value)).toBe(value);
	expect(
		marketplaceDocumentSchema.safeParse({ invalid: undefined }).success
	).toBe(false);
	expect(marketplaceStringList(["", "  ", " x ", 3])).toEqual([" x "]);
	expect(marketplaceNonemptyStrings(["", "  ", " x ", 3])).toEqual([
		"  ",
		" x ",
	]);
});
test("purchase sends bearer, JSON content type, and idempotency headers through real HTTP", async () => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => "fixture-session" },
	});
	expect(localStorage.getItem("anything")).toBe("fixture-session");
	serve({
		url: "https://checkout.example/session",
		sessionId: "session",
		alreadyLicensed: false,
		license: null,
	});
	expect(
		(await startPurchase({ kind: "plugin", id: "sample" })).sessionId
	).toBe("session");
	const request = received[0];
	expect(request?.headers.get("authorization")).toBe("Bearer fixture-session");
	expect(request?.headers.get("content-type")).toBe("application/json");
	expect(request?.headers.get("idempotency-key")).toBeTruthy();
	expect(JSON.parse(request?.body ?? "null")).toEqual({
		kind: "plugin",
		id: "sample",
	});
});
test("detail normalization bounds and de-duplicates bundle members without losing future setup JSON", async () => {
	serve({
		id: "bundle",
		kind: "bundle",
		name: "Bundle",
		communityStats: { downloads: 4, runs: "invalid" },
		bundleMembers: [
			{ id: " plugin ", kind: "plugin", required: false },
			{ id: "plugin", kind: "plugin" },
			{ id: "bad", kind: "bundle" },
			{ id: "missing", kind: "future_kind" },
		],
		setup: { version: 1, connections: [] },
	});
	const result = await fetchDetail("bundle", "bundle");
	expect(result.bundleMembers).toEqual([
		{ id: "plugin", kind: "plugin", name: null, required: false, source: null },
	]);
	expect(result.communityStats).toEqual({
		downloads: 4,
		instances: 0,
		runs: 0,
	});
});
test("private preview accepts camel and snake aliases and validates the actual kind domain", async () => {
	serve({
		preview: {
			kind: " stack_template ",
			id: " package ",
			name: " Package ",
			version: " 1 ",
			verification: "verified",
			setup: {
				connections: [
					{ provider: "GitHub", id: "source", used_by: [" app ", "  "] },
				],
			},
		},
	});
	const preview = await previewPrivatePackageShareCode("ABCD12345678");
	expect(preview.kind).toBe("stack_template");
	expect(preview.id).toBe("package");
	expect(preview.connections[0]?.consumers).toEqual([" app "]);
	serve({ preview: { kind: "future_kind" } });
	await expect(
		previewPrivatePackageShareCode("ABCD12345678")
	).rejects.toThrow();
});
test("like counters retain numeric clamping and malformed row fallback", async () => {
	serve({
		likes: [
			{ namespace: "sample", count: -3, liked: true },
			{ count: "9", liked: 1 },
			null,
		],
	});
	expect(await fetchLikeCounts(["sample"])).toEqual([
		{ namespace: "sample", count: 0, liked: true },
		{ namespace: "", count: 0, liked: false },
		{ namespace: "", count: 0, liked: false },
	]);
});
test("pending GitHub installations retain their actionable domain error", async () => {
	serve({ ready: false, repository: "owner/repo", future: { pending: true } });
	await expect(
		completeGithubInstallation({ repository: "owner/repo", state: "state" })
	).rejects.toMatchObject({
		kind: "github",
		code: "github_installation_invalid",
		details: { ready: false, future: { pending: true } },
	});
});

test("JSON contracts validate prototype-named own values as data", () => {
	const invalid = Object.defineProperty({}, "__proto__", {
		enumerable: true,
		value: () => undefined,
	});
	expect(marketplaceDocumentSchema.safeParse(invalid).success).toBe(false);
	expect(() =>
		parseMarketplaceResponse(catalogEnvelopeSchema, {
			items: [],
			future: invalid,
		})
	).toThrow();
});
