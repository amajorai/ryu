import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDomRegistration = globalThis.document === undefined;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}

const STORAGE_KEY = "ryu:getting-started";

const {
	GETTING_STARTED_EVENT,
	getCompletedSnapshot,
	markQuestComplete,
	resetGettingStarted,
	subscribeGettingStarted,
} = await import("./getting-started.ts");

// A fresh module instance stands in for a newly opened window: it reads storage
// once at load, exactly like the real module does on app start.
async function openNewWindow(): Promise<typeof import("./getting-started.ts")> {
	return await import(`./getting-started.ts?window=${crypto.randomUUID()}`);
}

function persisted(): unknown {
	return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
}

beforeEach(() => {
	resetGettingStarted();
});

afterAll(async () => {
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

test("a new window starts from the persisted completed set", async () => {
	// Progress saved by a previous launch; a fresh module instance is a new window.
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ completed: ["chat"] }));
	const freshWindow = await openNewWindow();
	expect(freshWindow.getCompletedSnapshot()).toEqual(["chat"]);

	// Corrupt saved progress starts a new window from scratch instead of throwing.
	localStorage.setItem(STORAGE_KEY, "{not json");
	const corruptWindow = await openNewWindow();
	expect(corruptWindow.getCompletedSnapshot()).toEqual([]);
});

test("completion persists, is sticky and idempotent, and notifies once", () => {
	let directCalls = 0;
	let windowEvents = 0;
	const unsubscribe = subscribeGettingStarted(() => {
		directCalls += 1;
	});
	const onEvent = () => {
		windowEvents += 1;
	};
	window.addEventListener(GETTING_STARTED_EVENT, onEvent);

	markQuestComplete("project");
	const afterFirst = getCompletedSnapshot();
	markQuestComplete("project");

	expect(getCompletedSnapshot()).toEqual(["project"]);
	// No-op repeat keeps the same reference so useSyncExternalStore does not spin.
	expect(getCompletedSnapshot()).toBe(afterFirst);
	expect(persisted()).toEqual({ completed: ["project"] });
	expect(directCalls).toBe(1);
	expect(windowEvents).toBe(1);

	markQuestComplete("model");
	expect(persisted()).toEqual({ completed: ["project", "model"] });

	unsubscribe();
	window.removeEventListener(GETTING_STARTED_EVENT, onEvent);
	markQuestComplete("skill");
	expect(directCalls).toBe(2);
});

test("reset clears persisted progress and is a no-op when already empty", () => {
	markQuestComplete("agent");
	resetGettingStarted();
	expect(getCompletedSnapshot()).toEqual([]);
	expect(persisted()).toEqual({ completed: [] });

	let calls = 0;
	const unsubscribe = subscribeGettingStarted(() => {
		calls += 1;
	});
	resetGettingStarted();
	expect(calls).toBe(0);
	unsubscribe();
});

test("a storage event from another window refreshes the snapshot", () => {
	let calls = 0;
	const unsubscribe = subscribeGettingStarted(() => {
		calls += 1;
	});

	localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify({ completed: ["workflow", "customize"] })
	);
	window.dispatchEvent(
		new StorageEvent("storage", { key: "some-other-key", newValue: "x" })
	);
	expect(calls).toBe(0);
	expect(getCompletedSnapshot()).toEqual([]);

	window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
	expect(calls).toBe(1);
	expect(getCompletedSnapshot()).toEqual(["workflow", "customize"]);

	// Another window wrote garbage: treat as a fresh start rather than throwing.
	localStorage.setItem(STORAGE_KEY, '{"completed":"nope"}');
	window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
	expect(getCompletedSnapshot()).toEqual([]);

	unsubscribe();
	localStorage.setItem(STORAGE_KEY, JSON.stringify({ completed: ["chat"] }));
	window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
	expect(getCompletedSnapshot()).toEqual([]);
	expect(calls).toBe(2);
});
