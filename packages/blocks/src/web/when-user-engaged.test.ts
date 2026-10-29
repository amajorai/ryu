import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}

const { whenUserEngaged } = await import("./when-user-engaged.ts");

afterEach(() => {
	Reflect.deleteProperty(navigator, "userActivation");
});

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("runs once on the first interaction and then stops listening", () => {
	let runs = 0;
	whenUserEngaged(() => {
		runs += 1;
	});
	expect(runs).toBe(0);
	window.dispatchEvent(new Event("pointermove"));
	window.dispatchEvent(new Event("keydown"));
	expect(runs).toBe(1);
});

test("a scroll inside any element counts", () => {
	let runs = 0;
	whenUserEngaged(() => {
		runs += 1;
	});
	const scroller = document.createElement("div");
	document.body.append(scroller);
	scroller.dispatchEvent(new Event("scroll"));
	scroller.remove();
	expect(runs).toBe(1);
});

test("cancelling before any interaction never runs the task", () => {
	let runs = 0;
	const cancel = whenUserEngaged(() => {
		runs += 1;
	});
	cancel();
	window.dispatchEvent(new Event("pointerdown"));
	expect(runs).toBe(0);
});

test("a page with sticky user activation runs the task right away", () => {
	Object.defineProperty(navigator, "userActivation", {
		configurable: true,
		value: { hasBeenActive: true, isActive: false },
	});
	let runs = 0;
	whenUserEngaged(() => {
		runs += 1;
	});
	expect(runs).toBe(1);
});
