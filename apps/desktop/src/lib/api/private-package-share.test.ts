import { expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	forgetRedeemedPrivatePackageShareSession,
	formatPrivatePackageShareCode,
	normalizePrivatePackageShareCode,
	peekRedeemedPrivatePackageShareSession,
	previewPrivatePackageShareCode,
	redeemPrivatePackageShareCode,
} from "./marketplace.ts";

test("normalizes private package codes entered with spaces or hyphens", () => {
	expect(normalizePrivatePackageShareCode("7k4m-x2qp-9f6d")).toBe(
		"7K4MX2QP9F6D"
	);
	expect(formatPrivatePackageShareCode("7K4MX2QP9F6D")).toBe("7K4M-X2QP-9F6D");
});

test("keeps incomplete codes readable while the user is typing", () => {
	expect(formatPrivatePackageShareCode("7K4M")).toBe("7K4M");
	expect(formatPrivatePackageShareCode("7K4MX2")).toBe("7K4M-X2");
});

test("reads the safe listing envelope and install session wire aliases", async () => {
	const originalFetch = globalThis.fetch;
	let call = 0;
	globalThis.fetch = createFetchFixture(originalFetch, async () => {
		call += 1;
		return Response.json(
			call === 1
				? {
						audience: "shareable",
						expiresAt: "2026-09-19T00:00:00.000Z",
						listing: {
							connections: [
								{
									display_name: "Google Drive",
									id: "google-drive",
									provider: "composio",
									required: true,
									toolkit: "GOOGLEDRIVE",
								},
							],
							id: "acme/report",
							kind: "workflow",
							name: "Customer report",
							version: "1.0.0",
						},
					}
				: {
						audience: "shareable",
						installSessionToken: "short-lived-session",
						listing: {
							id: "acme/report",
							kind: "workflow",
							name: "Customer report",
							version: "1.0.0",
						},
					}
		);
	});
	try {
		const preview = await previewPrivatePackageShareCode("7K4M-X2QP-9F6D");
		expect(preview.audience).toBe("shareable");
		expect(preview.expiresAt).toBe("2026-09-19T00:00:00.000Z");
		expect(preview.connections[0]).toMatchObject({
			displayName: "Google Drive",
			toolkit: "GOOGLEDRIVE",
		});
		const redeemed = await redeemPrivatePackageShareCode("7K4MX2QP9F6D");
		expect(redeemed.installSession).toBe("short-lived-session");
		expect(redeemed.preview.id).toBe("acme/report");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("reuses a live redeemed session instead of spending another redemption", async () => {
	const originalFetch = globalThis.fetch;
	const redeemPaths: string[] = [];
	let expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
	globalThis.fetch = createFetchFixture(originalFetch, async (input) => {
		redeemPaths.push(String(input));
		return Response.json({
			audience: "shareable",
			installSessionExpiresAt: expiresAt,
			installSessionToken: `session-${redeemPaths.length}`,
			listing: {
				id: "acme/single-use",
				kind: "workflow",
				name: "Single-use package",
				version: "1.0.0",
			},
		});
	});
	try {
		const first = await redeemPrivatePackageShareCode("4567-89ab-cdef");
		const again = await redeemPrivatePackageShareCode("456789ABCDEF");
		expect(redeemPaths).toHaveLength(1);
		expect(redeemPaths[0]).toEndWith("/share-codes/redeem");
		expect(first.installSession).toBe("session-1");
		expect(again.installSession).toBe("session-1");
		expect(again.preview.id).toBe("acme/single-use");
		expect(
			peekRedeemedPrivatePackageShareSession("4567 89ab cdef")?.installSession
		).toBe("session-1");

		forgetRedeemedPrivatePackageShareSession("456789ABCDEF");
		expect(peekRedeemedPrivatePackageShareSession("456789ABCDEF")).toBeNull();
		// A session that is already (nearly) expired is never handed back out.
		expiresAt = new Date(Date.now() + 10_000).toISOString();
		const expiring = await redeemPrivatePackageShareCode("456789ABCDEF");
		expect(redeemPaths).toHaveLength(2);
		expect(expiring.installSession).toBe("session-2");
		expect(peekRedeemedPrivatePackageShareSession("456789ABCDEF")).toBeNull();
		await redeemPrivatePackageShareCode("456789ABCDEF");
		expect(redeemPaths).toHaveLength(3);
	} finally {
		forgetRedeemedPrivatePackageShareSession("456789ABCDEF");
		globalThis.fetch = originalFetch;
	}
});

test("a slow local clock cannot stretch session reuse past its lifetime", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = createFetchFixture(originalFetch, async () =>
		Response.json({
			audience: "shareable",
			// Fifteen minutes on the server's clock reads as a day on one far behind.
			installSessionExpiresAt: new Date(
				Date.now() + 24 * 60 * 60_000
			).toISOString(),
			installSessionToken: "skewed-session",
			listing: {
				id: "acme/skewed",
				kind: "workflow",
				name: "Skewed package",
				version: "1.0.0",
			},
		})
	);
	try {
		const before = Date.now();
		await redeemPrivatePackageShareCode("89AB-CDEF-GHJK");
		const cached = peekRedeemedPrivatePackageShareSession("89ABCDEFGHJK");
		expect(cached?.installSession).toBe("skewed-session");
		expect(cached?.expiresAtMs).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
		expect(cached?.expiresAtMs).toBeGreaterThanOrEqual(before + 15 * 60_000);
	} finally {
		forgetRedeemedPrivatePackageShareSession("89ABCDEFGHJK");
		globalThis.fetch = originalFetch;
	}
});
