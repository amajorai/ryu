import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	BUILT_IN_LANGUAGE_PACKS,
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
} from "@ryu/i18n";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act, Profiler, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

// Retain Bun's network stack across DOM registration: the shipping SDK reads
// the installed catalog over real loopback HTTP, never through a mocked client.
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
const { LANGUAGE_MODE_KEY, setLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { LanguagePackBridge } = await import("./LanguagePackBridge.tsx");

const spanish: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/publication-spanish",
	name: "Publication Spanish",
	version: "1.0.0",
	locale: "es",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Instalar sin repetir" },
	enabled: true,
};
const french: LanguagePack = {
	...spanish,
	id: "coverage/publication-french",
	name: "Publication French",
	locale: "fr",
	messages: { "common.install": "Installer sans répéter" },
};

/**
 * Observable cost of one language publication. `publications` counts host
 * subscription callbacks (every runtime emit). `documentScans` counts the DOM
 * localizer's full-document tree walks. `rootWrites` counts attribute records
 * the provider's lang/dir/`--ryu-locale` writes leave on `<html>`, each of
 * which invalidates style for the whole document. `bridgeCommits` proves a
 * refreshed catalog reached the Bridge before a zero-cost assertion.
 */
const ledger = {
	bridgeCommits: 0,
	commitsAtLastRead: 0,
	documentScans: 0,
	publications: 0,
	rootWrites: 0,
};
let catalog: LanguagePack[] = [];
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
		ledger.commitsAtLastRead = ledger.bridgeCommits;
		// JSON serialization hands the client fresh, content-identical objects.
		return NativeResponse.json({ packs: catalog });
	},
});
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "language-publication-proof",
	nodes: [
		{
			name: "language-publication-proof",
			url: server.url.origin,
			token: "language-publication-token",
		},
	],
});

// Observe (and delegate) the document's own tree-walker entry point. happy-dom
// defines it on a per-window prototype, so the instance property is patched.
const nativeCreateTreeWalker = document.createTreeWalker;
document.createTreeWalker = (...input) => {
	if (input[0] === document.documentElement) {
		ledger.documentScans += 1;
	}
	return nativeCreateTreeWalker.apply(document, input);
};
// happy-dom routes `lang`, `dir` and `style.setProperty` through the element's
// `setAttribute`. A MutationObserver cannot count them here: happy-dom drops
// every observer on a node when the localizer disconnects its own observer.
const documentRoot = document.documentElement;
const nativeSetAttribute = documentRoot.setAttribute;
documentRoot.setAttribute = (name: string, value: string) => {
	if (name === "lang" || name === "dir" || name === "style") {
		ledger.rootWrites += 1;
	}
	nativeSetAttribute.call(documentRoot, name, value);
};

function Consumer() {
	const { availablePacks, locale, selectPack, subscribe, t } = useI18n();
	useEffect(
		() =>
			subscribe(() => {
				ledger.publications += 1;
			}),
		[subscribe]
	);
	return (
		<div>
			<input aria-label="Unsent publication draft" defaultValue="" />
			<button data-publication-raw="" data-ryu-i18n="on" type="button">
				Install
			</button>
			<button onClick={() => selectPack(french.id)} type="button">
				Choose French
			</button>
			<output data-publication-consumer="">
				{locale}:{t("common.install")}
			</output>
			<output data-publication-catalog="">
				{availablePacks
					.filter((pack) => pack.id.startsWith("coverage/"))
					.map((pack) => `${pack.id}=${pack.enabled}`)
					.join(",")}
			</output>
		</div>
	);
}

let root: Root | null = null;
let element: HTMLDivElement | null = null;
const nativeStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage"
)!;
/**
 * Refuse reads of the saved pack id, as a webview whose storage is not yet
 * available does, while the durable value stays in place, until `recover`.
 * Language-key writes are recorded for the whole case, so it can prove that
 * adopting the saved id only read storage.
 */
function refuseSavedPackReads() {
	const durable = localStorage;
	const writes: string[] = [];
	let refusing = true;
	const languageKeys = new Set([LANGUAGE_MODE_KEY, LANGUAGE_PACK_STORAGE_KEY]);
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: new Proxy(durable, {
			get(target, property) {
				if (property === "getItem") {
					return (key: string) => {
						if (refusing && key === LANGUAGE_PACK_STORAGE_KEY) {
							throw new DOMException("denied", "SecurityError");
						}
						return target.getItem(key);
					};
				}
				if (property === "setItem" || property === "removeItem") {
					return (key: string, value?: string) => {
						if (languageKeys.has(key)) {
							writes.push(`${property} ${key}`);
						}
						return property === "setItem"
							? target.setItem(key, value ?? "")
							: target.removeItem(key);
					};
				}
				if (property === "clear") {
					return () => {
						writes.push("clear");
						target.clear();
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	});
	return {
		recover: () => {
			refusing = false;
		},
		writes,
	};
}

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
/** Let every effect, emit, queued scan and mutation record of a commit drain. */
async function drain() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
}
function consumer() {
	return element!.querySelector<HTMLOutputElement>(
		"[data-publication-consumer]"
	)!.textContent;
}
function projectedCatalog() {
	return element!.querySelector<HTMLOutputElement>(
		"[data-publication-catalog]"
	)!.textContent;
}
function rawControl() {
	return element!.querySelector<HTMLButtonElement>("[data-publication-raw]")!;
}
/** Wait until the Bridge has committed the catalog Core returned for read `reads`. */
async function waitForAppliedRead(reads: number) {
	await settle(
		() =>
			catalogReads === reads && ledger.bridgeCommits > ledger.commitsAtLastRead
	);
	await drain();
}
async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	const before = catalogReads;
	await act(async () =>
		root!.render(
			<Profiler
				id="language-bridge"
				onRender={() => {
					ledger.bridgeCommits += 1;
				}}
			>
				<LanguagePackBridge>
					<Consumer />
				</LanguagePackBridge>
			</Profiler>
		)
	);
	await waitForAppliedRead(before + 1);
}
/** Ask the mounted Bridge to reread Core, and wait until it applied that read. */
async function refresh() {
	const before = catalogReads;
	await act(async () =>
		window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await waitForAppliedRead(before + 1);
}
function costSince(start: typeof ledger) {
	return {
		documentScans: ledger.documentScans - start.documentScans,
		publications: ledger.publications - start.publications,
		rootWrites: ledger.rootWrites - start.rootWrites,
	};
}

afterEach(async () => {
	Object.defineProperty(globalThis, "localStorage", nativeStorage);
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
	localStorage.clear();
	setLanguageMode("auto");
	catalog = [];
});
afterAll(async () => {
	Reflect.deleteProperty(documentRoot, "setAttribute");
	Reflect.deleteProperty(document, "createTreeWalker");
	await server.stop(true);
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

test("an unchanged empty Core catalog publishes nothing on mount or on refresh; only a real arrival and its removal publish", async () => {
	catalog = [];
	localStorage.setItem("publication-unrelated", "retained");
	const start = { ...ledger };
	await mount();
	expect(consumer()).toBe("en-US:Install");
	expect(projectedCatalog()).toBe("");
	// The runtime was built with this catalog; the Bridge's reset to an empty
	// list and Core's empty answer are the same content, so nothing republishes
	// and the localizer walks the document exactly once, when it mounts.
	expect(costSince(start)).toEqual({
		documentScans: 1,
		publications: 0,
		rootWrites: 3,
	});
	const mounted = { ...ledger };
	await refresh();
	await refresh();
	expect(costSince(mounted)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(consumer()).toBe("en-US:Install");
	// A real catalog arrival still publishes exactly once and rescans once.
	catalog = [spanish];
	const beforeArrival = { ...ledger };
	await refresh();
	expect(projectedCatalog()).toBe(`${spanish.id}=true`);
	expect(costSince(beforeArrival)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});
	// Its removal is a real change too ([spanish] -> []), and publishes once.
	catalog = [];
	const beforeRemoval = { ...ledger };
	await refresh();
	expect(projectedCatalog()).toBe("");
	expect(costSince(beforeRemoval)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});
	// The removed catalog repeated ([] -> []) is silent again.
	const removed = { ...ledger };
	await refresh();
	expect(costSince(removed)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(localStorage.getItem("publication-unrelated")).toBe("retained");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	expect(
		admissions.every(
			(entry) =>
				entry ===
				"GET /api/language-packs/installed Bearer language-publication-token"
		)
	).toBe(true);
});

test("a fixed selection republishes each real replacement, reorder, enable change, locale choice and removal once, while identical refreshes leave the draft, focus and raw DOM untouched", async () => {
	catalog = [spanish, french];
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, spanish.id);
	localStorage.setItem("publication-unrelated", "retained");
	setLanguageMode("fixed");
	await mount();
	const control = rawControl();
	await settle(() => control.textContent === "Instalar sin repetir");
	expect(consumer()).toBe("es:Instalar sin repetir");
	const draft = element!.querySelector<HTMLInputElement>(
		'input[aria-label="Unsent publication draft"]'
	)!;
	draft.value = "unsent words";
	draft.focus();

	// Two content-identical refreshes: fresh arrays and objects, same catalog.
	const loaded = { ...ledger };
	await refresh();
	await refresh();
	expect(costSince(loaded)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(consumer()).toBe("es:Instalar sin repetir");
	expect(rawControl() === control).toBe(true);
	expect(control.textContent).toBe("Instalar sin repetir");
	expect(draft.value).toBe("unsent words");
	expect(document.activeElement === draft).toBe(true);

	// Same id and version, different messages: a real replacement.
	catalog = [
		{ ...spanish, messages: { "common.install": "Instalar reemplazado" } },
		french,
	];
	const beforeReplacement = { ...ledger };
	await refresh();
	await settle(() => control.textContent === "Instalar reemplazado");
	expect(consumer()).toBe("es:Instalar reemplazado");
	expect(costSince(beforeReplacement)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});
	const replaced = { ...ledger };
	await refresh();
	expect(costSince(replaced)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});

	// Order decides which pack serves a locale, so a reordered catalog is new
	// content even though every pack is unchanged; restoring the order is too.
	const replacedSpanish = catalog[0]!;
	catalog = [french, replacedSpanish];
	const beforeReorder = { ...ledger };
	await refresh();
	expect(projectedCatalog()).toBe(`${french.id}=true,${spanish.id}=true`);
	catalog = [replacedSpanish, french];
	await refresh();
	expect(projectedCatalog()).toBe(`${spanish.id}=true,${french.id}=true`);
	expect(costSince(beforeReorder).publications).toBe(2);
	expect(consumer()).toBe("es:Instalar reemplazado");

	// Core disables, then re-enables, the selected pack.
	catalog = [{ ...catalog[0]!, enabled: false }, french];
	const beforeDisable = { ...ledger };
	await refresh();
	expect(consumer()).toBe("en:Install");
	expect(document.documentElement.lang).toBe("en");
	expect(costSince(beforeDisable).publications).toBe(1);
	catalog = [{ ...catalog[0]!, enabled: true }, french];
	const beforeEnable = { ...ledger };
	await refresh();
	expect(consumer()).toBe("es:Instalar reemplazado");
	expect(costSince(beforeEnable).publications).toBe(1);

	// A locale choice is not a catalog change and still publishes once.
	const beforeChoice = { ...ledger };
	const choose = Array.from(element!.querySelectorAll("button")).find(
		(button) => button.textContent === "Choose French"
	)!;
	await act(async () => choose.click());
	await drain();
	expect(consumer()).toBe("fr:Installer sans répéter");
	expect(control.textContent).toBe("Installer sans répéter");
	expect(document.documentElement.lang).toBe("fr");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(french.id);
	expect(costSince(beforeChoice)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});

	// Removing the selected pack falls back to English with one publication.
	catalog = [catalog[0]!];
	const beforeRemoval = { ...ledger };
	await refresh();
	expect(consumer()).toBe("en:Install");
	expect(control.textContent).toBe("Install");
	expect(costSince(beforeRemoval).publications).toBe(1);

	expect(draft.value).toBe("unsent words");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem("publication-unrelated")).toBe("retained");
});

test("a runtime rebuilt before it ever published still retranslates the raw DOM and publishes the replacement once", async () => {
	catalog = [];
	setLanguageMode("fixed");
	localStorage.setItem("publication-unrelated", "retained");
	const start = { ...ledger };
	await mount();
	const control = rawControl();
	expect(consumer()).toBe("en:Install");
	expect(control.textContent).toBe("Install");
	// Nothing has published, so this runtime's version is still its first.
	expect(costSince(start).publications).toBe(0);
	const arabic = BUILT_IN_LANGUAGE_PACKS.find(
		(pack) => pack.id === "official/ar"
	)!;
	const beforeRebuild = { ...ledger };
	const readsBeforeRebuild = catalogReads;
	// Another window saves the bundled Arabic pack; the Bridge rebuilds its
	// runtime, whose version count starts again at the same number.
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, arabic.id);
	await act(async () =>
		window.dispatchEvent(
			new StorageEvent("storage", {
				key: LANGUAGE_PACK_STORAGE_KEY,
				storageArea: localStorage,
			})
		)
	);
	await drain();
	expect(consumer()).toBe(`ar:${arabic.messages["common.install"]}`);
	await settle(() => control.textContent === arabic.messages["common.install"]);
	expect(rawControl() === control).toBe(true);
	expect(document.documentElement.lang).toBe("ar");
	expect(document.documentElement.dir).toBe("rtl");
	expect(costSince(beforeRebuild)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});
	// Rebuilding the runtime is a projection: no catalog read, no local write.
	expect(catalogReads).toBe(readsBeforeRebuild);
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(arabic.id);
	expect(localStorage.getItem("publication-unrelated")).toBe("retained");
});

test("the shared provider republishes a pack its host edited in place and handed over in a new array, once", async () => {
	const edited: LanguagePack = {
		...spanish,
		messages: { ...spanish.messages },
	};
	const host: { publish: ((packs: LanguagePack[]) => void) | null } = {
		publish: null,
	};
	function EditingHost() {
		const [packs, setPacks] = useState<LanguagePack[]>([edited]);
		host.publish = setPacks;
		return (
			<I18nProvider
				initialPackId={edited.id}
				packs={packs}
				persistPackId={() => undefined}
			>
				<Consumer />
			</I18nProvider>
		);
	}
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	const start = { ...ledger };
	await act(async () => root!.render(<EditingHost />));
	await drain();
	expect(consumer()).toBe("es:Instalar sin repetir");
	expect(costSince(start).publications).toBe(0);
	// The host edits the very object it handed over, then hands over a new array.
	edited.messages["common.install"] = "Instalar editado";
	const beforeEdit = { ...ledger };
	await act(async () => host.publish!([edited]));
	await drain();
	expect(consumer()).toBe("es:Instalar editado");
	expect(rawControl().textContent).toBe("Instalar editado");
	expect(costSince(beforeEdit)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});
	// Handing over that same edited content again changes nothing.
	const editedOnce = { ...ledger };
	await act(async () => host.publish!([edited]));
	await drain();
	expect(costSince(editedOnce)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
});

test("the shared provider republishes a pack its host edited in place and re-rendered with the same array, once", async () => {
	const edited: LanguagePack = {
		...spanish,
		messages: { ...spanish.messages },
	};
	const packs: LanguagePack[] = [edited];
	const host: { rerender: (() => void) | null } = { rerender: null };
	function EditingHost() {
		const [, setTick] = useState(0);
		host.rerender = () => setTick((tick) => tick + 1);
		return (
			<I18nProvider
				initialPackId={edited.id}
				packs={packs}
				persistPackId={() => undefined}
			>
				<Consumer />
			</I18nProvider>
		);
	}
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () => root!.render(<EditingHost />));
	await drain();
	expect(consumer()).toBe("es:Instalar sin repetir");
	// The host edits the object inside the array it already handed over and
	// re-renders without a new array: identity alone would miss the edit.
	edited.messages["common.install"] = "Instalar editado en sitio";
	const beforeEdit = { ...ledger };
	await act(async () => host.rerender!());
	await drain();
	expect(consumer()).toBe("es:Instalar editado en sitio");
	expect(costSince(beforeEdit)).toMatchObject({ publications: 1 });
	// Re-rendering again with nothing changed publishes nothing.
	const unchanged = { ...ledger };
	await act(async () => host.rerender!());
	await drain();
	expect(costSince(unchanged)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
});

test("while no pack is selected, an identical Core refresh still adopts a pack id saved since the runtime was built, once; refreshes without a new saved id stay silent", async () => {
	catalog = [spanish];
	setLanguageMode("fixed");
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, spanish.id);
	localStorage.setItem("publication-unrelated", "retained");
	const storage = refuseSavedPackReads();
	await mount();
	const control = rawControl();
	// The saved Spanish choice could not be read, so the runtime has no pack.
	expect(projectedCatalog()).toBe(`${spanish.id}=true`);
	expect(consumer()).toBe("en:Install");
	expect(control.textContent).toBe("Install");

	// Identical refreshes while the saved id is still unreadable change nothing.
	const refused = { ...ledger };
	await refresh();
	expect(costSince(refused)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(consumer()).toBe("en:Install");

	// Storage recovers without a storage event (none fires in the same window).
	// Core's next answer is content-identical, yet the runtime re-reads the
	// saved id it could not read before and publishes that choice once.
	storage.recover();
	const recovered = { ...ledger };
	await refresh();
	await settle(() => control.textContent === "Instalar sin repetir");
	expect(consumer()).toBe("es:Instalar sin repetir");
	expect(document.documentElement.lang).toBe("es");
	expect(costSince(recovered)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});

	// The adopted choice is now selected, so a further identical refresh is a
	// no-op again.
	const adopted = { ...ledger };
	await refresh();
	expect(costSince(adopted)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(consumer()).toBe("es:Instalar sin repetir");

	// Auto-detect never restores a saved pack id: the rebuilt runtime keeps the
	// detected locale through an identical refresh although Spanish is saved.
	await act(async () => setLanguageMode("auto"));
	await drain();
	expect(consumer()).toBe("en-US:Install");
	const automatic = { ...ledger };
	await refresh();
	expect(costSince(automatic)).toEqual({
		documentScans: 0,
		publications: 0,
		rootWrites: 0,
	});
	expect(consumer()).toBe("en-US:Install");

	// Adoption only read storage. The one language write is the mode switch.
	expect(storage.writes).toEqual([`setItem ${LANGUAGE_MODE_KEY}`]);
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(spanish.id);
	expect(localStorage.getItem("publication-unrelated")).toBe("retained");
});
