import { describe, expect, test } from "bun:test";
import {
	createHorizontalWheelHandler,
	type HorizontalWheelElement,
	type HorizontalWheelEvent,
	installHorizontalWheelScrolling,
	normalizeWheelDelta,
} from "./horizontal-wheel-scroll.ts";

type TestElement = HorizontalWheelElement & { overflowX: string };
const overflowValues = new WeakMap<HorizontalWheelElement, string>();

function element(overrides: Partial<TestElement> = {}): TestElement {
	let scrollLeft = overrides.scrollLeft ?? 0;
	const result: TestElement = {
		clientHeight: 100,
		clientWidth: 100,
		overflowX: "auto",
		parentElement: null,
		scrollHeight: 100,
		scrollLeft,
		scrollWidth: 100,
		...overrides,
	};
	Object.defineProperty(result, "scrollLeft", {
		configurable: true,
		get: () => scrollLeft,
		set: (value: number) => {
			scrollLeft = Math.min(
				Math.max(0, value),
				Math.max(0, result.scrollWidth - result.clientWidth)
			);
		},
	});
	overflowValues.set(result, result.overflowX);
	return result;
}

function wheelEvent(
	overrides: Partial<HorizontalWheelEvent> = {}
): HorizontalWheelEvent & { prevented: number } {
	const event = {
		ctrlKey: false,
		defaultPrevented: false,
		deltaMode: 0,
		deltaX: 0,
		deltaY: 0,
		prevented: 0,
		target: null,
		preventDefault() {
			this.prevented += 1;
		},
		...overrides,
	};
	return event;
}

function handler() {
	return createHorizontalWheelHandler(
		(candidate) => overflowValues.get(candidate) ?? ""
	);
}

describe("horizontal wheel scrolling", () => {
	test("moves an eligible horizontal-only container in both directions", () => {
		const scroller = element({ scrollWidth: 500 });
		const onWheel = handler();

		const right = wheelEvent({ deltaY: 1, target: scroller });
		onWheel(right);

		expect(scroller.scrollLeft).toBe(1);
		expect(right.prevented).toBe(1);

		const left = wheelEvent({ deltaY: -1, target: scroller });
		onWheel(left);

		expect(scroller.scrollLeft).toBe(0);
		expect(left.prevented).toBe(1);
	});

	test("normalizes line and page wheel deltas", () => {
		expect(normalizeWheelDelta(2, 0, 300)).toBe(2);
		expect(normalizeWheelDelta(2, 1, 300)).toBe(32);
		expect(normalizeWheelDelta(2, 2, 300)).toBe(600);

		const scroller = element({ clientHeight: 300, scrollWidth: 1000 });
		const event = wheelEvent({ deltaMode: 2, deltaY: 1, target: scroller });
		handler()(event);

		expect(scroller.scrollLeft).toBe(300);
	});

	test("skips vertical overflow and clipped horizontal content", () => {
		const vertical = element({
			scrollHeight: 500,
			scrollWidth: 500,
		});
		const hidden = element({
			overflowX: "hidden",
			scrollWidth: 500,
		});

		const verticalEvent = wheelEvent({ deltaY: 10, target: vertical });
		const hiddenEvent = wheelEvent({ deltaY: 10, target: hidden });
		handler()(verticalEvent);
		handler()(hiddenEvent);

		expect(vertical.scrollLeft).toBe(0);
		expect(verticalEvent.prevented).toBe(0);
		expect(hidden.scrollLeft).toBe(0);
		expect(hiddenEvent.prevented).toBe(0);
	});

	test("falls through an edge-locked nested scroller to its parent", () => {
		const parent = element({ scrollWidth: 500 });
		const nested = element({
			parentElement: parent,
			scrollLeft: 100,
			scrollWidth: 200,
		});
		const event = wheelEvent({ deltaY: 10, target: nested });

		handler()(event);

		expect(nested.scrollLeft).toBe(100);
		expect(parent.scrollLeft).toBe(10);
		expect(event.prevented).toBe(1);
	});

	test("leaves an edge-locked event native when no container can move", () => {
		const scroller = element({ scrollLeft: 100, scrollWidth: 200 });
		const event = wheelEvent({ deltaY: 10, target: scroller });

		handler()(event);

		expect(scroller.scrollLeft).toBe(100);
		expect(event.prevented).toBe(0);
	});

	test("preserves deltaX when handling a vertical wheel delta", () => {
		const scroller = element({ scrollWidth: 500 });
		const event = wheelEvent({ deltaX: 4, deltaY: 6, target: scroller });

		handler()(event);

		expect(scroller.scrollLeft).toBe(10);
		expect(event.prevented).toBe(1);

		const nativeTrackpadEvent = wheelEvent({ deltaX: 4, target: scroller });
		handler()(nativeTrackpadEvent);

		expect(scroller.scrollLeft).toBe(10);
		expect(nativeTrackpadEvent.prevented).toBe(0);
	});

	test("ignores pinch zoom and already-cancelled events", () => {
		const scroller = element({ scrollWidth: 500 });
		const pinch = wheelEvent({ ctrlKey: true, deltaY: 10, target: scroller });
		const cancelled = wheelEvent({
			defaultPrevented: true,
			deltaY: 10,
			target: scroller,
		});

		handler()(pinch);
		handler()(cancelled);

		expect(scroller.scrollLeft).toBe(0);
		expect(pinch.prevented).toBe(0);
		expect(cancelled.prevented).toBe(0);
	});

	test("installs one listener per document and cleans it up", () => {
		let added = 0;
		let removed = 0;
		const documentLike = {
			addEventListener() {
				added += 1;
			},
			removeEventListener() {
				removed += 1;
			},
		};

		const cleanup = installHorizontalWheelScrolling(documentLike);
		const duplicateCleanup = installHorizontalWheelScrolling(documentLike);

		expect(added).toBe(1);
		duplicateCleanup();
		expect(removed).toBe(0);
		cleanup();
		expect(removed).toBe(1);
	});
});
