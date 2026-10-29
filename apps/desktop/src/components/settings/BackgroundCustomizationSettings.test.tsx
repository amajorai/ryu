import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Mounts the shipping Backgrounds editor on the REAL background store
// (`useBackgroundCustomization.ts`): config goes to localStorage, the live
// layers go to CSS variables on <html>, and image bytes go to IndexedDB. The
// only stand-in is a small in-memory IndexedDB (happy-dom has none) that can
// be told to refuse writes, so the image error path is reachable.
const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface FakeRequest {
	error?: Error;
	onerror?: () => void;
	onsuccess?: () => void;
	onupgradeneeded?: () => void;
	result?: unknown;
}
interface FakeTransaction {
	error?: Error;
	objectStore: (name: string) => unknown;
	oncomplete?: () => void;
	onerror?: () => void;
}

const imageBytes = new Map<string, unknown>();
const stores = new Set<string>();
let refuseImageWrites = false;
const fakeDb = {
	objectStoreNames: { contains: (name: string) => stores.has(name) },
	createObjectStore: (name: string) => stores.add(name),
	transaction: () => {
		const tx: FakeTransaction = {
			objectStore: () => ({
				put: (value: unknown, key: string) => {
					queueMicrotask(() => {
						if (refuseImageWrites) {
							tx.error = new Error("QuotaExceededError");
							tx.onerror?.();
							return;
						}
						imageBytes.set(key, value);
						tx.oncomplete?.();
					});
				},
				get: (key: string) => {
					const req: FakeRequest = {};
					queueMicrotask(() => {
						req.result = imageBytes.get(key);
						req.onsuccess?.();
					});
					return req;
				},
				delete: (key: string) => {
					queueMicrotask(() => {
						imageBytes.delete(key);
						tx.oncomplete?.();
					});
				},
			}),
		};
		return tx;
	},
};
const indexedDbDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"indexedDB"
);
Object.defineProperty(globalThis, "indexedDB", {
	configurable: true,
	value: {
		open: () => {
			const req: FakeRequest = {};
			queueMicrotask(() => {
				req.result = fakeDb;
				if (stores.size === 0) {
					req.onupgradeneeded?.();
				}
				req.onsuccess?.();
			});
			return req;
		},
	},
});

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { toast } = await import("@ryu/ui/components/sileo.tsx");
const { resetBackgroundCustomization } = await import(
	"@/src/hooks/useBackgroundCustomization.ts"
);
const { BackgroundCustomizationSettings } = await import(
	"./BackgroundCustomizationSettings.tsx"
);

const runtimeErrors: string[] = [];
let root: ReturnType<typeof createRoot> | null = null;
let errorToast: ReturnType<typeof spyOn<typeof toast, "error">>;

async function idle() {
	for (let i = 0; i < 4; i++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
		});
	}
}
async function until(predicate: () => boolean, reason: string, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(reason);
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
}
async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(createElement(BackgroundCustomizationSettings))
	);
	await idle();
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	document.body.replaceChildren();
}
function stored(surface: "sidebar" | "page"): Record<string, unknown> {
	return JSON.parse(localStorage.getItem(`ryu:bg:${surface}`) ?? "null");
}
function seed(surface: "sidebar" | "page", value: Record<string, unknown>) {
	localStorage.setItem(`ryu:bg:${surface}`, JSON.stringify(value));
}
function byLabel(label: string): HTMLElement {
	const found = document.body.querySelector(`[aria-label="${label}"]`);
	if (!(found instanceof HTMLElement)) {
		throw new Error(`Missing control ${label}`);
	}
	return found;
}
function button(text: string): HTMLButtonElement | undefined {
	return [...document.body.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === text
	);
}
function stopRows(): number {
	return document.body.querySelectorAll('[aria-label^="Remove gradient stop"]')
		.length;
}
function swatch(label: string) {
	const trigger = byLabel(label);
	return {
		text: trigger.textContent?.trim(),
		fill: trigger.style.getPropertyValue("--color-picker-trigger-fill"),
		ink: trigger.style.getPropertyValue("--color-picker-trigger-foreground"),
	};
}
function cssVar(name: string): string {
	return document.documentElement.style.getPropertyValue(name);
}
async function click(element: HTMLElement | undefined) {
	if (!element) {
		throw new Error("Nothing to click");
	}
	await act(async () => element.click());
	await idle();
}
async function pickFile(file: File) {
	const input = document.body.querySelector('input[type="file"]');
	if (!(input instanceof HTMLInputElement)) {
		throw new Error("No image input");
	}
	Object.defineProperty(input, "files", { configurable: true, value: [file] });
	await act(async () => {
		input.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await idle();
}
function openOptions(): HTMLElement[] {
	const listbox = [
		...document.querySelectorAll<HTMLElement>('[role="listbox"]'),
	]
		.filter((box) => !box.closest("[data-closed]"))
		.at(-1);
	return [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
}

beforeEach(() => {
	localStorage.clear();
	imageBytes.clear();
	refuseImageWrites = false;
	resetBackgroundCustomization();
	runtimeErrors.length = 0;
	errorToast = spyOn(toast, "error");
});
afterEach(async () => {
	await unmount();
	errorToast.mockRestore();
	if (runtimeErrors.length > 0) {
		throw new Error(`runtime errors: ${runtimeErrors.join("; ")}`);
	}
});
afterAll(async () => {
	if (indexedDbDescriptor) {
		Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "indexedDB");
	}
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

test("adding stops drops each into the widest gap, persists it, and paints it on the live sidebar layer", async () => {
	seed("sidebar", {
		gradientEnabled: true,
		gradientStops: [
			{ color: "#ffffff", position: 0 },
			{ color: "#102030", position: 100 },
		],
	});
	await mount();
	expect(stopRows()).toBe(2);
	await click(button("Add stop"));
	expect(stored("sidebar").gradientStops).toEqual([
		{ color: "#ffffff", position: 0 },
		{ color: "#102030", position: 100 },
		{ color: "#8b8b93", position: 50 },
	]);
	await click(button("Add stop"));
	// 0..50 and 50..100 tie; the first widest gap wins.
	expect((stored("sidebar").gradientStops as unknown[]).at(-1)).toEqual({
		color: "#8b8b93",
		position: 25,
	});
	expect(stopRows()).toBe(4);
	expect(cssVar("--ryu-sidebar-bg-image")).toBe(
		"linear-gradient(135deg, rgba(255, 255, 255, 1) 0%, rgba(139, 139, 147, 1) 25%, rgba(139, 139, 147, 1) 50%, rgba(16, 32, 48, 1) 100%)"
	);
	expect(document.documentElement.getAttribute("data-ryu-bg-active")).toBe(
		"true"
	);
	// A remount reads the persisted stops back.
	await unmount();
	await mount();
	expect(stopRows()).toBe(4);
});

test("removing a stop persists the removal, and the last two stops cannot be removed", async () => {
	seed("sidebar", {
		gradientEnabled: true,
		gradientStops: [
			{ color: "#ff0000", position: 0 },
			{ color: "#00ff00", position: 40 },
			{ color: "#0000ff", position: 100 },
		],
	});
	await mount();
	const removeFirst = byLabel("Remove gradient stop 1") as HTMLButtonElement;
	expect(removeFirst.disabled).toBe(false);
	await click(removeFirst);
	expect(stored("sidebar").gradientStops).toEqual([
		{ color: "#00ff00", position: 40 },
		{ color: "#0000ff", position: 100 },
	]);
	expect(stopRows()).toBe(2);
	const guarded = byLabel("Remove gradient stop 1") as HTMLButtonElement;
	expect(guarded.disabled).toBe(true);
	expect(
		(byLabel("Remove gradient stop 2") as HTMLButtonElement).disabled
	).toBe(true);
});

test("swatches pick legible ink for their fill and show a stored non-hex color as black, without rewriting it", async () => {
	seed("sidebar", {
		gradientEnabled: true,
		gradientStops: [
			{ color: "#ffffff", position: 0 },
			{ color: "#808080", position: 30 },
			{ color: "#7f7f7f", position: 60 },
			{ color: "teal", position: 100 },
			{ color: "#00ff00", position: 70 },
			{ color: "#ff00ff", position: 80 },
		],
	});
	await mount();
	expect(swatch("Gradient stop 1 color")).toEqual({
		text: "#ffffff",
		fill: "#ffffff",
		ink: "#000000",
	});
	// Either side of the 0.5 luma threshold.
	expect(swatch("Gradient stop 2 color").ink).toBe("#000000");
	expect(swatch("Gradient stop 3 color").ink).toBe("#ffffff");
	expect(swatch("Gradient stop 4 color")).toEqual({
		text: "#000000",
		fill: "#000000",
		ink: "#ffffff",
	});
	// Channels are luma-weighted, not averaged: pure green reads light and
	// magenta reads dark, the opposite of what an even average would pick.
	expect(swatch("Gradient stop 5 color").ink).toBe("#000000");
	expect(swatch("Gradient stop 6 color").ink).toBe("#ffffff");
	expect((stored("sidebar").gradientStops as unknown[])[3]).toEqual({
		color: "teal",
		position: 100,
	});
});

test("the page gradient switch persists the choice and turns the live page layer on and off", async () => {
	await mount();
	expect(cssVar("--ryu-page-bg-image")).toBe("");
	await click(byLabel("Page gradient background"));
	expect(stored("page").gradientEnabled).toBe(true);
	expect(stored("sidebar")).toBeNull();
	expect(cssVar("--ryu-page-bg-image")).toBe(
		"linear-gradient(135deg, rgba(0, 153, 255, 1) 0%, rgba(124, 58, 237, 1) 100%)"
	);
	expect(document.documentElement.getAttribute("data-ryu-bg-active")).toBe(
		"true"
	);
	await click(byLabel("Page gradient background"));
	expect(stored("page").gradientEnabled).toBe(false);
	expect(cssVar("--ryu-page-bg-image")).toBe("");
	expect(document.documentElement.hasAttribute("data-ryu-bg-active")).toBe(
		false
	);
});

test("a non-image file is refused and a failed image store is reported, both without enabling a fit", async () => {
	await mount();
	await click(byLabel("Sidebar image background"));
	await pickFile(new File(["hello"], "notes.txt", { type: "text/plain" }));
	expect(errorToast).toHaveBeenCalledWith("Please choose an image file.");
	expect(imageBytes.size).toBe(0);
	refuseImageWrites = true;
	await pickFile(
		new File([new Uint8Array([1, 2])], "a.png", { type: "image/png" })
	);
	await until(() => errorToast.mock.calls.length === 2, "No store failure");
	expect(errorToast.mock.calls[1]?.[0]).toBe("Couldn't save that image.");
	expect(imageBytes.size).toBe(0);
	expect(document.body.querySelector('[aria-label="Sidebar image fit"]')).toBe(
		null
	);
	expect(button("Choose image")).toBeDefined();
});

test("a stored image unlocks fit; Tile persists, tiles the live layer and offers Scale; removing it clears the bytes", async () => {
	await mount();
	await click(byLabel("Sidebar image background"));
	await pickFile(
		new File([new Uint8Array([1, 2])], "a.png", { type: "image/png" })
	);
	await until(() => imageBytes.has("sidebar"), "Image bytes never stored");
	await until(
		() =>
			document.body.querySelector('[aria-label="Sidebar image fit"]') !== null,
		"Fit control never appeared"
	);
	expect(stored("sidebar").imageEnabled).toBe(true);
	expect(stored("sidebar")).not.toHaveProperty("imageSrc");
	expect(cssVar("--ryu-sidebar-bg-repeat")).toBe("no-repeat, no-repeat");
	expect(document.body.textContent).not.toContain("Scale");
	await click(byLabel("Sidebar image fit"));
	await until(() => openOptions().length > 0, "Fit options never opened");
	await click(
		openOptions().find((option) => option.textContent?.trim() === "Tile")
	);
	expect(stored("sidebar").imageFit).toBe("tile");
	expect(cssVar("--ryu-sidebar-bg-repeat")).toBe("no-repeat, repeat");
	expect(cssVar("--ryu-sidebar-bg-size")).toBe("cover, 100%");
	expect(document.body.textContent).toContain("Scale");
	await click(byLabel("Remove image"));
	await until(() => !imageBytes.has("sidebar"), "Image bytes not cleared");
	expect(button("Choose image")).toBeDefined();
	expect(cssVar("--ryu-sidebar-bg-image")).toBe("");
});
