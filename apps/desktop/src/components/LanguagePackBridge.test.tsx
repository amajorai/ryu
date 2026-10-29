import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { LANGUAGE_PACKS_CHANGED_EVENT, type LanguagePack } from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (globalThis.document === undefined) {
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
const pack: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/custom",
	name: "Custom",
	version: "1.0.0",
	locale: "es",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Instalar personalizado" },
};
let packs: LanguagePack[] = [];
let requests = 0;
let failure = false;
let holdNext = false;
let releaseHeld: (() => void) | null = null;
let authorization: string | null = null;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		requests += 1;
		authorization = request.headers.get("authorization");
		if (new URL(request.url).pathname !== "/api/language-packs/installed") {
			return new NativeResponse("wrong route", { status: 404 });
		}
		if (holdNext) {
			holdNext = false;
			const snapshot = packs.map((candidate) => ({ ...candidate }));
			return new Promise<Response>((resolve) => {
				releaseHeld = () => resolve(NativeResponse.json({ packs: snapshot }));
			});
		}
		return NativeResponse.json(failure ? { error: "unavailable" } : { packs }, {
			status: failure ? 503 : 200,
		});
	},
});
// A key-null storage event (another window clearing local settings) resets
// the node registry, so every case re-seeds the fixture node it reads from.
function seedFixtureNode() {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "fixture",
		nodes: [
			{ name: "fixture", url: server.url.origin, token: "fixture-node-token" },
		],
	});
}
seedFixtureNode();
beforeEach(seedFixtureNode);
let root: Root | null = null;
let element: HTMLDivElement | null = null;
function Consumer() {
	const { availablePacks, locale, t } = useI18n();
	return (
		<div>
			<input aria-label="Unsent draft" defaultValue="original" />
			<button data-language-raw-proof="" data-ryu-i18n="on">
				Install
			</button>
			<output>
				{locale}:{t("common.install")}
			</output>
			<span>
				{String(
					availablePacks.find((candidate) => candidate.id === pack.id)?.enabled
				)}
			</span>
		</div>
	);
}
async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: settle runs only inside this file's real bun:test cases and fails the awaiting case on timeout.
	expect(predicate()).toBe(true);
}
async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<LanguagePackBridge>
				<Consumer />
			</LanguagePackBridge>
		)
	);
	await settle(
		() => element!.querySelector("span")?.textContent !== "undefined"
	);
}
afterEach(async () => {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
	localStorage.clear();
	setLanguageMode("auto");
	failure = false;
});
afterAll(async () => {
	await server.stop(true);
});
test("bridge projects external mode changes into translated mounted content", async () => {
	packs = [{ ...pack, enabled: true }];
	localStorage.setItem("ryu:language-pack", pack.id);
	setLanguageMode("fixed");
	await mount();
	expect(element!.querySelector("output")!.textContent).toBe(
		"es:Instalar personalizado"
	);
	expect(authorization).toBe("Bearer fixture-node-token");
	localStorage.setItem(LANGUAGE_MODE_KEY, "auto");
	await act(async () =>
		window.dispatchEvent(
			new window.StorageEvent("storage", {
				key: LANGUAGE_MODE_KEY,
				storageArea: localStorage,
			})
		)
	);
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
});
test("catalog change events cannot enable a disabled pack without acknowledged Core state", async () => {
	packs = [{ ...pack, enabled: false }];
	localStorage.setItem("ryu:language-pack", pack.id);
	setLanguageMode("fixed");
	await mount();
	expect(element!.querySelector("span")!.textContent).toBe("false");
	const before = requests;
	await act(async () =>
		window.dispatchEvent(
			new window.CustomEvent(LANGUAGE_PACKS_CHANGED_EVENT, {
				detail: { ...pack, enabled: true },
			})
		)
	);
	await settle(() => requests > before);
	expect(element!.querySelector("span")!.textContent).toBe("false");
	expect(element!.querySelector("output")!.textContent).toBe("en:Install");
	packs = [{ ...pack, enabled: true }];
	await act(async () =>
		window.dispatchEvent(new window.Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await settle(
		() =>
			element!.querySelector("output")!.textContent ===
			"es:Instalar personalizado"
	);
});

test("failed catalog reads preserve English and recover only after a successful fresh read; unmount removes refresh subscription", async () => {
	packs = [{ ...pack, enabled: true }];
	failure = true;
	setLanguageMode("fixed");
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	const before = requests;
	await act(async () =>
		root!.render(
			<LanguagePackBridge>
				<Consumer />
			</LanguagePackBridge>
		)
	);
	await settle(() => requests > before);
	expect(element.querySelector("output")!.textContent).toBe("en:Install");
	localStorage.setItem("ryu:language-pack", pack.id);
	failure = false;
	await act(async () =>
		window.dispatchEvent(new window.Event(LANGUAGE_PACKS_CHANGED_EVENT))
	);
	await settle(
		() =>
			element!.querySelector("output")!.textContent ===
			"es:Instalar personalizado"
	);
	await act(async () => root!.unmount());
	root = null;
	const settledRequests = requests;
	window.dispatchEvent(new window.Event(LANGUAGE_PACKS_CHANGED_EVENT));
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(requests).toBe(settledRequests);
	expect(element.childNodes).toHaveLength(0);
});

test("fixed selections follow another window's persisted pack and clear without changing unrelated records", async () => {
	packs = [{ ...pack, enabled: true }];
	setLanguageMode("fixed");
	localStorage.setItem("ryu:language-pack", pack.id);
	localStorage.setItem("retained", "unchanged");
	await mount();
	localStorage.setItem("ryu:language-pack", "official/ar");
	await act(async () =>
		window.dispatchEvent(
			new window.StorageEvent("storage", {
				key: "ryu:language-pack",
				storageArea: localStorage,
			})
		)
	);
	expect(document.documentElement.dir).toBe("rtl");
	expect(document.documentElement.lang).toBe("ar");
	expect(localStorage.getItem("retained")).toBe("unchanged");
	localStorage.clear();
	await act(async () =>
		window.dispatchEvent(
			new window.StorageEvent("storage", {
				key: null,
				storageArea: localStorage,
			})
		)
	);
	expect(element!.querySelector("output")!.textContent).toBe("en-US:Install");
	expect(document.documentElement.dir).toBe("ltr");
});

test("external language changes preserve an unsent draft and keyboard focus", async () => {
	packs = [{ ...pack, enabled: true }];
	setLanguageMode("fixed");
	localStorage.setItem("ryu:language-pack", pack.id);
	await mount();
	const draft = element!.querySelector("input")!;
	draft.value = "unsent conversation draft";
	draft.focus();
	localStorage.setItem("ryu:language-pack", "official/ar");
	await act(async () =>
		window.dispatchEvent(
			new window.StorageEvent("storage", {
				key: "ryu:language-pack",
				storageArea: localStorage,
			})
		)
	);
	expect(document.documentElement.lang).toBe("ar");
	expect(element!.querySelector("input") === draft).toBe(true);
	expect(draft.value).toBe("unsent conversation draft");
	expect(document.activeElement === draft).toBe(true);
});

test("a delayed older catalog response cannot overwrite a newer acknowledged refresh", async () => {
	packs = [{ ...pack, enabled: false }];
	holdNext = true;
	localStorage.setItem("ryu:language-pack", pack.id);
	setLanguageMode("fixed");
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<LanguagePackBridge>
				<Consumer />
			</LanguagePackBridge>
		)
	);
	try {
		await settle(() => releaseHeld !== null);
		packs = [{ ...pack, enabled: true }];
		await act(async () =>
			window.dispatchEvent(new window.Event(LANGUAGE_PACKS_CHANGED_EVENT))
		);
		await settle(
			() =>
				element!.querySelector("output")!.textContent ===
				"es:Instalar personalizado"
		);
		await act(async () => {
			releaseHeld!();
			releaseHeld = null;
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(element!.querySelector("span")!.textContent).toBe("true");
		expect(element!.querySelector("output")!.textContent).toBe(
			"es:Instalar personalizado"
		);
	} finally {
		releaseHeld?.();
		releaseHeld = null;
	}
});

test("switching active nodes aborts pending old-node reads and cannot publish their catalog", async () => {
	const originalState = useNodeStore.getState();
	const fetchBoundary = globalThis.fetch;
	const signals: AbortSignal[] = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			if (init?.signal) {
				signals.push(init.signal);
			}
			return fetchBoundary(input, init);
		},
		fetchBoundary
	);
	const alternateIdentity: { bearer: string | null } = { bearer: null };
	const alternate = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			alternateIdentity.bearer = request.headers.get("authorization");
			return NativeResponse.json({
				packs: [
					{
						...pack,
						locale: "fr",
						enabled: true,
						messages: { "common.install": "Installer sur autre noeud" },
					},
				],
			});
		},
	});
	try {
		packs = [{ ...pack, enabled: true }];
		holdNext = true;
		localStorage.setItem("ryu:language-pack", pack.id);
		setLanguageMode("fixed");
		element = document.createElement("div");
		document.body.append(element);
		root = createRoot(element);
		await act(async () =>
			root!.render(
				<LanguagePackBridge>
					<Consumer />
				</LanguagePackBridge>
			)
		);
		await settle(() => releaseHeld !== null);
		await act(async () =>
			useNodeStore.setState({
				defaultNode: "alternate",
				nodes: [
					{
						name: "alternate",
						url: alternate.url.origin,
						token: "alternate-node-token",
					},
				],
			})
		);
		await settle(
			() =>
				element!.querySelector("output")!.textContent ===
				"fr:Installer sur autre noeud"
		);
		expect(signals[0].aborted).toBe(true);
		expect(alternateIdentity.bearer).toBe("Bearer alternate-node-token");
		await act(async () => {
			releaseHeld!();
			releaseHeld = null;
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(element!.querySelector("output")!.textContent).toBe(
			"fr:Installer sur autre noeud"
		);
	} finally {
		releaseHeld?.();
		releaseHeld = null;
		holdNext = false;
		if (root) {
			await act(async () => root!.unmount());
		}
		root = null;
		globalThis.fetch = fetchBoundary;
		useNodeStore.setState(originalState);
		await alternate.stop(true);
	}
});

test("loaded catalog selection retranslates the same static raw DOM node", async () => {
	packs = [
		{ ...pack, enabled: true },
		{
			...pack,
			id: "coverage/french",
			locale: "fr",
			enabled: true,
			messages: { "common.install": "Installer personnalisé" },
		},
	];
	setLanguageMode("fixed");
	localStorage.setItem("ryu:language-pack", pack.id);
	localStorage.setItem("raw-proof-unrelated", "preserved");
	await mount();
	const control = element!.querySelector<HTMLButtonElement>(
		"[data-language-raw-proof]"
	)!;
	await settle(() => control.textContent === "Instalar personalizado");
	const readsAfterCatalogLoaded = requests;
	localStorage.setItem("ryu:language-pack", "coverage/french");
	await act(async () =>
		window.dispatchEvent(
			new window.StorageEvent("storage", {
				key: "ryu:language-pack",
				storageArea: localStorage,
			})
		)
	);
	await settle(() => control.textContent === "Installer personnalisé");
	expect(element!.querySelector("[data-language-raw-proof]") === control).toBe(
		true
	);
	expect(document.documentElement.lang).toBe("fr");
	expect(requests).toBe(readsAfterCatalogLoaded);
	await act(async () => setLanguageMode("auto"));
	await settle(() => control.textContent === "Install");
	expect(element!.querySelector("[data-language-raw-proof]") === control).toBe(
		true
	);
	expect(localStorage.getItem("raw-proof-unrelated")).toBe("preserved");
	expect(requests).toBe(readsAfterCatalogLoaded);
});

test("unmount aborts a pending real catalog read and retires event subscriptions", async () => {
	const fetchBoundary = globalThis.fetch;
	const signals: AbortSignal[] = [];
	globalThis.fetch = Object.assign(
		(
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1]
		) => {
			if (init?.signal) {
				signals.push(init.signal);
			}
			return fetchBoundary(input, init);
		},
		fetchBoundary
	);
	try {
		packs = [{ ...pack, enabled: true }];
		holdNext = true;
		localStorage.setItem("ryu:language-pack", pack.id);
		localStorage.setItem("unmount-unrelated", "preserved");
		setLanguageMode("fixed");
		element = document.createElement("div");
		document.body.append(element);
		root = createRoot(element);
		await act(async () =>
			root!.render(
				<LanguagePackBridge>
					<Consumer />
				</LanguagePackBridge>
			)
		);
		await settle(() => releaseHeld !== null);
		const readCount = requests;
		expect(signals[0].aborted).toBe(false);
		await act(async () => root!.unmount());
		root = null;
		expect(signals[0].aborted).toBe(true);
		await act(async () => {
			releaseHeld!();
			releaseHeld = null;
			window.dispatchEvent(new window.Event(LANGUAGE_PACKS_CHANGED_EVENT));
			await new Promise((resolve) => setTimeout(resolve, 30));
		});
		expect(requests).toBe(readCount);
		expect(element.childNodes.length).toBe(0);
		expect(localStorage.getItem("ryu:language-pack")).toBe(pack.id);
		expect(localStorage.getItem("unmount-unrelated")).toBe("preserved");
	} finally {
		releaseHeld?.();
		releaseHeld = null;
		globalThis.fetch = fetchBoundary;
	}
});
