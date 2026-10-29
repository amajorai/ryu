// The pull cursor decides what this machine will ever see from the others, so
// it may only move past commits this machine has actually pulled. A push that
// lands after another machine's commit must not advance it past that commit.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, expect, it, mock } from "bun:test";
import type { PullResult, PushResult, SyncEntry } from "./api.ts";

let pullReply: PullResult | null = null;
let pushReply: PushResult | null = null;
const pulls: number[] = [];
const pushes: SyncEntry[][] = [];

mock.module("./api.ts", () => ({
	flushSettings: () => undefined,
	pullSettings: (since = 0) => {
		pulls.push(since);
		return Promise.resolve(structuredClone(pullReply));
	},
	pushSettings: (entries: SyncEntry[]) => {
		pushes.push(entries);
		return Promise.resolve(structuredClone(pushReply));
	},
}));
// Sync only acts for a verified identity: the live bearer must be the vault
// token of the active user, whose settings are the ones loaded.
const USER_ID = "engine-test-user";
const SESSION_TOKEN = "engine-test-session";
const TOKEN_KEY = "ryu_session_token";
mock.module("@/lib/auth-client.ts", () => ({
	BACKEND_URL: "http://127.0.0.1:1",
	getActiveToken: () => localStorage.getItem(TOKEN_KEY),
	onActiveTokenChange: () => () => undefined,
	onBeforeAccountIdentityChange: () => () => undefined,
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

const { activateSettingsOwner, markLocalChange } = await import(
	"./local-store.ts"
);
const {
	getConflicts,
	getPendingCount,
	getSyncStatus,
	setSyncEnabled,
	syncPendingNow,
} = await import("./engine.ts");

// The pull cursor and the pending set are kept per account.
const CURSOR_KEY = `ryu:settings-sync-cursor:${USER_ID}`;
const PENDING_LOCAL_KEY = `ryu:settings-sync-pending-local:${USER_ID}`;

/** A clean store signed in as the test account, whose settings are loaded. */
function resetSignedIn(): void {
	localStorage.clear();
	localStorage.setItem(
		"ryu_accounts",
		JSON.stringify([{ token: SESSION_TOKEN, userId: USER_ID }])
	);
	localStorage.setItem("ryu_active_user_id", USER_ID);
	localStorage.setItem(TOKEN_KEY, SESSION_TOKEN);
	activateSettingsOwner(null);
	activateSettingsOwner(USER_ID, true);
}

async function settle(): Promise<void> {
	const deadline = Date.now() + 2000;
	while (getSyncStatus() === "syncing") {
		if (Date.now() >= deadline) {
			throw new Error("settings sync cycle did not settle");
		}
		await Bun.sleep(1);
	}
}

/** Opt in again so the engine reseeds its pending set and runs one cycle. */
async function cycleWithLocalEdit(value: string, at: number): Promise<void> {
	localStorage.setItem("theme", value);
	markLocalChange("theme", at);
	setSyncEnabled(false);
	setSyncEnabled(true);
	await settle();
}

afterAll(() => {
	setSyncEnabled(false);
	localStorage.clear();
});

it("advances the pull cursor past a push only when no other commit landed in between", async () => {
	resetSignedIn();
	// Another machine commits revision 2 between this cycle's pull (revision 1)
	// and its push (which becomes revision 3).
	pullReply = { entries: [], revision: 1, updatedAt: 1000 };
	pushReply = {
		applied: ["theme"],
		rejected: [],
		revision: 3,
		updatedAt: 3000,
	};
	await cycleWithLocalEdit("dark", 5000);
	expect(pushes.at(-1)?.map((entry) => entry.key)).toEqual(["theme"]);
	expect(localStorage.getItem(CURSOR_KEY)).toBe("1000");

	// The next pull therefore still asks for revision 2. With no commit between
	// pull and push, the cursor moves to the push.
	pullReply = { entries: [], revision: 3, updatedAt: 3000 };
	pushReply = {
		applied: ["theme"],
		rejected: [],
		revision: 4,
		updatedAt: 4000,
	};
	await cycleWithLocalEdit("light", 6000);
	expect(pulls.at(-1)).toBe(1000);
	expect(pushes.at(-1)?.map((entry) => entry.value)).toEqual(["light"]);
	expect(localStorage.getItem(CURSOR_KEY)).toBe("4000");
	expect(getSyncStatus()).toBe("idle");
});

it("stops re-pushing a reseeded key the server already stores at that edit time", async () => {
	resetSignedIn();
	// A fast-clock machine's edit (t=9000) was pulled here earlier, and later
	// commits moved the cursor only to server time 5000. A restart reseeds the
	// key as pending because its edit time is ahead of the cursor.
	localStorage.setItem(CURSOR_KEY, "5000");
	pullReply = { entries: [], revision: 7, updatedAt: 5000 };
	// The server already holds that exact edit, so it neither applies nor
	// rejects the entry and reports it as unchanged.
	pushReply = {
		applied: [],
		rejected: [],
		revision: 7,
		unchanged: ["theme"],
		updatedAt: 5000,
	};
	await cycleWithLocalEdit("dark", 9000);
	expect(pushes.at(-1)).toEqual([
		{ deleted: false, key: "theme", updatedAt: 9000, value: "dark" },
	]);
	expect(getPendingCount()).toBe(0);
	expect(getSyncStatus()).toBe("idle");
	expect(localStorage.getItem(CURSOR_KEY)).toBe("5000");

	const pushed = pushes.length;
	await syncPendingNow();
	await settle();
	expect(pushes).toHaveLength(pushed);
});

it("keeps an entry pending when the server neither stored, rejected nor recognised it", async () => {
	resetSignedIn();
	localStorage.setItem(CURSOR_KEY, "5000");
	pullReply = { entries: [], revision: 7, updatedAt: 5000 };
	// An invalid (for example oversized) entry is dropped by the server and
	// appears in no list; it must not be reported as delivered.
	pushReply = {
		applied: [],
		rejected: [],
		revision: 7,
		unchanged: [],
		updatedAt: 5000,
	};
	await cycleWithLocalEdit("dark", 9000);
	expect(pushes.at(-1)?.map((entry) => entry.key)).toEqual(["theme"]);
	expect(getPendingCount()).toBe(1);

	const pushed = pushes.length;
	await syncPendingNow();
	await settle();
	expect(pushes).toHaveLength(pushed + 1);
	expect(getPendingCount()).toBe(1);
});

it("weighs a sibling window's unpushed edit against a remote change instead of overwriting it", async () => {
	resetSignedIn();
	localStorage.setItem(CURSOR_KEY, "5000");
	pullReply = { entries: [], revision: 7, updatedAt: 5000 };
	pushReply = {
		applied: [],
		rejected: [],
		revision: 7,
		unchanged: [],
		updatedAt: 5000,
	};
	setSyncEnabled(false);
	setSyncEnabled(true);
	await settle();

	// Another window of this app edits the font and journals it, but has not
	// pushed yet. This window only hears a `storage` event, so the key is not
	// in its own dirty set.
	const key = "ryu_ui_font";
	localStorage.setItem(key, "Inter");
	markLocalChange(key, 6000);
	localStorage.setItem(PENDING_LOCAL_KEY, JSON.stringify({ [key]: 6000 }));

	// Another machine changed the same setting later.
	pullReply = {
		entries: [{ deleted: false, key, updatedAt: 6500, value: "Mono" }],
		revision: 8,
		updatedAt: 6500,
	};
	await syncPendingNow();
	await settle();

	expect(localStorage.getItem(key)).toBe("Inter");
	expect(getConflicts().map((conflict) => conflict.key)).toEqual([key]);
	expect(getSyncStatus()).toBe("conflict");
});
