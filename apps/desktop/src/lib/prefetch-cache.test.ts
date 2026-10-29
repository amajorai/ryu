import { expect, test } from "bun:test";
import { createPrefetchCache } from "./prefetch-cache.ts";

function clock(start = 1000) {
	let at = start;
	return {
		advance: (ms: number) => {
			at += ms;
		},
		now: () => at,
	};
}

test("a prefetched value is handed over once", async () => {
	const time = clock();
	const cache = createPrefetchCache<string>(10_000, time.now);
	let loads = 0;
	cache.start("a", 1, () => {
		loads++;
		return Promise.resolve("page");
	});
	cache.start("a", 1, () => {
		loads++;
		return Promise.resolve("again");
	});
	expect(loads).toBe(1);
	expect(await cache.take("a", 1)).toBe("page");
	expect(cache.take("a", 1)).toBeUndefined();
});

test("an expired prefetch is not used and can be restarted", () => {
	const time = clock();
	const cache = createPrefetchCache<string>(10_000, time.now);
	cache.start("a", 1, () => Promise.resolve("old"));
	time.advance(10_000);
	expect(cache.take("a", 1)).toBeUndefined();

	cache.start("a", 1, () => Promise.resolve("old"));
	time.advance(10_000);
	let restarted = false;
	cache.start("a", 1, () => {
		restarted = true;
		return Promise.resolve("new");
	});
	expect(restarted).toBe(true);
});

test("a prefetch taken for a newer version is discarded", () => {
	const time = clock();
	const cache = createPrefetchCache<string>(10_000, time.now);
	cache.start("a", 1, () => Promise.resolve("before the new turn"));
	expect(cache.take("a", 2)).toBeUndefined();
	// Discarded, not kept for a later caller.
	expect(cache.take("a", 1)).toBeUndefined();
});
