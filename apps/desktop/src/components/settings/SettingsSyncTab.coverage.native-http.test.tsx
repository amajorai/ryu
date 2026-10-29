import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { sileo } from "sileo";
import { z } from "zod";

// The REAL Settings Sync tab driven by the REAL sync engine (localStorage
// observer, debounce, pull/apply/push cycle, conflict policy) against a
// loopback Bun control plane that implements the desktop-settings-sync
// contract the shipping router does: per-key last-writer-wins on each entry's
// own `updatedAt`, `rejected` carrying the newer server copy, `pull?since=`
// returning entries changed at or after the cursor, and DELETE forgetting the
// account's copy. The account is identified by the session bearer only.
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const nativeFetch = globalThis.fetch;

interface Entry {
	deleted?: boolean;
	key: string;
	updatedAt: number;
	value: string | null;
}
interface Call {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}
const ACCOUNT_TOKEN = "sync-session-token";
const pushBody = z.object({
	entries: z.array(
		z
			.object({
				deleted: z.boolean().optional(),
				key: z.string(),
				updatedAt: z.number(),
				value: z.string().nullable(),
			})
			.strict()
	),
});
let cloud = new Map<string, Entry>();
let revision = 0;
let calls: Call[] = [];
let refuseNext: string[] = [];
let unexpected: string[] = [];

function docUpdatedAt() {
	return Math.max(0, ...[...cloud.values()].map((entry) => entry.updatedAt));
}
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const route = `${request.method} ${url.pathname}`;
		const authorization = request.headers.get("authorization");
		if (
			route === "GET /api/auth/get-session" &&
			authorization === `Bearer ${ACCOUNT_TOKEN}`
		) {
			// The real auth vault enriches the signed-in bearer's profile once.
			return NativeResponse.json({
				session: { id: "sync-session", userId: "sync-user" },
				user: { email: "sync@example.test", id: "sync-user", name: "Sync" },
			});
		}
		const body = request.method === "POST" ? await request.json() : null;
		calls.push({
			authorization,
			body,
			method: request.method,
			path: url.pathname,
		});
		if (authorization !== `Bearer ${ACCOUNT_TOKEN}`) {
			unexpected.push(`unauthenticated ${route}`);
			return NativeResponse.json({ error: "Unauthorized" }, { status: 401 });
		}
		if (refuseNext.includes(route)) {
			refuseNext = refuseNext.filter((candidate) => candidate !== route);
			return NativeResponse.json({ error: "Unavailable" }, { status: 503 });
		}
		switch (route) {
			case "GET /api/desktop-settings-sync/pull": {
				const since = Number(url.searchParams.get("since") ?? 0);
				return NativeResponse.json({
					entries: [...cloud.values()].filter((e) => e.updatedAt >= since),
					revision,
					updatedAt: docUpdatedAt(),
				});
			}
			case "POST /api/desktop-settings-sync/push": {
				const parsed = pushBody.safeParse(body);
				if (!parsed.success) {
					unexpected.push(`bad push ${JSON.stringify(body)}`);
					return NativeResponse.json({ error: "Bad body" }, { status: 400 });
				}
				const applied: string[] = [];
				const rejected: Entry[] = [];
				for (const entry of parsed.data.entries) {
					const existing = cloud.get(entry.key);
					if (existing && existing.updatedAt >= entry.updatedAt) {
						if (existing.updatedAt > entry.updatedAt) {
							rejected.push(existing);
						}
						continue;
					}
					cloud.set(entry.key, {
						...entry,
						value: entry.deleted ? null : entry.value,
					});
					applied.push(entry.key);
				}
				if (applied.length > 0) {
					revision++;
				}
				return NativeResponse.json({
					applied,
					ok: true,
					rejected,
					revision,
					updatedAt: docUpdatedAt(),
				});
			}
			case "DELETE /api/desktop-settings-sync":
				cloud = new Map();
				revision = 0;
				return NativeResponse.json({ ok: true });
			default:
				unexpected.push(route);
				return NativeResponse.json({ error: "Unknown route" }, { status: 404 });
		}
	},
});
// The shipping client reads its control-plane origin from the Vite env at
// module load; Bun exposes `import.meta.env` as `process.env`.
process.env.VITE_APP_BACKEND_URL = server.url.origin;

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/**
 * happy-dom's Storage is a Proxy that stores any assigned property as an item,
 * so the engine's same-document observer (`localStorage.setItem = patched`)
 * would never install on it. A plain Storage double keeps the real path: a
 * local edit goes through the patched `setItem`, which stamps the key and tells
 * the engine, exactly as in the app. (A `storage` event no longer stamps: it is
 * a sibling window's write, which that window already stamped and pushes.)
 */
class PlainStorage implements Storage {
	readonly #items = new Map<string, string>();
	[name: string]: unknown;
	get length(): number {
		return this.#items.size;
	}
	clear(): void {
		this.#items.clear();
	}
	getItem(key: string): string | null {
		return this.#items.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.#items.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.#items.delete(key);
	}
	setItem(key: string, value: string): void {
		this.#items.set(key, String(value));
	}
}
const plainStorage = new PlainStorage();
for (const target of [globalThis, window]) {
	Object.defineProperty(target, "localStorage", {
		configurable: true,
		value: plainStorage,
		writable: true,
	});
}
const rejectedEgress: string[] = [];
let inFlight = 0;
const guardedFetch = Object.assign(
	async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(new NativeRequest(input, init).url);
		if (url.origin !== server.url.origin) {
			rejectedEgress.push(url.href);
			throw new Error("Settings Sync coverage refuses unowned HTTP egress");
		}
		inFlight++;
		try {
			return await nativeFetch(input, init);
		} finally {
			inFlight--;
		}
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = guardedFetch;
window.fetch = guardedFetch;

const { createRoot } = await import("react-dom/client");
const { Toaster } = await import("@ryu/ui/components/sileo.tsx");
const { SettingsSyncTab } = await import("./SettingsSyncTab.tsx");
const engine = await import("@/src/lib/settings-sync/engine.ts");
const { BACKEND_URL, TOKEN_KEY } = await import("@/lib/auth-client.ts");
const {
	button,
	choose,
	click,
	comboIn,
	isDisabled,
	isOn,
	maybeButton,
	row,
	settle,
	shownValue,
	switchIn,
} = await import("./privacy-security.test-support.ts");

const ENABLE = "Sync My Settings Across Machines";
let root: Root | null = null;
let stopEngine: (() => void) | null = null;

/**
 * Seed values and their recorded local-change times without engine side
 * effects, as this account's own: the visible-owner record names it, as it
 * does on any store this build wrote. (A store without the record is a
 * pre-scoping one, whose stamps are never claimed as anyone's pending work.)
 */
function seed(values: Record<string, string>, meta: Record<string, number>) {
	for (const [key, value] of Object.entries(values)) {
		localStorage.setItem(key, value);
	}
	localStorage.setItem("ryu:settings-sync-meta", JSON.stringify(meta));
	localStorage.setItem("ryu:settings-sync-visible-owner", "sync-user");
}
/** A local settings edit: the engine's patched `localStorage.setItem` sees it. */
async function localEdit(key: string, value: string) {
	await act(async () => {
		localStorage.setItem(key, value);
	});
}
function pushes(): Entry[][] {
	return calls
		.filter((call) => call.method === "POST")
		.map((call) => pushBody.parse(call.body).entries);
}
function pulls(): number {
	return calls.filter((call) => call.method === "GET").length;
}
const text = () => document.body.textContent ?? "";
const status = () =>
	row("Status").textContent?.replace("Status", "").trim() ?? "";
function dialog(): HTMLElement | null {
	return (
		[...document.querySelectorAll<HTMLElement>('[role="alertdialog"]')].find(
			(candidate) => !candidate.hasAttribute("data-closed")
		) ?? null
	);
}
async function idle() {
	await settle(
		() => inFlight === 0 && engine.getSyncStatus() !== "syncing",
		"sync engine idle"
	);
}
async function mount() {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		stopEngine = engine.startSettingsSync();
		root!.render(
			<>
				<SettingsSyncTab />
				<Toaster />
			</>
		);
	});
	await idle();
}
async function unmount() {
	await idle();
	if (root) {
		const current = root;
		await act(async () => current.unmount());
		root = null;
	}
	stopEngine?.();
	stopEngine = null;
	document.body.replaceChildren();
}
async function remount() {
	await unmount();
	await mount();
}
async function syncNow() {
	await click(button("Sync now"));
	await idle();
}

beforeEach(() => {
	sileo.clear();
	cloud = new Map();
	revision = 0;
	calls = [];
	refuseNext = [];
	unexpected = [];
	localStorage.clear();
	// A verified account: settings sync acts only when the live bearer and the
	// vault's active account agree.
	localStorage.setItem(
		"ryu_accounts",
		JSON.stringify([
			{
				email: "sync@example.test",
				image: null,
				name: "Sync",
				token: ACCOUNT_TOKEN,
				userId: "sync-user",
			},
		])
	);
	localStorage.setItem("ryu_active_user_id", "sync-user");
	localStorage.setItem(TOKEN_KEY, ACCOUNT_TOKEN);
	localStorage.setItem("ryu:settings-sync-policy", "ask");
	// Engine state is module-global; every case must leave it settled.
	if (engine.getPendingCount() !== 0 || engine.getConflicts().length !== 0) {
		throw new Error("A previous case left unsynced engine state");
	}
});
afterEach(async () => {
	await unmount();
	sileo.clear();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case keeps to the owned sync contract and session bearer.
	expect(unexpected).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses foreign egress.
	expect(rejectedEgress).toEqual([]);
});
afterAll(() => {
	server.stop(true);
	globalThis.fetch = nativeFetch;
});

test("the fixture is the client's configured control plane", () => {
	expect(BACKEND_URL).toBe(server.url.origin);
});

test("Sync My Settings Across Machines opts in, uploads only allowlisted local changes, survives a remount, and opting out stops uploads", async () => {
	seed(
		{
			"ryu:settings-sync-enabled": "false",
			"ryu:settings-sync-cursor": "0",
			theme: "dark",
			ryu_ui_font: "Inter",
			ryu_workspace_path: "/private/workspace",
		},
		{ theme: 10, ryu_ui_font: 11, ryu_workspace_path: 12 }
	);
	await mount();
	expect(isOn(switchIn(ENABLE))).toBe(false);
	expect(status()).toBe("Off");
	expect(isDisabled(button("Sync now"))).toBe(true);
	expect(text()).toContain("2 changes waiting to upload. Last synced never.");
	expect(calls).toEqual([]);

	await click(switchIn(ENABLE));
	await idle();
	expect(localStorage.getItem("ryu:settings-sync-enabled")).toBe("true");
	await settle(() => status() === "Up to date", "first sync");
	expect(pushes()).toEqual([
		[
			{ deleted: false, key: "theme", updatedAt: 10, value: "dark" },
			{ deleted: false, key: "ryu_ui_font", updatedAt: 11, value: "Inter" },
		],
	]);
	expect(cloud.has("ryu_workspace_path")).toBe(false);
	expect(JSON.stringify(calls)).not.toContain("/private/workspace");
	expect(text()).toContain("Last synced just now.");

	await remount();
	expect(isOn(switchIn(ENABLE))).toBe(true);
	expect(status()).toBe("Up to date");
	expect(pushes()).toHaveLength(1);

	await click(switchIn(ENABLE));
	await idle();
	expect(localStorage.getItem("ryu:settings-sync-enabled")).toBe("false");
	expect(status()).toBe("Off");
	expect(isDisabled(button("Sync now"))).toBe(true);
	const callsWhileOff = calls.length;
	await localEdit("theme", "light");
	await idle();
	expect(calls).toHaveLength(callsWhileOff);
	expect(cloud.get("theme")?.value).toBe("dark");

	await click(switchIn(ENABLE));
	await settle(() => cloud.get("theme")?.value === "light", "re-enabled push");
	await idle();
	expect(status()).toBe("Up to date");
	expect(pushes().at(-1)).toEqual([
		expect.objectContaining({ key: "theme", value: "light" }),
	]);
});

test("Status and Last Sync report waiting, offline and conflict states, Sync now recovers, and Use cloud resolves the decision", async () => {
	seed({ "ryu:settings-sync-enabled": "true" }, {});
	await mount();
	expect(status()).toBe("Up to date");
	expect(text()).toContain("Last synced just now.");

	await localEdit("ryu_ui_font", "Mono");
	await settle(() => status() === "Changes waiting to upload", "waiting");
	expect(text()).toContain("1 change waiting to upload.");
	expect(cloud.has("ryu_ui_font")).toBe(false);

	refuseNext.push("GET /api/desktop-settings-sync/pull");
	await syncNow();
	expect(status()).toBe("Sync incomplete");
	await settle(
		() => text().includes("Couldn't sync settings"),
		"offline toast"
	);
	expect(text()).toContain("1 change waiting to upload.");
	expect(cloud.has("ryu_ui_font")).toBe(false);

	await syncNow();
	expect(status()).toBe("Up to date");
	await settle(() => text().includes("Settings synced"), "synced toast");
	expect(cloud.get("ryu_ui_font")?.value).toBe("Mono");
	expect(text()).toContain("Last synced just now.");

	const remoteAt = Date.now() + 60_000;
	cloud.set("theme", { key: "theme", updatedAt: remoteAt, value: "light" });
	await localEdit("theme", "dark");
	await syncNow();
	expect(status()).toBe("Needs your decision");
	await settle(
		() => text().includes("Settings need your decision"),
		"conflict toast"
	);
	expect(text()).toContain("1 setting needs a decision");
	expect(text()).toContain("Light / dark / system");
	expect(cloud.get("theme")?.value).toBe("light");
	expect(
		pushes()
			.flat()
			.some((entry) => entry.key === "theme")
	).toBe(false);

	await click(button("Use cloud"));
	await idle();
	expect(localStorage.getItem("theme")).toBe("light");
	expect(status()).toBe("Up to date");
	expect(text()).not.toContain("needs a decision");
	expect(engine.getPendingCount()).toBe(0);
});

test("Conflict Handling persists the chosen policy and decides contested settings: newer cloud copy downloads, this machine's copy uploads", async () => {
	seed({ "ryu:settings-sync-enabled": "true" }, {});
	await mount();
	expect(shownValue(comboIn("Conflict Handling"))).toContain(
		"Ask me every time"
	);
	await choose(comboIn("Conflict Handling"), "Always use the newer cloud copy");
	expect(localStorage.getItem("ryu:settings-sync-policy")).toBe("download");
	await remount();
	expect(shownValue(comboIn("Conflict Handling"))).toContain(
		"Always use the newer cloud copy"
	);

	cloud.set("ryu_dark_preset", {
		key: "ryu_dark_preset",
		updatedAt: Date.now() + 60_000,
		value: "cloud-night",
	});
	await localEdit("ryu_dark_preset", "local-night");
	await syncNow();
	expect(status()).toBe("Up to date");
	expect(localStorage.getItem("ryu_dark_preset")).toBe("cloud-night");
	expect(cloud.get("ryu_dark_preset")?.value).toBe("cloud-night");
	expect(maybeButton("Use cloud")).toBeNull();

	await choose(comboIn("Conflict Handling"), "Always keep this machine's copy");
	expect(localStorage.getItem("ryu:settings-sync-policy")).toBe("upload");
	const cloudAt = Date.now() + 120_000;
	cloud.set("ryu_light_preset", {
		key: "ryu_light_preset",
		updatedAt: cloudAt,
		value: "cloud-day",
	});
	await localEdit("ryu_light_preset", "local-day");
	await syncNow();
	expect(status()).toBe("Up to date");
	expect(localStorage.getItem("ryu_light_preset")).toBe("local-day");
	expect(cloud.get("ryu_light_preset")?.value).toBe("local-day");
	expect(cloud.get("ryu_light_preset")?.updatedAt).toBeGreaterThan(cloudAt);
	expect(maybeButton("Use cloud")).toBeNull();
});

test("Delete My Synced Settings asks first, Cancel keeps the cloud copy, a refused delete stays open for retry, and success removes only the cloud copy", async () => {
	seed({ "ryu:settings-sync-enabled": "true", theme: "dark" }, { theme: 10 });
	await mount();
	await settle(() => cloud.get("theme")?.value === "dark", "seeded upload");
	const deletes = () => calls.filter((call) => call.method === "DELETE");

	await click(button("Delete cloud copy", row("Delete My Synced Settings")));
	await settle(() => dialog() !== null, "confirmation open");
	expect(dialog()?.textContent).toContain("Delete your cloud settings?");
	await click(button("Cancel", dialog()!));
	await settle(() => dialog() === null, "confirmation closed");
	expect(deletes()).toEqual([]);
	expect(cloud.size).toBe(1);

	await click(button("Delete cloud copy", row("Delete My Synced Settings")));
	await settle(() => dialog() !== null, "confirmation reopened");
	refuseNext.push("DELETE /api/desktop-settings-sync");
	await click(button("Delete cloud copy", dialog()!));
	await settle(
		() => text().includes("Couldn't delete the cloud copy"),
		"refusal toast"
	);
	expect(dialog()).not.toBeNull();
	expect(cloud.size).toBe(1);

	await click(button("Delete cloud copy", dialog()!));
	await settle(() => text().includes("Cloud copy deleted"), "deleted toast");
	await settle(() => dialog() === null, "confirmation closed after delete");
	expect(text()).toContain("The settings on this machine were not changed.");
	expect(cloud.size).toBe(0);
	expect(deletes()).toEqual([
		{
			authorization: `Bearer ${ACCOUNT_TOKEN}`,
			body: null,
			method: "DELETE",
			path: "/api/desktop-settings-sync",
		},
		{
			authorization: `Bearer ${ACCOUNT_TOKEN}`,
			body: null,
			method: "DELETE",
			path: "/api/desktop-settings-sync",
		},
	]);
	expect(localStorage.getItem("theme")).toBe("dark");
	expect(localStorage.getItem("ryu:settings-sync-enabled")).toBe("true");
	expect(pulls()).toBeGreaterThan(0);
});
