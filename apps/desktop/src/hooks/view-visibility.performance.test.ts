import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	isViewVisible,
	subscribeViewVisibility,
} from "@ryu/ui/lib/view-visibility.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
test("embedded consumers share one observer and release it after the last unsubscribe", () => {
	const originalParent = Object.getOwnPropertyDescriptor(window, "parent");
	const originalObserver = globalThis.IntersectionObserver;
	let created = 0;
	let disconnected = 0;
	let notify: (entries: IntersectionObserverEntry[]) => void = () => undefined;
	function entry(isIntersecting: boolean): IntersectionObserverEntry {
		const rect = new DOMRect(0, 0, 1, 1);
		return {
			time: 0,
			target: document.documentElement,
			isIntersecting,
			boundingClientRect: rect,
			intersectionRect: rect,
			intersectionRatio: isIntersecting ? 1 : 0,
			rootBounds: rect,
		};
	}
	class Observer implements IntersectionObserver {
		readonly root = null;
		readonly rootMargin = "0px";
		readonly thresholds = [0];
		constructor(callback: IntersectionObserverCallback) {
			created++;
			notify = (entries) => callback(entries, this);
		}
		observe() {}
		unobserve() {}
		takeRecords(): IntersectionObserverEntry[] {
			return [];
		}
		disconnect() {
			disconnected++;
		}
	}
	Object.defineProperty(window, "parent", { configurable: true, value: {} });
	Object.assign(globalThis, { IntersectionObserver: Observer });
	const first: boolean[] = [];
	const second: boolean[] = [];
	const unsubscribe = subscribeViewVisibility(() =>
		first.push(isViewVisible())
	);
	const unsubscribeSecond = subscribeViewVisibility(() =>
		second.push(isViewVisible())
	);
	try {
		expect(created).toBe(1);
		notify([entry(false)]);
		expect(first).toEqual([false]);
		expect(second).toEqual([false]);
		unsubscribe();
		expect(disconnected).toBe(0);
		notify([entry(true)]);
		expect(first).toEqual([false]);
		expect(second).toEqual([false, true]);
		unsubscribeSecond();
		expect(disconnected).toBe(1);
	} finally {
		unsubscribe();
		unsubscribeSecond();
		Object.assign(globalThis, { IntersectionObserver: originalObserver });
		if (originalParent) {
			Object.defineProperty(window, "parent", originalParent);
		} else {
			Reflect.deleteProperty(window, "parent");
		}
	}
});
