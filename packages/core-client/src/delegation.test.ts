// packages/core-client/src/delegation.test.ts
//
// Tests for the sub-agent delegation client. `streamDelegation` is a fetch+
// ReadableStream SSE reader: it splits frames on a blank line, keeps only the
// `data:` lines, JSON-parses each into a discriminated `DelegateEvent`, buffers
// payloads that span reader chunks, flushes a trailing frame that has no
// terminating blank line, skips malformed frames, and throws on a non-2xx or
// bodiless connect. The exported caps/limits/preset constants are contract
// invariants the picker + server-side clamp both rely on, so they are pinned too.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	DEFAULT_CAPS,
	DELEGATION_LIMITS,
	type DelegateEvent,
	type DelegateRequest,
	PRESET_OPTIONS,
	streamDelegation,
} from "./delegation.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

interface Captured {
	init?: RequestInit;
	url?: string;
}

/** Serve `chunks` as a streamed body and capture the outgoing url + init. */
function streamOnce(chunks: string[], init?: ResponseInit): Captured {
	const cap: Captured = {};
	const encoder = new TextEncoder();
	globalThis.fetch = ((url: string, reqInit: RequestInit) => {
		cap.url = url;
		cap.init = reqInit;
		return Promise.resolve(
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
		);
	}) as typeof fetch;
	return cap;
}

async function collect(chunks: string[]): Promise<DelegateEvent[]> {
	streamOnce(chunks);
	const seen: DelegateEvent[] = [];
	const body: DelegateRequest = {
		delegates: [{ id: "d1", preset: "research", task: "go" }],
	};
	await streamDelegation(target, body, (e) => seen.push(e));
	return seen;
}

describe("streamDelegation — SSE parsing", () => {
	test("parses each event kind in order", async () => {
		const seen = await collect([
			'data: {"event":"started","id":"d1","preset":"research"}\n\n',
			'data: {"event":"finished","result":{"id":"d1","error":null,"output":"ok","preset":"research"}}\n\n',
			'data: {"event":"done","results":[]}\n\n',
		]);
		expect(seen.map((e) => e.event)).toEqual(["started", "finished", "done"]);
	});

	test("stitches a payload split across two reader chunks", async () => {
		const seen = await collect([
			'data: {"event":"star',
			'ted","id":"d1","preset":"research"}\n\n',
		]);
		expect(seen).toEqual([{ event: "started", id: "d1", preset: "research" }]);
	});

	test("flushes a trailing frame with no terminating blank line", async () => {
		const seen = await collect(['data: {"event":"error","error":"boom"}']);
		expect(seen).toEqual([{ event: "error", error: "boom" }]);
	});

	test("skips a malformed frame and keeps going", async () => {
		const seen = await collect([
			"data: {not json\n\n",
			'data: {"event":"done","results":[]}\n\n',
		]);
		expect(seen).toEqual([{ event: "done", results: [] }]);
	});

	test("ignores frames with no data: line", async () => {
		const seen = await collect([
			": keep-alive comment\n\n",
			'data: {"event":"done","results":[]}\n\n',
		]);
		expect(seen).toEqual([{ event: "done", results: [] }]);
	});

	test("POSTs the request body to the delegate stream endpoint", async () => {
		const cap = streamOnce([]);
		await streamDelegation(
			target,
			{ delegates: [{ id: "d1", preset: "summarise", task: "t" }], depth: 2 },
			() => {
				// no-op
			}
		);
		expect(cap.url).toBe("http://127.0.0.1:7980/api/delegate/stream");
		expect(cap.init?.method).toBe("POST");
		expect(JSON.parse(cap.init?.body as string)).toEqual({
			delegates: [{ id: "d1", preset: "summarise", task: "t" }],
			depth: 2,
		});
	});
});

describe("streamDelegation — failure paths", () => {
	test("throws with the status on a non-2xx connect", async () => {
		streamOnce([], { status: 503 });
		await expect(
			streamDelegation(target, { delegates: [] }, () => {
				// no-op
			})
		).rejects.toThrow("delegation failed: 503");
	});

	test("throws when the response has no body", async () => {
		globalThis.fetch = (() =>
			Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch;
		await expect(
			streamDelegation(target, { delegates: [] }, () => {
				// no-op
			})
		).rejects.toThrow("delegation stream returned no body");
	});
});

describe("delegation constants (contract invariants)", () => {
	test("DEFAULT_CAPS.max_concurrent tracks the hard limit", () => {
		expect(DEFAULT_CAPS.max_concurrent).toBe(DELEGATION_LIMITS.maxConcurrent);
		expect(DEFAULT_CAPS.max_tokens).toBeGreaterThan(0);
		expect(DEFAULT_CAPS.wall_time_secs).toBeGreaterThan(0);
	});

	test("PRESET_OPTIONS lists exactly the four closed presets, in order", () => {
		expect(PRESET_OPTIONS.map((p) => p.value)).toEqual([
			"research",
			"code_read",
			"code_write",
			"summarise",
		]);
		// Every option carries a label + hint for the picker.
		for (const opt of PRESET_OPTIONS) {
			expect(opt.label.length).toBeGreaterThan(0);
			expect(opt.hint.length).toBeGreaterThan(0);
		}
	});
});
