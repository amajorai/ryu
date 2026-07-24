// packages/core-client/src/downloads.test.ts
//
// Tests for the download-center client: the isTerminal/isInFlight state
// predicates, the snapshot fetch (listDownloads with its `?? []` fallback), the
// pause/resume/retry/cancel control POSTs + the DELETE clear, and streamDownloads
// — a fetch + ReadableStream SSE reader that splits frames on a blank line, keeps
// only `data:` lines, JSON-parses each, buffers a payload split across chunks,
// FLUSHES a trailing frame with no terminating blank line (unlike meetings), skips
// malformed frames, and throws on a non-2xx or bodiless connect.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	cancelDownload,
	clearDownload,
	type DownloadEvent,
	type DownloadState,
	isInFlight,
	isTerminal,
	listDownloads,
	pauseDownload,
	resumeDownload,
	retryDownload,
	streamDownloads,
} from "./downloads.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

interface Captured {
	init?: RequestInit;
	url?: string;
}

function stub(bodyText: string, status = 200): Captured {
	const cap: Captured = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		cap.url = url;
		cap.init = init;
		return Promise.resolve(new Response(bodyText, { status }));
	}) as typeof fetch;
	return cap;
}

function streamOnce(chunks: string[], init?: ResponseInit): void {
	const encoder = new TextEncoder();
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					start(c) {
						for (const chunk of chunks) {
							c.enqueue(encoder.encode(chunk));
						}
						c.close();
					},
				}),
				init
			)
		)) as typeof fetch;
}

async function collect(chunks: string[]): Promise<DownloadEvent[]> {
	streamOnce(chunks);
	const seen: DownloadEvent[] = [];
	await streamDownloads(target, (e) => seen.push(e));
	return seen;
}

describe("state predicates", () => {
	test("isTerminal is true for exactly the three terminal states", () => {
		const terminal: DownloadState[] = ["completed", "cancelled", "failed"];
		const other: DownloadState[] = ["queued", "active", "paused", "verifying"];
		for (const s of terminal) {
			expect(isTerminal(s)).toBe(true);
		}
		for (const s of other) {
			expect(isTerminal(s)).toBe(false);
		}
	});

	test("isInFlight is true for queued/active/verifying only", () => {
		const inFlight: DownloadState[] = ["queued", "active", "verifying"];
		const other: DownloadState[] = [
			"paused",
			"completed",
			"failed",
			"cancelled",
		];
		for (const s of inFlight) {
			expect(isInFlight(s)).toBe(true);
		}
		for (const s of other) {
			expect(isInFlight(s)).toBe(false);
		}
	});

	test("paused is neither terminal nor in-flight (its own resting state)", () => {
		expect(isTerminal("paused")).toBe(false);
		expect(isInFlight("paused")).toBe(false);
	});
});

describe("listDownloads", () => {
	test("returns the downloads array from the snapshot", async () => {
		const cap = stub(JSON.stringify({ downloads: [{ id: "d1" }, { id: "d2" }] }));
		const tasks = await listDownloads(target);
		expect(tasks.map((t) => t.id)).toEqual(["d1", "d2"]);
		expect(cap.url).toBe("http://127.0.0.1:7980/api/downloads");
	});

	test("falls back to [] when the field is absent", async () => {
		stub("{}");
		expect(await listDownloads(target)).toEqual([]);
	});
});

describe("control actions", () => {
	test("each control POSTs to /:id/<action>", async () => {
		const cases: Array<[
			(t: ApiTarget, id: string) => Promise<unknown>,
			string,
		]> = [
			[pauseDownload, "pause"],
			[resumeDownload, "resume"],
			[retryDownload, "retry"],
			[cancelDownload, "cancel"],
		];
		for (const [fn, action] of cases) {
			const cap = stub(JSON.stringify({ ok: true }));
			await fn(target, "d9");
			expect(cap.url).toBe(`http://127.0.0.1:7980/api/downloads/d9/${action}`);
			expect(cap.init?.method).toBe("POST");
		}
	});

	test("clearDownload issues a DELETE against the entry", async () => {
		const cap = stub(JSON.stringify({ ok: true }));
		await clearDownload(target, "d9");
		expect(cap.url).toBe("http://127.0.0.1:7980/api/downloads/d9");
		expect(cap.init?.method).toBe("DELETE");
	});

	test("a control action rejects on a non-2xx (surfaces the status)", async () => {
		stub("nope", 500);
		await expect(pauseDownload(target, "d9")).rejects.toThrow(
			"/api/downloads/d9/pause failed: 500"
		);
	});
});

describe("streamDownloads — SSE parsing", () => {
	test("parses snapshot / update / removed events in order", async () => {
		const seen = await collect([
			'data: {"type":"snapshot","tasks":[]}\n\n',
			'data: {"type":"update","task":{"id":"d1"}}\n\n',
			'data: {"type":"removed","id":"d1"}\n\n',
		]);
		expect(seen.map((e) => e.type)).toEqual(["snapshot", "update", "removed"]);
	});

	test("stitches a payload split across two reader chunks", async () => {
		const seen = await collect([
			'data: {"type":"remo',
			'ved","id":"d7"}\n\n',
		]);
		expect(seen).toEqual([{ type: "removed", id: "d7" }]);
	});

	test("flushes a trailing frame with no terminating blank line", async () => {
		const seen = await collect(['data: {"type":"removed","id":"tail"}']);
		expect(seen).toEqual([{ type: "removed", id: "tail" }]);
	});

	test("joins multiple data: lines within one frame", async () => {
		const seen = await collect([
			'data: {"type":"removed",\ndata: "id":"multi"}\n\n',
		]);
		expect(seen).toEqual([{ type: "removed", id: "multi" }]);
	});

	test("ignores a frame that has no data: line (keep-alive comment)", async () => {
		const seen = await collect([
			": keep-alive\n\n",
			'data: {"type":"removed","id":"d1"}\n\n',
		]);
		expect(seen).toEqual([{ type: "removed", id: "d1" }]);
	});

	test("skips a malformed frame and keeps going", async () => {
		const seen = await collect([
			"data: {not json\n\n",
			'data: {"type":"removed","id":"ok"}\n\n',
		]);
		expect(seen).toEqual([{ type: "removed", id: "ok" }]);
	});

	test("a whitespace-only trailing buffer flushes nothing", async () => {
		const seen = await collect([
			'data: {"type":"removed","id":"d1"}\n\n',
			"   \n",
		]);
		expect(seen).toEqual([{ type: "removed", id: "d1" }]);
	});
});

describe("streamDownloads — failure paths", () => {
	test("throws with the status on a non-2xx connect", async () => {
		streamOnce([], { status: 503 });
		await expect(
			streamDownloads(target, () => {
				// no-op
			})
		).rejects.toThrow("downloads stream failed: 503");
	});

	test("throws when the response has no body", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch;
		await expect(
			streamDownloads(target, () => {
				// no-op
			})
		).rejects.toThrow("downloads stream returned no body");
	});
});
