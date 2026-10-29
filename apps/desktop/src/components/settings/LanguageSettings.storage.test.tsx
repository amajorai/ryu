import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

// Retain Bun's network stack across DOM registration: the catalog is read by the
// production SDK over real loopback HTTP, not through a mocked client.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const ownsDomRegistration = globalThis.document === undefined;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
// Bun's native fetch only accepts the runtime's own abort signals, not
// happy-dom's, and the shipping clients hand it the caller's signal.
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LANGUAGE_MODE_KEY, setLanguageMode, useLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { LanguagePackBridge } = await import("../LanguagePackBridge.tsx");
const { LanguageSettings } = await import("./LanguageSettings.tsx");

const french: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/storage-french",
	name: "Storage French",
	version: "1.0.0",
	locale: "fr",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installer pour la session" },
	enabled: true,
};
const arabic: LanguagePack = {
	...french,
	id: "coverage/storage-arabic",
	name: "Storage Arabic",
	locale: "ar",
	direction: "rtl",
	messages: { "common.install": "تثبيت من نافذة أخرى" },
};
let catalog = [french, arabic];
let catalogReads = 0;
const admissions: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const route = new URL(request.url).pathname;
		admissions.push(
			`${request.method} ${route} ${request.headers.get("authorization")}`
		);
		if (route !== "/api/language-packs/installed" || request.method !== "GET") {
			return new NativeResponse("undeclared route", { status: 404 });
		}
		catalogReads += 1;
		return NativeResponse.json({ packs: catalog });
	},
});
// A key-null storage event (another window clearing local settings) resets
// the node registry, so every case re-seeds the fixture node it reads from.
function seedFixtureNode() {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "language-storage-proof",
		nodes: [
			{
				name: "language-storage-proof",
				url: server.url.origin,
				token: "language-storage-token",
			},
		],
	});
}
seedFixtureNode();
beforeEach(seedFixtureNode);

function Consumer() {
	const { direction, locale, selectedPackId, t } = useI18n();
	const [mode] = useLanguageMode();
	return (
		<output
			data-direction={direction}
			data-mode={mode}
			data-pack={selectedPackId ?? ""}
			data-storage-consumer=""
		>
			{locale}:{t("common.install")}
		</output>
	);
}

let root: Root | null = null;
let element: HTMLDivElement | null = null;
const reactErrors: unknown[] = [];
const recordWindowError = (event: ErrorEvent) => reactErrors.push(event.error);
window.addEventListener("error", recordWindowError);
const nativeStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
)!;

async function settle(predicate: () => boolean) {
	for (let count = 0; count < 150 && !predicate(); count += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	if (!predicate()) {
		throw new Error(`Condition not reached: ${predicate.toString()}`);
	}
}
function consumer() {
	return element!.querySelector<HTMLOutputElement>("[data-storage-consumer]")!;
}
function trigger() {
	return element!.querySelector<HTMLButtonElement>('[role="combobox"]')!;
}
/** The visible selected value, excluding the trigger's decorative chevron. */
function shownChoice() {
	return trigger().querySelector('[data-slot="select-value"]')!.textContent;
}
async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element, {
		onUncaughtError: (error) => reactErrors.push(error),
	});
	const before = catalogReads;
	await act(async () =>
		root!.render(
			<MemoryRouter>
				<LanguagePackBridge>
					<LanguageSettings />
					<Consumer />
				</LanguagePackBridge>
			</MemoryRouter>
		)
	);
	await settle(
		() => catalogReads > before && element!.textContent!.includes(arabic.name)
	);
}
async function unmount() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
}
/** Pick a Settings option through the actual Base UI trigger and portal item. */
async function choose(name: string) {
	await act(async () => trigger().click());
	await settle(() =>
		Array.from(document.querySelectorAll('[role="option"]')).some(
			(option) => option.textContent === name
		)
	);
	const option = Array.from(
		document.querySelectorAll<HTMLElement>('[role="option"]')
	).find((candidate) => candidate.textContent === name)!;
	await act(async () => option.click());
}
/**
 * Install a Storage boundary over the durable store. Reads delegate; every write
 * method is recorded. With `refuse`, language-key `setItem` throws the browser's
 * quota error (as Safari private browsing does). Unexpected writes fail loudly.
 */
function observeLanguageWrites({ refuse }: { refuse: boolean }) {
	const durable = localStorage;
	const refused: string[] = [];
	const writes: string[] = [];
	const boundary = new Proxy(durable, {
		get(target, property) {
			if (property === "setItem") {
				return (key: string, value: string) => {
					if (key !== LANGUAGE_MODE_KEY && key !== LANGUAGE_PACK_STORAGE_KEY) {
						throw new Error(`Unexpected storage write: ${key}`);
					}
					writes.push(`set ${key}`);
					if (!refuse) {
						return target.setItem(key, value);
					}
					refused.push(key);
					throw new DOMException("denied", "QuotaExceededError");
				};
			}
			if (property === "removeItem" || property === "clear") {
				return (key?: string) => {
					writes.push(`${String(property)} ${key ?? ""}`);
					return property === "clear"
						? target.clear()
						: target.removeItem(key!);
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: boundary,
	});
	return {
		durable,
		refused,
		writes,
		restore: () =>
			Object.defineProperty(globalThis, "localStorage", nativeStorage),
	};
}
async function storageEvent(key: string | null) {
	await act(async () =>
		window.dispatchEvent(
			new StorageEvent("storage", { key, storageArea: localStorage })
		)
	);
}

afterEach(async () => {
	Object.defineProperty(globalThis, "localStorage", nativeStorage);
	await unmount();
	element = null;
	localStorage.clear();
	setLanguageMode("auto");
	catalog = [french, arabic];
	const errors = reactErrors.splice(0);
	if (errors.length > 0) {
		throw new Error(`React or window errors: ${errors.map(String).join("; ")}`);
	}
});
afterAll(async () => {
	window.removeEventListener("error", recordWindowError);
	await server.stop(true);
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

test("refused storage keeps an automatic-to-pack Settings choice in both mounted consumers; explicit retry persists it for a remount", async () => {
	setLanguageMode("auto");
	localStorage.setItem("storage-unrelated", "retained");
	await mount();
	expect(consumer().textContent).toBe("en-US:Install");
	expect(shownChoice()).toBe("Auto detect");
	const boundary = observeLanguageWrites({ refuse: true });
	try {
		await choose(french.name);
		// Both actual consumers keep the new choice for this session.
		await settle(
			() => consumer().textContent === "fr:Installer pour la session"
		);
		expect(consumer().dataset.mode).toBe("fixed");
		expect(consumer().dataset.pack).toBe(french.id);
		expect(shownChoice()).toBe(french.name);
		expect(document.documentElement.lang).toBe("fr");
		// Each language key was attempted exactly once and nothing durable changed.
		expect(boundary.refused).toEqual([
			LANGUAGE_MODE_KEY,
			LANGUAGE_PACK_STORAGE_KEY,
		]);
		expect(boundary.durable.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
		expect(boundary.durable.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
		const durableReload = await import(
			`@/src/hooks/useLanguageMode.ts?refused-settings=${Date.now()}`
		);
		expect(durableReload.readLanguageMode()).toBe("auto");
		// A later acknowledged catalog refresh keeps the unsaved session choice.
		const beforeRefresh = catalogReads;
		await act(async () =>
			window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
		);
		await settle(() => catalogReads > beforeRefresh);
		expect(consumer().textContent).toBe("fr:Installer pour la session");
	} finally {
		boundary.restore();
	}
	// Retry once storage is available: choosing the same pack again saves both keys.
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
	await choose(french.name);
	await settle(() => localStorage.getItem(LANGUAGE_MODE_KEY) === "fixed");
	expect(consumer().textContent).toBe("fr:Installer pour la session");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(french.id);
	expect(localStorage.getItem("storage-unrelated")).toBe("retained");
	await unmount();
	const independent = await import(
		`@/src/hooks/useLanguageMode.ts?retried-settings=${Date.now()}`
	);
	expect(independent.readLanguageMode()).toBe("fixed");
	await mount();
	await settle(() => consumer().textContent === "fr:Installer pour la session");
	expect(shownChoice()).toBe(french.name);
	expect(
		admissions.every(
			(entry) =>
				entry ===
				"GET /api/language-packs/installed Bearer language-storage-token"
		)
	).toBe(true);
});

test("external storage events replace a session-only choice only when they match, then unmount retires every listener", async () => {
	setLanguageMode("auto");
	localStorage.setItem("storage-unrelated", "retained");
	await mount();
	const boundary = observeLanguageWrites({ refuse: true });
	try {
		await choose(french.name);
		await settle(
			() => consumer().textContent === "fr:Installer pour la session"
		);
	} finally {
		boundary.restore();
	}
	expect(boundary.refused.length).toBe(2);
	// Storage is readable again but still holds the earlier durable choice.
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
	localStorage.setItem("storage-unrelated", "changed elsewhere");
	await storageEvent("storage-unrelated");
	await act(async () =>
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: LANGUAGE_PACK_STORAGE_KEY,
				storageArea: sessionStorage,
			})
		)
	);
	expect(consumer().textContent).toBe("fr:Installer pour la session");
	expect(shownChoice()).toBe(french.name);
	// Mode-only saves elsewhere also supersede the unsaved pack: returning to a
	// fixed mode uses the saved English choice, not this window's French one.
	localStorage.setItem(LANGUAGE_MODE_KEY, "auto");
	await storageEvent(LANGUAGE_MODE_KEY);
	await settle(() => consumer().textContent === "en-US:Install");
	expect(shownChoice()).toBe("Auto detect");
	localStorage.setItem(LANGUAGE_MODE_KEY, "fixed");
	await storageEvent(LANGUAGE_MODE_KEY);
	await settle(() => consumer().dataset.mode === "fixed");
	expect(consumer().textContent).toBe("en:Install");
	expect(consumer().dataset.pack).toBe("");
	expect(shownChoice()).toBe("English");
	// Another window durably fixes Arabic; its matching events are authoritative.
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, arabic.id);
	localStorage.setItem(LANGUAGE_MODE_KEY, "fixed");
	await storageEvent(LANGUAGE_PACK_STORAGE_KEY);
	await storageEvent(LANGUAGE_MODE_KEY);
	await settle(() => consumer().textContent === "ar:تثبيت من نافذة أخرى");
	expect(consumer().dataset.direction).toBe("rtl");
	expect(document.documentElement.dir).toBe("rtl");
	expect(shownChoice()).toBe(arabic.name);
	// Clearing local settings elsewhere returns both consumers to automatic English.
	localStorage.clear();
	await storageEvent(null);
	await settle(() => consumer().textContent === "en-US:Install");
	expect(consumer().dataset.mode).toBe("auto");
	expect(shownChoice()).toBe("Auto detect");
	expect(document.documentElement.dir).toBe("ltr");
	const container = element!;
	const readsBeforeUnmount = catalogReads;
	await unmount();
	expect(container.childNodes.length).toBe(0);
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, french.id);
	await storageEvent(LANGUAGE_PACK_STORAGE_KEY);
	await act(async () =>
		window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	expect(catalogReads).toBe(readsBeforeUnmount);
	expect(container.childNodes.length).toBe(0);
});

test("a mode-only save from another window that matches this window's session mode still replaces its unsaved pack with the saved English choice", async () => {
	setLanguageMode("auto");
	localStorage.setItem("storage-unrelated", "retained");
	await mount();
	const refusing = observeLanguageWrites({ refuse: true });
	try {
		await choose(french.name);
		await settle(
			() => consumer().textContent === "fr:Installer pour la session"
		);
	} finally {
		refusing.restore();
	}
	expect(refusing.refused).toEqual([
		LANGUAGE_MODE_KEY,
		LANGUAGE_PACK_STORAGE_KEY,
	]);
	// This window already runs fixed mode for the session; durable storage is automatic.
	expect(consumer().dataset.mode).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	// Storage recovers. Another window saves English: its mode write (auto -> fixed)
	// is the only event, because removing the absent pack key changes nothing.
	const observer = observeLanguageWrites({ refuse: false });
	try {
		observer.durable.setItem(LANGUAGE_MODE_KEY, "fixed");
		await storageEvent(LANGUAGE_MODE_KEY);
		await settle(() => consumer().textContent === "en:Install");
		expect(consumer().dataset.mode).toBe("fixed");
		expect(consumer().dataset.pack).toBe("");
		expect(shownChoice()).toBe("English");
		expect(document.documentElement.lang).toBe("en");
		expect(document.documentElement.dir).toBe("ltr");
		// The discarded choice stays discarded across an acknowledged catalog refresh.
		const beforeRefresh = catalogReads;
		await act(async () =>
			window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
		);
		await settle(() => catalogReads > beforeRefresh);
		expect(consumer().textContent).toBe("en:Install");
		expect(shownChoice()).toBe("English");
		// Projecting the other window's save writes nothing from this window.
		expect(observer.writes).toEqual([]);
	} finally {
		observer.restore();
	}
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	expect(localStorage.getItem("storage-unrelated")).toBe("retained");
	// An independent remount reads the same saved English choice.
	await unmount();
	await mount();
	expect(consumer().textContent).toBe("en:Install");
	expect(consumer().dataset.mode).toBe("fixed");
	expect(shownChoice()).toBe("English");
});

test("a Core-disabled saved pack falls back to English in Settings and content without rewriting the saved choice; acknowledged re-enable restores it", async () => {
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, french.id);
	setLanguageMode("fixed");
	localStorage.setItem("storage-unrelated", "retained");
	catalog = [{ ...french, enabled: false }, arabic];
	const boundary = observeLanguageWrites({ refuse: false });
	try {
		await mount();
		// Core's catalog is authoritative: the saved id is kept but not projected.
		expect(consumer().textContent).toBe("en:Install");
		expect(consumer().dataset.pack).toBe(french.id);
		expect(consumer().dataset.mode).toBe("fixed");
		expect(shownChoice()).toBe("English");
		expect(document.documentElement.lang).toBe("en");
		expect(element!.textContent).toContain(
			"This pack is installed but disabled."
		);
		// An independent remount while disabled still reads the saved choice.
		await unmount();
		await mount();
		expect(consumer().textContent).toBe("en:Install");
		expect(consumer().dataset.pack).toBe(french.id);
		// Core acknowledges re-enabling the pack; the saved choice returns unchanged.
		catalog = [french, arabic];
		const beforeRefresh = catalogReads;
		await act(async () =>
			window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
		);
		await settle(
			() =>
				catalogReads > beforeRefresh &&
				consumer().textContent === "fr:Installer pour la session"
		);
		expect(shownChoice()).toBe(french.name);
		expect(document.documentElement.lang).toBe("fr");
		expect(element!.textContent).not.toContain(
			"This pack is installed but disabled."
		);
		// Fallback, remount and recovery are projections; none writes local settings.
		expect(boundary.writes).toEqual([]);
	} finally {
		boundary.restore();
	}
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(french.id);
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem("storage-unrelated")).toBe("retained");
});
