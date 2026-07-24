// Unit tests for composeRefs: the radix-derived ref-composition utility that
// fans one node out to a mix of callback refs and RefObject(s), and returns a
// React-19 cleanup only when a child ref itself returned one.

import { describe, expect, test } from "bun:test";
import type { RefCallback } from "react";
import { composeRefs } from "./compose-refs.ts";

describe("composeRefs", () => {
	test("assigns the node to both a callback ref and a RefObject", () => {
		let fromCallback: string | null = null;
		const objectRef: { current: string | null } = { current: null };
		const composed = composeRefs<string>((v) => {
			fromCallback = v;
		}, objectRef);

		composed("node");
		expect(fromCallback).toBe("node");
		expect(objectRef.current).toBe("node");
	});

	test("tolerates null / undefined refs in the list", () => {
		const objectRef: { current: string | null } = { current: null };
		const composed = composeRefs<string>(null, undefined, objectRef);
		expect(() => composed("n")).not.toThrow();
		expect(objectRef.current).toBe("n");
	});

	test("returns no cleanup when no child ref returned one", () => {
		const composed = composeRefs<string>(() => {
			// callback ref returning void
		});
		expect(composed("n")).toBeUndefined();
	});

	test("returns a cleanup that invokes each child ref's own cleanup (React 19)", () => {
		let cleaned = false;
		const cleanupRef: RefCallback<string> = () => () => {
			cleaned = true;
		};
		const composed = composeRefs<string>(cleanupRef);
		const cleanup = composed("n");
		expect(typeof cleanup).toBe("function");
		(cleanup as () => void)();
		expect(cleaned).toBe(true);
	});

	test("when one child returns a cleanup, refs without one are reset to null", () => {
		const objectRef: { current: string | null } = { current: null };
		let cleaned = false;
		const cleanupRef: RefCallback<string> = () => () => {
			cleaned = true;
		};
		const composed = composeRefs<string>(cleanupRef, objectRef);
		const cleanup = composed("node") as () => void;
		expect(objectRef.current).toBe("node");
		cleanup();
		expect(cleaned).toBe(true);
		// The object ref had no cleanup fn of its own, so it is nulled out.
		expect(objectRef.current).toBeNull();
	});
});
