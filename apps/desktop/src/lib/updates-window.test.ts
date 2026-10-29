import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// The updater reads the window synchronously from localStorage, scoped to the
// account the auth vault says is active. Both are process-global seams, so the
// suite owns them (scripts/test-isolated.ts runs this file in its own process).
const store = new Map<string, string>();
const memoryStorage = {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => {
		store.set(key, String(value));
	},
	removeItem: (key: string) => {
		store.delete(key);
	},
	clear: () => store.clear(),
	key: (index: number) => [...store.keys()][index] ?? null,
	get length() {
		return store.size;
	},
};
const previousStorage = Reflect.get(globalThis, "localStorage");
Reflect.set(globalThis, "localStorage", memoryStorage);

let activeUserId: string | null = "alice";
mock.module("@/lib/auth-client.ts", () => ({
	getActiveUserId: () => activeUserId,
}));

const {
	getUpdatesCutoff,
	getUpdatesCutoffMs,
	getUpdatesWindowEnd,
	markNaggedForVersion,
	setUpdatesWindow,
	shouldNagForVersion,
} = await import("./updates-window.ts");

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_KEY = "ryu.updates-window";
const NAG_KEY = "ryu.updates-nag";

beforeEach(() => {
	store.clear();
	activeUserId = "alice";
});

afterAll(() => {
	Reflect.set(globalThis, "localStorage", previousStorage);
});

describe("updates window persistence", () => {
	test("persists the window end scoped to the active account", () => {
		setUpdatesWindow("2030-01-02T00:00:00.000Z");

		expect(JSON.parse(store.get(WINDOW_KEY) ?? "null")).toEqual({
			accountId: "alice",
			windowEndsAt: "2030-01-02T00:00:00.000Z",
		});
		expect(getUpdatesWindowEnd()).toBe("2030-01-02T00:00:00.000Z");

		// Another account signing in on the same machine must not inherit it.
		activeUserId = "bob";
		expect(getUpdatesWindowEnd()).toBeNull();
		expect(getUpdatesCutoff()).toBeNull();

		activeUserId = null;
		expect(getUpdatesWindowEnd()).toBeNull();
	});

	test("writes nothing while signed out and null clears the record", () => {
		activeUserId = null;
		setUpdatesWindow("2030-01-02T00:00:00.000Z");
		expect(store.has(WINDOW_KEY)).toBe(false);

		activeUserId = "alice";
		setUpdatesWindow("2030-01-02T00:00:00.000Z");
		expect(store.has(WINDOW_KEY)).toBe(true);
		setUpdatesWindow(null);
		expect(store.has(WINDOW_KEY)).toBe(false);
		expect(getUpdatesWindowEnd()).toBeNull();
	});

	test("a corrupt stored date reads as no window, never a NaN cutoff", () => {
		store.set(
			WINDOW_KEY,
			JSON.stringify({ accountId: "alice", windowEndsAt: "not-a-date" })
		);
		expect(getUpdatesWindowEnd()).toBeNull();
		expect(getUpdatesCutoffMs()).toBeNull();
		expect(getUpdatesCutoff()).toBeNull();

		store.set(WINDOW_KEY, "{broken");
		expect(getUpdatesWindowEnd()).toBeNull();
	});

	test("the cutoff is sent only once the grace-inclusive window has lapsed", () => {
		// Still open: the owner takes the normal update path.
		setUpdatesWindow(new Date(Date.now() + 30 * DAY_MS).toISOString());
		expect(getUpdatesCutoffMs()).toBeNull();
		expect(getUpdatesCutoff()).toBeNull();

		// Ended an hour ago but still inside the one-day skew grace.
		setUpdatesWindow(new Date(Date.now() - 60 * 60 * 1000).toISOString());
		expect(getUpdatesCutoff()).toBeNull();

		// Lapsed: the cutoff is the window end plus exactly one day of grace.
		const endMs = Date.parse("2020-06-01T00:00:00.000Z");
		setUpdatesWindow(new Date(endMs).toISOString());
		expect(getUpdatesCutoffMs()).toBe(endMs + DAY_MS);
		expect(getUpdatesCutoff()).toBe("2020-06-02T00:00:00.000Z");
	});
});

describe("lapsed-window nag", () => {
	test("nags once per version for the account that was nagged", () => {
		expect(shouldNagForVersion("1.2.3")).toBe(true);
		markNaggedForVersion("1.2.3");
		expect(JSON.parse(store.get(NAG_KEY) ?? "null")).toEqual({
			accountId: "alice",
			version: "1.2.3",
		});
		expect(shouldNagForVersion("1.2.3")).toBe(false);
		// A newly published version prompts again.
		expect(shouldNagForVersion("1.2.4")).toBe(true);

		// Bob never saw the prompt for 1.2.3.
		activeUserId = "bob";
		expect(shouldNagForVersion("1.2.3")).toBe(true);
	});

	test("marking while signed out records nothing", () => {
		activeUserId = null;
		markNaggedForVersion("1.2.3");
		expect(store.has(NAG_KEY)).toBe(false);
	});
});
