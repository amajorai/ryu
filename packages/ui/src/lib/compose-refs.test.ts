// Unit tests for composeRefs: the radix-derived ref-composition utility that
// fans one node out to a mix of callback refs and RefObject(s), and returns a
// React-19 cleanup only when a child ref itself returned one.

import { describe, expect, test } from "bun:test";
import { createRef, type RefCallback } from "react";
import { composeRefs } from "./compose-refs.ts";

describe("composeRefs", () => {
	test("assigns the node to both a callback ref and a RefObject", () => {
		const observed = createRef<string>();
		const objectRef = createRef<string>();
		const composed = composeRefs<string>((v) => {
			observed.current = v;
		}, objectRef);

		composed("node");
		expect(observed.current).toBe("node");
		expect(objectRef.current).toBe("node");
	});

	test("tolerates null / undefined refs in the list", () => {
		const objectRef = createRef<string>();
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
		expect(cleanup).toBeInstanceOf(Function);
		if (!cleanup) {
			throw new Error("Expected the React callback-ref cleanup");
		}
		cleanup();
		expect(cleaned).toBe(true);
	});

	test("when one child returns a cleanup, refs without one are reset to null", () => {
		const objectRef = createRef<string>();
		let cleaned = false;
		const cleanupRef: RefCallback<string> = () => () => {
			cleaned = true;
		};
		const composed = composeRefs<string>(cleanupRef, objectRef);
		const cleanup = composed("node");
		if (!cleanup) {
			throw new Error("Expected the React callback-ref cleanup");
		}
		expect(objectRef.current).toBe("node");
		cleanup();
		expect(cleaned).toBe(true);
		// The object ref had no cleanup fn of its own, so it is nulled out.
		expect(objectRef.current).toBeNull();
	});
});
