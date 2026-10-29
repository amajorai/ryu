import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { z } from "zod";
import { ownAppRequest } from "./app-request.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		cleanup();
	}
});
function fixture(statuses: number[]) {
	let calls = 0;
	const server = Bun.serve({
		port: 0,
		fetch() {
			const status = statuses[Math.min(calls++, statuses.length - 1)];
			return Response.json({ ready: status === 200 }, { status });
		},
	});
	cleanups.push(() => server.stop(true));
	return {
		target: {
			url: server.url.toString(),
			token: null,
			userJwt: "fixture-user",
		},
		calls: () => calls,
	};
}
test("startup reads retry transient failures within the existing budget; writes do not", async () => {
	const read = fixture([503, 502, 200]);
	const controller = new AbortController();
	expect(
		await ownAppRequest(read.target, "fixture", {
			path: "/status",
			signal: controller.signal,
		})
	).toEqual({ ready: true });
	expect(read.calls()).toBe(3);
	expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	const exhausted = fixture([503]);
	await expect(
		ownAppRequest(exhausted.target, "fixture", { path: "/status" })
	).rejects.toThrow();
	expect(exhausted.calls()).toBe(3);
	const write = fixture([503, 200]);
	await expect(
		ownAppRequest(write.target, "fixture", { path: "/status", method: "POST" })
	).rejects.toThrow();
	expect(write.calls()).toBe(1);
});

test("cancelling a startup retry clears its wait and starts no further fetch", async () => {
	const read = fixture([503, 200]);
	const controller = new AbortController();
	const reason = new Error("fixture closed");
	const originalTimer = globalThis.setTimeout;
	const originalClear = globalThis.clearTimeout;
	let retryTimer: ReturnType<typeof originalTimer> | undefined;
	let cleared = false;
	globalThis.setTimeout = new Proxy(originalTimer, {
		apply(timer, receiver, args) {
			// Bind preserves the native receiver while the direct call retains all
			// timer overloads and forwards the callback arguments intact.
			const result = timer.bind(receiver)(args[0], args[1], ...args.slice(2));
			if (z.literal(100).safeParse(args[1]).success) {
				retryTimer = result;
				queueMicrotask(() => controller.abort(reason));
			}
			return result;
		},
	});
	globalThis.clearTimeout = new Proxy(originalClear, {
		apply(clear, receiver, args) {
			const timer = args[0];
			if (timer === retryTimer) {
				cleared = true;
			}
			return clear.call(receiver, timer);
		},
	});
	cleanups.push(() => {
		globalThis.setTimeout = originalTimer;
		globalThis.clearTimeout = originalClear;
	});
	await expect(
		ownAppRequest(read.target, "fixture", {
			path: "/status",
			signal: controller.signal,
		})
	).rejects.toBe(reason);
	expect(cleared).toBe(true);
	expect(read.calls()).toBe(1);
	expect(getEventListeners(controller.signal, "abort").length).toBe(0);
});
