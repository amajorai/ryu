// The credit-alert stream is mounted for every signed-in window, so a refusal
// that only user action can clear (signed out or revoked, no active org, org
// access policy) must drop to the slow cadence instead of repeating every 10s
// for the whole session — the same rule `useWalletStream` follows.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

const delays: number[] = [];
let stopAfterDelays = 2;
let controller = new AbortController();
mock.module("@/src/lib/abortable-delay.ts", () => ({
	abortableDelay: (ms: number) => {
		delays.push(ms);
		if (delays.length >= stopAfterDelays) {
			controller.abort();
		}
		return Promise.resolve();
	},
}));

const { TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { runCreditAlertStream } = await import("./useCreditAlertEvents.ts");

const realFetch = globalThis.fetch;
let status = 200;
let connects = 0;

beforeEach(() => {
	delays.length = 0;
	stopAfterDelays = 2;
	controller = new AbortController();
	connects = 0;
	localStorage.setItem(TOKEN_KEY, "credit-alert-session");
	globalThis.fetch = Object.assign(
		() => {
			connects += 1;
			return Promise.resolve(new Response(null, { status }));
		},
		{ preconnect: realFetch.preconnect }
	);
});

afterAll(() => {
	globalThis.fetch = realFetch;
	localStorage.removeItem(TOKEN_KEY);
});

describe("runCreditAlertStream reconnect cadence", () => {
	for (const refused of [401, 403, 409]) {
		it(`waits the terminal interval after a ${refused} instead of reconnecting within 10s`, async () => {
			status = refused;
			await runCreditAlertStream(controller.signal, () => undefined);
			expect(connects).toBe(2);
			expect(delays).toEqual([300_000, 300_000]);
		});
	}

	it("keeps the fast, growing backoff for a transient 500", async () => {
		status = 500;
		stopAfterDelays = 3;
		await runCreditAlertStream(controller.signal, () => undefined);
		expect(connects).toBe(3);
		expect(delays).toEqual([1000, 2000, 4000]);
	});

	it("does not connect without a session token", async () => {
		localStorage.removeItem(TOKEN_KEY);
		status = 401;
		stopAfterDelays = 1;
		await runCreditAlertStream(controller.signal, () => undefined);
		expect(connects).toBe(0);
		expect(delays).toEqual([10_000]);
	});
});
