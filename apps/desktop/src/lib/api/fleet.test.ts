import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { vaultHydrated } from "@/lib/auth-client.ts";
import {
	bindSelfHostedNodeToOrganization,
	getFleetBindingStatus,
	NodeAlreadyBoundError,
	parseFleetBindingStatus,
} from "./fleet.ts";
import type { PluginValue } from "./plugin-wire-values.ts";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const target = { token: "local-core-token", url: "http://127.0.0.1:7980" };
function storage(token: string | null): Storage {
	return {
		getItem: () => token,
		setItem: () => {},
		removeItem: () => {},
		clear: () => {},
		key: () => null,
		length: token ? 1 : 0,
	};
}
function stubFetch(
	callback: (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit
	) => Promise<Response>
) {
	globalThis.fetch = Object.assign(callback, {
		preconnect: originalFetch.preconnect,
	});
}
const validEnrollmentToken = `rfe_${"a".repeat(64)}`;

// Importing the auth client starts its vault hydration, which waits for the
// Tauri bridge before migrating a legacy session token. Let it finish before
// any test installs a session in storage, or its background profile lookup
// lands in whichever test's stubbed fetch happens to be live at that moment.
await vaultHydrated;

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage("account-session"),
	});
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalStorage) {
		Object.defineProperty(globalThis, "localStorage", originalStorage);
	} else {
		Reflect.deleteProperty(globalThis, "localStorage");
	}
	globalThis.setTimeout = originalSetTimeout;
	globalThis.clearTimeout = originalClearTimeout;
});

describe("Fleet organization binding", () => {
	test("issues one org-scoped code and hands it directly to the active Core", async () => {
		const requests: Array<{
			body: string;
			signal: AbortSignal | null | undefined;
			url: string;
		}> = [];
		let statusReads = 0;
		stubFetch(async (input, init) => {
			const url = String(input);
			requests.push({
				body: String(init?.body ?? ""),
				signal: init?.signal,
				url,
			});
			if (url.endsWith("/api/fleet/status")) {
				statusReads += 1;
				return Response.json(
					statusReads === 1
						? { enrolled: false }
						: {
								enrolled: true,
								managedInferenceReady: true,
								nodeId: "node-1",
								organizationId: "org-1",
								organizationName: "Acme",
							}
				);
			}
			if (url.includes("/nodes/enrollment-tokens")) {
				return Response.json({
					expiresAt: "2030-01-01T00:10:00.000Z",
					token: validEnrollmentToken,
				});
			}
			return Response.json({ nodeId: "node-1", organizationId: "org-1" });
		});

		await expect(
			bindSelfHostedNodeToOrganization({
				name: "Studio workstation",
				organizationId: "org-1",
				target,
			})
		).resolves.toMatchObject({
			enrolled: true,
			managedInferenceReady: true,
			nodeId: "node-1",
			organizationId: "org-1",
		});
		// The Better Auth client created by auth-client.ts may read its session
		// (GET /api/auth/get-session) in the background at any point; only the
		// Fleet calls belong to this flow.
		const enrollmentRequests = requests.filter(
			(request) => !new URL(request.url).pathname.startsWith("/api/auth/")
		);
		expect(enrollmentRequests.map((request) => request.url)).toEqual([
			"http://127.0.0.1:7980/api/fleet/status",
			expect.stringContaining(
				"/api/control-plane/orgs/org-1/nodes/enrollment-tokens"
			),
			"http://127.0.0.1:7980/api/fleet/enroll",
			"http://127.0.0.1:7980/api/fleet/status",
		]);
		expect(
			enrollmentRequests.every(
				(request) => request.signal instanceof AbortSignal
			)
		).toBe(true);
		expect(JSON.parse(enrollmentRequests[1]?.body ?? "{}")).toEqual({
			kind: "byod",
			name: "Studio workstation",
		});
		expect(JSON.parse(enrollmentRequests[2]?.body ?? "{}")).toEqual({
			controlPlaneUrl: expect.any(String),
			token: validEnrollmentToken,
		});
	});

	test("rejects a malformed cloud token before sending it to Core", async () => {
		const requestedUrls: string[] = [];
		stubFetch(async (input) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/api/fleet/status")) {
				return Response.json({ enrolled: false });
			}
			if (url.includes("/nodes/enrollment-tokens")) {
				return Response.json({ token: "rfe_not-a-real-code" });
			}
			return Response.json({});
		});

		await expect(
			bindSelfHostedNodeToOrganization({
				name: "Studio workstation",
				organizationId: "org-1",
				target,
			})
		).rejects.toThrow("invalid enrollment code");
		expect(
			requestedUrls.filter((url) => url.endsWith("/api/fleet/enroll"))
		).toHaveLength(0);
	});

	test("rejects a trimmed node name longer than 128 characters before fetching", async () => {
		let requestCount = 0;
		stubFetch(async (_input, _init) => {
			requestCount += 1;
			return Response.json({ enrolled: false });
		});

		await expect(
			bindSelfHostedNodeToOrganization({
				name: `  ${"n".repeat(129)}  `,
				organizationId: "org-1",
				target,
			})
		).rejects.toThrow("128 characters");
		expect(requestCount).toBe(0);
	});

	test("never issues a new code for an already-bound node", async () => {
		const requestedUrls: string[] = [];
		stubFetch(async (input) => {
			requestedUrls.push(String(input));
			return Response.json({
				enrolled: true,
				managedInferenceReady: true,
				nodeId: "node-1",
				organizationId: "org-existing",
				organizationName: "Existing org",
			});
		});

		await expect(
			bindSelfHostedNodeToOrganization({
				name: "Studio workstation",
				organizationId: "org-new",
				target,
			})
		).rejects.toBeInstanceOf(NodeAlreadyBoundError);
		expect(
			requestedUrls.filter((url) => url.includes("/nodes/enrollment-tokens"))
		).toHaveLength(0);
	});

	test("rejects an incomplete enrolled status at the network boundary", () => {
		expect(() =>
			parseFleetBindingStatus({ enrolled: true, organizationId: "org-1" })
		).toThrow("nodeId");
	});

	test("aborts a blackholed Core status request and clears its timer", async () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: storage(null),
		});
		let clearedTimers = 0;
		globalThis.setTimeout = new Proxy(originalSetTimeout, {
			apply(timer, receiver, args) {
				const handler = z.function().safeParse(args[0]);
				if (handler.success) {
					handler.data();
				}
				return timer.call(receiver, () => {}, 0);
			},
		});
		globalThis.clearTimeout = new Proxy(originalClearTimeout, {
			apply(clear, receiver, args) {
				clearedTimers += 1;
				return clear.call(receiver, args[0]);
			},
		});
		stubFetch(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("aborted", "AbortError"));
					});
					if (init?.signal?.aborted) {
						reject(new DOMException("aborted", "AbortError"));
					}
				})
		);

		const result = await Promise.race([
			getFleetBindingStatus(target).then(
				() => "resolved",
				(error) => {
					const parsed = z.instanceof(Error).safeParse(error);
					return parsed.success ? parsed.data.message : "unknown error";
				}
			),
			new Promise<string>((resolve) =>
				originalSetTimeout(() => resolve("still pending"), 100)
			),
		]);

		expect(result).toContain("timed out");
		expect(clearedTimers).toBe(1);
	});
});

test("Fleet legacy metadata defaults and identifier error order stay intact", () => {
	expect(
		parseFleetBindingStatus({
			enrolled: false,
			nodeId: {},
			organizationId: false,
		})
	).toEqual({ enrolled: false, state: "unbound" });
	expect(
		parseFleetBindingStatus({
			enrolled: true,
			nodeId: " node-1 ",
			organizationId: "org-1",
			organizationName: "  ",
			managedInferenceReady: "true",
		})
	).toEqual({
		enrolled: true,
		state: "bound",
		nodeId: " node-1 ",
		organizationId: "org-1",
		organizationName: null,
		managedInferenceReady: false,
	});
	expect(() => parseFleetBindingStatus({ enrolled: "true" })).toThrow(
		"invalid Fleet status"
	);
	expect(() =>
		parseFleetBindingStatus({
			enrolled: true,
			nodeId: null,
			organizationId: null,
		})
	).toThrow("missing nodeId");
	expect(() =>
		parseFleetBindingStatus({
			enrolled: true,
			nodeId: "node-1",
			organizationId: " ",
		})
	).toThrow("missing organizationId");
});

test("cloud enrollment errors preserve message priority, whitespace, and status fallback", async () => {
	for (const [body, expected] of [
		[{ message: " first ", error: "second" }, " first "],
		[{ message: " ", error: " second " }, " second "],
		[{ message: false, error: 1 }, "Could not create enrollment code (409)."],
		[null, "Could not create enrollment code (409)."],
	] satisfies [PluginValue, string][]) {
		stubFetch(async (input) =>
			String(input).endsWith("/api/fleet/status")
				? Response.json({ enrolled: false })
				: Response.json(body, { status: 409 })
		);
		await expect(
			bindSelfHostedNodeToOrganization({
				name: "node",
				organizationId: "org",
				target,
			})
		).rejects.toThrow(expected);
	}
});
