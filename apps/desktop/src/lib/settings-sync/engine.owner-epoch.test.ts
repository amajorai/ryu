// A feature that holds a synced setting in memory must not write it into the
// next account's settings after an account switch, in any window of the app.
//
// The real engine, local store, HTTP client and split-layout store run here
// over a Storage whose `setItem`/`removeItem` the settings observer really
// patches, as in a browser (happy-dom's own Storage ignores the patch). Window
// W2 is the engine under test; window W1 is a separate local-store instance
// whose writes reach W2 only as `storage` events. Only the control-plane
// server is a fixture, keyed by bearer the way the real route derives userId.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import {
	type AccountIdentity,
	announceAccountIdentityChange,
	onBeforeAccountIdentityChange,
	trackAccountWrite,
} from "@/lib/account-transition.ts";

const TOKEN_KEY = "ryu_session_token";
const ACCOUNTS_KEY = "ryu_accounts";
const ACTIVE_USER_KEY = "ryu_active_user_id";
const ENABLED_KEY = "ryu:settings-sync-enabled";
const BACKEND = "http://settings-sync-epoch.fixture.test";
const ACCOUNT_A: AccountIdentity = { token: "bearer-a", userId: "user-a" };
const ACCOUNT_B: AccountIdentity = { token: "bearer-b", userId: "user-b" };
const ACCOUNT_A_REFRESHED: AccountIdentity = {
	token: "bearer-a-refreshed",
	userId: "user-a",
};
const A_LAYOUT = "A confidential client layout";
const A_ROUTE = "/chat/conversation-of-a";

mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: BACKEND,
	getActiveToken: () => localStorage.getItem(TOKEN_KEY),
	onActiveTokenChange: () => () => undefined,
	onBeforeAccountIdentityChange,
	TOKEN_KEY,
}));
mock.module("@/src/lib/api/preferences.ts", () => ({
	getKeybindings: () => Promise.resolve({}),
	setKeybindings: () => Promise.resolve(),
}));
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: {
		getState: () => ({
			getActiveNode: () => ({ token: null, url: "http://127.0.0.1:1" }),
		}),
		subscribe: () => () => undefined,
	},
}));

// ── A Storage the observer can patch ─────────────────────────────────────────

const shared = globalThis.localStorage;
const sharedDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
);
function storageView(): Storage {
	return {
		clear: () => shared.clear(),
		getItem: (key: string) => shared.getItem(key),
		key: (index: number) => shared.key(index),
		get length() {
			return shared.length;
		},
		removeItem(key: string) {
			shared.removeItem(key);
		},
		setItem(key: string, value: string) {
			shared.setItem(key, value);
		},
	};
}
/** This window's `localStorage`: the one the settings observer patches. */
const w2Storage = storageView();
function useStorage(storage: Storage): void {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: storage,
		writable: true,
	});
}
useStorage(w2Storage);

// ── The control-plane fixture ────────────────────────────────────────────────

interface Entry {
	key: string;
	updatedAt: number;
	value: string | null;
}
interface Call {
	authorization: string | null;
	body: string;
	method: string;
}
const USERS_BY_BEARER = new Map([
	[`Bearer ${ACCOUNT_A.token}`, "user-a"],
	[`Bearer ${ACCOUNT_B.token}`, "user-b"],
	[`Bearer ${ACCOUNT_A_REFRESHED.token}`, "user-a"],
]);
const clouds = new Map<string, Map<string, Entry>>();
let calls: Call[] = [];
let revision = 0;

function cloudOf(userId: string): Map<string, Entry> {
	let cloud = clouds.get(userId);
	if (!cloud) {
		cloud = new Map();
		clouds.set(userId, cloud);
	}
	return cloud;
}

const originalFetch = globalThis.fetch;
const fixtureFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const body = request.method === "GET" ? "" : await request.text();
	const authorization = request.headers.get("authorization");
	calls.push({ authorization, body, method: request.method });
	const userId = USERS_BY_BEARER.get(authorization ?? "");
	if (!userId) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}
	const cloud = cloudOf(userId);
	if (url.pathname.endsWith("/pull")) {
		return Response.json({
			entries: [...cloud.values()],
			revision,
			updatedAt: 1,
		});
	}
	if (url.pathname.endsWith("/push")) {
		const { entries } = JSON.parse(body) as { entries: Entry[] };
		for (const entry of entries) {
			cloud.set(entry.key, entry);
		}
		revision++;
		return Response.json({
			applied: entries.map((entry) => entry.key),
			rejected: [],
			revision,
			updatedAt: 1,
		});
	}
	return Response.json({ error: "Unknown route" }, { status: 404 });
};
globalThis.fetch = Object.assign(fixtureFetch, {
	preconnect: originalFetch.preconnect,
});

const engine = await import("./engine.ts");
const { SYNCABLE_KEYS } = await import("./keys.ts");
const { SETTINGS_OWNER_CHANGED_EVENT } = await import("./local-store.ts");
const { reloadWhenSettingsOwnerChanges } = await import("./owner-reload.ts");
const { SPLIT_PRESETS_KEY, useSplitPresetStore } = await import(
	"@/src/store/useSplitPresetStore.ts"
);
const { makePresetBranch, makeSlot } = await import(
	"@/src/lib/splitPresets.ts"
);

let stopEngine: (() => void) | null = null;
let ownerChangedEvents = 0;
const countOwnerChanged = () => {
	ownerChangedEvents++;
};
window.addEventListener(SETTINGS_OWNER_CHANGED_EVENT, countOwnerChanged);

async function idle(): Promise<void> {
	const deadline = Date.now() + 3000;
	while (engine.getSyncStatus() === "syncing") {
		if (Date.now() > deadline) {
			throw new Error("settings sync did not settle");
		}
		await Bun.sleep(1);
	}
	await Bun.sleep(5);
}

function sentWith(account: AccountIdentity): Call[] {
	return calls.filter(
		(call) => call.authorization === `Bearer ${account.token}`
	);
}

function bSawAnywhere(needle: string): boolean {
	return (
		sentWith(ACCOUNT_B).some((call) => call.body.includes(needle)) ||
		[...cloudOf("user-b").values()].some((entry) =>
			(entry.value ?? "").includes(needle)
		)
	);
}

function seedVault(accounts: readonly AccountIdentity[], active: string): void {
	localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
	localStorage.setItem(ACTIVE_USER_KEY, active);
}

/** The settings-sync engine of W2, signed in as A with sync on. */
async function startAsA(): Promise<void> {
	seedVault([ACCOUNT_A, ACCOUNT_B], ACCOUNT_A.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_A.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	stopEngine = engine.startSettingsSync();
	await idle();
}

/** What persistVault does in W2 itself: announce, then move the live bearer. */
function switchThisWindowTo(next: AccountIdentity): void {
	announceAccountIdentityChange({
		from: {
			token: localStorage.getItem(TOKEN_KEY),
			userId: localStorage.getItem(ACTIVE_USER_KEY),
		},
		to: next,
	});
	localStorage.setItem(ACTIVE_USER_KEY, next.userId ?? "");
	localStorage.setItem(TOKEN_KEY, next.token ?? "");
	// happy-dom delivers no same-document event for the bearer write.
	window.dispatchEvent(
		new StorageEvent("storage", { key: TOKEN_KEY, newValue: next.token })
	);
}

let otherWindowSeq = 0;

/**
 * W1 switches the shared storage from A to B: its own engine's activation (a
 * separate module instance) and its vault write, straight to the shared
 * storage, each write then delivered to W2 as a `storage` event.
 */
async function switchInOtherWindow(): Promise<void> {
	otherWindowSeq++;
	const writes: { key: string; newValue: string | null }[] = [];
	const w1Storage: Storage = {
		...storageView(),
		get length() {
			return shared.length;
		},
		removeItem(key: string) {
			shared.removeItem(key);
			writes.push({ key, newValue: null });
		},
		setItem(key: string, value: string) {
			shared.setItem(key, value);
			writes.push({ key, newValue: value });
		},
	};
	useStorage(w1Storage);
	// W1's own window events (its remote-applied and owner-changed events) are
	// dispatched in W1's document, not this one.
	const dispatchInW2 = window.dispatchEvent;
	window.dispatchEvent = () => true;
	try {
		const w1 = (await import(
			`./local-store.ts?epoch-window=${otherWindowSeq}`
		)) as typeof import("./local-store.ts");
		w1.activateSettingsOwner("user-a", w1.visibleSettingsClaim("user-a"));
		w1.activateSettingsOwner("user-b");
		localStorage.setItem(ACTIVE_USER_KEY, ACCOUNT_B.userId ?? "");
		localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
	} finally {
		window.dispatchEvent = dispatchInW2;
		useStorage(w2Storage);
	}
	for (const { key, newValue } of writes) {
		window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
	}
	await idle();
}

const twoPanes = (path?: string) =>
	makePresetBranch("columns", [makeSlot(path), makeSlot()]);

/** A's split layouts, saved through the real store and synced to A's cloud. */
async function saveLayoutsAsA(): Promise<void> {
	useSplitPresetStore.getState().reload();
	if (!useSplitPresetStore.getState().savePreset(A_LAYOUT, twoPanes(A_ROUTE))) {
		throw new Error("fixture: A's layout was not saved");
	}
	await engine.syncPendingNow();
	await idle();
	// Precondition: the store's writes really pass the patched observer.
	if (!cloudOf("user-a").get(SPLIT_PRESETS_KEY)?.value?.includes(A_LAYOUT)) {
		throw new Error("fixture: A's layout did not reach A's cloud");
	}
}

beforeEach(() => {
	localStorage.clear();
	clouds.clear();
	calls = [];
	revision = 0;
	ownerChangedEvents = 0;
});
afterEach(() => {
	stopEngine?.();
	stopEngine = null;
});
afterAll(() => {
	window.removeEventListener(SETTINGS_OWNER_CHANGED_EVENT, countOwnerChanged);
	globalThis.fetch = originalFetch;
	if (sharedDescriptor) {
		Object.defineProperty(globalThis, "localStorage", sharedDescriptor);
	}
});

test("a second window that followed a switch to B cannot push A's split layouts with B's bearer", async () => {
	await startAsA();
	await saveLayoutsAsA();

	await switchInOtherWindow();
	expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");

	// The user saves, renames and deletes layouts in W2 before it reloads; the
	// store still holds A's layouts in memory and writes the whole collection.
	const store = useSplitPresetStore.getState();
	const saved = store.savePreset("B layout", twoPanes());
	const aLayout = useSplitPresetStore
		.getState()
		.presets.find((preset) => preset.name === A_LAYOUT);
	if (aLayout) {
		store.renamePreset(aLayout.id, `${A_LAYOUT} (renamed)`);
	}
	if (saved) {
		store.deletePreset(saved.id);
	}
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();

	expect(bSawAnywhere(A_LAYOUT)).toBe(false);
	expect(bSawAnywhere("conversation-of-a")).toBe(false);
	expect(localStorage.getItem(SPLIT_PRESETS_KEY) ?? "").not.toContain(A_LAYOUT);
	// A's layouts stay A's, and W2 was told to reload.
	expect(localStorage.getItem("ryu:settings-sync-values:user-a")).toContain(
		A_LAYOUT
	);
	expect(ownerChangedEvents).toBe(1);
});

test("the switching window cannot push A's split layouts with B's bearer before its reload", async () => {
	await startAsA();
	await saveLayoutsAsA();

	switchThisWindowTo(ACCOUNT_B);
	expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");
	useSplitPresetStore.getState().savePreset("B layout", twoPanes());
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();

	expect(bSawAnywhere(A_LAYOUT)).toBe(false);
	expect(bSawAnywhere("conversation-of-a")).toBe(false);
	expect(ownerChangedEvents).toBe(1);
});

test("no allowlisted value held in a window's memory reaches B after another window's switch", async () => {
	await startAsA();
	const aValues = Object.fromEntries(
		SYNCABLE_KEYS.map(({ key }) => [key, `a-private-${key}`])
	);
	for (const [key, value] of Object.entries(aValues)) {
		localStorage.setItem(key, value);
	}
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf("user-a").size).toBe(SYNCABLE_KEYS.length);

	await switchInOtherWindow();
	expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");
	// Every feature in W2 writes its in-memory (A's) value back.
	for (const [key, value] of Object.entries(aValues)) {
		localStorage.setItem(key, `${value}-edited`);
	}
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();

	for (const { key } of SYNCABLE_KEYS) {
		expect({ key, leaked: bSawAnywhere(`a-private-${key}`) }).toEqual({
			key,
			leaked: false,
		});
		expect({ key, visible: localStorage.getItem(key) }).toEqual({
			key,
			visible: null,
		});
	}
});

test("every window reloads after an account switch, once the vault write settles", async () => {
	const reloads: string[] = [];
	const stopReload = reloadWhenSettingsOwnerChanges(() => reloads.push("W2"));
	try {
		await startAsA();
		let finishVaultWrite: () => void = () => undefined;
		// The durable vault copy is still being written when the switch lands.
		trackAccountWrite(
			new Promise<void>((resolve) => {
				finishVaultWrite = resolve;
			})
		);
		await switchInOtherWindow();
		await Bun.sleep(5);
		expect(reloads).toEqual([]);
		finishVaultWrite();
		await Bun.sleep(5);
		expect(reloads).toEqual(["W2"]);
	} finally {
		stopReload();
	}
});

test("a same-account bearer refresh reloads no window", async () => {
	const reloads: string[] = [];
	const stopReload = reloadWhenSettingsOwnerChanges(() => reloads.push("W2"));
	try {
		await startAsA();
		seedVault([ACCOUNT_A_REFRESHED, ACCOUNT_B], ACCOUNT_A.userId ?? "");
		switchThisWindowTo(ACCOUNT_A_REFRESHED);
		await Bun.sleep(5);
		expect(reloads).toEqual([]);
		expect(ownerChangedEvents).toBe(0);
		// Its feature writes are still A's own edits.
		localStorage.setItem("theme", "a-after-refresh");
		expect(engine.getPendingCount()).toBe(1);
	} finally {
		stopReload();
	}
});

test("layouts a pre-scoping store showed in a shared vault are neither kept for the account at upgrade nor written back from memory", async () => {
	// The earlier build kept one set of visible settings for every account: A's
	// layouts are on screen while B is active, with no record of their owner.
	seedVault([ACCOUNT_A, ACCOUNT_B], ACCOUNT_B.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	localStorage.setItem("theme", "legacy-theme");
	localStorage.setItem(
		SPLIT_PRESETS_KEY,
		JSON.stringify([
			{
				createdAt: 1,
				id: "preset-a",
				name: A_LAYOUT,
				root: twoPanes(A_ROUTE),
			},
		])
	);
	// The store read them when the window loaded, before the engine started.
	useSplitPresetStore.getState().reload();
	expect(useSplitPresetStore.getState().presets[0]?.name).toBe(A_LAYOUT);

	stopEngine = engine.startSettingsSync();
	await idle();
	expect(localStorage.getItem("theme")).toBe("legacy-theme");
	expect(localStorage.getItem(SPLIT_PRESETS_KEY)).toBeNull();

	useSplitPresetStore.getState().savePreset("B layout", twoPanes());
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();
	expect(bSawAnywhere(A_LAYOUT)).toBe(false);
	expect(bSawAnywhere("conversation-of-a")).toBe(false);
	expect(ownerChangedEvents).toBe(1);
});

test("a sole account's pre-scoping layouts stay on screen without a reload", async () => {
	seedVault([ACCOUNT_B], ACCOUNT_B.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
	localStorage.setItem(
		SPLIT_PRESETS_KEY,
		JSON.stringify([
			{ createdAt: 1, id: "preset-b", name: "B layout", root: twoPanes() },
		])
	);
	stopEngine = engine.startSettingsSync();
	await idle();
	expect(localStorage.getItem(SPLIT_PRESETS_KEY)).toContain("B layout");
	expect(ownerChangedEvents).toBe(0);
});
