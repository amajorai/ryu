// Settings ownership across the real auth-client paths that move the live
// bearer outside an ordinary vault switch:
// - a legacy single-token install, migrated under a placeholder id and then
//   enriched with its real profile while no settings engine is running;
// - the offline sign-in fallback, which stores a bearer with no vault row while
//   the active-user selector still names the previous account.
//
// Runs the real auth client, settings engine, local store and HTTP client; only
// the control-plane server is a fixture keyed by bearer.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, expect, mock, test } from "bun:test";

const LEGACY_TOKEN_KEY = "ryu_session_token";
const VISIBLE_OWNER_KEY = "ryu:settings-sync-visible-owner";
const SECTIONS_KEY = "ryu:bot-chat-sections:v1";
const LEGACY_TOKEN = "legacy-bearer";
const LEGACY_USER = "user-legacy";
const OFFLINE_TOKEN = "offline-bearer-of-another-account";
const placeholderScope = encodeURIComponent(LEGACY_TOKEN);

// A stand-in for the native `desktop_secret_*` slot the sealed vault lives in
// (see auth-vault-sealing.test.ts): tokens never touch localStorage any more.
const slots = new Map<string, string>();
Reflect.set(window, "__TAURI_INTERNALS__", {
	invoke: (command: string, args: { name?: string; value?: string }) => {
		if (command === "desktop_secret_get") {
			return Promise.resolve(slots.get(args.name ?? "") ?? null);
		}
		if (command === "desktop_secret_set") {
			slots.set(args.name ?? "", args.value ?? "");
		}
		if (command === "desktop_secret_delete") {
			slots.delete(args.name ?? "");
		}
		return Promise.resolve(null);
	},
	transformCallback: () => 0,
});

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

interface Call {
	authorization: string;
	body: string;
	path: string;
}
const calls: Call[] = [];
let releaseProfile: () => void = () => undefined;
const profileReleased = new Promise<void>((resolve) => {
	releaseProfile = resolve;
});

const originalFetch = globalThis.fetch;
async function fixtureFetch(
	input: RequestInfo | URL,
	init?: RequestInit
): Promise<Response> {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const authorization = request.headers.get("authorization") ?? "";
	const body = request.method === "GET" ? "" : await request.text();
	calls.push({ authorization, body, path: url.pathname });
	if (url.pathname.endsWith("/api/auth/get-session")) {
		if (authorization !== `Bearer ${LEGACY_TOKEN}`) {
			// The offline fallback: this profile lookup fails.
			return new Response(null, { status: 503 });
		}
		await profileReleased;
		return Response.json({ user: { id: LEGACY_USER, email: "l@x.test" } });
	}
	if (url.pathname.endsWith("/pull")) {
		return Response.json({ entries: [], revision: 0, updatedAt: 1 });
	}
	if (url.pathname.endsWith("/push")) {
		return Response.json({ applied: [], rejected: [], revision: 1 });
	}
	return new Response(null, { status: 404 });
}
globalThis.fetch = Object.assign(fixtureFetch, {
	preconnect: originalFetch.preconnect,
});

// A pre-vault install: the legacy bearer, and a settings scope written while
// an earlier engine ran under the placeholder id.
localStorage.setItem(LEGACY_TOKEN_KEY, LEGACY_TOKEN);
localStorage.setItem(SECTIONS_KEY, "legacy-sections");
localStorage.setItem(
	`ryu:settings-sync-values:${placeholderScope}`,
	JSON.stringify({ [SECTIONS_KEY]: "legacy-sections" })
);
localStorage.setItem(`ryu:settings-sync-cursor:${placeholderScope}`, "42");
localStorage.setItem(VISIBLE_OWNER_KEY, LEGACY_TOKEN);

const auth = await import("./auth-client.ts");
await auth.vaultHydrated;
const engine = await import("@/src/lib/settings-sync/engine.ts");
const { observeLocalWrite } = await import(
	"@/src/lib/settings-sync/local-store.ts"
);

afterAll(() => {
	globalThis.fetch = originalFetch;
});

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

test("a legacy placeholder's settings become the resolved account's", async () => {
	expect(auth.getActiveUserId()).toBe(LEGACY_TOKEN);
	releaseProfile();
	const deadline = Date.now() + 3000;
	while (auth.getActiveUserId() !== LEGACY_USER) {
		if (Date.now() > deadline) {
			throw new Error("legacy profile enrichment did not complete");
		}
		await Bun.sleep(1);
	}
	expect(localStorage.getItem(`ryu:settings-sync-cursor:${LEGACY_USER}`)).toBe(
		"42"
	);
	expect(
		localStorage.getItem(`ryu:settings-sync-values:${placeholderScope}`)
	).toBeNull();
	expect(localStorage.getItem(VISIBLE_OWNER_KEY)).toBe(LEGACY_USER);

	const stop = engine.startSettingsSync();
	try {
		expect(localStorage.getItem(SECTIONS_KEY)).toBe("legacy-sections");
		expect(engine.getActiveSyncIdentity()).toEqual({
			token: LEGACY_TOKEN,
			userId: LEGACY_USER,
		});
	} finally {
		stop();
	}
});

test("the offline sign-in fallback suspends sync instead of acting for the previous account", async () => {
	engine.setSyncEnabled(true);
	const stop = engine.startSettingsSync();
	try {
		await idle();
		expect(engine.getActiveSyncIdentity()?.userId).toBe(LEGACY_USER);
		localStorage.setItem(SECTIONS_KEY, "pending-for-legacy-user");
		// What the settings engine's same-document setItem patch reports in a
		// browser (happy-dom ignores the patch).
		observeLocalWrite(SECTIONS_KEY);
		expect(engine.getPendingCount()).toBe(1);

		await auth.storeSessionToken(OFFLINE_TOKEN);
		// The bearer is the live one, but its profile never resolved: it is held
		// as a placeholder account whose id is the bearer itself, which owns no
		// settings.
		expect(auth.getActiveToken()).toBe(OFFLINE_TOKEN);
		expect(auth.getVerifiedActiveUserId()).toBeNull();
		expect(engine.getActiveSyncIdentity()).toBeNull();

		window.dispatchEvent(new Event("pagehide"));
		await engine.syncPendingNow();
		await idle();
		const sentWithOffline = calls.filter(
			(call) =>
				call.authorization === `Bearer ${OFFLINE_TOKEN}` &&
				call.path.includes("desktop-settings-sync")
		);
		expect(sentWithOffline).toEqual([]);
		expect(
			calls.some((call) => call.body.includes("pending-for-legacy-user"))
		).toBe(false);
		// The previous account's pending edit stayed in its own scope.
		expect(
			localStorage.getItem(`ryu:settings-sync-values:${LEGACY_USER}`)
		).toContain("pending-for-legacy-user");
	} finally {
		stop();
		engine.setSyncEnabled(false);
	}
});
