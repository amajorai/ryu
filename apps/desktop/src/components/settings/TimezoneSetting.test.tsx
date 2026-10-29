import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const {
	TIMEZONE_KEY,
	getTimezonePreference,
	resetTimezone,
	setTimezonePreference,
} = await import("@/src/lib/timezone.ts");
const { TimezoneSetting } = await import("./TimezoneSetting.tsx");

const roots: Root[] = [];

beforeEach(() => {
	localStorage.clear();
	resetTimezone();
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	resetTimezone();
	localStorage.clear();
});

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 10; tick += 1) {
			await Promise.resolve();
		}
	});
}

async function mount() {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => root.render(<TimezoneSetting />));
	await flush();
	return container;
}

function trigger(): HTMLElement {
	const element = document.querySelector<HTMLElement>(
		'[data-purpose="timezone-select"], [role="combobox"]'
	);
	if (!element) {
		throw new Error("Missing time zone trigger");
	}
	return element;
}

function description(container: HTMLElement): string {
	const text = container.textContent ?? "";
	const match = /Timestamps currently read (.*)\./u.exec(text);
	if (!match?.[1]) {
		throw new Error(`Missing preview in: ${text}`);
	}
	return match[1];
}

async function open() {
	await act(async () => {
		const element = trigger();
		element.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, button: 0 })
		);
		element.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, button: 0 })
		);
		element.click();
	});
	await flush();
}

function searchInput(): HTMLInputElement {
	const element = document.querySelector<HTMLInputElement>(
		'input[placeholder="Search a city or zone…"]'
	);
	if (!element) {
		throw new Error("Missing time zone search input");
	}
	return element;
}

async function search(query: string) {
	const element = searchInput();
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(element, query);
		element.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await flush();
}

function optionLabels(): string[] {
	return Array.from(document.querySelectorAll('[role="option"]')).map(
		(option) => option.textContent ?? ""
	);
}

test("searching by the IANA id with an underscore finds the zone whose label uses a space", async () => {
	await mount();
	await open();
	await search("los_angeles");

	const labels = optionLabels();
	expect(labels.length).toBeGreaterThan(0);
	expect(labels.every((label) => label.includes("Los Angeles"))).toBe(true);

	await search("tokyo");
	const tokyo = optionLabels();
	expect(tokyo.some((label) => label.includes("Asia/Tokyo"))).toBe(true);
	expect(tokyo.some((label) => label.includes("Los Angeles"))).toBe(false);

	await search("no-such-zone-anywhere");
	expect(optionLabels()).toEqual([]);
	expect(document.body.textContent).toContain("No time zones found.");
});

test("choosing a zone persists it and repaints the live preview in that zone", async () => {
	// 00:37 UTC is 9:37 in Tokyo (UTC+9, no DST), so the preview clock itself
	// must move to the chosen zone, not only its label. Start from UTC so the
	// host machine's own zone cannot already read 9:37.
	setTimezonePreference("UTC");
	const instant = Date.UTC(2026, 0, 15, 0, 37);
	const clock = spyOn(Date, "now").mockReturnValue(instant);
	const container = await mount().finally(() => clock.mockRestore());
	const before = description(container);
	expect(before).not.toContain("9:37");

	await open();
	await search("Asia/Tokyo");
	const tokyo = Array.from(
		document.querySelectorAll<HTMLElement>('[role="option"]')
	).find((option) => option.textContent?.includes("Asia/Tokyo"));
	if (!tokyo) {
		throw new Error("Missing Asia/Tokyo option");
	}
	await act(async () => {
		tokyo.click();
	});
	await flush();

	expect(localStorage.getItem(TIMEZONE_KEY)).toBe("Asia/Tokyo");
	expect(getTimezonePreference()).toBe("Asia/Tokyo");
	const after = description(container);
	expect(after).toContain("Asia/Tokyo");
	expect(after).toContain("9:37");
	expect(after).not.toBe(before);
	expect(trigger().textContent).toContain("Asia/Tokyo");
});
