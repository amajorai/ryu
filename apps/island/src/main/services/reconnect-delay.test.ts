import { afterEach, expect, spyOn, test } from "bun:test";
import { waitForReconnect } from "./reconnect-delay.ts";

afterEach(() => {
	// Restore any spies installed by a test.
	for (const spy of spies.splice(0)) {
		spy.mockRestore();
	}
});

const spies: { mockRestore: () => void }[] = [];

function settledFlag(promise: Promise<void>): { settled: boolean } {
	const flag = { settled: false };
	promise.then(() => {
		flag.settled = true;
	});
	return flag;
}

test("resolves only once the delay elapses", async () => {
	const controller = new AbortController();
	const started = performance.now();
	const pending = waitForReconnect(controller.signal, 40);
	const flag = settledFlag(pending);
	// A shorter timer registered later fires first; the 40ms wait must still be pending.
	await waitForReconnect(controller.signal, 5);
	expect(flag.settled).toBe(false);
	await pending;
	expect(performance.now() - started).toBeGreaterThanOrEqual(35);
});

test("resolves immediately when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	const setTimeoutSpy = spyOn(globalThis, "setTimeout");
	spies.push(setTimeoutSpy);
	const flag = settledFlag(waitForReconnect(controller.signal, 60_000));
	await Promise.resolve();
	await Promise.resolve();
	expect(flag.settled).toBe(true);
	expect(setTimeoutSpy).not.toHaveBeenCalled();
});

test("abort resolves early, clears the timer and removes the listener", async () => {
	const controller = new AbortController();
	const clearSpy = spyOn(globalThis, "clearTimeout");
	const removeSpy = spyOn(controller.signal, "removeEventListener");
	spies.push(clearSpy, removeSpy);
	const pending = waitForReconnect(controller.signal, 60_000);
	const flag = settledFlag(pending);
	await Promise.resolve();
	expect(flag.settled).toBe(false);
	controller.abort();
	await pending;
	expect(flag.settled).toBe(true);
	expect(clearSpy).toHaveBeenCalledTimes(1);
	expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
});

test("an elapsed delay releases its abort listener", async () => {
	const controller = new AbortController();
	const removeSpy = spyOn(controller.signal, "removeEventListener");
	const addSpy = spyOn(controller.signal, "addEventListener");
	spies.push(removeSpy, addSpy);
	await waitForReconnect(controller.signal, 1);
	expect(addSpy).toHaveBeenCalledTimes(1);
	const listener = addSpy.mock.calls[0]?.[1];
	expect(removeSpy).toHaveBeenCalledWith("abort", listener);
});
