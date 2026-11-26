// The declared personal or work use: stored per install, defaulting to
// personal, seeded from the onboarding answer, and reactive for every consumer.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const {
	DECLARED_USE_KEY,
	DECLARED_USE_VALUES,
	declaredUseForSetupKind,
	readDeclaredUse,
	readStoredDeclaredUse,
	recordDeclaredUseFromSetup,
	setDeclaredUse,
	useDeclaredUse,
} = await import("./useDeclaredUse.ts");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Consumer({ name }: { name: string }) {
	return createElement("output", { "data-consumer": name }, useDeclaredUse());
}
async function mount() {
	await act(async () => {
		root.render(
			createElement(
				"div",
				null,
				createElement(Consumer, { name: "settings" }),
				createElement(Consumer, { name: "later-reader" })
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
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	localStorage.clear();
});

test("someone who was never asked is treated as personal use, with nothing stored", () => {
	expect(readStoredDeclaredUse()).toBeNull();
	expect(readDeclaredUse()).toBe("personal");
	expect(localStorage.getItem(DECLARED_USE_KEY)).toBeNull();
});

test("the declaration is stored and read back, and can be changed both ways", () => {
	setDeclaredUse("work");
	expect(localStorage.getItem(DECLARED_USE_KEY)).toBe("work");
	expect(readStoredDeclaredUse()).toBe("work");
	expect(readDeclaredUse()).toBe("work");
	setDeclaredUse("personal");
	expect(localStorage.getItem(DECLARED_USE_KEY)).toBe("personal");
	expect(readStoredDeclaredUse()).toBe("personal");
	expect(readDeclaredUse()).toBe("personal");
});

test("an unknown stored value is ignored instead of being trusted", () => {
	localStorage.setItem(DECLARED_USE_KEY, "enterprise");
	expect(readStoredDeclaredUse()).toBeNull();
	expect(readDeclaredUse()).toBe("personal");
	expect([...DECLARED_USE_VALUES]).toEqual(["personal", "work"]);
});

test("the onboarding answer maps to the declared use and the newest answer wins", () => {
	expect(declaredUseForSetupKind("personal")).toBe("personal");
	expect(declaredUseForSetupKind("team")).toBe("work");
	recordDeclaredUseFromSetup("team");
	expect(readStoredDeclaredUse()).toBe("work");
	recordDeclaredUseFromSetup("personal");
	expect(readStoredDeclaredUse()).toBe("personal");
});

test("mounted consumers follow a change made in this window and remount from storage", async () => {
	await mount();
	expect(values()).toEqual(["personal", "personal"]);
	await act(async () => setDeclaredUse("work"));
	expect(values()).toEqual(["work", "work"]);
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount();
	expect(values()).toEqual(["work", "work"]);
});

test("mounted consumers follow a change made in another window", async () => {
	await mount();
	await act(async () => {
		localStorage.setItem(DECLARED_USE_KEY, "work");
		window.dispatchEvent(
			new StorageEvent("storage", { key: DECLARED_USE_KEY, newValue: "work" })
		);
	});
	expect(values()).toEqual(["work", "work"]);
	await act(async () => {
		localStorage.removeItem(DECLARED_USE_KEY);
		window.dispatchEvent(
			new StorageEvent("storage", { key: DECLARED_USE_KEY, newValue: null })
		);
	});
	expect(values()).toEqual(["personal", "personal"]);
});
