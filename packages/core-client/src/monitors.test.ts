// packages/core-client/src/monitors.test.ts
//
// Tests for the website-monitoring client. The interesting logic is the
// error-envelope handling: get/create/update/run all read `{ monitor?, error? }`
// and throw the server's `error` string (with a sensible fallback) when the
// success field is absent — so a validation failure reaches the UI verbatim
// instead of a bare status code. The list helpers default a missing array to [].
// `streamMonitorAlerts` is a fetch+ReadableStream SSE reader with the same
// frame-splitting / self-heal contract as the other streams.

import { afterEach, describe, expect, test } from "bun:test";
import type { ApiTarget } from "./client.ts";
import {
	type Alert,
	createMonitor,
	getMonitor,
	listMonitors,
	type MonitorInput,
	runMonitor,
	streamMonitorAlerts,
} from "./monitors.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = { url: "http://127.0.0.1:7980", token: "t" };

const input: MonitorInput = {
	backend: "http",
	check: { type: "uptime" },
	enabled: true,
	interval: "5m",
	name: "site",
	notify: [],
	url: "https://example.com",
};

function stubJson(bodyText: string, status = 200): void {
	globalThis.fetch = (() =>
		Promise.resolve(new Response(bodyText, { status }))) as typeof fetch;
}

describe("monitors error envelopes", () => {
	test("getMonitor throws the server error string when monitor is absent", async () => {
		stubJson(JSON.stringify({ error: "no such monitor" }));
		await expect(getMonitor(target, "m1")).rejects.toThrow("no such monitor");
	});

	test("getMonitor falls back to a default message when error is absent", async () => {
		stubJson("{}");
		await expect(getMonitor(target, "m1")).rejects.toThrow("monitor not found");
	});

	test("getMonitor returns the monitor on success", async () => {
		stubJson(JSON.stringify({ monitor: { id: "m1", name: "site" } }));
		const m = await getMonitor(target, "m1");
		expect(m).toEqual({ id: "m1", name: "site" } as never);
	});

	test("createMonitor surfaces the validation error verbatim", async () => {
		stubJson(JSON.stringify({ error: "interval too small" }));
		await expect(createMonitor(target, input)).rejects.toThrow(
			"interval too small"
		);
	});

	test("createMonitor falls back when neither monitor nor error is present", async () => {
		stubJson("{}");
		await expect(createMonitor(target, input)).rejects.toThrow(
			"failed to create monitor"
		);
	});

	test("runMonitor returns the check status, or throws the error", async () => {
		stubJson(JSON.stringify({ status: "triggered" }));
		expect(await runMonitor(target, "m1")).toBe("triggered");
		stubJson(JSON.stringify({ error: "fetch backend down" }));
		await expect(runMonitor(target, "m1")).rejects.toThrow(
			"fetch backend down"
		);
	});

	test("listMonitors defaults a missing array to []", async () => {
		stubJson("{}");
		expect(await listMonitors(target)).toEqual([]);
		stubJson(JSON.stringify({ monitors: [{ id: "m1" }] }));
		expect(await listMonitors(target)).toEqual([{ id: "m1" }] as never);
	});
});

describe("streamMonitorAlerts", () => {
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

	async function collect(chunks: string[]): Promise<Alert[]> {
		streamOnce(chunks);
		const seen: Alert[] = [];
		await streamMonitorAlerts(target, (a) => seen.push(a));
		return seen;
	}

	test("emits one alert per data frame", async () => {
		const seen = await collect([
			'data: {"id":1,"title":"Down"}\n\n',
			'data: {"id":2,"title":"Up"}\n\n',
		]);
		expect(seen.map((a) => a.id)).toEqual([1, 2]);
	});

	test("stitches an alert split across two chunks and skips a bad frame", async () => {
		const seen = await collect([
			'data: {"id":1,"tit',
			'le":"Split"}\n\n',
			"data: {broken\n\n",
			'data: {"id":2,"title":"ok"}\n\n',
		]);
		expect(seen.map((a) => a.title)).toEqual(["Split", "ok"]);
	});

	test("throws with the status on a non-2xx connect", async () => {
		streamOnce([], { status: 502 });
		await expect(
			streamMonitorAlerts(target, () => {
				// no-op
			})
		).rejects.toThrow("alert stream failed: 502");
	});
});
