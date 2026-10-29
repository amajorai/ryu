import type { Monitor } from "./monitors.ts";
import { createFetchFixture } from "./test-support/http-fixture.ts";
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
	listUsageProviders,
	type MonitorInput,
	queryProviderUsage,
	runMonitor,
	streamMonitorAlerts,
	type UsageProviderOption,
} from "./monitors.ts";

const monitorFixture: Monitor = {
	backend: "http",
	check: { type: "uptime" },
	created_at: "2026-01-01T00:00:00Z",
	enabled: true,
	id: "m1",
	interval: "5m",
	name: "site",
	notify: [],
	updated_at: "2026-01-01T00:00:00Z",
	url: "https://example.test",
};

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

const target: ApiTarget = {
	url: "http://127.0.0.1:7980",
	token: "t",
	userJwt: null,
};

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
	globalThis.fetch = createFetchFixture(() =>
		Promise.resolve(new Response(bodyText, { status }))
	);
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
		stubJson(JSON.stringify({ monitor: monitorFixture }));
		const m = await getMonitor(target, "m1");
		expect(m).toEqual(monitorFixture);
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
		stubJson(JSON.stringify({ monitors: [monitorFixture] }));
		expect(await listMonitors(target)).toEqual([monitorFixture]);
	});

	test("provider usage discovery and query use the monitor API routes", async () => {
		const paths: string[] = [];
		let requestBody: BodyInit | null | undefined;
		globalThis.fetch = createFetchFixture(
			(input: RequestInfo | URL, init?: RequestInit) => {
				paths.push(String(input));
				requestBody = init?.body;
				return Promise.resolve(
					Response.json(
						paths.at(-1)?.endsWith("/usage/providers")
							? { providers: [] }
							: {
									available: true,
									meters: [],
									providerId: "acp:codex",
									windows: [],
								}
					)
				);
			}
		);
		expect(await listUsageProviders(target)).toEqual([]);
		expect(paths[0]).toContain("/api/monitors/usage/providers");
		expect(await queryProviderUsage(target, "acp:codex")).toEqual({
			available: true,
			meters: [],
			providerId: "acp:codex",
			windows: [],
		});
		expect(paths[1]).toContain("/api/monitors/usage/query");
		expect(JSON.parse(String(requestBody))).toEqual({
			provider_id: "acp:codex",
		});
	});

	test("an account-scoped usage query sends account_id and returns the read account", async () => {
		let requestBody: BodyInit | null | undefined;
		const reading = {
			accountId: "acct_2",
			accountLabel: null,
			available: true,
			cached: false,
			meters: [],
			observedAt: "2026-10-14T00:00:00Z",
			providerId: "claude-pro-max",
			windows: [],
		};
		globalThis.fetch = createFetchFixture(
			(_input: RequestInfo | URL, init?: RequestInit) => {
				requestBody = init?.body;
				return Promise.resolve(Response.json(reading));
			}
		);
		const snapshot = await queryProviderUsage(
			target,
			"claude-pro-max",
			"acct_2"
		);
		expect(snapshot).toEqual(reading);
		expect(snapshot.accountId).toBe("acct_2");
		expect(JSON.parse(String(requestBody))).toEqual({
			provider_id: "claude-pro-max",
			account_id: "acct_2",
		});
	});

	test("provider discovery keeps label-free accounts and capabilities", async () => {
		const providers: UsageProviderOption[] = [
			{
				accounts: [
					{
						accountId: "acct_1",
						active: true,
						kind: "oauth",
						needsReauth: false,
					},
				],
				capabilities: { accountUsage: true },
				kind: "subscription",
				label: "Claude Pro/Max",
				providerId: "claude-pro-max",
			},
			{ kind: "api_credits", label: "OpenRouter", providerId: "openrouter" },
		];
		stubJson(JSON.stringify({ providers }));
		expect(await listUsageProviders(target)).toEqual(providers);
	});

	test("provider_usage_reset monitors round-trip account_id", async () => {
		const pinned: Monitor = {
			...monitorFixture,
			check: {
				type: "provider_usage_reset",
				provider_id: "claude-pro-max",
				account_id: "acct_2",
				target_ids: ["window:Session::18000"],
				minimum_drop_percent: 20,
			},
			url: "ryu-usage://claude-pro-max",
		};
		const followActive: Monitor = {
			...pinned,
			check: {
				type: "provider_usage_reset",
				provider_id: "claude-pro-max",
				target_ids: ["window:Session::18000"],
				minimum_drop_percent: 20,
			},
			id: "m2",
		};
		stubJson(JSON.stringify({ monitors: [pinned, followActive] }));
		const listed = await listMonitors(target);
		expect(listed).toEqual([pinned, followActive]);
		expect(listed[1]?.check).not.toHaveProperty("account_id");
	});
});

describe("streamMonitorAlerts", () => {
	function alertPayload(id: number, title: string): string {
		const alert: Alert = {
			acknowledged: false,
			created_at: "2026-01-01T00:00:00Z",
			id,
			kind: "uptime",
			message: title,
			monitor_id: "monitor-1",
			monitor_name: "Site",
			title,
		};
		return JSON.stringify(alert);
	}

	function streamOnce(chunks: string[], init?: ResponseInit): void {
		const encoder = new TextEncoder();
		globalThis.fetch = createFetchFixture(() =>
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
			)
		);
	}

	async function collect(chunks: string[]): Promise<Alert[]> {
		streamOnce(chunks);
		const seen: Alert[] = [];
		await streamMonitorAlerts(target, (a) => seen.push(a));
		return seen;
	}

	test("emits one alert per data frame", async () => {
		const seen = await collect([
			`data: ${alertPayload(1, "Down")}\n\n`,
			`data: ${alertPayload(2, "Up")}\n\n`,
		]);
		expect(seen.map((a) => a.id)).toEqual([1, 2]);
	});

	test("stitches an alert split across two chunks and skips a bad frame", async () => {
		const payload = alertPayload(1, "Split");
		const seen = await collect([
			`data: ${payload.slice(0, 20)}`,
			`${payload.slice(20)}\n\n`,
			"data: {broken\n\n",
			'data: {"id":2,"title":"missing required alert fields"}\n\n',
			`data: ${alertPayload(2, "ok")}\n\n`,
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
