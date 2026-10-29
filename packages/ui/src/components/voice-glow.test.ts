import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});
afterEach(() => {
	document.documentElement.classList.remove("dark", "light");
	document.body.replaceChildren();
});

const { resolveHostTheme } = await import("./voice-glow.tsx");

function hostInside(scopeClass?: string): HTMLElement {
	const scope = document.createElement("div");
	if (scopeClass) {
		scope.className = scopeClass;
	}
	const host = document.createElement("div");
	scope.append(host);
	document.body.append(scope);
	return host;
}

test("a forced-dark surface wins over a light app theme", () => {
	// The Island notch: a black `.dark` surface while <html> stays light.
	const host = hostInside("dark island-surface-radius bg-black");
	expect(resolveHostTheme(host)).toBe("dark");
});

test("a forced-light scope wins over a dark app theme", () => {
	document.documentElement.classList.add("dark");
	expect(resolveHostTheme(hostInside("light"))).toBe("light");
});

test("without a local scope the glow follows the app theme on <html>", () => {
	const host = hostInside();
	expect(resolveHostTheme(host)).toBe("light");
	document.documentElement.classList.add("dark");
	expect(resolveHostTheme(host)).toBe("dark");
});

test("an unmounted glow falls back to the app theme", () => {
	document.documentElement.classList.add("dark");
	expect(resolveHostTheme(null)).toBe("dark");
});
