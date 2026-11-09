// Keyboard tests for StarRatingInput's radiogroup under both reading
// directions. The stars run along the inline axis, so under a right-to-left
// layout ArrowLeft moves toward the higher rating and ArrowRight toward the
// lower one; ArrowUp/ArrowDown and Home/End keep their meaning either way.

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});
const { StarRatingInput } = await import("./star-rating.tsx");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
});

/** Render the picker at rating 3 and press `key` on the third star. Happy DOM
 *  does not apply the user-agent `[dir]` rule, so the RTL wrapper also sets the
 *  `direction` property a browser would compute from `dir="rtl"`. */
async function pressOnThirdStar(
	key: string,
	direction: "ltr" | "rtl"
): Promise<number[]> {
	const received: number[] = [];
	await act(() =>
		root.render(
			<div dir={direction} style={{ direction }}>
				<StarRatingInput
					onChange={(rating) => received.push(rating)}
					value={3}
				/>
			</div>
		)
	);
	const star = container.querySelector<HTMLButtonElement>(
		'button[aria-label="3 stars"]'
	);
	if (!star) {
		throw new Error("third star button not rendered");
	}
	await act(() => {
		star.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
	});
	return received;
}

describe("StarRatingInput arrow keys", () => {
	test("right-to-left: ArrowLeft raises the rating", async () => {
		expect(await pressOnThirdStar("ArrowLeft", "rtl")).toEqual([4]);
	});

	test("right-to-left: ArrowRight lowers the rating", async () => {
		expect(await pressOnThirdStar("ArrowRight", "rtl")).toEqual([2]);
	});

	test("right-to-left: ArrowUp and ArrowDown are unchanged", async () => {
		expect(await pressOnThirdStar("ArrowUp", "rtl")).toEqual([4]);
		expect(await pressOnThirdStar("ArrowDown", "rtl")).toEqual([2]);
	});

	test("right-to-left: Home and End still pick the extremes", async () => {
		expect(await pressOnThirdStar("Home", "rtl")).toEqual([1]);
		expect(await pressOnThirdStar("End", "rtl")).toEqual([5]);
	});

	test("left-to-right: ArrowLeft lowers and ArrowRight raises", async () => {
		expect(await pressOnThirdStar("ArrowLeft", "ltr")).toEqual([2]);
		expect(await pressOnThirdStar("ArrowRight", "ltr")).toEqual([4]);
	});

	test("unrelated keys leave the rating alone", async () => {
		expect(await pressOnThirdStar("a", "rtl")).toEqual([]);
	});
});
