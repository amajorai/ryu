import { afterEach, describe, expect, it, mock } from "bun:test";
import {
	DEVICE_LIMIT_DEFAULTS,
	DEVICE_SURFACE_LABELS,
	DEVICE_SURFACES,
} from "@ryu/auth/lib/device-limits";
import type { Session } from "./api-client.ts";
import {
	fetchDeviceLimitSummary,
	occupiedDeviceLimits,
	parseDeviceLimitSummary,
	sessionSurface,
} from "./device-limits-api.ts";
import { localizedDeviceSurfaceLabel } from "./device-surface-labels.ts";

const baseSession: Session = {
	createdAt: new Date(0),
	expiresAt: new Date(0),
	id: "s1",
	isCurrent: false,
	userId: "u1",
};

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("sessionSurface", () => {
	it("reads a known surface and ignores anything else", () => {
		expect(
			sessionSurface({ ...baseSession, surface: "desktop" } as Session)
		).toBe("desktop");
		expect(sessionSurface(baseSession)).toBeNull();
		expect(
			sessionSurface({ ...baseSession, surface: "fridge" } as Session)
		).toBeNull();
	});
});

describe("parseDeviceLimitSummary", () => {
	it("keeps valid rows and drops unknown surfaces or malformed counts", () => {
		expect(
			parseDeviceLimitSummary({
				enforced: true,
				surfaces: [
					{ count: 2, label: "Web browsers", limit: 10, surface: "web" },
					{ count: 1, label: "Toaster", limit: 1, surface: "toaster" },
					{ count: -1, label: "Ryu Desktop", limit: 5, surface: "desktop" },
				],
			})
		).toEqual({
			enforced: true,
			surfaces: [
				{ count: 2, label: "Web browsers", limit: 10, surface: "web" },
			],
		});
		expect(parseDeviceLimitSummary({ enforced: "yes" })).toBeNull();
		expect(parseDeviceLimitSummary(null)).toBeNull();
	});
});

describe("occupiedDeviceLimits", () => {
	it("lists only surfaces in use, and nothing when not enforced", () => {
		const surfaces = DEVICE_SURFACES.map((surface) => ({
			count: surface === "desktop" ? 3 : 0,
			label: DEVICE_SURFACE_LABELS[surface],
			limit: DEVICE_LIMIT_DEFAULTS[surface],
			surface,
		}));
		expect(occupiedDeviceLimits({ enforced: true, surfaces })).toEqual([
			{ count: 3, label: "Ryu Desktop", limit: 5, surface: "desktop" },
		]);
		expect(occupiedDeviceLimits({ enforced: false, surfaces })).toEqual([]);
		expect(occupiedDeviceLimits(null)).toEqual([]);
	});
});

describe("fetchDeviceLimitSummary", () => {
	it("calls the summary route on the configured origin with cookies", async () => {
		const previous = process.env.NEXT_PUBLIC_SERVER_URL;
		process.env.NEXT_PUBLIC_SERVER_URL = "https://api.example.test/";
		const fetchMock = mock((_url: string, _init: RequestInit) =>
			Promise.resolve(
				Response.json({
					enforced: false,
					surfaces: [
						{ count: 1, label: "CLI and MCP", limit: 5, surface: "cli" },
					],
				})
			)
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const summary = await fetchDeviceLimitSummary();
			expect(summary?.surfaces).toHaveLength(1);
			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				"https://api.example.test/api/sessions/device-limits"
			);
			expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
		} finally {
			if (previous === undefined) {
				delete process.env.NEXT_PUBLIC_SERVER_URL;
			} else {
				process.env.NEXT_PUBLIC_SERVER_URL = previous;
			}
		}
	});

	it("resolves to null when the request fails", async () => {
		globalThis.fetch = mock(() =>
			Promise.reject(new Error("offline"))
		) as unknown as typeof fetch;
		expect(await fetchDeviceLimitSummary()).toBeNull();
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("nope", { status: 404 }))
		) as unknown as typeof fetch;
		expect(await fetchDeviceLimitSummary()).toBeNull();
	});
});

describe("localizedDeviceSurfaceLabel", () => {
	it("matches the shared English labels", () => {
		const identity = (source: string) => source;
		for (const surface of DEVICE_SURFACES) {
			expect(localizedDeviceSurfaceLabel(identity, surface)).toBe(
				DEVICE_SURFACE_LABELS[surface]
			);
		}
	});
});
