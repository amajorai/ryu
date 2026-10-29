import { afterEach, describe, expect, it } from "bun:test";
import { deepStrictEqual } from "node:assert/strict";
import { WAITLIST_MANAGED_ONLY_FLAG } from "@ryuhq/protocol/feature-flags";
import { createFetchFixture } from "./test-support/http-fixture.ts";
import {
	fetchWaitlistAccess,
	fetchWaitlistManagedOnly,
	fetchWaitlistMe,
	openWaitlistStream,
	parseWaitlistMe,
	readWaitlistManagedOnly,
	resolveNodeWaitlistAccess,
	waitlistManagedOnlyFromFeatures,
} from "./waitlist.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

const target = {
	token: "better-auth-token",
	url: "https://account.example.test/",
};

describe("parseWaitlistMe", () => {
	it("accepts the server contract and normalizes optional values", () => {
		expect(
			parseWaitlistMe({
				applicationStatus: "submitted",
				displayUsername: "RyuFan",
				eta: "~2 weeks",
				hasApplied: true,
				isAdmin: false,
				joinedAt: "2026-09-22T00:00:00.000Z",
				position: 3,
				referralCode: "ABCD2345",
				referralCount: 2.9,
				referralUrl: "https://ryu.example/r/ABCD2345",
				status: "pending",
				totalWaiting: 12,
				username: "ryufan",
			})
		).toEqual({
			applicationStatus: "submitted",
			displayUsername: "RyuFan",
			eta: "~2 weeks",
			hasApplied: true,
			isAdmin: false,
			joinedAt: "2026-09-22T00:00:00.000Z",
			position: 3,
			referralCode: "ABCD2345",
			referralCount: 2,
			referralUrl: "https://ryu.example/r/ABCD2345",
			status: "pending",
			totalWaiting: 12,
			username: "ryufan",
		});
	});

	it("rejects a payload without an explicit status", () => {
		expect(parseWaitlistMe({ position: 1 })).toBeNull();
	});
});

describe("fetchWaitlistAccess", () => {
	it("sends the control-plane bearer and returns approved", async () => {
		let request: Request | undefined;
		globalThis.fetch = createFetchFixture(async (input, init) => {
			request = new Request(input, init);
			return Response.json({ status: "approved" });
		});

		expect(await fetchWaitlistAccess(target)).toBe("approved");
		expect(request?.url).toBe("https://account.example.test/api/waitlist/me");
		expect(request?.headers.get("authorization")).toBe(
			"Bearer better-auth-token"
		);
		expect(request?.credentials).toBe("include");
	});

	it("distinguishes a dead session from a temporary outage", async () => {
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response(null, { status: 401 })),
			{ preconnect: realFetch.preconnect }
		);
		expect(await fetchWaitlistAccess(target)).toBe("unauthenticated");

		globalThis.fetch = Object.assign(
			() => Promise.reject(new Error("offline")),
			{ preconnect: realFetch.preconnect }
		);
		expect(await fetchWaitlistAccess(target)).toBe("unavailable");
	});

	it("fails closed on malformed successful responses", async () => {
		globalThis.fetch = Object.assign(
			() => Promise.resolve(Response.json({ status: "maybe" })),
			{ preconnect: realFetch.preconnect }
		);
		expect(await fetchWaitlistAccess(target)).toBe("unavailable");
		await expect(fetchWaitlistMe(target)).rejects.toThrow(
			"waitlist-invalid-response"
		);
	});
});

describe("waitlist managed-only feature flag", () => {
	it("uses the shared all-nodes default when the value is missing or malformed", () => {
		expect(waitlistManagedOnlyFromFeatures(null)).toBe(false);
		expect(waitlistManagedOnlyFromFeatures({})).toBe(false);
		expect(
			waitlistManagedOnlyFromFeatures({
				[WAITLIST_MANAGED_ONLY_FLAG.key]: "true",
			})
		).toBe(false);
	});

	it("accepts only an explicit boolean server value", () => {
		expect(
			waitlistManagedOnlyFromFeatures({
				[WAITLIST_MANAGED_ONLY_FLAG.key]: true,
			})
		).toBe(true);
		expect(
			waitlistManagedOnlyFromFeatures({
				[WAITLIST_MANAGED_ONLY_FLAG.key]: false,
			})
		).toBe(false);
	});

	it("fetches the public flag without forwarding the account bearer", async () => {
		let request: Request | undefined;
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				request = new Request(input, init);
				return Response.json({
					features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: true },
				});
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(await fetchWaitlistManagedOnly(target)).toBe(true);
		expect(request?.url).toBe(
			"https://account.example.test/api/feature-flags/public"
		);
		expect(request?.headers.get("authorization")).toBeNull();
	});

	it("keeps all-node gating when the public flag endpoint is unavailable", async () => {
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response(null, { status: 503 })),
			{ preconnect: realFetch.preconnect }
		);

		expect(await fetchWaitlistManagedOnly(target)).toBe(false);
	});

	it("reports an unreadable flag as null so a live caller can keep its scope", async () => {
		globalThis.fetch = Object.assign(
			() => Promise.resolve(new Response(null, { status: 503 })),
			{ preconnect: realFetch.preconnect }
		);
		expect(await readWaitlistManagedOnly(target)).toBeNull();

		globalThis.fetch = Object.assign(
			() => Promise.reject(new TypeError("network down")),
			{ preconnect: realFetch.preconnect }
		);
		expect(await readWaitlistManagedOnly(target)).toBeNull();
		expect(await fetchWaitlistManagedOnly(target)).toBe(false);

		globalThis.fetch = Object.assign(
			() =>
				Promise.resolve(
					Response.json({
						features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: true },
					})
				),
			{ preconnect: realFetch.preconnect }
		);
		expect(await readWaitlistManagedOnly(target)).toBe(true);
	});
});

describe("resolveNodeWaitlistAccess", () => {
	it("gates every node when the server managed-only flag is off", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push(request);
				return request.url.endsWith("/api/feature-flags/public")
					? Response.json({
							features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: false },
						})
					: Response.json({ status: "pending" });
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveNodeWaitlistAccess(
				{ ...target, url: "https://account.example.test" },
				"http://127.0.0.1:7980"
			)
		).toEqual({ access: "pending", scope: "all" });
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/feature-flags/public",
			"/api/waitlist/me",
		]);
		expect(requests[0]?.headers.get("authorization")).toBeNull();
		expect(requests[1]?.headers.get("authorization")).toBe(
			"Bearer better-auth-token"
		);
	});

	it("checks only managed nodes when the server flag is on", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith("/api/feature-flags/public")) {
					return Response.json({
						features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: true },
					});
				}
				if (request.url.endsWith("/api/control-plane/nodes")) {
					return Response.json({
						nodes: [{ url: "https://managed.example.test/" }],
					});
				}
				return Response.json({ status: "pending" });
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveNodeWaitlistAccess(
				{ ...target, url: "https://account.example.test" },
				"https://managed.example.test"
			)
		).toEqual({ access: "pending", scope: "managed" });
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/feature-flags/public",
			"/api/control-plane/nodes",
			"/api/waitlist/me",
		]);
	});

	it("bypasses local and existing nodes when managed-only is enabled", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push(request);
				if (request.url.endsWith("/api/feature-flags/public")) {
					return Response.json({
						features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: true },
					});
				}
				if (request.url.endsWith("/api/control-plane/nodes")) {
					return Response.json({
						nodes: [{ url: "https://managed.example.test" }],
					});
				}
				return Response.json({ status: "pending" });
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveNodeWaitlistAccess(
				{ ...target, url: "https://account.example.test" },
				"https://managed.example.test"
			)
		).toEqual({ access: "pending", scope: "managed" });

		expect(
			await resolveNodeWaitlistAccess(
				{ ...target, url: "https://account.example.test" },
				"http://127.0.0.1:7980/"
			)
		).toEqual({ scope: "bypassed" });
	});

	it("falls back to all-node gating if the server has no flag value", async () => {
		const requests: Request[] = [];
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				requests.push(request);
				return request.url.endsWith("/api/feature-flags/public")
					? Response.json({ features: {} })
					: Response.json({ status: "pending" });
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveNodeWaitlistAccess(
				{ ...target, url: "https://account.example.test" },
				"http://127.0.0.1:7980"
			)
		).toEqual({ access: "pending", scope: "all" });
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			"/api/feature-flags/public",
			"/api/waitlist/me",
		]);
	});

	it("does not classify malformed managed-node data as an empty list", async () => {
		globalThis.fetch = Object.assign(
			async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const request = new Request(input, init);
				return request.url.endsWith("/api/feature-flags/public")
					? Response.json({
							features: { [WAITLIST_MANAGED_ONLY_FLAG.key]: true },
						})
					: Response.json({ nodes: [{ url: "not a URL" }] });
			},
			{ preconnect: realFetch.preconnect }
		);

		expect(
			await resolveNodeWaitlistAccess(
				{ ...target, url: "https://account.example.test" },
				"https://managed.example.test"
			)
		).toEqual({ scope: "bypassed" });
	});
});

it("admits only native approval events while preserving stream auth and abort options", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	globalThis.fetch = createFetchFixture((url, init) => {
		requestUrl = url;
		requestInit = init;
		return Promise.resolve(
			new Response(
				[
					'data: {"status":"pending"}',
					"",
					'data: {"status":"approved","future":{"kept":true}}',
					"",
					'data: {"status":true}',
					"",
					"data: null",
					"",
					"event: approved",
					'data: {"status":"approved"}',
					"",
					"",
				].join("\n"),
				{ headers: { "Content-Type": "text/event-stream" } }
			)
		);
	});
	const controller = new AbortController();
	const events = [];
	for await (const message of openWaitlistStream(target, controller.signal)) {
		events.push(message);
	}
	deepStrictEqual(events, [
		{ event: "message", data: { status: "approved", future: { kept: true } } },
		{ event: "approved", data: { status: "approved" } },
	]);
	expect(requestUrl).toBe("https://account.example.test/api/waitlist/stream");
	expect(requestInit?.method).toBe("GET");
	expect(requestInit?.credentials).toBe("include");
	expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
		"Bearer better-auth-token"
	);
	expect(requestInit?.signal).toBe(controller.signal);
	expect(requestInit?.cache).toBeUndefined();
});
it("retains the abort signal when a native approval stream is already cancelled", async () => {
	const controller = new AbortController();
	controller.abort();
	let signal: RequestInit["signal"];
	globalThis.fetch = createFetchFixture((_url, init) => {
		signal = init.signal;
		return Promise.reject(
			new DOMException("The operation was aborted", "AbortError")
		);
	});
	const iterator = openWaitlistStream(target, controller.signal);
	await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
	expect(signal).toBe(controller.signal);
});
