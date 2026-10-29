// Account switch with a pending settings change: a value edited while account A
// is active must never be sent with account B's bearer — not by the close-time
// flush, not by B's next sync cycle — and must still reach A's cloud copy once
// A is active again.
//
// Runs the real engine, local store and HTTP client; only the control-plane
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
} from "@/lib/account-transition.ts";

const TOKEN_KEY = "ryu_session_token";
const ENABLED_KEY = "ryu:settings-sync-enabled";
const VISIBLE_OWNER_KEY = "ryu:settings-sync-visible-owner";
const BACKEND = "http://settings-sync.fixture.test";
// Allowlisted, and holds user-authored section names and conversation ids.
const SECTIONS_KEY = "ryu:bot-chat-sections:v1";
const A_SECRET = JSON.stringify({
	assignments: { "conversation-of-a": "section-a" },
	sections: [{ id: "section-a", name: "A's private section" }],
});

const ACCOUNTS_KEY = "ryu_accounts";
const ACTIVE_USER_KEY = "ryu_active_user_id";

const ACCOUNT_A: AccountIdentity = { token: "bearer-a", userId: "user-a" };
const ACCOUNT_B: AccountIdentity = { token: "bearer-b", userId: "user-b" };
// Account A after a routine bearer refresh: same account, new token.
const ACCOUNT_A_REFRESHED: AccountIdentity = {
	token: "bearer-a-refreshed",
	userId: "user-a",
};
// A third account signing in on the shared profile while its profile lookup
// fails: the auth client's offline fallback stores the bearer with no vault row.
const UNVERIFIED_C_TOKEN = "bearer-c-unverified";
// A legacy single-token install runs under the token itself as a placeholder
// userId until its profile resolves.
const LEGACY_TOKEN = "bearer-legacy";
const LEGACY_REAL_USER = "user-legacy";

// The vault and live bearer are real storage, read by the real session-owner
// check; only the auth client's network/Tauri side is replaced.
mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: BACKEND,
	getActiveToken: () => localStorage.getItem(TOKEN_KEY),
	onActiveTokenChange: () => () => undefined,
	onBeforeAccountIdentityChange,
	TOKEN_KEY,
}));
// Core's shortcut preference: ONE set per node, shared by every account, the
// way apps/core get_preference/set_preference store it (no caller scope).
let coreShortcuts: Record<string, string | null> = {};
// Holds Core's shortcut write open, to retire a cycle while it is in flight.
let coreShortcutWriteGate: Promise<void> | null = null;
mock.module("@/src/lib/api/preferences.ts", () => ({
	getKeybindings: () => Promise.resolve({ ...coreShortcuts }),
	setKeybindings: async (
		_target: unknown,
		overrides: Record<string, string | null>
	) => {
		await coreShortcutWriteGate;
		coreShortcuts = { ...overrides };
	},
}));
// The selected Core node; a test that selects another node restores it.
const DEFAULT_NODE_URL = "http://127.0.0.1:1";
let activeNodeUrl = DEFAULT_NODE_URL;
const nodeListeners = new Set<() => void>();
mock.module("@/src/store/useNodeStore.ts", () => ({
	useNodeStore: {
		getState: () => ({
			getActiveNode: () => ({ token: null, url: activeNodeUrl }),
		}),
		subscribe: (listener: () => void) => {
			nodeListeners.add(listener);
			return () => nodeListeners.delete(listener);
		},
	},
}));

function selectNode(url: string): void {
	activeNodeUrl = url;
	for (const listener of nodeListeners) {
		listener();
	}
}

interface Entry {
	deleted?: boolean;
	key: string;
	updatedAt: number;
	value: string | null;
}
interface Call {
	authorization: string | null;
	body: string;
	method: string;
	path: string;
	search: string;
}
const USERS_BY_BEARER = new Map([
	[`Bearer ${ACCOUNT_A.token}`, "user-a"],
	[`Bearer ${ACCOUNT_B.token}`, "user-b"],
	[`Bearer ${ACCOUNT_A_REFRESHED.token}`, "user-a"],
	[`Bearer ${UNVERIFIED_C_TOKEN}`, "user-c"],
	[`Bearer ${LEGACY_TOKEN}`, LEGACY_REAL_USER],
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
	calls.push({
		authorization,
		body,
		method: request.method,
		path: url.pathname,
		search: url.search,
	});
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
	if (request.method === "DELETE") {
		cloud.clear();
		return Response.json({ ok: true });
	}
	return Response.json({ error: "Unknown route" }, { status: 404 });
};
globalThis.fetch = Object.assign(fixtureFetch, {
	preconnect: originalFetch.preconnect,
});

const engine = await import("./engine.ts");
const { coreKvHotkeyStorage } = await import("@/src/lib/hotkeys/storage.ts");
const { resetRemoteSettings } = await import("./api.ts");
const { currentPlatform, keybindingsKey } = await import("./keys.ts");
const { observeLocalWrite } = await import("./local-store.ts");
const SHORTCUTS_KEY = keybindingsKey(currentPlatform());

let stopEngine: (() => void) | null = null;

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

/**
 * A write to the live bearer, as the engine sees it in a real browser: the
 * same-document `setItem` patch (ignored by happy-dom) or another window's
 * `storage` event both reach the same listener, so drive it explicitly.
 */
function writeLiveBearer(token: string): void {
	localStorage.setItem(TOKEN_KEY, token);
	window.dispatchEvent(
		new StorageEvent("storage", { key: TOKEN_KEY, newValue: token })
	);
}

function seedVault(
	accounts: readonly AccountIdentity[],
	activeUserId: string
): void {
	localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
	localStorage.setItem(ACTIVE_USER_KEY, activeUserId);
}

/** What the vault's persistVault does: announce, then move the live bearer. */
function becomeActive(next: AccountIdentity): void {
	const from = {
		token: localStorage.getItem(TOKEN_KEY),
		userId: localStorage.getItem(ACTIVE_USER_KEY),
	};
	announceAccountIdentityChange({ from, to: next });
	localStorage.setItem(ACTIVE_USER_KEY, next.userId ?? "");
	writeLiveBearer(next.token ?? "");
}

/**
 * A local settings edit. happy-dom ignores the engine's same-document
 * `setItem` patch, so the write is announced through the real cross-window
 * `storage` listener, as the other settings-sync DOM tests do.
 */
function localEdit(key: string, value: string): void {
	localStorage.setItem(key, value);
	observeLocalWrite(key);
}

function sentWith(account: AccountIdentity): Call[] {
	return calls.filter(
		(call) => call.authorization === `Bearer ${account.token}`
	);
}

async function startAsA(): Promise<void> {
	seedVault([ACCOUNT_A, ACCOUNT_B], ACCOUNT_A.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_A.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	stopEngine = engine.startSettingsSync();
	await idle();
	localEdit(SECTIONS_KEY, A_SECRET);
	if (engine.getPendingCount() !== 1) {
		throw new Error("fixture: account A's edit is not pending");
	}
}

beforeEach(() => {
	localStorage.clear();
	coreShortcuts = {};
	coreShortcutWriteGate = null;
	clouds.clear();
	calls = [];
	revision = 0;
});
afterEach(() => {
	stopEngine?.();
	stopEngine = null;
});
afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("the close-time flush after a switch never sends A's pending value with B's bearer", async () => {
	await startAsA();
	becomeActive(ACCOUNT_B);
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();

	expect(localStorage.getItem(SECTIONS_KEY)).toBeNull();
	expect(
		sentWith(ACCOUNT_B).some((call) => call.body.includes("section-a"))
	).toBe(false);
	expect(cloudOf("user-b").has(SECTIONS_KEY)).toBe(false);

	// A's pending change stayed with A and is delivered once A is active again.
	becomeActive(ACCOUNT_A);
	expect(localStorage.getItem(SECTIONS_KEY)).toBe(A_SECRET);
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf("user-a").get(SECTIONS_KEY)?.value).toBe(A_SECRET);
	expect(cloudOf("user-b").has(SECTIONS_KEY)).toBe(false);
	expect(engine.getPendingCount()).toBe(0);
});

test("B's fresh sync cycle does not collect A's pending value", async () => {
	await startAsA();
	becomeActive(ACCOUNT_B);
	await engine.syncPendingNow();
	await idle();
	expect(
		sentWith(ACCOUNT_B).filter((call) => call.method === "GET")
	).not.toEqual([]);
	expect(
		sentWith(ACCOUNT_B).some((call) => call.body.includes("section-a"))
	).toBe(false);
	expect(cloudOf("user-b").size).toBe(0);
});

test("a bearer swapped without the vault transition flushes nothing", async () => {
	await startAsA();
	// A direct writer moves the live bearer and active user to B without the
	// vault's announce; the engine only learns of it from the TOKEN_KEY write.
	localStorage.setItem(ACTIVE_USER_KEY, ACCOUNT_B.userId ?? "");
	writeLiveBearer(ACCOUNT_B.token ?? "");
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();
	expect(
		sentWith(ACCOUNT_B).some((call) => call.body.includes("section-a"))
	).toBe(false);
	expect(cloudOf("user-b").has(SECTIONS_KEY)).toBe(false);
	expect(localStorage.getItem(SECTIONS_KEY)).toBeNull();
});

test("an unverified bearer stored while the vault still names A acts for no one", async () => {
	await startAsA();
	// storeSessionToken's offline fallback: announce a token-only identity, then
	// write the bearer. The active-user selector still names A.
	announceAccountIdentityChange({
		from: ACCOUNT_A,
		to: { token: UNVERIFIED_C_TOKEN, userId: null },
	});
	writeLiveBearer(UNVERIFIED_C_TOKEN);
	expect(localStorage.getItem(ACTIVE_USER_KEY)).toBe("user-a");
	expect(engine.getActiveSyncIdentity()).toBeNull();

	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();
	// Nothing at all goes out with the unverified bearer: no push of A's work,
	// and no pull that could write C's cloud values into A's local scope.
	expect(
		calls.filter(
			(call) => call.authorization === `Bearer ${UNVERIFIED_C_TOKEN}`
		)
	).toEqual([]);
	expect(cloudOf("user-c").size).toBe(0);
	expect(localStorage.getItem(SECTIONS_KEY)).toBeNull();

	// Once the vault resolves A again, A's pending edit is A's and reaches A.
	becomeActive(ACCOUNT_A);
	expect(localStorage.getItem(SECTIONS_KEY)).toBe(A_SECRET);
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf("user-a").get(SECTIONS_KEY)?.value).toBe(A_SECRET);
	expect(cloudOf("user-c").size).toBe(0);
});

test("an unverified bearer at startup does not activate the vault's active user", async () => {
	seedVault([ACCOUNT_A], ACCOUNT_A.userId ?? "");
	localStorage.setItem(TOKEN_KEY, UNVERIFIED_C_TOKEN);
	localStorage.setItem(ENABLED_KEY, "true");
	stopEngine = engine.startSettingsSync();
	await engine.syncPendingNow();
	await idle();
	expect(engine.getActiveSyncIdentity()).toBeNull();
	expect(calls).toEqual([]);
});

test("a cloud-copy deletion confirmed for A is not sent after a switch to B", async () => {
	await startAsA();
	await engine.syncPendingNow();
	await idle();
	const confirmedFor = engine.getActiveSyncIdentity();
	expect(confirmedFor?.userId).toBe("user-a");
	cloudOf("user-b").set("theme", {
		key: "theme",
		updatedAt: 1,
		value: "dark",
	});

	becomeActive(ACCOUNT_B);
	expect(await resetRemoteSettings(confirmedFor)).toBe(false);
	expect(sentWith(ACCOUNT_B).some((call) => call.method === "DELETE")).toBe(
		false
	);
	expect(cloudOf("user-b").has("theme")).toBe(true);
});

test("a restart keeps the active account's newest visible settings", async () => {
	await startAsA();
	// Round-trip through B leaves an older saved snapshot of A behind.
	becomeActive(ACCOUNT_B);
	becomeActive(ACCOUNT_A);
	localEdit(SECTIONS_KEY, "newer-a-value");
	stopEngine?.();
	stopEngine = engine.startSettingsSync();
	await idle();
	expect(localStorage.getItem(SECTIONS_KEY)).toBe("newer-a-value");
	expect(localStorage.getItem(VISIBLE_OWNER_KEY)).toBe("user-a");
});

test("a legacy placeholder session keeps its settings when its profile resolves", async () => {
	// hydrateVault's legacy migration: the token doubles as the userId.
	seedVault([{ token: LEGACY_TOKEN, userId: LEGACY_TOKEN }], LEGACY_TOKEN);
	localStorage.setItem(TOKEN_KEY, LEGACY_TOKEN);
	localStorage.setItem(ENABLED_KEY, "true");
	localStorage.setItem("theme", "legacy-theme");
	stopEngine = engine.startSettingsSync();
	await idle();
	localEdit(SECTIONS_KEY, A_SECRET);
	expect(engine.getPendingCount()).toBe(1);

	// enrichLegacyAccount -> persistVault: same bearer, real userId.
	becomeActiveSameSession(LEGACY_REAL_USER);
	expect(localStorage.getItem("theme")).toBe("legacy-theme");
	expect(localStorage.getItem(SECTIONS_KEY)).toBe(A_SECRET);
	expect(localStorage.getItem(VISIBLE_OWNER_KEY)).toBe(LEGACY_REAL_USER);
	expect(engine.getActiveSyncIdentity()).toEqual({
		token: LEGACY_TOKEN,
		userId: LEGACY_REAL_USER,
	});
	// The placeholder's pending work is the same account's and is delivered.
	expect(engine.getPendingCount()).toBe(1);
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf(LEGACY_REAL_USER).get(SECTIONS_KEY)?.value).toBe(A_SECRET);
	const placeholderScoped: string[] = [];
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key?.endsWith(`:${encodeURIComponent(LEGACY_TOKEN)}`)) {
			placeholderScoped.push(key);
		}
	}
	expect(placeholderScoped).toEqual([]);
});

test("an engine started before the vault resolved keeps unattributed settings", async () => {
	// Pre-scoping install: a legacy bearer and visible settings, no vault yet.
	localStorage.setItem(TOKEN_KEY, LEGACY_TOKEN);
	localStorage.setItem(ENABLED_KEY, "true");
	localStorage.setItem("theme", "legacy-theme");
	stopEngine = engine.startSettingsSync();
	await idle();
	expect(engine.getActiveSyncIdentity()).toBeNull();
	// The vault migrates the placeholder, then enrichment resolves the profile.
	seedVault([{ token: LEGACY_TOKEN, userId: LEGACY_TOKEN }], LEGACY_TOKEN);
	becomeActiveSameSession(LEGACY_REAL_USER);
	expect(localStorage.getItem("theme")).toBe("legacy-theme");
	expect(engine.getActiveSyncIdentity()?.userId).toBe(LEGACY_REAL_USER);
});

/** enrichLegacyAccount: the live session's vault row gets its real userId. */
function becomeActiveSameSession(userId: string): void {
	const token = localStorage.getItem(TOKEN_KEY);
	announceAccountIdentityChange({
		from: { token, userId: localStorage.getItem(ACTIVE_USER_KEY) },
		to: { token, userId },
	});
	seedVault([{ token, userId }], userId);
	writeLiveBearer(token ?? "");
}

// ── A second window of the app ─────────────────────────────────────────────
//
// Detached tabs and standalone-app windows load the same origin, so every
// window runs its own engine over ONE shared storage area. The engine under
// test is window W2; window W1 is a separate local-store instance (its own
// loaded owner) whose writes reach W2 only as `storage` events, as in a real
// browser. Its activation is the real code that W1's engine runs on a switch.

const B_SECRET = JSON.stringify({
	assignments: { "conversation-of-b": "section-b" },
	sections: [{ id: "section-b", name: "B's private section" }],
});
const ACCOUNT_SCOPED_PREFIXES = [
	"ryu:settings-sync-values:",
	"ryu:settings-sync-meta:",
	"ryu:settings-sync-value-cache:",
	"ryu:settings-sync-cursor:",
	"ryu:settings-sync-last:",
	"ryu:settings-sync-pending-local:",
	"ryu:settings-sync-keybindings-capture:",
	"ryu:settings-sync-keybindings-journal:",
];

/** How W1's writes reach W2: each as it happens, or all once W1 is done. */
type Delivery = "with-each-write" | "after-writes";

let otherWindowSeq = 0;

async function openOtherWindowAs(owner: string) {
	otherWindowSeq++;
	const w1 = (await import(
		`./local-store.ts?window=${otherWindowSeq}`
	)) as typeof import("./local-store.ts");
	w1.activateSettingsOwner(owner, w1.visibleSettingsClaim(owner));
	return w1;
}

/**
 * Run `writes` as W1 and deliver each storage write to W2 as an event. W1's
 * code reaches storage through the `localStorage` global, which is swapped for
 * a recording view of the same storage area while it runs.
 */
function asOtherWindow(writes: () => void, delivery: Delivery): void {
	const shared = globalThis.localStorage;
	const descriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"localStorage"
	);
	const queued: { key: string; newValue: string | null }[] = [];
	let delivering = false;
	const deliver = (key: string, newValue: string | null) => {
		delivering = true;
		try {
			window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
		} finally {
			delivering = false;
		}
	};
	const record = (key: string, newValue: string | null) => {
		if (delivering) {
			return; // W2's own reaction, not W1's write.
		}
		if (delivery === "with-each-write") {
			deliver(key, newValue);
		} else {
			queued.push({ key, newValue });
		}
	};
	const recording = {
		clear: () => shared.clear(),
		getItem: (key: string) => shared.getItem(key),
		key: (index: number) => shared.key(index),
		get length() {
			return shared.length;
		},
		removeItem(key: string) {
			shared.removeItem(key);
			record(key, null);
		},
		setItem(key: string, value: string) {
			shared.setItem(key, value);
			record(key, value);
		},
	};
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: recording,
		writable: true,
	});
	try {
		writes();
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "localStorage", descriptor);
		}
	}
	for (const { key, newValue } of queued) {
		deliver(key, newValue);
	}
}

/** W1's vault write after its engine moved the settings (persistVault). */
function writeVaultAsOtherWindow(
	accounts: readonly AccountIdentity[],
	active: AccountIdentity
): void {
	localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
	localStorage.setItem(ACTIVE_USER_KEY, active.userId ?? "");
	localStorage.setItem(TOKEN_KEY, active.token ?? "");
}

function scopedKeysOf(userId: string): string[] {
	const suffix = `:${encodeURIComponent(userId)}`;
	const found: string[] = [];
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key && ACCOUNT_SCOPED_PREFIXES.some((p) => key === `${p}${userId}`)) {
			found.push(key);
		} else if (key?.startsWith("ryu:settings-sync-") && key.endsWith(suffix)) {
			found.push(key);
		}
	}
	return found;
}

function sentAnywhere(value: string): boolean {
	return calls.some((call) => call.body.includes(value));
}

for (const delivery of ["with-each-write", "after-writes"] as const) {
	test(`another window's switch to B keeps B's settings out of A's scope and cloud (${delivery})`, async () => {
		// B used this profile before: its saved settings scope exists.
		localStorage.setItem(
			"ryu:settings-sync-values:user-b",
			JSON.stringify({ [SECTIONS_KEY]: B_SECRET })
		);
		await startAsA(); // W2, with A's edit pending
		const w1 = await openOtherWindowAs("user-a");

		asOtherWindow(() => {
			w1.activateSettingsOwner("user-b");
			writeVaultAsOtherWindow([ACCOUNT_A, ACCOUNT_B], ACCOUNT_B);
		}, delivery);
		await idle();

		// W2 follows the shared storage to B instead of stamping B's values as A's.
		expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");
		expect(localStorage.getItem(SECTIONS_KEY)).toBe(B_SECRET);
		expect(localStorage.getItem("ryu:settings-sync-values:user-a")).toBe(
			JSON.stringify({ [SECTIONS_KEY]: A_SECRET })
		);
		expect(
			localStorage.getItem("ryu:settings-sync-pending-local:user-a")
		).toContain(SECTIONS_KEY);
		window.dispatchEvent(new Event("pagehide"));
		await engine.syncPendingNow();
		await idle();
		expect(sentAnywhere("section-a")).toBe(false);

		// Back to A in this window: only A's own pending edit reaches A's cloud.
		becomeActive(ACCOUNT_A);
		expect(localStorage.getItem(SECTIONS_KEY)).toBe(A_SECRET);
		await engine.syncPendingNow();
		await idle();
		expect(cloudOf("user-a").get(SECTIONS_KEY)?.value).toBe(A_SECRET);
		expect(
			sentWith(ACCOUNT_A).some((call) => call.body.includes("section-b"))
		).toBe(false);
		expect(cloudOf("user-b").has(SECTIONS_KEY)).toBe(false);
	});
}

test("the verifier's second-window sequence leaves A's scope and cloud free of B's values", async () => {
	// The exact writes and event order from the round-2 verification, with no
	// pending A edit: B's values, the record, the selector, then the bearer.
	seedVault([ACCOUNT_A, ACCOUNT_B], ACCOUNT_A.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_A.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	localStorage.setItem(
		"ryu:settings-sync-values:user-b",
		JSON.stringify({ [SECTIONS_KEY]: B_SECRET })
	);
	stopEngine = engine.startSettingsSync();
	await idle();
	expect(engine.getActiveSyncIdentity()?.userId).toBe("user-a");

	localStorage.setItem(SECTIONS_KEY, B_SECRET);
	localStorage.setItem(VISIBLE_OWNER_KEY, "user-b");
	localStorage.setItem(ACTIVE_USER_KEY, "user-b");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
	for (const [key, newValue] of [
		[SECTIONS_KEY, B_SECRET],
		[VISIBLE_OWNER_KEY, "user-b"],
		[ACTIVE_USER_KEY, "user-b"],
		[TOKEN_KEY, ACCOUNT_B.token ?? ""],
	] as const) {
		window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
	}
	await idle();
	expect(
		localStorage.getItem("ryu:settings-sync-values:user-a") ?? ""
	).not.toContain("section-b");
	expect(
		localStorage.getItem("ryu:settings-sync-pending-local:user-a") ?? "{}"
	).toBe("{}");
	expect(localStorage.getItem("ryu:settings-sync-meta:user-a") ?? "{}").toBe(
		"{}"
	);

	becomeActive(ACCOUNT_A);
	expect(localStorage.getItem(SECTIONS_KEY)).toBeNull();
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf("user-a").has(SECTIONS_KEY)).toBe(false);
	expect(
		sentWith(ACCOUNT_A).some((call) => call.body.includes("section-b"))
	).toBe(false);
});

test("a window left behind by another window's switch neither syncs nor saves B's values as A's", async () => {
	await startAsA();
	await engine.syncPendingNow();
	await idle();
	// A's cloud has a newer theme that a stale cycle would write over B's.
	cloudOf("user-a").set("theme", {
		key: "theme",
		updatedAt: Date.now() + 60_000,
		value: "a-cloud-theme",
	});
	localStorage.setItem(
		"ryu:settings-sync-values:user-b",
		JSON.stringify({ [SECTIONS_KEY]: B_SECRET, theme: "b-theme" })
	);
	const w1 = await openOtherWindowAs("user-a");
	// W1 has installed B's values; its vault write has not reached W2 yet.
	asOtherWindow(() => w1.activateSettingsOwner("user-b"), "with-each-write");
	calls = [];

	await engine.syncPendingNow();
	await idle();
	expect(calls).toEqual([]);
	expect(localStorage.getItem("theme")).toBe("b-theme");

	// Closing W2 now must not save the visible (B's) values as A's.
	stopEngine?.();
	stopEngine = null;
	expect(localStorage.getItem("ryu:settings-sync-values:user-a")).toBe(
		JSON.stringify({ [SECTIONS_KEY]: A_SECRET })
	);
});

for (const delivery of ["with-each-write", "after-writes"] as const) {
	test(`signing A out in another window does not re-create A's settings scope (${delivery})`, async () => {
		localStorage.setItem(
			"ryu:settings-sync-values:user-b",
			JSON.stringify({ [SECTIONS_KEY]: B_SECRET })
		);
		await startAsA();
		const w1 = await openOtherWindowAs("user-a");

		// signOutAccount(A) with B remaining: W1's engine moves the settings,
		// persistVault falls back to B, then A's kept state is removed.
		asOtherWindow(() => {
			w1.activateSettingsOwner("user-b");
			writeVaultAsOtherWindow([ACCOUNT_B], ACCOUNT_B);
			for (const prefix of ACCOUNT_SCOPED_PREFIXES) {
				localStorage.removeItem(`${prefix}user-a`);
			}
		}, delivery);
		await idle();
		await engine.syncPendingNow();
		await idle();
		window.dispatchEvent(new Event("pagehide"));

		expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");
		expect(scopedKeysOf("user-a")).toEqual([]);
		expect(sentAnywhere("section-a")).toBe(false);
	});
}

// ── Keyboard shortcuts: one node-wide Core set shared by every account ───────

/** An edit in a shortcuts editor holding `editor` (by default Core's current
 *  set): the real coreKvHotkeyStorage.save the provider calls, which writes the
 *  whole edited set to Core and announces the set and the edit. */
async function shortcutEdit(
	change: Record<string, string | null>,
	editor: Record<string, string | null> = coreShortcuts
): Promise<void> {
	const before = { ...editor };
	await coreKvHotkeyStorage.save({ ...before, ...change }, before);
}

function cloudShortcuts(userId: string): unknown {
	const value = cloudOf(userId).get(SHORTCUTS_KEY)?.value;
	return value ? JSON.parse(value) : undefined;
}

function pushedWith(account: AccountIdentity, needle: string): boolean {
	return sentWith(account).some(
		(call) => call.method === "POST" && call.body.includes(needle)
	);
}

async function startAs(account: AccountIdentity): Promise<void> {
	seedVault([ACCOUNT_A, ACCOUNT_B], account.userId ?? "");
	localStorage.setItem(TOKEN_KEY, account.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	stopEngine = engine.startSettingsSync();
	await idle();
}

test("a pending shortcut edit never uploads another account's overrides from the node-wide Core set", async () => {
	await startAs(ACCOUNT_B);
	await shortcutEdit({ "b.cmd": "Mod+B" });
	expect(engine.getPendingCount()).toBe(1);
	// Switch to A inside B's debounce; A edits on top of the node's set.
	becomeActive(ACCOUNT_A);
	await idle();
	await shortcutEdit({ "a.private-command": "Mod+Shift+A" });
	expect(coreShortcuts).toEqual({
		"a.private-command": "Mod+Shift+A",
		"b.cmd": "Mod+B",
	});
	// Back to B inside A's debounce: B's seeded pending shortcut key is sent.
	becomeActive(ACCOUNT_B);
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_B, "a.private-command")).toBe(false);
	expect(cloudShortcuts("user-b")).toEqual({ "b.cmd": "Mod+B" });
	// And A's pending edit reaches A carrying only A's own override.
	becomeActive(ACCOUNT_A);
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_A, "b.cmd")).toBe(false);
	expect(cloudShortcuts("user-a")).toEqual({
		"a.private-command": "Mod+Shift+A",
	});
	expect(pushedWith(ACCOUNT_B, "a.private-command")).toBe(false);
});

test("B's downloaded shortcuts in Core are not uploaded as A's pending shortcut edit", async () => {
	cloudOf("user-b").set(SHORTCUTS_KEY, {
		key: SHORTCUTS_KEY,
		updatedAt: 50,
		value: JSON.stringify({ "b.private-command": "Mod+Shift+B" }),
	});
	await startAs(ACCOUNT_A);
	await shortcutEdit({ "a.cmd": "Mod+A" });
	expect(engine.getPendingCount()).toBe(1);
	becomeActive(ACCOUNT_B);
	await engine.syncPendingNow();
	await idle();
	// B's pull installed B's synced set into the node-wide Core slot.
	expect(coreShortcuts).toEqual({ "b.private-command": "Mod+Shift+B" });
	expect(pushedWith(ACCOUNT_B, "a.cmd")).toBe(false);
	// A returns inside its debounce with the shortcut key still pending.
	becomeActive(ACCOUNT_A);
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_A, "b.private-command")).toBe(false);
	expect(cloudShortcuts("user-a")).toEqual({ "a.cmd": "Mod+A" });
	expect(cloudShortcuts("user-b")).toEqual({
		"b.private-command": "Mod+Shift+B",
	});
});

test("an edit made while Core holds another account's shortcuts uploads only the changed override", async () => {
	// The fixture's pull re-delivers each account's own earlier push; "upload"
	// lets the follow-up edits win that self-comparison instead of pausing on it.
	localStorage.setItem("ryu:settings-sync-policy", "upload");
	await startAs(ACCOUNT_A);
	await shortcutEdit({ "a.private-command": "Mod+Shift+A" });
	await engine.syncPendingNow();
	await idle();
	expect(cloudShortcuts("user-a")).toEqual({
		"a.private-command": "Mod+Shift+A",
	});
	becomeActive(ACCOUNT_B);
	await idle();
	// B's shortcuts editor saves the whole node set, A's override included.
	await shortcutEdit({ "b.cmd": "Mod+B", "chat.send": "Mod+Enter" });
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_B, "a.private-command")).toBe(false);
	expect(cloudShortcuts("user-b")).toEqual({
		"b.cmd": "Mod+B",
		"chat.send": "Mod+Enter",
	});
	// B's further edit removing one of its own overrides stays B's own change.
	const { "chat.send": _removed, ...withoutSend } = coreShortcuts;
	await coreKvHotkeyStorage.save(withoutSend, { ...coreShortcuts });
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_B, "a.private-command")).toBe(false);
	expect(cloudShortcuts("user-b")).toEqual({ "b.cmd": "Mod+B" });
	// Back on A, an edit on the mixed set does not adopt B's override either.
	becomeActive(ACCOUNT_A);
	await idle();
	await shortcutEdit({ "a.second": "Mod+2" });
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_A, "b.cmd")).toBe(false);
	expect(cloudShortcuts("user-a")).toEqual({
		"a.private-command": "Mod+Shift+A",
		"a.second": "Mod+2",
	});
});

// The editor may hold a set that is not Core's: a window that missed a
// download (the change event is same-webview only, and a retired download
// used not to announce itself), or overrides set before this device recorded
// anything. Only the overrides an edit changed may join an account's own set.

function setCloudShortcuts(
	userId: string,
	overrides: Record<string, string | null>,
	updatedAt = 50
): void {
	cloudOf(userId).set(SHORTCUTS_KEY, {
		key: SHORTCUTS_KEY,
		updatedAt,
		value: JSON.stringify(overrides),
	});
}

test("an editor left on B's set by another window uploads only A's own edit", async () => {
	localStorage.setItem("ryu:settings-sync-policy", "upload");
	await startAs(ACCOUNT_B);
	await shortcutEdit({ "b.private": "Mod+B" });
	await engine.syncPendingNow();
	await idle();
	expect(cloudShortcuts("user-b")).toEqual({ "b.private": "Mod+B" });
	setCloudShortcuts("user-a", { "a.cmd": "Mod+A" });
	becomeActive(ACCOUNT_A);
	await engine.syncPendingNow();
	await idle();
	// A's download installed A's set; a sibling window's editor never heard.
	expect(coreShortcuts).toEqual({ "a.cmd": "Mod+A" });
	const siblingEditor = { "b.private": "Mod+B" };
	await shortcutEdit({ "a.new": "Mod+N" }, siblingEditor);
	expect(coreShortcuts).toEqual({ "a.new": "Mod+N", "b.private": "Mod+B" });
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_A, "b.private")).toBe(false);
	expect(cloudShortcuts("user-a")).toEqual({
		"a.cmd": "Mod+A",
		"a.new": "Mod+N",
	});
});

test("a download retired mid-write still updates the editor, and A's next edit carries none of B's overrides", async () => {
	localStorage.setItem("ryu:settings-sync-policy", "upload");
	let editor: Record<string, string | null> = {};
	const unsubscribe =
		coreKvHotkeyStorage.subscribe?.((next) => {
			editor = { ...next };
		}) ?? (() => undefined);
	try {
		await startAs(ACCOUNT_B);
		await shortcutEdit({ "b.private": "Mod+B" }, editor);
		expect(editor).toEqual({ "b.private": "Mod+B" });
		await engine.syncPendingNow();
		await idle();
		setCloudShortcuts("user-a", { "a.cmd": "Mod+A" });
		becomeActive(ACCOUNT_A);
		await idle();
		let release: () => void = () => undefined;
		coreShortcutWriteGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cycle = engine.syncPendingNow();
		await Bun.sleep(20);
		// A routine same-account bearer refresh retires the in-flight cycle.
		seedVault([ACCOUNT_A_REFRESHED, ACCOUNT_B], "user-a");
		becomeActive(ACCOUNT_A_REFRESHED);
		coreShortcutWriteGate = null;
		release();
		await cycle;
		// The retired cycle installed A's set into Core and told the editor.
		expect(coreShortcuts).toEqual({ "a.cmd": "Mod+A" });
		expect(editor).toEqual({ "a.cmd": "Mod+A" });
		await engine.syncPendingNow();
		await idle();
		// Even an edit on the set B left in the editor adds only A's change.
		await shortcutEdit({ "a.new": "Mod+N" }, { "b.private": "Mod+B" });
		await engine.syncPendingNow();
		await idle();
		expect(
			calls.some(
				(call) =>
					call.method === "POST" &&
					call.authorization?.startsWith("Bearer bearer-a") === true &&
					call.body.includes("b.private")
			)
		).toBe(false);
		expect(cloudShortcuts("user-a")).toEqual({
			"a.cmd": "Mod+A",
			"a.new": "Mod+N",
		});
	} finally {
		unsubscribe();
	}
});

test("overrides already in Core with no record of their owner are never claimed by the first account to edit", async () => {
	// Set by A before this device recorded anything (an upgrade, a new device,
	// or another client of the same Core node).
	coreShortcuts = { "a.private": "Mod+Shift+A" };
	await startAs(ACCOUNT_B);
	await shortcutEdit({ "b.cmd": "Mod+B" });
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_B, "a.private")).toBe(false);
	expect(cloudShortcuts("user-b")).toEqual({ "b.cmd": "Mod+B" });
});

for (const origin of [
	"a pre-scoping install",
	"an earlier scoped build",
] as const) {
	test(`a shortcut set cached by ${origin} is re-read from the account's cloud, not uploaded`, async () => {
		// "This device wins" must not make a dropped set win either.
		localStorage.setItem("ryu:settings-sync-policy", "upload");
		// The cache held Core's live node-wide set, A's override included, and its
		// stamp is newer than the cursor, so it would be seeded as B's pending edit.
		const contaminated = JSON.stringify({
			"a.private": "Mod+Shift+A",
			"b.cmd": "Mod+B",
		});
		coreShortcuts = { "a.private": "Mod+Shift+A", "b.cmd": "Mod+B" };
		setCloudShortcuts("user-b", { "b.cmd": "Mod+B" }, 40);
		const scope = origin === "a pre-scoping install" ? "" : ":user-b";
		localStorage.setItem(
			`ryu:settings-sync-value-cache${scope}`,
			JSON.stringify({ [SHORTCUTS_KEY]: contaminated })
		);
		localStorage.setItem(
			`ryu:settings-sync-meta${scope}`,
			JSON.stringify({ [SHORTCUTS_KEY]: 100 })
		);
		localStorage.setItem(`ryu:settings-sync-cursor${scope}`, "50");
		if (scope) {
			localStorage.setItem(VISIBLE_OWNER_KEY, "user-b");
		}
		// Edits made before the account's own set is known wait, unsent.
		seedVault([ACCOUNT_A, ACCOUNT_B], "user-b");
		localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
		stopEngine = engine.startSettingsSync();
		await idle();
		await shortcutEdit({ "b.two": "Mod+2" });
		window.dispatchEvent(new Event("pagehide"));
		await idle();
		expect(calls).toEqual([]);

		engine.setSyncEnabled(true);
		await idle();
		expect(pushedWith(ACCOUNT_B, "a.private")).toBe(false);
		// B's cloud set is kept and gains exactly B's own edit.
		expect(cloudShortcuts("user-b")).toEqual({
			"b.cmd": "Mod+B",
			"b.two": "Mod+2",
		});
		expect(engine.getPendingCount()).toBe(0);
	});
}

test("a dropped legacy shortcut set with no edit waiting is neither uploaded nor reported pending", async () => {
	localStorage.setItem("ryu:settings-sync-policy", "upload");
	coreShortcuts = { "a.private": "Mod+Shift+A", "b.cmd": "Mod+B" };
	localStorage.setItem(
		"ryu:settings-sync-value-cache",
		JSON.stringify({ [SHORTCUTS_KEY]: JSON.stringify(coreShortcuts) })
	);
	localStorage.setItem(
		"ryu:settings-sync-meta",
		JSON.stringify({ [SHORTCUTS_KEY]: 100 })
	);
	localStorage.setItem("ryu:settings-sync-cursor", "50");
	await startAs(ACCOUNT_B);
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_B, "a.private")).toBe(false);
	expect(cloudOf("user-b").has(SHORTCUTS_KEY)).toBe(false);
	expect(engine.getPendingCount()).toBe(0);
	// Core's shortcuts in effect are left alone.
	expect(coreShortcuts).toEqual({
		"a.private": "Mod+Shift+A",
		"b.cmd": "Mod+B",
	});
});

// An edit belongs to the account that was active when the user made it. Core's
// write can still be in flight when the sidebar switch moves the session (the
// vault announces the new identity, then awaits the Tauri store before the
// reload), so attributing the edit once the write returns would credit it to
// whichever account is active by then.

/** A shortcut edit whose Core write is held until `release` is called. */
function heldShortcutEdit(change: Record<string, string | null>): {
	release: () => Promise<void>;
} {
	let open: () => void = () => undefined;
	coreShortcutWriteGate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const saved = shortcutEdit(change);
	return {
		release: async () => {
			coreShortcutWriteGate = null;
			open();
			await saved;
		},
	};
}

for (const bBaseKnown of [true, false]) {
	test(`an edit in flight across an A->B switch stays A's (B's set ${bBaseKnown ? "known" : "not yet known"} here)`, async () => {
		localStorage.setItem("ryu:settings-sync-policy", "upload");
		setCloudShortcuts("user-b", { "b.cmd": "Mod+B" });
		if (bBaseKnown) {
			// B's own set is cached on this device by an earlier session.
			await startAs(ACCOUNT_B);
			await engine.syncPendingNow();
			await idle();
			becomeActive(ACCOUNT_A);
		} else {
			await startAs(ACCOUNT_A);
		}
		await engine.syncPendingNow();
		await idle();
		const edit = heldShortcutEdit({ "a.private": "Mod+Shift+P" });
		await Bun.sleep(5);
		// NavUser's switch lands while Core's write is still in flight.
		becomeActive(ACCOUNT_B);
		await edit.release();
		expect(coreShortcuts).toMatchObject({ "a.private": "Mod+Shift+P" });
		// The reload's close-time flush, then B's own cycle.
		window.dispatchEvent(new Event("pagehide"));
		await engine.syncPendingNow();
		await idle();
		expect(pushedWith(ACCOUNT_B, "a.private")).toBe(false);
		expect(cloudShortcuts("user-b")).toEqual({ "b.cmd": "Mod+B" });
		// A's edit was A's when it was made: A's next cycle delivers it.
		becomeActive(ACCOUNT_A);
		await engine.syncPendingNow();
		await idle();
		expect(pushedWith(ACCOUNT_A, "b.cmd")).toBe(false);
		expect(cloudShortcuts("user-a")).toEqual({ "a.private": "Mod+Shift+P" });
		expect(pushedWith(ACCOUNT_B, "a.private")).toBe(false);
	});
}

test("an edit in flight across a sign-out is credited to no one who signs in next", async () => {
	localStorage.setItem("ryu:settings-sync-policy", "upload");
	setCloudShortcuts("user-b", { "b.cmd": "Mod+B" });
	await startAs(ACCOUNT_B);
	await engine.syncPendingNow();
	await idle();
	becomeActive(ACCOUNT_A);
	await engine.syncPendingNow();
	await idle();
	const edit = heldShortcutEdit({ "a.private": "Mod+Shift+P" });
	await Bun.sleep(5);
	// A signs out while the write is in flight; B signs in afterwards.
	announceAccountIdentityChange({
		from: { token: ACCOUNT_A.token, userId: ACCOUNT_A.userId },
		to: { token: null, userId: null },
	});
	seedVault([ACCOUNT_B], "");
	writeLiveBearer("");
	await edit.release();
	seedVault([ACCOUNT_B], "");
	becomeActive(ACCOUNT_B);
	window.dispatchEvent(new Event("pagehide"));
	await engine.syncPendingNow();
	await idle();
	expect(pushedWith(ACCOUNT_B, "a.private")).toBe(false);
	expect(cloudShortcuts("user-b")).toEqual({ "b.cmd": "Mod+B" });
});

// A Core scope change re-reads the account's whole document so the new node
// gets the account's shortcuts, but it must not make every setting this device
// ever stamped look like a pending local edit once that account's pending work
// is rebuilt (here, by the account becoming active again after a switch).

test("after a node change, a switch away and back does not turn A's old settings into pending edits", async () => {
	cloudOf("user-a").set("theme", {
		key: "theme",
		updatedAt: 200,
		value: "light",
	});
	revision = 1;
	seedVault([ACCOUNT_A, ACCOUNT_B], ACCOUNT_A.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_A.token ?? "");
	localStorage.setItem("theme", "dark");
	localStorage.setItem("ryu:settings-sync-meta", JSON.stringify({ theme: 10 }));
	localStorage.setItem("ryu:settings-sync-cursor", "10");
	// A's own synced state (the record names A), so its stamp and cursor load.
	localStorage.setItem(VISIBLE_OWNER_KEY, "user-a");
	// Sync is off while the node changes and the accounts switch.
	stopEngine = engine.startSettingsSync();
	try {
		selectNode("http://127.0.0.1:2");
		becomeActive(ACCOUNT_B);
		becomeActive(ACCOUNT_A);
		expect(engine.getPendingCount()).toBe(0);
		engine.setSyncEnabled(true);
		await idle();
		await engine.syncPendingNow();
		await idle();
		// A's newer cloud value is news, not a conflict with an old local stamp.
		expect(engine.getConflicts()).toEqual([]);
		expect(localStorage.getItem("theme")).toBe("light");
		expect(pushedWith(ACCOUNT_A, "dark")).toBe(false);
		expect(cloudOf("user-a").get("theme")?.value).toBe("light");
		// The node change still re-read the whole document.
		expect(
			calls.some(
				(call) =>
					call.authorization === `Bearer ${ACCOUNT_A.token}` &&
					call.path.endsWith("/pull") &&
					call.search === "?since=0"
			)
		).toBe(true);
	} finally {
		selectNode(DEFAULT_NODE_URL);
	}
});

// ── A store from before settings were scoped to accounts ─────────────────────
//
// An earlier build kept one ownerless pending set across account switches and
// sign-outs: A's dirty value, its stamp, the cursor and the crash-recovery
// journal all survived a switch to B (with sync off, or a flush that failed
// offline). The first start after the upgrade has no visible-owner record, so
// nothing proves whose that pending work is. It must not become the upload of
// whichever account happens to be active.

const LEGACY_META_KEY = "ryu:settings-sync-meta";
const LEGACY_CURSOR_KEY = "ryu:settings-sync-cursor";
const LEGACY_PENDING_KEY = "ryu:settings-sync-pending-local";

interface LegacyUpgrade {
	cursor: number;
	journal: boolean;
	name: string;
	vault: readonly AccountIdentity[];
}

const LEGACY_UPGRADES: readonly LegacyUpgrade[] = [
	{
		cursor: 0,
		journal: false,
		name: "B active in a two-account vault, A's stamp newer than the cursor",
		vault: [ACCOUNT_A, ACCOUNT_B],
	},
	{
		cursor: 500,
		journal: true,
		name: "B active in a two-account vault, A's edit only in the journal",
		vault: [ACCOUNT_A, ACCOUNT_B],
	},
	{
		cursor: 0,
		journal: true,
		name: "A signed out before the upgrade, B the only account left",
		vault: [ACCOUNT_B],
	},
];

function seedLegacyPendingOfA({ cursor, journal, vault }: LegacyUpgrade): void {
	seedVault(vault, ACCOUNT_B.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	// A's unsent edit as the earlier build left it: unscoped value, stamp,
	// cursor and journal, and no visible-owner record.
	localStorage.setItem(SECTIONS_KEY, A_SECRET);
	localStorage.setItem(
		LEGACY_META_KEY,
		JSON.stringify({ [SECTIONS_KEY]: 100 })
	);
	localStorage.setItem(LEGACY_CURSOR_KEY, String(cursor));
	if (journal) {
		localStorage.setItem(
			LEGACY_PENDING_KEY,
			JSON.stringify({ [SECTIONS_KEY]: 100 })
		);
	}
	if (localStorage.getItem(VISIBLE_OWNER_KEY) !== null) {
		throw new Error("fixture: a pre-scoping store has no visible-owner record");
	}
}

for (const upgrade of LEGACY_UPGRADES) {
	test(`a pre-scoping store's pending change is not uploaded by the account active at upgrade (${upgrade.name})`, async () => {
		seedLegacyPendingOfA(upgrade);
		stopEngine = engine.startSettingsSync();
		expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");
		const pendingAtStart = engine.getPendingCount();
		window.dispatchEvent(new Event("pagehide"));
		await engine.syncPendingNow();
		await idle();

		// Nothing of A's went out under B, and B pulled its whole document
		// (A's cursor is not B's).
		expect(sentAnywhere("A's private section")).toBe(false);
		expect(sentAnywhere("conversation-of-a")).toBe(false);
		expect(cloudOf("user-b").has(SECTIONS_KEY)).toBe(false);
		expect(
			sentWith(ACCOUNT_B).some(
				(call) => call.method === "GET" && call.search === "?since=0"
			)
		).toBe(true);
		expect(pendingAtStart).toBe(0);
		expect(engine.getPendingCount()).toBe(0);
		// The stamp and journal were not adopted into B's scope either, so no
		// later restart or switch back to B can turn them into B's upload.
		expect(
			JSON.parse(localStorage.getItem("ryu:settings-sync-meta:user-b") ?? "{}")
		).not.toHaveProperty(SECTIONS_KEY);
		expect(
			JSON.parse(
				localStorage.getItem("ryu:settings-sync-pending-local:user-b") ?? "{}"
			)
		).toEqual({});
		stopEngine?.();
		stopEngine = engine.startSettingsSync();
		await engine.syncPendingNow();
		await idle();
		expect(cloudOf("user-b").has(SECTIONS_KEY)).toBe(false);
		expect(sentAnywhere("A's private section")).toBe(false);
	});
}

test("a pre-scoping store's values give way to the active account's own cloud copy", async () => {
	seedLegacyPendingOfA(LEGACY_UPGRADES[0]!);
	// B's own (older-stamped) sections: the unattributed local stamp of 100
	// must not outrank them.
	cloudOf("user-b").set(SECTIONS_KEY, {
		key: SECTIONS_KEY,
		updatedAt: 50,
		value: B_SECRET,
	});
	revision = 1;
	stopEngine = engine.startSettingsSync();
	await engine.syncPendingNow();
	await idle();
	expect(engine.getConflicts()).toEqual([]);
	expect(localStorage.getItem(SECTIONS_KEY)).toBe(B_SECRET);
	expect(cloudOf("user-b").get(SECTIONS_KEY)?.value).toBe(B_SECRET);
	expect(sentAnywhere("A's private section")).toBe(false);
});

test("a pre-scoping store keeps its visible settings on screen for the account that starts", async () => {
	seedLegacyPendingOfA(LEGACY_UPGRADES[0]!);
	localStorage.setItem("theme", "legacy-theme");
	localStorage.setItem(ENABLED_KEY, "false");
	stopEngine = engine.startSettingsSync();
	expect(localStorage.getItem("theme")).toBe("legacy-theme");
	expect(localStorage.getItem(VISIBLE_OWNER_KEY)).toBe("user-b");
	// Unstamped, so it is no one's pending upload until B edits it here.
	expect(engine.getPendingCount()).toBe(0);
	const bMeta = () =>
		JSON.parse(localStorage.getItem("ryu:settings-sync-meta:user-b") ?? "{}");
	expect(bMeta()).toEqual({});
	localEdit("theme", "b-theme");
	expect(bMeta().theme).toBeGreaterThan(0);
});

/** A sidebar edit as the sections hook makes it: read the visible value, add
 *  a section, write the whole value back. */
function addSectionToVisible(id: string, name: string): void {
	const current = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "null") as {
		assignments: Record<string, string>;
		sections: { id: string; name: string }[];
	} | null;
	localEdit(
		SECTIONS_KEY,
		JSON.stringify({
			assignments: current?.assignments ?? {},
			sections: [...(current?.sections ?? []), { id, name }],
		})
	);
}

for (const upgrade of LEGACY_UPGRADES.filter((u) => u.vault.length > 1)) {
	test(`a pre-scoping store's sidebar sections never reach the account active at upgrade, even through its own edit (${upgrade.name})`, async () => {
		seedLegacyPendingOfA(upgrade);
		localStorage.setItem("theme", "legacy-theme");
		// B's cloud copy has no sections key: nothing replaces A's on pull.
		stopEngine = engine.startSettingsSync();
		await engine.syncPendingNow();
		await idle();
		// The plain preference stays on screen; the account content does not.
		expect(localStorage.getItem("theme")).toBe("legacy-theme");
		expect(localStorage.getItem(SECTIONS_KEY)).toBeNull();

		// B's next edit to any section.
		addSectionToVisible("section-b-new", "B's new section");
		window.dispatchEvent(new Event("pagehide"));
		await engine.syncPendingNow();
		await idle();
		const bCloud = cloudOf("user-b").get(SECTIONS_KEY)?.value ?? "";
		expect(bCloud).toContain("B's new section");
		expect(sentAnywhere("A's private section")).toBe(false);
		expect(sentAnywhere("conversation-of-a")).toBe(false);
		expect(
			localStorage.getItem("ryu:settings-sync-values:user-b") ?? ""
		).not.toContain("A's private section");
	});
}

test("a store this build wrote for the active account keeps that account's pending change across a restart", async () => {
	// The record names B, so the unscoped mirror is B's own and is claimed.
	seedVault([ACCOUNT_A, ACCOUNT_B], ACCOUNT_B.userId ?? "");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_B.token ?? "");
	localStorage.setItem(ENABLED_KEY, "true");
	localStorage.setItem(SECTIONS_KEY, B_SECRET);
	localStorage.setItem(
		LEGACY_META_KEY,
		JSON.stringify({ [SECTIONS_KEY]: 100 })
	);
	localStorage.setItem(LEGACY_CURSOR_KEY, "0");
	localStorage.setItem(VISIBLE_OWNER_KEY, "user-b");
	stopEngine = engine.startSettingsSync();
	expect(engine.getPendingCount()).toBe(1);
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf("user-b").get(SECTIONS_KEY)?.value).toBe(B_SECRET);
});

// ── Features holding the previous account's value in memory ──────────────────
//
// A switch replaces the visible values through the original setter, which no
// listener in this window sees. The sidebar's section hook keeps the latest
// committed state in a ref; if it kept A's sections, the first edit after the
// switch (made while switchAccount awaits the Tauri store, before the reload)
// would write A's sections plus the edit into B's visible value, stamped as
// B's change, and B's next push would carry them.

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useBotChatSections } = await import(
	"@/src/hooks/useBotChatSections.ts"
);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

test("an edit right after a switch starts from B's sections, not the A sections still in memory", async () => {
	localStorage.setItem(
		"ryu:settings-sync-values:user-b",
		JSON.stringify({ [SECTIONS_KEY]: B_SECRET })
	);
	await startAsA();
	await engine.syncPendingNow();
	await idle();
	expect(cloudOf("user-a").get(SECTIONS_KEY)?.value).toBe(A_SECRET);

	const sidebar: { current: ReturnType<typeof useBotChatSections> | null } = {
		current: null,
	};
	function Sidebar() {
		sidebar.current = useBotChatSections();
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => root.render(createElement(Sidebar)));
	try {
		expect(sidebar.current?.sections.map((section) => section.name)).toEqual([
			"A's private section",
		]);

		// The sidebar switch: the transition runs, the bearer moves, and the
		// user creates a section before switchAccount's reload.
		becomeActive(ACCOUNT_B);
		await act(async () => {
			sidebar.current?.createSection("B's new section");
		});
		// What the engine's same-document setItem patch reports in a browser.
		observeLocalWrite(SECTIONS_KEY);

		const visible = localStorage.getItem(SECTIONS_KEY) ?? "";
		expect(visible).toContain("B's new section");
		expect(visible).toContain("B's private section");
		expect(visible).not.toContain("A's private section");
		expect(visible).not.toContain("conversation-of-a");

		window.dispatchEvent(new Event("pagehide"));
		await engine.syncPendingNow();
		await idle();
		const bCloud = cloudOf("user-b").get(SECTIONS_KEY)?.value ?? "";
		expect(bCloud).toContain("B's new section");
		expect(bCloud).not.toContain("A's private section");
		expect(
			sentWith(ACCOUNT_B).some((call) =>
				call.body.includes("A's private section")
			)
		).toBe(false);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});

// ── A window left behind by another window's switch ──────────────────────────

test("a window whose account another window switched away treats its features' settings writes as stale", async () => {
	await startAsA(); // W2, with A's sections visible
	const local = await import("./local-store.ts");
	expect(local.isStaleWindowWrite(SECTIONS_KEY)).toBe(false);
	// W1 has installed B's values and recorded B as their owner; W2 has not
	// processed W1's events yet (the record write alone moves no owner).
	// W1's activation advanced the shared owner epoch before moving a value.
	localStorage.setItem(
		"ryu:settings-sync-owner-epoch",
		JSON.stringify({ clean: false, epoch: 1 })
	);
	localStorage.setItem(SECTIONS_KEY, B_SECRET);
	localStorage.setItem(VISIBLE_OWNER_KEY, "user-b");
	expect(local.getSettingsOwner()).toBe("user-a");
	// A sidebar write from W2 now would put A's in-memory sections into B's
	// visible value: the setItem patch drops it (exercised in the browser by
	// e2e/settings-sync-engine-native-http.spec.ts). Identity and other
	// non-synced keys still write through.
	expect(local.isStaleWindowWrite(SECTIONS_KEY)).toBe(true);
	expect(local.isStaleWindowWrite(TOKEN_KEY)).toBe(false);
	// Mid-switch (no owner recorded yet) is stale too.
	localStorage.setItem(VISIBLE_OWNER_KEY, local.UNOWNED_VISIBLE_SETTINGS);
	expect(local.isStaleWindowWrite(SECTIONS_KEY)).toBe(true);
	// Following the switch moves W2's engine to B, but its features still hold
	// A's values in memory: their writes stay stale until W2 reloads.
	localStorage.setItem(VISIBLE_OWNER_KEY, "user-b");
	becomeActive(ACCOUNT_B);
	expect(engine.getActiveSyncIdentity()?.userId).toBe("user-b");
	expect(local.isStaleWindowWrite(SECTIONS_KEY)).toBe(true);
	expect(local.isStaleWindowWrite(TOKEN_KEY)).toBe(false);
	expect(local.isSettingsWindowStale()).toBe(true);
});
