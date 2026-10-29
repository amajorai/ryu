import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

/**
 * `bun test` is this package's runner (`"test": "bun test src"`), and its vitest
 * shim covers `describe`/`it`/`expect` but NOT `vi.stubGlobal`,
 * `vi.unstubAllGlobals`, or a `mock()` that `expect(...).toHaveBeenCalled()`
 * recognises. Importing from "vitest" therefore threw at the first stub and made
 * four cases here unrunnable. Ported to bun's own primitives rather than adding a
 * vitest runner for one file.
 */
const stubbedGlobals = new Map<string, PropertyDescriptor | undefined>();

/** `vi.stubGlobal`: install a global, remembering how to put it back. */
function stubGlobal<TValue>(name: string, value: TValue): void {
	if (!stubbedGlobals.has(name)) {
		stubbedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	}
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
}

/** `vi.unstubAllGlobals`: restore every global this file replaced. */
function unstubAllGlobals(): void {
	for (const [name, descriptor] of stubbedGlobals) {
		if (descriptor) {
			Object.defineProperty(globalThis, name, descriptor);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
	stubbedGlobals.clear();
}

import {
	clearDevMetrics,
	getDevMetricsText,
	getTurnSamples,
	type HttpSample,
	instrumentedFetch,
	normalizePath,
	recordHttpSample,
	refreshDevMetricsGate,
	subscribeDevMetrics,
	summarizeHttp,
	summarizeTurns,
} from "./dev-metrics.ts";

const sample = (path: string, ms: number, status = 200): HttpSample => ({
	at: 0,
	method: "GET",
	path,
	status,
	ms,
});

beforeEach(() => {
	// ARM THE GATE. Recording is a no-op unless `isDevMetricsEnabled()`, which
	// reads `import.meta.env.DEV` first — true under vite/vitest, UNDEFINED under
	// `bun test` — and then falls back to the Developer Mode key in localStorage,
	// which bun does not provide either. So every `recordHttpSample` here silently
	// did nothing and the subscriber/text cases asserted against an empty store.
	//
	// Stubbed at the real seam rather than bypassed: this drives the same
	// localStorage branch a release build uses when a user flips Developer Mode,
	// so the gate itself stays covered instead of being assumed away.
	stubGlobal("localStorage", {
		getItem: (key: string) => (key === "ryu_developer_mode" ? "true" : null),
	});
	refreshDevMetricsGate();
	clearDevMetrics();
});

// PUT THE GLOBALS BACK. `bun test` runs every file in this package in ONE
// process, so a `localStorage` left stubbed here is the `localStorage` the next
// file inherits — and the files after this one expect happy-dom's real one.
// Leaving it installed is what turns one file's fixture into three other files'
// failures, visible only in the full run and never when they are run alone.
afterAll(() => {
	unstubAllGlobals();
	refreshDevMetricsGate();
});

describe("normalizePath", () => {
	it("collapses uuids so calls aggregate by shape", () => {
		expect(
			normalizePath(
				"/api/conversations/8f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8/messages"
			)
		).toBe("/api/conversations/:id/messages");
	});

	it("collapses numeric and long-hex segments", () => {
		expect(normalizePath("/api/runs/12345")).toBe("/api/runs/:n");
		expect(normalizePath("/api/blobs/deadbeefdeadbeefcafe")).toBe(
			"/api/blobs/:id"
		);
	});

	it("drops the query string", () => {
		expect(normalizePath("/api/agents?limit=20&cursor=abc")).toBe(
			"/api/agents"
		);
	});

	it("leaves an already-plain path alone", () => {
		expect(normalizePath("/api/health")).toBe("/api/health");
	});
});

describe("summarizeHttp", () => {
	it("groups by path and orders by p95, slowest first", () => {
		const stats = summarizeHttp([
			sample("/api/fast", 5),
			sample("/api/fast", 7),
			sample("/api/slow", 900),
			sample("/api/slow", 1100),
		]);
		expect(stats[0].path).toBe("/api/slow");
		expect(stats[0].count).toBe(2);
	});

	it("counts a non-2xx and a never-answered call as errors", () => {
		const [stat] = summarizeHttp([
			sample("/api/x", 10, 200),
			sample("/api/x", 10, 500),
			sample("/api/x", 10, 0),
		]);
		expect(stat.errors).toBe(2);
	});

	it("uses nearest-rank percentiles rather than interpolating", () => {
		// Ten samples 10..100: the median (5th of 10) is 50, p95 (10th) is 100.
		const [stat] = summarizeHttp(
			Array.from({ length: 10 }, (_, i) => sample("/api/p", (i + 1) * 10))
		);
		expect(stat.median).toBe(50);
		expect(stat.p95).toBe(100);
		expect(stat.max).toBe(100);
	});
});

describe("summarizeTurns", () => {
	it("excludes turns that never produced a first byte from the TTFT stats", () => {
		const stats = summarizeTurns([
			{
				at: 0,
				path: "/api/chat",
				status: 200,
				ttftMs: 100,
				ms: 500,
				bytes: 1,
				chunks: 1,
			},
			{
				at: 0,
				path: "/api/chat",
				status: 0,
				ttftMs: null,
				ms: 30_000,
				bytes: 0,
				chunks: 0,
			},
		]);
		expect(stats.count).toBe(2);
		expect(stats.medianTtft).toBe(100);
		// The failed turn still counts toward totals — a 30s hang is the finding.
		expect(stats.p95Total).toBe(30_000);
	});
});

describe("instrumentedFetch", () => {
	it("passes the body through unchanged and records the turn", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("hello "));
				controller.enqueue(new TextEncoder().encode("world"));
				controller.close();
			},
		});
		stubGlobal(
			"fetch",
			mock(() => Promise.resolve(new Response(body, { status: 200 })))
		);

		const response = await instrumentedFetch("http://localhost:7980/api/chat");
		// The sample is recorded on stream FLUSH, so it only exists once the
		// consumer has drained the body — same lifetime as the real turn.
		expect(await response.text()).toBe("hello world");

		const [turn] = getTurnSamples();
		expect(turn.path).toBe("/api/chat");
		expect(turn.status).toBe(200);
		expect(turn.bytes).toBe(11);
		expect(turn.chunks).toBe(2);
		expect(turn.ttftMs).not.toBeNull();
		unstubAllGlobals();
	});

	it("records a failed request as status 0 and rethrows", async () => {
		stubGlobal(
			"fetch",
			mock(() => Promise.reject(new Error("offline")))
		);
		await expect(
			instrumentedFetch("http://localhost:7980/api/chat")
		).rejects.toThrow("offline");
		expect(getTurnSamples()[0].status).toBe(0);
		unstubAllGlobals();
	});
});

describe("subscribers and text output", () => {
	it("notifies on a recorded sample", () => {
		const listener = mock();
		const unsubscribe = subscribeDevMetrics(listener);
		recordHttpSample(sample("/api/health", 3));
		expect(listener).toHaveBeenCalled();
		unsubscribe();
	});

	it("renders nothing at all when nothing was recorded", () => {
		expect(getDevMetricsText()).toBe("");
	});

	it("renders a per-path line once there is data", () => {
		recordHttpSample(sample("/api/health", 3));
		expect(getDevMetricsText()).toContain("/api/health");
	});
});
