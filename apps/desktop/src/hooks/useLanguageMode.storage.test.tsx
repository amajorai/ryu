import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { LANGUAGE_PACK_STORAGE_KEY } from "@ryu/i18n/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { LANGUAGE_MODE_KEY, setLanguageMode, useLanguageMode } = await import(
	"./useLanguageMode.ts"
);
const mounted: { root: Root; element: HTMLDivElement }[] = [];
function Consumer() {
	const [mode, setMode] = useLanguageMode();
	return (
		<div>
			<output>{mode}</output>
			<button onClick={() => setMode("fixed")}>Fixed</button>
		</div>
	);
}
async function mount() {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element);
	mounted.push({ root, element });
	await act(async () => root.render(<Consumer />));
	return element;
}
async function storage(key: string | null, storageArea = localStorage) {
	await act(async () =>
		window.dispatchEvent(new StorageEvent("storage", { key, storageArea }))
	);
}
afterEach(async () => {
	for (const { root, element } of mounted.splice(0)) {
		await act(async () => root.unmount());
		element.remove();
	}
	localStorage.clear();
	setLanguageMode("auto");
});
test("failed mode writes still update two mounted consumers, then retry persists for an independent runtime", async () => {
	localStorage.setItem("unrelated", "retained");
	setLanguageMode("auto");
	const first = await mount();
	const second = await mount();
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	)!;
	const durable = localStorage;
	let refusedWrites = 0;
	const boundary = new Proxy(durable, {
		get(target, property) {
			if (property === "setItem") {
				return (key: string) => {
					if (key !== LANGUAGE_MODE_KEY) {
						throw new Error(`Unexpected storage write: ${key}`);
					}
					refusedWrites += 1;
					throw new DOMException("denied", "QuotaExceededError");
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: boundary,
	});
	try {
		await act(async () => first.querySelector("button")!.click());
		expect(first.querySelector("output")!.textContent).toBe("fixed");
		expect(second.querySelector("output")!.textContent).toBe("fixed");
		expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
		const refusedReload = await import(
			`./useLanguageMode.ts?refusedReload=${Date.now()}`
		);
		expect(refusedReload.readLanguageMode()).toBe("auto");
		expect(refusedWrites).toBe(1);
	} finally {
		Object.defineProperty(globalThis, "localStorage", descriptor);
	}
	await act(async () => first.querySelector("button")!.click());
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem("unrelated")).toBe("retained");
	// A new module instance reads durable storage, without borrowing the original cache.
	const independent = await import(`./useLanguageMode.ts?reload=${Date.now()}`);
	expect(independent.readLanguageMode()).toBe("fixed");
});
test("mounted mode consumers follow external legacy pack changes and clear, ignoring another storage area", async () => {
	setLanguageMode("auto");
	const first = await mount();
	const second = await mount();
	localStorage.removeItem(LANGUAGE_MODE_KEY);
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, "fr");
	await storage(LANGUAGE_PACK_STORAGE_KEY);
	expect(first.querySelector("output")!.textContent).toBe("fixed");
	expect(second.querySelector("output")!.textContent).toBe("fixed");
	localStorage.clear();
	await storage(null);
	expect(first.querySelector("output")!.textContent).toBe("auto");
	expect(second.querySelector("output")!.textContent).toBe("auto");
	localStorage.setItem(LANGUAGE_MODE_KEY, "fixed");
	await storage(LANGUAGE_MODE_KEY, sessionStorage);
	expect(first.querySelector("output")!.textContent).toBe("auto");
	await storage(LANGUAGE_MODE_KEY);
	expect(first.querySelector("output")!.textContent).toBe("fixed");
});

test("unmount removes each storage and same-window language subscription", async () => {
	const add = window.addEventListener;
	const remove = window.removeEventListener;
	const active = new Map<string, Set<EventListenerOrEventListenerObject>>();
	window.addEventListener = function (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions
	) {
		if (type === "storage" || type === "ryu:language-mode-changed") {
			const listeners =
				active.get(type) ?? new Set<EventListenerOrEventListenerObject>();
			listeners.add(listener);
			active.set(type, listeners);
		}
		add.call(this, type, listener, options);
	};
	window.removeEventListener = function (
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions
	) {
		active.get(type)?.delete(listener);
		remove.call(this, type, listener, options);
	};
	try {
		setLanguageMode("auto");
		await mount();
		await mount();
		expect(active.get("storage")?.size).toBe(2);
		expect(active.get("ryu:language-mode-changed")?.size).toBe(2);
		for (const { root, element } of mounted.splice(0)) {
			await act(async () => root.unmount());
			element.remove();
		}
		expect(active.get("storage")?.size).toBe(0);
		expect(active.get("ryu:language-mode-changed")?.size).toBe(0);
	} finally {
		window.addEventListener = add;
		window.removeEventListener = remove;
	}
});

test("unreadable stored mode falls back safely and recovers when storage becomes readable", async () => {
	setLanguageMode("fixed");
	localStorage.setItem("unrelated", "retained");
	const first = await mount();
	const second = await mount();
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	)!;
	const durable = localStorage;
	let refusedReads = 0;
	const boundary = new Proxy(durable, {
		get(target, property) {
			if (property === "getItem") {
				return () => {
					refusedReads += 1;
					throw new DOMException("denied", "SecurityError");
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: boundary,
	});
	try {
		await act(async () =>
			window.dispatchEvent(
				new StorageEvent("storage", { key: LANGUAGE_MODE_KEY })
			)
		);
		expect(first.querySelector("output")!.textContent).toBe("auto");
		expect(second.querySelector("output")!.textContent).toBe("auto");
		expect(refusedReads).toBe(2);
		expect(durable.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	} finally {
		Object.defineProperty(globalThis, "localStorage", descriptor);
	}
	await storage(LANGUAGE_MODE_KEY);
	expect(first.querySelector("output")!.textContent).toBe("fixed");
	expect(second.querySelector("output")!.textContent).toBe("fixed");
	expect(localStorage.getItem("unrelated")).toBe("retained");
});
