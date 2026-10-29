import { afterEach, expect, test } from "bun:test";
import {
	localizeNativeCopy,
	registerNativeCopyTranslator,
} from "./native-copy.ts";

let dispose: (() => void) | null = null;
afterEach(() => {
	dispose?.();
	dispose = null;
});

test("passes text through without a translator", () => {
	expect(localizeNativeCopy("Video")).toBe("Video");
	expect(localizeNativeCopy(null)).toBeNull();
});

test("uses the registered translator", () => {
	dispose = registerNativeCopyTranslator((text) => `fr:${text}`);
	expect(localizeNativeCopy("Video")).toBe("fr:Video");
	expect(localizeNativeCopy("")).toBe("");
});

test("a stale disposer leaves a newer translator in place", () => {
	const first = registerNativeCopyTranslator(() => "first");
	dispose = registerNativeCopyTranslator(() => "second");
	first();
	expect(localizeNativeCopy("x")).toBe("second");
});

test("a throwing translator falls back to the source", () => {
	dispose = registerNativeCopyTranslator(() => {
		throw new Error("boom");
	});
	expect(localizeNativeCopy("Video")).toBe("Video");
});
