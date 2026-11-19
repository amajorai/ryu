import { expect, test } from "bun:test";
import type { VaultEventMessage } from "@ryuhq/core-client/vault-events";
import { isRefusal, watchVaultChanges } from "./vault-change-stream.ts";

const change = (seq: number): VaultEventMessage => ({
	event: { action: "write", at: "2026-11-13T00:00:00Z", seq, type: "kv-write" },
	kind: "event",
});

async function* messages(list: VaultEventMessage[]) {
	for (const message of list) {
		yield message;
	}
}

/** Timers that fire only when `flush` runs, so bursts are observable. */
function manualTimers() {
	const queued = new Map<number, () => void>();
	let next = 0;
	return {
		clearTimer: (handle: unknown) => queued.delete(handle as number),
		flush: () => {
			for (const [id, fn] of [...queued]) {
				queued.delete(id);
				fn();
			}
		},
		setTimer: (fn: () => void) => {
			next += 1;
			queued.set(next, fn);
			return next;
		},
	};
}

test("a burst of changes refreshes once, and each later burst once more", async () => {
	const controller = new AbortController();
	const timers = manualTimers();
	let refreshes = 0;
	let opens = 0;
	const done = watchVaultChanges({
		...timers,
		onChange: () => {
			refreshes += 1;
		},
		open: () => {
			opens += 1;
			if (opens === 1) {
				return Promise.resolve(
					messages([change(1), change(2), { kind: "lagged", skipped: 4 }])
				);
			}
			controller.abort();
			return Promise.resolve(messages([]));
		},
		signal: controller.signal,
		sleep: () => {
			timers.flush();
			return Promise.resolve();
		},
	});
	expect(await done).toBe("aborted");
	expect(refreshes).toBe(1);
	expect(opens).toBe(2);
});

test("a dropped or failed stream reconnects with growing, capped backoff", async () => {
	const controller = new AbortController();
	const delays: number[] = [];
	let opens = 0;
	const result = await watchVaultChanges({
		backoffMs: [10, 20, 40],
		onChange: () => undefined,
		open: () => {
			opens += 1;
			if (opens === 5) {
				controller.abort();
			}
			return opens % 2 === 0
				? Promise.reject(new Error("connection reset"))
				: Promise.resolve(messages([]));
		},
		signal: controller.signal,
		sleep: (ms) => {
			delays.push(ms);
			return Promise.resolve();
		},
	});
	expect(result).toBe("aborted");
	expect(delays).toEqual([10, 20, 40, 40]);
});

test("a refusal stops watching instead of retrying", async () => {
	const controller = new AbortController();
	let opens = 0;
	const result = await watchVaultChanges({
		onChange: () => undefined,
		open: () => {
			opens += 1;
			return Promise.reject(
				Object.assign(new Error("denied"), { status: 403 })
			);
		},
		signal: controller.signal,
		sleep: () => Promise.resolve(),
	});
	expect(result).toBe("refused");
	expect(opens).toBe(1);
});

test("no refresh fires after the watch is aborted", async () => {
	const controller = new AbortController();
	const timers = manualTimers();
	let refreshes = 0;
	await watchVaultChanges({
		...timers,
		onChange: () => {
			refreshes += 1;
		},
		open: async () => {
			async function* oneThenAbort() {
				yield change(1);
				controller.abort();
			}
			return await Promise.resolve(oneThenAbort());
		},
		signal: controller.signal,
	});
	timers.flush();
	expect(refreshes).toBe(0);
});

test("refusals are 401, 403 and 404 only", () => {
	for (const status of [401, 403, 404]) {
		expect(isRefusal({ status })).toBe(true);
	}
	for (const error of [
		{ status: 500 },
		{ status: 503 },
		new Error("x"),
		null,
	]) {
		expect(isRefusal(error)).toBe(false);
	}
});
