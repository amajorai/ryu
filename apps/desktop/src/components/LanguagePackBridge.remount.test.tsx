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

// Retain Bun's network stack across DOM registration: each Bridge reads the
// catalog through the production SDK over real loopback HTTP.
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
const { LanguagePackBridge } = await import("./LanguagePackBridge.tsx");
const { LanguageSettings } = await import("./settings/LanguageSettings.tsx");

const french: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/remount-french",
	name: "Remount French",
	version: "1.0.0",
	locale: "fr",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installer après remontage" },
	enabled: true,
};
const arabic: LanguagePack = {
	...french,
	id: "coverage/remount-arabic",
	name: "Remount Arabic",
	locale: "ar",
	direction: "rtl",
	messages: { "common.install": "تثبيت بعد إعادة التركيب" },
};
const frenchText = "fr:Installer après remontage";
const arabicText = "ar:تثبيت بعد إعادة التركيب";
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
		return NativeResponse.json({ packs: [french, arabic] });
	},
});
// A key-null storage event (another window clearing local settings) resets
// the node registry, so every case re-seeds the fixture node it reads from.
function seedFixtureNode() {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "language-remount-proof",
		nodes: [
			{
				name: "language-remount-proof",
				url: server.url.origin,
				token: "language-remount-token",
			},
		],
	});
}
seedFixtureNode();
beforeEach(seedFixtureNode);

function Consumer({ label }: { label: string }) {
	const { direction, locale, selectedPackId, t } = useI18n();
	const [mode] = useLanguageMode();
	return (
		<output
			data-direction={direction}
			data-mode={mode}
			data-pack={selectedPackId ?? ""}
			data-remount-consumer={label}
		>
			{locale}:{t("common.install")}
		</output>
	);
}

interface MountedBridge {
	element: HTMLDivElement;
	root: Root;
}
const mounted = new Set<MountedBridge>();
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
function consumer(bridge: MountedBridge) {
	return bridge.element.querySelector<HTMLOutputElement>(
		"[data-remount-consumer]"
	)!;
}
function shownChoice(bridge: MountedBridge) {
	return bridge.element
		.querySelector('[role="combobox"]')!
		.querySelector('[data-slot="select-value"]')!.textContent;
}
/** Mount one Bridge (with Settings when asked) in its own container and root. */
async function mountBridge(
	label: string,
	{ settings }: { settings: boolean }
): Promise<MountedBridge> {
	const element = document.createElement("div");
	document.body.append(element);
	const root = createRoot(element, {
		onUncaughtError: (error) => reactErrors.push(error),
	});
	const bridge = { element, root };
	mounted.add(bridge);
	const before = catalogReads;
	await act(async () =>
		root.render(
			<MemoryRouter>
				<LanguagePackBridge>
					{settings ? <LanguageSettings /> : null}
					<Consumer label={label} />
				</LanguagePackBridge>
			</MemoryRouter>
		)
	);
	await settle(
		() =>
			catalogReads > before &&
			(!settings || element.textContent!.includes(arabic.name))
	);
	return bridge;
}
async function unmountBridge(bridge: MountedBridge) {
	await act(async () => bridge.root.unmount());
	bridge.element.remove();
	mounted.delete(bridge);
}
/** Pick a Settings option through the Bridge's own Base UI trigger and portal item. */
async function choose(bridge: MountedBridge, name: string) {
	const trigger =
		bridge.element.querySelector<HTMLButtonElement>('[role="combobox"]')!;
	await act(async () => trigger.click());
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
 * Install a Storage boundary over the durable store. Reads delegate; every
 * write is recorded; with `refuse`, language-key `setItem` throws the browser's
 * quota error. Writes to any other key fail the case loudly.
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
	for (const bridge of Array.from(mounted)) {
		await unmountBridge(bridge);
	}
	localStorage.clear();
	// Each case starts in automatic mode, where a Bridge ignores any pack choice
	// a previous case left unsaved.
	setLanguageMode("auto");
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

test("an unsaved Settings choice survives same-window Bridge remounts without any storage write, until an explicit retry after recovery saves it", async () => {
	setLanguageMode("auto");
	localStorage.setItem("remount-unrelated", "retained");
	let bridge = await mountBridge("only", { settings: true });
	expect(consumer(bridge).textContent).toBe("en-US:Install");
	const refusing = observeLanguageWrites({ refuse: true });
	try {
		await choose(bridge, french.name);
		await settle(() => consumer(bridge).textContent === frenchText);
		expect(refusing.refused).toEqual([
			LANGUAGE_MODE_KEY,
			LANGUAGE_PACK_STORAGE_KEY,
		]);
		const writesBeforeRemount = refusing.writes.length;
		// The whole Bridge tree unmounts and mounts again in this window.
		await unmountBridge(bridge);
		bridge = await mountBridge("only", { settings: true });
		await settle(() => consumer(bridge).textContent === frenchText);
		expect(consumer(bridge).dataset.mode).toBe("fixed");
		expect(consumer(bridge).dataset.pack).toBe(french.id);
		expect(shownChoice(bridge)).toBe(french.name);
		expect(document.documentElement.lang).toBe("fr");
		// Remounting and reloading the catalog only project the session choice.
		const beforeRefresh = catalogReads;
		await act(async () =>
			window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
		);
		await settle(() => catalogReads > beforeRefresh);
		expect(consumer(bridge).textContent).toBe(frenchText);
		expect(refusing.writes.length).toBe(writesBeforeRemount);
		expect(refusing.durable.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
		expect(refusing.durable.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	} finally {
		refusing.restore();
	}
	// Storage recovers but still holds the older durable choice. A further
	// remount keeps the session choice instead of reverting to it.
	await unmountBridge(bridge);
	const recovered = observeLanguageWrites({ refuse: false });
	try {
		bridge = await mountBridge("only", { settings: true });
		await settle(() => consumer(bridge).textContent === frenchText);
		expect(shownChoice(bridge)).toBe(french.name);
		expect(recovered.writes).toEqual([]);
		// The explicit retry now saves both keys.
		await choose(bridge, french.name);
		await settle(() => localStorage.getItem(LANGUAGE_MODE_KEY) === "fixed");
		expect(recovered.writes).toEqual([
			`set ${LANGUAGE_MODE_KEY}`,
			`set ${LANGUAGE_PACK_STORAGE_KEY}`,
		]);
	} finally {
		recovered.restore();
	}
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(french.id);
	await unmountBridge(bridge);
	bridge = await mountBridge("only", { settings: true });
	await settle(() => consumer(bridge).textContent === frenchText);
	expect(localStorage.getItem("remount-unrelated")).toBe("retained");
	expect(
		admissions.every(
			(entry) =>
				entry ===
				"GET /api/language-packs/installed Bearer language-remount-token"
		)
	).toBe(true);
});

test("two Bridges in one document project the same window choice, including another window's mode-only save that discards an unsaved pack; unmounting one retires only its listeners", async () => {
	setLanguageMode("auto");
	localStorage.setItem("remount-unrelated", "retained");
	const readsBefore = catalogReads;
	const first = await mountBridge("first", { settings: true });
	const second = await mountBridge("second", { settings: false });
	// Each Bridge reads its own catalog from the node.
	expect(catalogReads).toBe(readsBefore + 2);
	for (const bridge of [first, second]) {
		expect(consumer(bridge).textContent).toBe("en-US:Install");
	}
	const refusing = observeLanguageWrites({ refuse: true });
	try {
		await choose(first, french.name);
		for (const bridge of [first, second]) {
			await settle(() => consumer(bridge).textContent === frenchText);
			expect(consumer(bridge).dataset.mode).toBe("fixed");
		}
	} finally {
		refusing.restore();
	}
	expect(refusing.refused).toEqual([
		LANGUAGE_MODE_KEY,
		LANGUAGE_PACK_STORAGE_KEY,
	]);
	// Another window saves English. Its only event is the mode write, which
	// matches this window's session mode; both Bridges must drop French.
	const observer = observeLanguageWrites({ refuse: false });
	try {
		observer.durable.setItem(LANGUAGE_MODE_KEY, "fixed");
		await storageEvent(LANGUAGE_MODE_KEY);
		for (const bridge of [first, second]) {
			await settle(() => consumer(bridge).textContent === "en:Install");
			expect(consumer(bridge).dataset.pack).toBe("");
		}
		expect(shownChoice(first)).toBe("English");
		// Another window then saves Arabic; both Bridges follow it.
		observer.durable.setItem(LANGUAGE_PACK_STORAGE_KEY, arabic.id);
		await storageEvent(LANGUAGE_PACK_STORAGE_KEY);
		for (const bridge of [first, second]) {
			await settle(() => consumer(bridge).textContent === arabicText);
			expect(consumer(bridge).dataset.direction).toBe("rtl");
		}
		expect(document.documentElement.dir).toBe("rtl");
		expect(observer.durable.getItem("remount-unrelated")).toBe("retained");
		// Clearing local settings elsewhere returns both to automatic English.
		observer.durable.clear();
		await storageEvent(null);
		for (const bridge of [first, second]) {
			await settle(() => consumer(bridge).textContent === "en-US:Install");
			expect(consumer(bridge).dataset.mode).toBe("auto");
		}
		// That clear also reset the node registry; restore the fixture node so the
		// listener-retirement step below still reads from this file's server, and
		// wait for both Bridges' node-switch reads before counting reads again.
		const readsBeforeReseed = catalogReads;
		await act(async () => seedFixtureNode());
		await settle(() => catalogReads === readsBeforeReseed + 2);
		// Projecting other windows' saves writes nothing from this one.
		expect(observer.writes).toEqual([]);
	} finally {
		observer.restore();
	}
	// Unmounting the first Bridge leaves the second one live, and only it reads.
	const firstElement = first.element;
	await unmountBridge(first);
	expect(firstElement.childNodes.length).toBe(0);
	const readsAfterUnmount = catalogReads;
	await act(async () =>
		window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await settle(() => catalogReads === readsAfterUnmount + 1);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	expect(catalogReads).toBe(readsAfterUnmount + 1);
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, french.id);
	localStorage.setItem(LANGUAGE_MODE_KEY, "fixed");
	await storageEvent(LANGUAGE_PACK_STORAGE_KEY);
	await storageEvent(LANGUAGE_MODE_KEY);
	await settle(() => consumer(second).textContent === frenchText);
	expect(firstElement.childNodes.length).toBe(0);
});
