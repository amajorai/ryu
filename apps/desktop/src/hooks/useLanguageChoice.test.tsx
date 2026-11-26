import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { LANGUAGE_PACK_STORAGE_KEY, type LanguagePack } from "@ryu/i18n";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Retain Bun's network stack across DOM registration: the installed packs are
// read, and a pack is enabled, over real loopback HTTP, not through a mock.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const ownsDomRegistration = globalThis.document === undefined;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LANGUAGE_MODE_KEY, setLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { LanguagePackBridge } = await import(
	"@/src/components/LanguagePackBridge.tsx"
);
const {
	AUTO_DETECT_VALUE,
	DEFAULT_PACK_VALUE,
	ENGLISH_LANGUAGE,
	readyLanguagePacks,
	systemLanguageName,
	useLanguageChoice,
} = await import("./useLanguageChoice.ts");

const dutch: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/choice-dutch",
	name: "Nederlands",
	version: "1.0.0",
	locale: "nl",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installeren" },
	enabled: true,
};
const swedish: LanguagePack = {
	...dutch,
	id: "coverage/choice-swedish",
	name: "Svenska",
	locale: "sv",
	messages: { "common.install": "Installera" },
	enabled: false,
};
const englishVoice: LanguagePack = {
	...dutch,
	id: "coverage/choice-voice",
	name: "Plain voice",
	locale: "en",
};

let catalog: LanguagePack[] = [dutch, swedish];
const admissions: string[] = [];
const ENABLE_ROUTE = `/api/marketplace/packages/language_pack/${encodeURIComponent(swedish.id)}/enable`;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const route = new URL(request.url).pathname;
		admissions.push(`${request.method} ${route}`);
		if (route === "/api/language-packs/installed" && request.method === "GET") {
			return NativeResponse.json({ packs: catalog });
		}
		if (route === ENABLE_ROUTE && request.method === "POST") {
			catalog = catalog.map((pack) =>
				pack.id === swedish.id ? { ...pack, enabled: true } : pack
			);
			return NativeResponse.json({ ok: true });
		}
		return new NativeResponse("undeclared route", { status: 404 });
	},
});
function seedFixtureNode() {
	useNodeStore.setState({
		autoSelect: false,
		defaultNode: "language-choice-proof",
		nodes: [
			{
				name: "language-choice-proof",
				url: server.url.origin,
				token: "language-choice-token",
			},
		],
	});
}
seedFixtureNode();
beforeEach(seedFixtureNode);

type Choice = ReturnType<typeof useLanguageChoice>;
let choice: Choice | null = null;
function Probe() {
	choice = useLanguageChoice();
	return null;
}
function current(): Choice {
	if (!choice) {
		throw new Error("The probe has not rendered.");
	}
	return choice;
}

let root: Root | null = null;
let element: HTMLDivElement | null = null;
async function wait(milliseconds: number) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, milliseconds));
	});
}
async function settle(predicate: () => boolean, attempts = 150) {
	for (let count = 0; count < attempts && !predicate(); count += 1) {
		await wait(10);
	}
	if (!predicate()) {
		throw new Error(`Condition not reached: ${predicate.toString()}`);
	}
}
async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<LanguagePackBridge>
				<Probe />
			</LanguagePackBridge>
		)
	);
	// The installed packs arrive after the first render.
	await settle(() => current().packs.some((pack) => pack.id === dutch.id));
}

afterEach(async () => {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
	choice = null;
	catalog = [dutch, swedish];
	admissions.length = 0;
	// Reset the session's mode first: the setter itself writes to storage.
	setLanguageMode("auto");
	localStorage.clear();
});
afterAll(async () => {
	await server.stop(true);
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

test("ready packs are the enabled translations, never an English voice", () => {
	expect(
		readyLanguagePacks([dutch, swedish, englishVoice]).map((pack) => pack.id)
	).toEqual([dutch.id]);
	// A pack that does not say it is disabled is ready.
	const unmarked: LanguagePack = { ...dutch };
	Reflect.deleteProperty(unmarked, "enabled");
	expect(readyLanguagePacks([unmarked])).toEqual([unmarked]);
});

test("the system language is the first one Ryu can show, by its own name", () => {
	expect(systemLanguageName(["nl-NL", "en"], [dutch])).toEqual({
		locale: "nl",
		name: "Nederlands",
	});
	// A disabled pack cannot be shown, so the list falls through to English.
	expect(systemLanguageName(["sv-SE", "en-GB"], [swedish])).toEqual(
		ENGLISH_LANGUAGE
	);
	expect(systemLanguageName(["en-US"], [dutch])).toEqual(ENGLISH_LANGUAGE);
	expect(systemLanguageName([], [dutch])).toEqual(ENGLISH_LANGUAGE);
});

test("follows the system by default and lists every pack for Settings", async () => {
	await mount();
	expect(current().value).toBe(AUTO_DETECT_VALUE);
	expect(current().languageMode).toBe("auto");
	expect(current().busyId).toBeNull();
	expect(current().operationError).toBeNull();
	const ids = current().packs.map((pack) => pack.id);
	expect(ids).toContain("official/fr");
	expect(ids).toContain(swedish.id);
	// Settings also lists the built-in English voice; the ready list does not,
	// because a voice is not another language.
	expect(ids).toContain("en-x-ryu-online");
	const ready = current().readyPacks.map((pack) => pack.id);
	expect(ready).toContain("official/fr");
	expect(ready).toContain(dutch.id);
	expect(ready).not.toContain(swedish.id);
	expect(ready.some((id) => id.startsWith("en-x-"))).toBe(false);
});

test("a fixed choice and a return to the system write the shared storage keys", async () => {
	await mount();
	await act(async () => current().select("official/fr"));
	await settle(() => current().value === "official/fr");
	expect(current().languageMode).toBe("fixed");
	expect(current().selectedPack?.name).toBe("Français");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe("official/fr");
	// With a fixed choice, "Auto detect" names the language it would return to.
	expect(current().systemLanguage).toEqual(ENGLISH_LANGUAGE);

	await act(async () => current().select(DEFAULT_PACK_VALUE));
	await settle(() => current().value === DEFAULT_PACK_VALUE);
	expect(current().selectedPack).toBeNull();
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();

	await act(async () => current().select(AUTO_DETECT_VALUE));
	await settle(() => current().value === AUTO_DETECT_VALUE);
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	// Choosing among languages that are ready never writes to the node.
	expect(admissions.filter((entry) => entry.startsWith("POST"))).toEqual([]);
});

test("a pack the node must enable is enabled there first, then chosen", async () => {
	await mount();
	await act(async () => current().select(swedish.id));
	await settle(() => current().value === swedish.id);
	expect(admissions).toContain(`POST ${ENABLE_ROUTE}`);
	expect(current().busyId).toBeNull();
	expect(current().operationError).toBeNull();
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(swedish.id);
});

test("a failed enable reports the error and leaves the choice alone", async () => {
	catalog = [dutch, { ...swedish, id: "coverage/choice-missing" }];
	await mount();
	await settle(() =>
		current().packs.some((pack) => pack.id === "coverage/choice-missing")
	);
	await act(async () => current().select("coverage/choice-missing"));
	await settle(() => current().operationError !== null);
	expect(current().busyId).toBeNull();
	expect(current().value).toBe(AUTO_DETECT_VALUE);
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
});
