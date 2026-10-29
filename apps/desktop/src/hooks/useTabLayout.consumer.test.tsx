import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { setTabLayout, useTabLayout } = await import("./useTabLayout.ts");
const key = "ryu_tab_layout";
const happyWindow = window as unknown as {
	happyDOM: {
		setWindowSize(size: { width: number; height: number }): void;
	};
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Consumer({ name }: { name: string }) {
	return createElement("output", { "data-consumer": name }, useTabLayout());
}
async function mount() {
	await act(async () => {
		root.render(
			createElement(
				"div",
				null,
				createElement(Consumer, { name: "titlebar" }),
				createElement(Consumer, { name: "sidebar" })
			)
		);
	});
}
function values() {
	return Array.from(
		container.querySelectorAll("output"),
		(output) => output.textContent
	);
}
beforeEach(() => {
	localStorage.clear();
	happyWindow.happyDOM.setWindowSize({ width: 1280, height: 800 });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

test("mounted layout consumers acknowledge writes and independently remount from persistence", async () => {
	await mount();
	expect(values()).toEqual(["horizontal", "horizontal"]);
	await act(async () => setTabLayout("canvas"));
	expect(values()).toEqual(["canvas", "canvas"]);
	expect(localStorage.getItem(key)).toBe("canvas");
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	expect(values()).toEqual(["canvas", "canvas"]);
});

test("cross-window storage changes and storage clearing update real consumers", async () => {
	localStorage.setItem(key, "vertical");
	await mount();
	await act(async () => {
		localStorage.setItem(key, "scroll");
		window.dispatchEvent(
			new StorageEvent("storage", { key, newValue: "scroll" })
		);
	});
	expect(values()).toEqual(["scroll", "scroll"]);
	await act(async () => {
		localStorage.clear();
		window.dispatchEvent(new StorageEvent("storage", { key: null }));
	});
	expect(values()).toEqual(["horizontal", "horizontal"]);
});

test("a refused write leaves acknowledged layout and durable bytes unchanged, then retries", async () => {
	localStorage.setItem(key, "vertical");
	await mount();
	const original = localStorage.setItem;
	Object.defineProperty(localStorage, "setItem", {
		configurable: true,
		value: () => {
			throw new DOMException("Storage quota reached", "QuotaExceededError");
		},
	});
	try {
		expect(() => setTabLayout("canvas")).toThrow("Storage quota reached");
		expect(values()).toEqual(["vertical", "vertical"]);
		expect(localStorage.getItem(key)).toBe("vertical");
	} finally {
		Object.defineProperty(localStorage, "setItem", {
			configurable: true,
			value: original,
		});
	}
	await act(async () => setTabLayout("canvas"));
	expect(values()).toEqual(["canvas", "canvas"]);
	expect(localStorage.getItem(key)).toBe("canvas");
});

test("phone chrome overrides layout without overwriting the wide-window preference", async () => {
	localStorage.setItem(key, "vertical");
	happyWindow.happyDOM.setWindowSize({ width: 375, height: 800 });
	await mount();
	await act(async () => window.dispatchEvent(new Event("resize")));
	expect(values()).toEqual(["horizontal", "horizontal"]);
	expect(localStorage.getItem(key)).toBe("vertical");
	await act(async () =>
		happyWindow.happyDOM.setWindowSize({ width: 1280, height: 800 })
	);
	expect(values()).toEqual(["vertical", "vertical"]);
	expect(localStorage.getItem(key)).toBe("vertical");
});

test("unmount removes every layout storage subscription", async () => {
	const add = spyOn(window, "addEventListener");
	const remove = spyOn(window, "removeEventListener");
	try {
		await mount();
		const subscriptions = add.mock.calls.filter(([type]) => type === "storage");
		expect(subscriptions).toHaveLength(2);
		await act(async () => root.unmount());
		for (const [type, handler] of subscriptions) {
			expect(
				remove.mock.calls.some(
					([removedType, removedHandler]) =>
						removedType === type && removedHandler === handler
				)
			).toBe(true);
		}
		root = createRoot(container);
	} finally {
		add.mockRestore();
		remove.mockRestore();
	}
});
