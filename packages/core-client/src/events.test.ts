// packages/core-client/src/events.test.ts
//
// Tests for streamDesktopNotifications: a fetch-based SSE reader that splits
// frames on "\n\n", keeps only "data:" lines (trimmed), JSON-parses each, and
// invokes the callback. Malformed frames are skipped ("self-heal"); a non-2xx
// connect throws. Covers the buffer-stitching case (payload across two chunks).

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	type DesktopNotification,
	streamDesktopNotifications,
} from "./events.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

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

async function collect(chunks: string[]): Promise<DesktopNotification[]> {
	streamOnce(chunks);
	const seen: DesktopNotification[] = [];
	await streamDesktopNotifications(target, (n) => seen.push(n));
	return seen;
}

describe("streamDesktopNotifications", () => {
	test("emits one notification per data frame", async () => {
		const seen = await collect([
			'data: {"title":"Hi","body":"there"}\n\n',
			'data: {"title":"Two"}\n\n',
		]);
		expect(seen).toEqual([{ title: "Hi", body: "there" }, { title: "Two" }]);
	});

	test("stitches a payload split across two reader chunks", async () => {
		const seen = await collect(['data: {"title":"Sp', 'lit"}\n\n']);
		expect(seen).toEqual([{ title: "Split" }]);
	});

	test("skips a malformed frame and continues", async () => {
		const seen = await collect(["data: {bad\n\n", 'data: {"title":"ok"}\n\n']);
		expect(seen).toEqual([{ title: "ok" }]);
	});

	test("ignores non-data lines within a frame", async () => {
		const seen = await collect(['event: notify\ndata: {"title":"named"}\n\n']);
		expect(seen).toEqual([{ title: "named" }]);
	});

	test("throws with the status on a non-2xx connect", async () => {
		streamOnce([], { status: 500 });
		await expect(
			streamDesktopNotifications(target, () => {
				// no-op
			})
		).rejects.toThrow("notifications stream failed: 500");
	});
});
