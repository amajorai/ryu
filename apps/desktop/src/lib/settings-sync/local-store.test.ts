// The observer is what makes sync notice anything at all, so these cover the
// two ways it can be silently wrong: missing a write (nothing ever syncs) and
// reporting a write it made itself (an applied remote value bounces straight
// back up, and two machines ping-pong forever).

import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Register happy-dom FIRST, on the same guard every other DOM test in this
// package uses. Without it this file's `window` stub was the only `window` in
// the process when it ran first, and its teardown then DELETED the global —
// leaving every later file that calls `window.dispatchEvent` with nothing.
// Registering means the stubs below replace real globals and the teardown puts
// real globals back, which is the invariant the whole package depends on.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	mock,
} from "bun:test";

/**
 * `bun test` runs this package, and its vitest shim has no `vi.stubGlobal` — the
 * import threw before a single case ran. Installed directly on `globalThis`
 * instead; there is nothing to restore afterwards because both globals are
 * absent under bun and this file owns them for its whole lifetime, which is the
 * install-once contract the comment below depends on.
 */
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();

const stubGlobal = (
	name: string,
	value: Storage | Pick<Window, "addEventListener">
): void => {
	if (!originalGlobals.has(name)) {
		originalGlobals.set(
			name,
			Object.getOwnPropertyDescriptor(globalThis, name)
		);
	}
	Object.defineProperty(globalThis, name, {
		configurable: true,
		writable: true,
		value,
	});
};

import { SYNCABLE_KEYS } from "./keys.ts";
import {
	activateSettingsOwner,
	allLocalTimestamps,
	applyRemote,
	installSettingsObserver,
	isSettingsWindowStale,
	localTimestamp,
	markLocalChange,
	onSettingsChange,
	onStorageKeyChange,
	readCachedValue,
	readLocal,
	writeCachedValue,
} from "./local-store.ts";

/**
 * A minimal in-memory localStorage, installed ONCE — before the observer patches
 * it — and cleared between tests. Re-stubbing per test would leave the observer's
 * captured original setter pointing at a discarded store, which is a test
 * artifact, not a bug in the module: the app installs the observer exactly once
 * over one real Storage.
 */
const store = new Map<string, string>();
/** The `storage` listener the observer registers, so a test can play a sibling window. */
let storageListener: EventListener | null = null;

// INSIDE `beforeAll`, not at module scope. `bun test` imports EVERY file in the
// package before it runs a single test, so a module-level stub is applied at
// import time and owns the global for the whole run — an `afterAll` here cannot
// undo it in time, because other files' tests have already executed against it.
// A `window` carrying only `addEventListener` reached every later file that way,
// and each one died on `window.dispatchEvent`. Installed and torn down around
// THIS file's tests instead, which is the only scope that is actually ours.
beforeAll(() => {
	stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => store.clear(),
		key: (index: number) => [...store.keys()][index] ?? null,
		get length() {
			return store.size;
		},
	});
	// `window` for the `storage` listener the observer registers.
	stubGlobal("window", {
		addEventListener: mock(
			(type: string, listener: EventListenerOrEventListenerObject) => {
				if (type === "storage" && typeof listener === "function") {
					storageListener = listener;
				}
			}
		),
	});
	installSettingsObserver();
});

beforeEach(() => {
	store.clear();
});

const SYNCED_KEY = "ryu_pointer_cursor";
const UNSYNCED_KEY = "ryu_session_token";

describe("change observation", () => {
	it("reports a write to an allowlisted key", () => {
		const seen: string[] = [];
		const off = onSettingsChange((key) => seen.push(key));
		localStorage.setItem(SYNCED_KEY, "true");
		off();
		expect(seen).toContain(SYNCED_KEY);
	});

	it("ignores a write to anything not on the allowlist", () => {
		const seen: string[] = [];
		const off = onSettingsChange((key) => seen.push(key));
		localStorage.setItem(UNSYNCED_KEY, "secret");
		off();
		expect(seen).toEqual([]);
	});

	it("still performs the write it observes", () => {
		localStorage.setItem(SYNCED_KEY, "false");
		expect(readLocal(SYNCED_KEY)).toBe("false");
	});

	it("reports a removal", () => {
		localStorage.setItem(SYNCED_KEY, "true");
		const seen: string[] = [];
		const off = onSettingsChange((key) => seen.push(key));
		localStorage.removeItem(SYNCED_KEY);
		off();
		expect(seen).toContain(SYNCED_KEY);
	});
});

describe("a write from a sibling window", () => {
	it("is neither re-stamped nor reported as this window's change", () => {
		store.set(SYNCED_KEY, "true");
		markLocalChange(SYNCED_KEY, 100);
		const seen: string[] = [];
		const offSettings = onSettingsChange((key) => seen.push(key));
		const storageKeys: string[] = [];
		const offStorage = onStorageKeyChange((key) => storageKeys.push(key));
		storageListener?.(new StorageEvent("storage", { key: SYNCED_KEY }));
		storageListener?.(new StorageEvent("storage", { key: UNSYNCED_KEY }));
		offSettings();
		offStorage();
		expect(storageListener).not.toBeNull();
		expect(localTimestamp(SYNCED_KEY)).toBe(100);
		expect(seen).toEqual([]);
		expect(storageKeys).toEqual([SYNCED_KEY, UNSYNCED_KEY]);
	});
});

describe("applying a remote value", () => {
	it("does not report as a local change", () => {
		const seen: string[] = [];
		const off = onSettingsChange((key) => seen.push(key));
		applyRemote(SYNCED_KEY, "true", 1234);
		off();
		expect(seen).toEqual([]);
		expect(readLocal(SYNCED_KEY)).toBe("true");
	});

	it("adopts the remote timestamp rather than stamping now", () => {
		applyRemote(SYNCED_KEY, "true", 4242);
		expect(localTimestamp(SYNCED_KEY)).toBe(4242);
	});

	it("deletes when the remote value is a tombstone", () => {
		localStorage.setItem(SYNCED_KEY, "true");
		applyRemote(SYNCED_KEY, null, 99);
		expect(readLocal(SYNCED_KEY)).toBeNull();
	});
});

describe("timestamps", () => {
	it("reads 0 for a key that never changed", () => {
		expect(localTimestamp("ryu_radius")).toBe(0);
	});

	it("records an explicit change time", () => {
		markLocalChange("ryu_radius", 777);
		expect(localTimestamp("ryu_radius")).toBe(777);
	});

	it("stamps a real write with a current time", () => {
		const before = Date.now();
		localStorage.setItem(SYNCED_KEY, "true");
		expect(localTimestamp(SYNCED_KEY)).toBeGreaterThanOrEqual(before);
	});
});

// PUT THE GLOBALS BACK when this file is done. `bun test` runs the whole package
// in ONE process, and the `window` installed above is a two-property stand-in —
// it has `addEventListener` and nothing else. Left in place it becomes the
// `window` every later file sees, so the first one to call `window.dispatchEvent`
// dies on a global this file owns. That failure only ever appears in the full
// run, never when the victim is run alone, which is what makes it expensive to
// track down.
afterAll(() => {
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) {
			Object.defineProperty(globalThis, name, descriptor);
		} else {
			Reflect.deleteProperty(globalThis, name);
		}
	}
	originalGlobals.clear();
});

describe("persisted sync maps", () => {
	it("retains own timestamp keys and the native numeric domain", () => {
		store.set(
			"ryu:settings-sync-meta",
			'{"__proto__":7,"unsafeEpoch":9007199254740992,"overflow":1e400}'
		);
		const timestamps = allLocalTimestamps();
		expect(Object.hasOwn(timestamps, "__proto__")).toBe(true);
		expect(timestamps.unsafeEpoch).toBe(9_007_199_254_740_992);
		expect(timestamps.overflow).toBe(Number.POSITIVE_INFINITY);
		markLocalChange("new", 42);
		expect(localTimestamp("__proto__")).toBe(7);
	});

	it("refuses malformed map entries without inventing typed timestamps or values", () => {
		store.set("ryu:settings-sync-meta", '{"key":"not a timestamp"}');
		expect(allLocalTimestamps()).toEqual({});
		expect(localTimestamp("key")).toBe(0);
		store.set("ryu:settings-sync-value-cache", '{"key":42}');
		expect(readCachedValue("key")).toBeNull();
	});

	it("updates a complete string cache without losing own prototype-named keys", () => {
		store.set(
			"ryu:settings-sync-value-cache",
			'{"__proto__":"future","key":"old"}'
		);
		writeCachedValue("key", "new");
		expect(readCachedValue("__proto__")).toBe("future");
		expect(readCachedValue("key")).toBe("new");
		writeCachedValue("key", null);
		expect(readCachedValue("key")).toBeNull();
	});
});

describe("account ownership", () => {
	it("keeps values and timestamps with the account that authored them", () => {
		localStorage.setItem(SYNCED_KEY, "account-a-value");
		markLocalChange(SYNCED_KEY, 101);
		activateSettingsOwner("account-a", true);

		activateSettingsOwner("account-b");
		expect(readLocal(SYNCED_KEY)).toBeNull();
		// B's edit, made in a window loaded after the switch (this one's features
		// may still hold A's values, so its own writes are dropped).
		store.set(SYNCED_KEY, "account-b-value");
		markLocalChange(SYNCED_KEY, 202);

		activateSettingsOwner("account-a");
		expect(readLocal(SYNCED_KEY)).toBe("account-a-value");
		expect(localTimestamp(SYNCED_KEY)).toBe(101);
		activateSettingsOwner("account-b");
		expect(readLocal(SYNCED_KEY)).toBe("account-b-value");
		expect(localTimestamp(SYNCED_KEY)).toBe(202);
		activateSettingsOwner(null);
	});
});

describe("a window left behind by another window's switch", () => {
	const VISIBLE_OWNER_KEY = "ryu:settings-sync-visible-owner";

	it("drops its features' writes to synced keys until it follows the switch", () => {
		activateSettingsOwner(null);
		store.clear();
		activateSettingsOwner("account-a", true);
		localStorage.setItem(SYNCED_KEY, "a-value");
		const stampOfA = localTimestamp(SYNCED_KEY);
		// Another window installed B's values. Its writes reach this window's
		// storage, not this window's setItem patch.
		store.set(SYNCED_KEY, "b-value");
		store.set(VISIBLE_OWNER_KEY, "account-b");

		// A feature here still holds A's value and writes it back.
		localStorage.setItem(SYNCED_KEY, "a-value-from-memory");
		localStorage.removeItem(SYNCED_KEY);
		expect(store.get(SYNCED_KEY)).toBe("b-value");
		expect(localTimestamp(SYNCED_KEY)).toBe(stampOfA);
		// Identity and other unsynced keys are not this window's to hold back.
		localStorage.setItem(UNSYNCED_KEY, "next-bearer");
		expect(store.get(UNSYNCED_KEY)).toBe("next-bearer");

		// Mid-switch, while no owner is recorded, it is no one's write either.
		store.set(VISIBLE_OWNER_KEY, "unowned-transition");
		localStorage.setItem(SYNCED_KEY, "a-value-from-memory");
		expect(store.get(SYNCED_KEY)).toBe("b-value");

		// Once this window follows the switch, its writes are B's own again.
		store.set(VISIBLE_OWNER_KEY, "account-b");
		activateSettingsOwner("account-b");
		expect(store.get(SYNCED_KEY)).toBe("b-value");
		localStorage.setItem(SYNCED_KEY, "b-edit");
		expect(store.get(SYNCED_KEY)).toBe("b-edit");
		activateSettingsOwner(null);
	});
});

describe("account ownership across restarts", () => {
	const VISIBLE_OWNER_KEY = "ryu:settings-sync-visible-owner";
	let previousProcessPatch: Pick<Storage, "removeItem" | "setItem"> | null =
		null;
	afterEach(() => {
		if (previousProcessPatch) {
			localStorage.setItem = previousProcessPatch.setItem;
			localStorage.removeItem = previousProcessPatch.removeItem;
			previousProcessPatch = null;
		}
	});
	/**
	 * A new process: a fresh module instance with no owner loaded in memory,
	 * over a Storage the previous process's observer no longer patches (that
	 * module stays loaded in this runner with its owner in memory, and its
	 * patch would otherwise judge the new process's writes).
	 */
	async function restart(tag: string) {
		previousProcessPatch ??= {
			removeItem: localStorage.removeItem,
			setItem: localStorage.setItem,
		};
		localStorage.setItem = (key: string, value: string) => {
			store.set(key, value);
		};
		localStorage.removeItem = (key: string) => {
			store.delete(key);
		};
		return (await import(
			`./local-store.ts?restart=${tag}`
		)) as typeof import("./local-store.ts");
	}

	it("a restart does not replace the active account's newer values with an older snapshot", async () => {
		activateSettingsOwner(null);
		store.clear();
		activateSettingsOwner("account-a", true);
		localStorage.setItem(SYNCED_KEY, "a-older");
		activateSettingsOwner("account-b");
		activateSettingsOwner("account-a");
		// Edited after the snapshot taken when A was last switched away from (in
		// a window loaded after the switch back).
		store.set(SYNCED_KEY, "a-newer");

		const next = await restart("same-account");
		next.activateSettingsOwner(
			"account-a",
			next.canClaimVisibleSettings("account-a")
		);
		expect(next.readLocal(SYNCED_KEY)).toBe("a-newer");
		activateSettingsOwner(null);
	});

	it("a switch made while no engine was loaded saves the previous owner's values before loading the next", async () => {
		activateSettingsOwner(null);
		store.clear();
		activateSettingsOwner("account-a", true);
		localStorage.setItem(SYNCED_KEY, "a-value");
		// The process ends while A's values are visible; the next start is B.
		const next = await restart("other-account");
		expect(next.canClaimVisibleSettings("account-b")).toBe(false);
		next.activateSettingsOwner("account-b", false);
		expect(next.readLocal(SYNCED_KEY)).toBeNull();
		next.activateSettingsOwner("account-a");
		expect(next.readLocal(SYNCED_KEY)).toBe("a-value");
		next.activateSettingsOwner(null);
		activateSettingsOwner(null);
	});

	it("values left by a sign-out are claimed by no account", async () => {
		activateSettingsOwner(null);
		store.clear();
		activateSettingsOwner("account-a", true);
		activateSettingsOwner(null);
		// Written while no verified account was active.
		localStorage.setItem(SYNCED_KEY, "ownerless");
		expect(localStorage.getItem(VISIBLE_OWNER_KEY)).toBe("unowned-transition");
		const next = await restart("signed-out");
		expect(next.canClaimVisibleSettings("account-b")).toBe(false);
		next.activateSettingsOwner("account-b", false);
		expect(next.readLocal(SYNCED_KEY)).toBeNull();
		next.activateSettingsOwner(null);
	});
});

// The binding between a feature's write and the owner whose values it loaded.
// Features hold synced values in memory (a zustand store read at module load,
// React state, refs) and write them back whole; the setItem/removeItem patch
// is the one place every such write passes, for every allowlisted key.
describe("writes from a window whose features loaded another owner's settings", () => {
	const VALUES_B = "ryu:settings-sync-values:account-b";
	const VALUES_A = "ryu:settings-sync-values:account-a";
	const valuesOf = (owner: string) =>
		Object.fromEntries(
			SYNCABLE_KEYS.map(({ key }) => [key, `${owner}-private:${key}`])
		);
	const A_VALUES = valuesOf("a");
	const B_VALUES = valuesOf("b");
	let thisWindowsPatch: Pick<Storage, "removeItem" | "setItem"> | null = null;
	let documentSeq = 0;

	afterEach(() => {
		if (thisWindowsPatch) {
			localStorage.setItem = thisWindowsPatch.setItem;
			localStorage.removeItem = thisWindowsPatch.removeItem;
			thisWindowsPatch = null;
		}
		activateSettingsOwner(null);
	});

	/** Every storage write made while `run` executes, as another window of the
	 *  app makes it: straight to the shared storage, past this window's patch. */
	function asOtherWindow(run: () => void): void {
		const patched = globalThis.localStorage;
		const shared = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => {
				store.set(key, value);
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
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			writable: true,
			value: shared,
		});
		try {
			run();
		} finally {
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				writable: true,
				value: patched,
			});
		}
	}

	/** Another window's settings module (its own loaded owner and epoch). */
	async function otherWindowModule() {
		documentSeq++;
		return (await import(
			`./local-store.ts?window=other-${documentSeq}`
		)) as typeof import("./local-store.ts");
	}

	/** A new document (a reloaded window): a fresh module whose own patch is
	 *  the one judging its writes. */
	async function reloadedDocument() {
		thisWindowsPatch ??= {
			removeItem: localStorage.removeItem,
			setItem: localStorage.setItem,
		};
		localStorage.setItem = (key: string, value: string) => {
			store.set(key, value);
		};
		localStorage.removeItem = (key: string) => {
			store.delete(key);
		};
		documentSeq++;
		const module = (await import(
			`./local-store.ts?reloaded=${documentSeq}`
		)) as typeof import("./local-store.ts");
		module.installSettingsObserver();
		return module;
	}

	function showAsVisible(values: Record<string, string>): void {
		for (const [key, value] of Object.entries(values)) {
			store.set(key, value);
		}
	}

	/** Every allowlisted key written back from memory, then removed. */
	function writeBackEveryKey(values: Record<string, string>): string[] {
		const reported: string[] = [];
		const off = onSettingsChange((key) => reported.push(key));
		for (const { key } of SYNCABLE_KEYS) {
			localStorage.setItem(key, values[key] ?? "");
		}
		for (const { key } of SYNCABLE_KEYS) {
			localStorage.removeItem(key);
		}
		off();
		return reported;
	}

	/** The visible value of every allowlisted key. */
	function visibleValues(): Record<string, string | undefined> {
		return Object.fromEntries(
			SYNCABLE_KEYS.map(({ key }) => [key, store.get(key)])
		);
	}

	it("drops every allowlisted key's write-back after another window switched accounts, even once this window follows", async () => {
		store.clear();
		activateSettingsOwner("account-a", true);
		showAsVisible(A_VALUES);
		store.set(VALUES_B, JSON.stringify(B_VALUES));

		const w1 = await otherWindowModule();
		asOtherWindow(() => {
			w1.activateSettingsOwner(
				"account-a",
				w1.visibleSettingsClaim("account-a")
			);
			w1.activateSettingsOwner("account-b");
		});
		expect(visibleValues()).toEqual(B_VALUES);
		// This window follows the switch, as its engine does on the bearer change.
		activateSettingsOwner("account-b");

		const reported = writeBackEveryKey(A_VALUES);
		expect(visibleValues()).toEqual(B_VALUES);
		expect(reported).toEqual([]);
		for (const { key } of SYNCABLE_KEYS) {
			expect({ key, stamp: localTimestamp(key) }).toEqual({ key, stamp: 0 });
		}
		// Identity and other unsynced keys are not held back.
		localStorage.setItem(UNSYNCED_KEY, "next-bearer");
		expect(store.get(UNSYNCED_KEY)).toBe("next-bearer");

		// Leaving B saves B's own values, not this window's in-memory A copies.
		activateSettingsOwner("account-a");
		expect(JSON.parse(store.get(VALUES_B) ?? "{}")).toEqual(B_VALUES);
		// Sticky until a reload: following the switch did not make it fresh.
		expect(isSettingsWindowStale()).toBe(true);
	});

	it("drops every allowlisted key's write-back in the switching window before it reloads", () => {
		store.clear();
		activateSettingsOwner("account-a", true);
		showAsVisible(A_VALUES);
		store.set(VALUES_B, JSON.stringify(B_VALUES));
		activateSettingsOwner("account-b");

		expect(writeBackEveryKey(A_VALUES)).toEqual([]);
		expect(visibleValues()).toEqual(B_VALUES);
		activateSettingsOwner("account-a");
		expect(JSON.parse(store.get(VALUES_B) ?? "{}")).toEqual(B_VALUES);
		expect(JSON.parse(store.get(VALUES_A) ?? "{}")).toEqual(A_VALUES);
	});

	it("a window reloaded after the switch writes as the new account again", async () => {
		store.clear();
		activateSettingsOwner("account-a", true);
		showAsVisible(A_VALUES);
		activateSettingsOwner("account-b");
		const reloaded = await reloadedDocument();
		reloaded.activateSettingsOwner(
			"account-b",
			reloaded.visibleSettingsClaim("account-b")
		);
		expect(reloaded.isSettingsWindowStale()).toBe(false);
		localStorage.setItem(SYNCED_KEY, "b-edit");
		expect(store.get(SYNCED_KEY)).toBe("b-edit");
		expect(reloaded.localTimestamp(SYNCED_KEY)).toBeGreaterThan(0);
		reloaded.activateSettingsOwner(null);
	});

	it("signing in from the signed-out slate does not strand a window loaded while signed out", async () => {
		store.clear();
		activateSettingsOwner("account-a", true);
		showAsVisible(A_VALUES);
		// Sign-out: A's values are moved aside and the clean slate installed.
		activateSettingsOwner(null);
		expect(isSettingsWindowStale()).toBe(true);
		const loginWindow = await reloadedDocument();
		expect(loginWindow.isSettingsWindowStale()).toBe(false);
		loginWindow.activateSettingsOwner(
			"account-b",
			loginWindow.visibleSettingsClaim("account-b")
		);
		// Nothing any account wrote was in its memory: it is not stale.
		expect(loginWindow.isSettingsWindowStale()).toBe(false);
		localStorage.setItem(SYNCED_KEY, "b-edit");
		expect(store.get(SYNCED_KEY)).toBe("b-edit");
		// The window that loaded A's values stays stale across that sign-in.
		expect(isSettingsWindowStale()).toBe(true);
		loginWindow.activateSettingsOwner(null);
	});

	it("values left visible by a sign-out no engine moved aside strand the window that loaded them", async () => {
		store.clear();
		activateSettingsOwner("account-a", true);
		showAsVisible(A_VALUES);
		// The auth client marks the record on a sign-out with no engine mounted;
		// A's values are still on screen.
		store.set("ryu:settings-sync-visible-owner", "unowned-transition");
		const loginWindow = await reloadedDocument();
		loginWindow.activateSettingsOwner(
			"account-b",
			loginWindow.visibleSettingsClaim("account-b")
		);
		expect(loginWindow.isSettingsWindowStale()).toBe(true);
		const reported: string[] = [];
		const off = loginWindow.onSettingsChange((key) => reported.push(key));
		localStorage.setItem(SYNCED_KEY, A_VALUES[SYNCED_KEY] ?? "");
		off();
		expect(store.get(SYNCED_KEY)).toBeUndefined();
		expect(reported).toEqual([]);
		loginWindow.activateSettingsOwner(null);
	});
});
