// Reading-direction helpers: scroll math and arrow keys under dir="rtl",
// where engines report scrollLeft from 0 down to negative values.
import "./board-test-dom.ts";
import { describe, expect, test } from "bun:test";
import { DirectionProvider } from "@ryu/ui/components/direction.tsx";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	inlineArrowStep,
	logicalArrowKey,
	logicalScroll,
	logicalSpan,
	useInlineSign,
} from "./inline-direction.ts";

/** A horizontal scroller with fixed metrics and a recorded scrollTo. */
function scroller(direction: "ltr" | "rtl", scrollLeft: number) {
	const element = document.createElement("div");
	element.style.direction = direction;
	document.body.append(element);
	const calls: ScrollToOptions[] = [];
	Object.defineProperties(element, {
		clientWidth: { configurable: true, value: 300 },
		scrollLeft: { configurable: true, value: scrollLeft },
		scrollWidth: { configurable: true, value: 1000 },
	});
	element.scrollTo = ((options: ScrollToOptions) => {
		calls.push(options);
	}) as typeof element.scrollTo;
	return { calls, element };
}

describe("logicalScroll", () => {
	test("reads an LTR scroller as is", () => {
		const { calls, element } = scroller("ltr", 120);
		const scroll = logicalScroll(element);
		expect(scroll).toMatchObject({ max: 700, position: 120, sign: 1 });
		scroll.scrollToLogical(400);
		expect(calls).toEqual([{ left: 400 }]);
	});

	test("normalizes a negative RTL scrollLeft and negates targets", () => {
		const { calls, element } = scroller("rtl", -120);
		const scroll = logicalScroll(element);
		expect(scroll).toMatchObject({ max: 700, position: 120, sign: -1 });
		scroll.scrollToLogical(400, "smooth");
		expect(calls).toEqual([{ behavior: "smooth", left: -400 }]);
	});
});

describe("logicalSpan", () => {
	const container = { left: 100, right: 400 };
	const box = { left: 150, right: 250 };
	test("measures from the left edge in LTR", () => {
		expect(logicalSpan(box, container, 1)).toEqual({ end: 150, start: 50 });
	});
	test("measures from the right edge in RTL", () => {
		expect(logicalSpan(box, container, -1)).toEqual({ end: 250, start: 150 });
	});
});

describe("arrow keys", () => {
	test("pass through in LTR", () => {
		const { element } = scroller("ltr", 0);
		expect(logicalArrowKey("ArrowLeft", element)).toBe("ArrowLeft");
		expect(inlineArrowStep("ArrowRight", element)).toBe(1);
	});
	test("swap left and right in RTL and leave other keys alone", () => {
		const { element } = scroller("rtl", 0);
		expect(logicalArrowKey("ArrowLeft", element)).toBe("ArrowRight");
		expect(logicalArrowKey("ArrowRight", element)).toBe("ArrowLeft");
		expect(logicalArrowKey("ArrowUp", element)).toBe("ArrowUp");
		expect(inlineArrowStep("ArrowLeft", element)).toBe(1);
		expect(inlineArrowStep("ArrowRight", element)).toBe(-1);
		expect(inlineArrowStep("Home", element)).toBe(0);
	});
});

describe("useInlineSign", () => {
	function SignProbe() {
		return createElement("output", null, String(useInlineSign()));
	}
	const signUnder = (direction?: "ltr" | "rtl") =>
		renderToStaticMarkup(
			direction
				? createElement(
						DirectionProvider,
						{ direction },
						createElement(SignProbe)
					)
				: createElement(SignProbe)
		);
	test("is 1 left-to-right and without a direction provider", () => {
		expect(signUnder("ltr")).toBe("<output>1</output>");
		expect(signUnder()).toBe("<output>1</output>");
	});
	test("is -1 right-to-left", () => {
		expect(signUnder("rtl")).toBe("<output>-1</output>");
	});
});
