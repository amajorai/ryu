import { describe, expect, test } from "bun:test";
import { HORIZONTAL_WHEEL_SCROLL_SCRIPT } from "./horizontal-wheel-scroll-script.ts";

interface FakeElement {
	clientHeight: number;
	clientWidth: number;
	direction: "ltr" | "rtl";
	overflowX: string;
	parentElement: FakeElement | null;
	scrollHeight: number;
	scrollLeft: number;
	scrollWidth: number;
}

interface FakeWheelEvent {
	ctrlKey: boolean;
	defaultPrevented: boolean;
	deltaMode: number;
	deltaX: number;
	deltaY: number;
	preventDefault: () => void;
	target: FakeElement;
}

type WheelListener = (event: FakeWheelEvent) => void;

function strip(direction: "ltr" | "rtl"): FakeElement {
	let scrollLeft = 0;
	const result: FakeElement = {
		clientHeight: 40,
		clientWidth: 100,
		direction,
		overflowX: "auto",
		parentElement: null,
		scrollHeight: 40,
		scrollLeft: 0,
		scrollWidth: 500,
	};
	Object.defineProperty(result, "scrollLeft", {
		get: () => scrollLeft,
		set: (value: number) => {
			const range = result.scrollWidth - result.clientWidth;
			// Chromium and WebKit run RTL scrollLeft from 0 toward -range.
			scrollLeft =
				direction === "rtl"
					? Math.min(Math.max(-range, value), 0)
					: Math.min(Math.max(0, value), range);
		},
	});
	return result;
}

/** Run the sandbox script against a minimal window/document and return its listener. */
function installScript(): WheelListener {
	let listener: WheelListener | null = null;
	const fakeDocument = {
		addEventListener(type: string, handler: WheelListener) {
			if (type === "wheel") {
				listener = handler;
			}
		},
	};
	const fakeGetComputedStyle = (element: FakeElement) => ({
		direction: element.direction,
		overflowX: element.overflowX,
	});
	const run = new Function(
		"window",
		"document",
		"getComputedStyle",
		HORIZONTAL_WHEEL_SCROLL_SCRIPT
	);
	run({}, fakeDocument, fakeGetComputedStyle);
	if (!listener) {
		throw new Error("the sandbox script did not install a wheel listener");
	}
	return listener;
}

function wheel(
	target: FakeElement,
	deltaY: number,
	deltaX = 0
): FakeWheelEvent & { prevented: number } {
	return {
		ctrlKey: false,
		defaultPrevented: false,
		deltaMode: 0,
		deltaX,
		deltaY,
		prevented: 0,
		preventDefault() {
			this.prevented += 1;
		},
		target,
	};
}

describe("sandbox horizontal wheel script", () => {
	test("left-to-right: wheel-down moves toward the inline end", () => {
		const onWheel = installScript();
		const element = strip("ltr");
		const event = wheel(element, 30);

		onWheel(event);

		expect(element.scrollLeft).toBe(30);
		expect(event.prevented).toBe(1);
	});

	test("right-to-left: wheel-down moves toward the inline end", () => {
		const onWheel = installScript();
		const element = strip("rtl");
		const down = wheel(element, 30);

		onWheel(down);

		expect(element.scrollLeft).toBe(-30);
		expect(down.prevented).toBe(1);

		const up = wheel(element, -30);
		onWheel(up);

		expect(element.scrollLeft).toBe(0);
		expect(up.prevented).toBe(1);
	});

	test("right-to-left: deltaX stays physical", () => {
		const onWheel = installScript();
		const element = strip("rtl");

		onWheel(wheel(element, 6, -4));

		expect(element.scrollLeft).toBe(-10);
	});
});
