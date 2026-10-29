import { beforeEach, describe, expect, it } from "bun:test";
import {
	COMPOSER_PINS_STORAGE_KEY,
	getComposerPins,
	toggleComposerPin,
} from "./composer-pins.ts";

function installStorage(impl?: Partial<Storage>): void {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
		clear: () => values.clear(),
		key: (index: number) => [...values.keys()][index] ?? null,
		get length() {
			return values.size;
		},
		...impl,
	} satisfies Storage;
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
		writable: true,
	});
}

beforeEach(() => installStorage());

describe("composer pins", () => {
	it("keeps pins in the order they were added", () => {
		expect(toggleComposerPin("app:calendar")).toEqual(["app:calendar"]);
		expect(toggleComposerPin("skill:review")).toEqual([
			"app:calendar",
			"skill:review",
		]);
		expect(getComposerPins()).toEqual(["app:calendar", "skill:review"]);
	});

	it("removes a pin without changing the remaining order", () => {
		toggleComposerPin("action:attach");
		toggleComposerPin("app:calendar");
		toggleComposerPin("plugin:proof");

		expect(toggleComposerPin("app:calendar")).toEqual([
			"action:attach",
			"plugin:proof",
		]);
	});

	it("deduplicates stored ids and ignores malformed storage", () => {
		globalThis.localStorage.setItem(
			COMPOSER_PINS_STORAGE_KEY,
			JSON.stringify(["app:calendar", "app:calendar", 4, null])
		);
		expect(getComposerPins()).toEqual(["app:calendar"]);

		globalThis.localStorage.setItem(COMPOSER_PINS_STORAGE_KEY, "not-json");
		expect(getComposerPins()).toEqual([]);
	});

	it("does not throw when storage rejects writes", () => {
		installStorage({
			setItem: () => {
				throw new Error("QuotaExceededError");
			},
		});

		expect(() => toggleComposerPin("app:calendar")).not.toThrow();
	});
});
