// Fixtures, the publication ledger and cleanup for
// LanguagePackBridge.publication.test.tsx, which imports this module first so
// the DOM, the loopback Core and the catalog loader exist before any test.
import { afterAll, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	LANGUAGE_PACK_STORAGE_KEY,
	LANGUAGE_PACKS_CHANGED_EVENT,
	type LanguagePack,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act, Profiler, useEffect } from "react";
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

export { LANGUAGE_MODE_KEY, setLanguageMode };

// The Bridge opts into the official literal catalogs, which arrive as lazy
// chunks; each arrival republishes the runtime showing that locale
// (runtime-literals.ts). Serve the locales these tests show synchronously, so
// every count below is the Bridge's own publication, not a chunk's timing.
const { loadOfficialLiteralCatalog } = await import(
	"@ryu/i18n/official-catalog"
);
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/lite");
const preloadedCatalogs = new Map(
	await Promise.all(
		["ar", "es", "fr"].map(
			async (locale) =>
				[locale, await loadOfficialLiteralCatalog(locale)] as const
		)
	)
);
registerLiteralCatalogLoader((locale) =>
	preloadedCatalogs.has(locale)
		? (preloadedCatalogs.get(locale) ?? null)
		: loadOfficialLiteralCatalog(locale)
);

export const spanish: LanguagePack = {
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
export const french: LanguagePack = {
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
export const ledger = {
	bridgeCommits: 0,
	commitsAtLastRead: 0,
	documentScans: 0,
	publications: 0,
	rootWrites: 0,
};
/** Fixture state the tests read and replace. */
export const live: {
	catalog: LanguagePack[];
	catalogReads: number;
	element: HTMLDivElement | null;
	root: Root | null;
} = { catalog: [], catalogReads: 0, element: null, root: null };
export const admissions: string[] = [];
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
		live.catalogReads += 1;
		ledger.commitsAtLastRead = ledger.bridgeCommits;
		// JSON serialization hands the client fresh, content-identical objects.
		return NativeResponse.json({ packs: live.catalog });
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

export function Consumer() {
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
			<button
				data-publication-choose=""
				onClick={() => selectPack(french.id)}
				type="button"
			>
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
export function refuseSavedPackReads() {
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

export async function settle(predicate: () => boolean) {
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
export async function drain() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
}
export function consumer() {
	return live.element!.querySelector<HTMLOutputElement>(
		"[data-publication-consumer]"
	)!.textContent;
}
export function projectedCatalog() {
	return live.element!.querySelector<HTMLOutputElement>(
		"[data-publication-catalog]"
	)!.textContent;
}
export function rawControl() {
	return live.element!.querySelector<HTMLButtonElement>(
		"[data-publication-raw]"
	)!;
}
/** Wait until the Bridge has committed the catalog Core returned for read `reads`. */
async function waitForAppliedRead(reads: number) {
	await settle(
		() =>
			live.catalogReads === reads &&
			ledger.bridgeCommits > ledger.commitsAtLastRead
	);
	await drain();
}
export async function mount() {
	live.element = document.createElement("div");
	document.body.append(live.element);
	live.root = createRoot(live.element);
	const before = live.catalogReads;
	await act(async () =>
		live.root!.render(
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
export async function refresh() {
	const before = live.catalogReads;
	await act(async () =>
		window.dispatchEvent(new Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await waitForAppliedRead(before + 1);
}
export function costSince(start: typeof ledger) {
	return {
		documentScans: ledger.documentScans - start.documentScans,
		publications: ledger.publications - start.publications,
		rootWrites: ledger.rootWrites - start.rootWrites,
	};
}

/** The cleanup every publication suite registers at its top level. */
export function registerPublicationHooks() {
	afterEach(async () => {
		Object.defineProperty(globalThis, "localStorage", nativeStorage);
		if (live.root) {
			await act(async () => live.root!.unmount());
		}
		live.root = null;
		live.element?.remove();
		live.element = null;
		localStorage.clear();
		setLanguageMode("auto");
		live.catalog = [];
	});
	afterAll(async () => {
		Reflect.deleteProperty(documentRoot, "setAttribute");
		Reflect.deleteProperty(document, "createTreeWalker");
		await server.stop(true);
		if (ownsDomRegistration) {
			await GlobalRegistrator.unregister();
		}
	});
}
