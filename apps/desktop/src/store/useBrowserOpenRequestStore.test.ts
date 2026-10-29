import { expect, test } from "bun:test";
import { useBrowserOpenRequestStore } from "./useBrowserOpenRequestStore.ts";

test("a repeated request for the same URL after the panel consumed the first gets a new nonce", () => {
	const store = useBrowserOpenRequestStore.getState();
	store.open("https://example.com");
	const first = useBrowserOpenRequestStore.getState().pending;
	// The Browser panel clears the request as soon as it consumes it.
	store.clear();
	expect(useBrowserOpenRequestStore.getState().pending).toBeNull();
	store.open("https://example.com");
	const second = useBrowserOpenRequestStore.getState().pending;
	expect(first?.url).toBe("https://example.com");
	expect(second?.url).toBe("https://example.com");
	expect(second?.nonce).not.toBe(first?.nonce);
	expect(second?.nonce ?? 0).toBeGreaterThan(first?.nonce ?? 0);
});
