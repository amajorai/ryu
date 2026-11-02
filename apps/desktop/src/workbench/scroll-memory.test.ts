import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createScrollMemory } from "./scroll-memory.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

function scrollTo(element: HTMLElement, top: number, left = 0) {
	element.scrollTop = top;
	element.scrollLeft = left;
	element.dispatchEvent(new Event("scroll"));
}

function mountItem() {
	const root = document.createElement("div");
	const scroller = document.createElement("div");
	root.append(scroller);
	document.body.append(root);
	return { root, scroller };
}

describe("createScrollMemory", () => {
	test("puts a scroller back where it was after parking resets it", () => {
		const { root, scroller } = mountItem();
		const memory = createScrollMemory(root);
		scrollTo(scroller, 260, 12);
		memory.park();
		// Parking (display: none or a detached subtree) drops the scroll box.
		scrollTo(scroller, 0);
		memory.restore();
		expect(scroller.scrollTop).toBe(260);
		expect(scroller.scrollLeft).toBe(12);
		memory.dispose();
		root.remove();
	});

	test("records the latest shown offset, including a return to the top", () => {
		const { root, scroller } = mountItem();
		const memory = createScrollMemory(root);
		scrollTo(scroller, 260);
		scrollTo(scroller, 0);
		scroller.scrollTop = 90;
		memory.restore();
		// Back at the top was the last shown position: nothing is restored.
		expect(scroller.scrollTop).toBe(90);
		memory.dispose();
		root.remove();
	});

	test("forgets scrollers that left the item and stops after dispose", () => {
		const { root, scroller } = mountItem();
		const memory = createScrollMemory(root);
		scrollTo(scroller, 140);
		scroller.remove();
		scroller.scrollTop = 0;
		memory.restore();
		expect(scroller.scrollTop).toBe(0);
		root.append(scroller);
		memory.dispose();
		scrollTo(scroller, 300);
		scroller.scrollTop = 0;
		memory.restore();
		expect(scroller.scrollTop).toBe(0);
		root.remove();
	});
});
