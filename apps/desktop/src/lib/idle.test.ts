import { afterEach, describe, expect, it } from "bun:test";

import { runWhenIdle } from "./idle.ts";

const GLOBALS = [
	"requestIdleCallback",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"document",
] as const;
const originals = new Map(
	GLOBALS.map((name) => [name, Reflect.get(globalThis, name)])
);

afterEach(() => {
	for (const [name, value] of originals) {
		Reflect.set(globalThis, name, value);
	}
});

function withoutIdleApis(): void {
	for (const name of GLOBALS) {
		Reflect.set(globalThis, name, undefined);
	}
}

/** A frame scheduler whose frames run only when `flush()` is called, like a
 *  WebKit page whose frames are suspended until then. */
function manualFrames() {
	withoutIdleApis();
	const frames = new Map<number, () => void>();
	let next = 0;
	Reflect.set(globalThis, "requestAnimationFrame", (callback: () => void) => {
		next += 1;
		frames.set(next, callback);
		return next;
	});
	Reflect.set(globalThis, "cancelAnimationFrame", (id: number) => {
		frames.delete(id);
	});
	return {
		pending: () => frames.size,
		flush: () => {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback();
			}
		},
	};
}

/** A document whose load and visibility state the test drives. */
function fakePage(
	visibilityState: DocumentVisibilityState,
	readyState: DocumentReadyState
) {
	const page = Object.assign(new EventTarget(), {
		readyState,
		visibilityState,
	});
	Reflect.set(globalThis, "document", page);
	return {
		set(next: Partial<typeof page>, type: string) {
			Object.assign(page, next);
			page.dispatchEvent(new Event(type));
		},
	};
}

describe("runWhenIdle", () => {
	it("hands the timeout to requestIdleCallback when it exists", () => {
		withoutIdleApis();
		const requests: { timeout?: number }[] = [];
		let idle: (() => void) | undefined;
		Reflect.set(
			globalThis,
			"requestIdleCallback",
			(callback: () => void, options: { timeout?: number }) => {
				idle = callback;
				requests.push(options);
				return 1;
			}
		);
		let runs = 0;
		runWhenIdle(() => {
			runs += 1;
		}, 1234);
		expect(requests).toEqual([{ timeout: 1234 }]);
		expect(runs).toBe(0);
		idle?.();
		expect(runs).toBe(1);
	});

	it("runs on the next frame of a visible page, once", () => {
		const frames = manualFrames();
		const page = fakePage("visible", "complete");
		let runs = 0;
		runWhenIdle(() => {
			runs += 1;
		});
		expect(runs).toBe(0);
		frames.flush();
		expect(runs).toBe(1);
		// The page listeners are gone: hiding it later does not run it again.
		page.set({ visibilityState: "hidden" }, "visibilitychange");
		expect(runs).toBe(1);
	});

	it("runs once a hidden page has loaded, without waiting for a frame", () => {
		const frames = manualFrames();
		const page = fakePage("hidden", "interactive");
		let runs = 0;
		runWhenIdle(() => {
			runs += 1;
		});
		expect(runs).toBe(0);
		page.set({ readyState: "complete" }, "readystatechange");
		expect(runs).toBe(1);
		// The frame was cancelled, and a late frame would not run it again.
		expect(frames.pending()).toBe(0);
		frames.flush();
		expect(runs).toBe(1);
	});

	it("runs when a loaded page is hidden before its frame", () => {
		const frames = manualFrames();
		const page = fakePage("visible", "complete");
		let runs = 0;
		runWhenIdle(() => {
			runs += 1;
		});
		page.set({ visibilityState: "hidden" }, "visibilitychange");
		expect(runs).toBe(1);
		expect(frames.pending()).toBe(0);
	});

	it("runs now on a page that is already hidden and loaded", () => {
		manualFrames();
		fakePage("hidden", "complete");
		let runs = 0;
		runWhenIdle(() => {
			runs += 1;
		});
		expect(runs).toBe(1);
	});

	it("runs now with neither API", () => {
		withoutIdleApis();
		let runs = 0;
		runWhenIdle(() => {
			runs += 1;
		});
		expect(runs).toBe(1);
	});
});
