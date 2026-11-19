// Lease renewal for `ryu-cli secrets run --lease` (`secrets-run-lease-renewal.ts`):
// renewed before expiry by `--lease-ttl`, stopped at the maximum lifetime or a
// refusal, retried after an outage, and never renewed after `stop()` returns.
// Core is a fake `fetch`; time is a manual clock, so nothing waits in real time.

import { expect, test } from "bun:test";
import { vaultLease } from "@ryuhq/core-client/vault";
import {
	type RenewalClock,
	type RenewRequest,
	renewDelay,
	startLeaseRenewal,
	timestampMs,
} from "../cli/secrets-run-lease-renewal.ts";
import {
	fakeNode,
	json,
	jsonExport,
	lease,
	type NodeCall,
	runSecrets,
} from "./secrets-fixture.ts";

const START = Date.parse("2026-06-01T00:00:00Z");
const MINUTE = 60_000;

function manualClock() {
	let now = START;
	const timers: { at: number; resolve: () => void }[] = [];
	const clock: RenewalClock = {
		now: () => now,
		sleep: (ms, signal) =>
			new Promise<void>((resolve) => {
				timers.push({ at: now + ms, resolve });
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
	};
	async function settle() {
		for (let round = 0; round < 10; round++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
	return {
		clock,
		now: () => now,
		settle,
		/** Move time forward, firing due timers one at a time. */
		async advance(ms: number) {
			const until = now + ms;
			for (;;) {
				timers.sort((a, b) => a.at - b.at);
				const due = timers[0];
				if (!due || due.at > until) {
					break;
				}
				timers.shift();
				now = due.at;
				due.resolve();
				await settle();
			}
			now = until;
			await settle();
		},
	};
}

function liveLease(id: string, expiresAt: number, maxExpiresAt: number) {
	return {
		...lease(id),
		createdAt: START,
		expiresAt,
		maxExpiresAt,
	};
}

function capture() {
	let err = "";
	return {
		io: {
			out: () => undefined,
			err: (text: string) => {
				err += text;
			},
		},
		err: () => err,
	};
}

function renewThrough(node: ReturnType<typeof fakeNode>): RenewRequest {
	return async (id, ttlSecs) =>
		(await vaultLease(node.target, id, "renew", ttlSecs)).lease;
}

const renewRoute = (id: string) => `POST /api/vault/leases/${id}/renew`;

test("timestamps and the renew delay", () => {
	expect(timestampMs(1000)).toBe(1000);
	expect(timestampMs("2026-06-01T00:00:00Z")).toBe(START);
	expect(timestampMs("not a date")).toBeNull();
	expect(renewDelay(0, 90_000, 1000)).toBe(60_000);
	expect(renewDelay(0, 600, 1000)).toBe(1000);
});

test("a lease is renewed before it expires until its maximum lifetime", async () => {
	const time = manualClock();
	const max = START + 3 * MINUTE;
	const node = fakeNode({
		[renewRoute("vl_1")]: (call: NodeCall) => {
			const { ttlSecs } = JSON.parse(call.body) as { ttlSecs: number };
			const expiresAt = Math.min(time.now() + ttlSecs * 1000, max);
			return Response.json({ lease: liveLease("vl_1", expiresAt, max) });
		},
	});
	const out = capture();
	const renewal = startLeaseRenewal(
		out,
		[liveLease("vl_1", START + MINUTE, max)],
		renewThrough(node),
		{ clock: time.clock, ttlSecs: 60 }
	);
	await time.settle();
	expect(node.calls).toEqual([]);
	// Two thirds of the first minute: the first renewal.
	await time.advance(40_000);
	expect(node.calls.map((call) => call.route)).toEqual([renewRoute("vl_1")]);
	expect(JSON.parse(node.calls[0]?.body ?? "{}")).toEqual({ ttlSecs: 60 });
	// The lease never expires while renewals keep landing.
	await time.advance(10 * MINUTE);
	const renewals = node.calls.length;
	expect(renewals).toBeGreaterThanOrEqual(3);
	expect(out.err()).toContain("lease vl_1 (db) can no longer be renewed");
	// At the maximum lifetime there is nothing left to renew.
	await time.advance(10 * MINUTE);
	expect(node.calls.length).toBe(renewals);
	await renewal.stop();
});

test("a refused renewal is not retried and is reported without values", async () => {
	const time = manualClock();
	const node = fakeNode({
		[renewRoute("vl_2")]: () =>
			Response.json({ error: "forbidden" }, { status: 403 }),
	});
	const out = capture();
	const renewal = startLeaseRenewal(
		out,
		[liveLease("vl_2", START + MINUTE, START + 60 * MINUTE)],
		renewThrough(node),
		{ clock: time.clock, retryMs: [1000, 1000] }
	);
	await time.advance(5 * MINUTE);
	expect(node.calls.length).toBe(1);
	expect(out.err()).toContain("vl_2");
	expect(out.err()).toContain("can no longer be renewed");
	await renewal.stop();
});

test("an outage is retried and renewal carries on", async () => {
	const time = manualClock();
	let attempts = 0;
	const node = fakeNode({
		[renewRoute("vl_3")]: () => {
			attempts += 1;
			if (attempts === 1) {
				return Response.json({ error: "down" }, { status: 503 });
			}
			return Response.json({
				lease: liveLease("vl_3", time.now() + MINUTE, START + 60 * MINUTE),
			});
		},
	});
	const out = capture();
	const renewal = startLeaseRenewal(
		out,
		[liveLease("vl_3", START + MINUTE, START + 60 * MINUTE)],
		renewThrough(node),
		{ clock: time.clock, retryMs: [2000] }
	);
	await time.advance(40_000);
	expect(attempts).toBe(1);
	await time.advance(2000);
	expect(attempts).toBe(2);
	expect(out.err()).toBe("");
	await renewal.stop();
});

test("a lease that is not renewable or already expired is left alone", async () => {
	const time = manualClock();
	const node = fakeNode({});
	const out = capture();
	const renewal = startLeaseRenewal(
		out,
		[
			{
				...liveLease("vl_4", START + MINUTE, START + 60 * MINUTE),
				renewable: false,
			},
			liveLease("vl_5", START - 1, START + 60 * MINUTE),
		],
		renewThrough(node),
		{ clock: time.clock }
	);
	await time.advance(60 * MINUTE);
	expect(node.calls).toEqual([]);
	expect(out.err()).toBe("");
	await renewal.stop();
});

test("stop() waits for a renewal in flight and no renewal follows it", async () => {
	const time = manualClock();
	let release: () => void = () => undefined;
	const node = fakeNode({
		[renewRoute("vl_6")]: () =>
			new Promise<Response>((resolve) => {
				release = () =>
					resolve(
						Response.json({
							lease: liveLease(
								"vl_6",
								time.now() + MINUTE,
								START + 60 * MINUTE
							),
						})
					);
			}),
	});
	const renewal = startLeaseRenewal(
		capture(),
		[liveLease("vl_6", START + MINUTE, START + 60 * MINUTE)],
		renewThrough(node),
		{ clock: time.clock }
	);
	await time.advance(40_000);
	expect(node.calls.length).toBe(1);
	let stopped = false;
	const stopping = renewal.stop().then(() => {
		stopped = true;
	});
	await time.settle();
	expect(stopped).toBe(false);
	release();
	await stopping;
	expect(stopped).toBe(true);
	await time.advance(60 * MINUTE);
	expect(node.calls.length).toBe(1);
});

test("run --lease revokes after the command and does not renew a short run", async () => {
	const live = {
		...lease("vl_7"),
		expiresAt: Date.now() + 60 * MINUTE,
		maxExpiresAt: Date.now() + 120 * MINUTE,
	};
	const node = fakeNode({
		"POST /api/vault/export": json(jsonExport({})),
		"POST /api/vault/dynamic/issue/db": json({
			credential: { data: { password: "p" }, lease: live },
		}),
		"POST /api/vault/leases/vl_7/revoke": json({
			lease: { ...live, revokedAt: Date.now() },
		}),
	});
	const result = await runSecrets(
		["run", "--no-project", "--lease", "db", "--", "psql"],
		node,
		{ spawn: () => Promise.resolve(0) }
	);
	expect(result.code).toBe(0);
	const routes = node.calls.map((call) => call.route);
	expect(routes).not.toContain(renewRoute("vl_7"));
	expect(routes.at(-1)).toBe("POST /api/vault/leases/vl_7/revoke");
});
