import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { LANGUAGE_PACK_STORAGE_KEY, type LanguagePack } from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Keep Bun's network stack across DOM registration: the Bridge and the sync
// talk to this file's node over real loopback HTTP.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const ownsDomRegistration = globalThis.document === undefined;
if (ownsDomRegistration) {
	GlobalRegistrator.register();
}
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
globalThis.fetch = nativeFetch;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { useNodeStore } = await import("@/src/store/useNodeStore.ts");
const { LANGUAGE_MODE_KEY, setLanguageMode, useLanguageMode } = await import(
	"@/src/hooks/useLanguageMode.ts"
);
const { resetUiLanguagePreferenceSync } = await import(
	"@/src/lib/ui-language-preference.ts"
);
const { LanguagePackBridge } = await import("./LanguagePackBridge.tsx");
const { UiLanguagePreferenceSync } = await import(
	"./UiLanguagePreferenceSync.tsx"
);

const french: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/adopt-french",
	name: "Adopt French",
	version: "1.0.0",
	locale: "fr",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installer" },
	enabled: true,
};
const arabic: LanguagePack = {
	...french,
	id: "coverage/adopt-arabic",
	name: "Adopt Arabic",
	locale: "ar",
	direction: "rtl",
	messages: { "common.install": "تثبيت" },
};

let stored: string | null = null;
const writes: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const route = new URL(request.url).pathname;
		if (route === "/api/language-packs/installed") {
			return NativeResponse.json({ packs: [french, arabic] });
		}
		if (route !== "/api/preferences/ui-language") {
			return new NativeResponse("undeclared route", { status: 404 });
		}
		if (request.method === "PUT") {
			const body = (await request.json()) as { value: string };
			stored = body.value;
			writes.push(body.value);
			return NativeResponse.json({ ok: true });
		}
		return NativeResponse.json({ key: "ui-language", value: stored });
	},
});

/** The Island main process saving a picker choice (`selectLanguagePack`). */
function islandPicks(packId: string | null) {
	stored = JSON.stringify({ mode: "fixed", packId });
}

let mounts = 0;
let desktopSelectPack: ((id: string | null) => void) | null = null;
function Consumer() {
	const { direction, locale, selectedPackId, selectPack, t } = useI18n();
	desktopSelectPack = selectPack;
	const [mode] = useLanguageMode();
	return (
		<output
			data-direction={direction}
			data-mode={mode}
			data-pack={selectedPackId ?? ""}
			ref={(element) => {
				if (element && !element.dataset.mounted) {
					mounts += 1;
					element.dataset.mounted = String(mounts);
				}
			}}
		>
			{locale}:{t("common.install")}
		</output>
	);
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

const element = document.createElement("div");
document.body.append(element);
const root = createRoot(element);
const consumer = () => element.querySelector<HTMLOutputElement>("output")!;

async function mount() {
	await act(async () =>
		root.render(
			<LanguagePackBridge>
				<UiLanguagePreferenceSync />
				<Consumer />
				<input aria-label="draft" />
			</LanguagePackBridge>
		)
	);
}

afterEach(async () => {
	await act(async () => root.render(null));
	localStorage.clear();
	setLanguageMode("auto");
	resetUiLanguagePreferenceSync();
	stored = null;
	writes.length = 0;
	mounts = 0;
});
afterAll(async () => {
	await act(async () => root.unmount());
	await server.stop(true);
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "adopt-fixture",
	nodes: [{ name: "adopt-fixture", url: server.url.origin, token: "adopt" }],
});

test("a language picked in the Island switches Desktop's locale and direction in place, without writing it back", async () => {
	setLanguageMode("auto");
	await mount();
	// Desktop seeds the unset key with its automatic choice.
	await settle(() => writes.length === 1);
	expect(JSON.parse(writes[0] ?? "null")).toMatchObject({ mode: "auto" });
	const output = consumer();
	const draft = element.querySelector<HTMLInputElement>("input")!;
	draft.value = "unsent draft";

	islandPicks(arabic.id);
	await act(async () => window.dispatchEvent(new Event("focus")));
	await settle(() => consumer().dataset.pack === arabic.id);

	expect(consumer().textContent).toBe("ar:تثبيت");
	expect(consumer().dataset.direction).toBe("rtl");
	expect(consumer().dataset.mode).toBe("fixed");
	expect(document.documentElement.dir).toBe("rtl");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(arabic.id);
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	// Same consumer node and the draft survives: nothing remounted.
	expect(consumer()).toBe(output);
	expect(mounts).toBe(1);
	expect(element.querySelector("input")?.value).toBe("unsent draft");
	// The adopted choice is never written back, so the writers cannot ping-pong.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(writes).toHaveLength(1);
});

test("a choice the Island saved while Desktop was closed is adopted at launch, and an Island English choice is adopted too", async () => {
	localStorage.setItem(LANGUAGE_MODE_KEY, "fixed");
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, french.id);
	setLanguageMode("fixed");
	islandPicks(arabic.id);
	await mount();
	await settle(() => consumer().dataset.pack === arabic.id);
	expect(consumer().dataset.direction).toBe("rtl");
	expect(writes).toEqual([]);

	islandPicks(null);
	await act(async () => window.dispatchEvent(new Event("focus")));
	await settle(() => consumer().dataset.pack === "");
	expect(consumer().dataset.direction).toBe("ltr");
	expect(consumer().dataset.mode).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	expect(writes).toEqual([]);
});

test("Desktop's own value in the shared key is never re-applied over a newer Desktop choice", async () => {
	setLanguageMode("auto");
	await mount();
	await settle(() => writes.length === 1);
	// Desktop's own fixed French choice is written once.
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, french.id);
	await act(async () => {
		setLanguageMode("fixed");
	});
	await settle(() => consumer().dataset.pack === french.id);
	await settle(() => writes.length === 2);
	expect(JSON.parse(stored ?? "null")).toEqual({
		mode: "fixed",
		packId: french.id,
	});
	await act(async () => window.dispatchEvent(new Event("focus")));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(consumer().dataset.pack).toBe(french.id);
	expect(writes).toHaveLength(2);
});

test("after adopting an Island choice, a later Desktop choice is written again and the Island can take it back", async () => {
	setLanguageMode("auto");
	await mount();
	await settle(() => writes.length === 1);
	islandPicks(arabic.id);
	await act(async () => window.dispatchEvent(new Event("focus")));
	await settle(() => consumer().dataset.pack === arabic.id);
	expect(writes).toHaveLength(1);

	// Desktop's Settings picks French: the adoption hold is released, so this
	// newer Desktop choice is the last writer.
	await act(async () => {
		setLanguageMode("fixed");
		desktopSelectPack?.(french.id);
	});
	await settle(() => writes.length === 2);
	expect(consumer().textContent).toBe("fr:Installer");
	expect(consumer().dataset.direction).toBe("ltr");
	expect(JSON.parse(stored ?? "null")).toEqual({
		mode: "fixed",
		packId: french.id,
	});

	// The Island picks Arabic again and Desktop follows once more.
	islandPicks(arabic.id);
	await act(async () => window.dispatchEvent(new Event("focus")));
	await settle(() => consumer().dataset.pack === arabic.id);
	expect(document.documentElement.dir).toBe("rtl");
	expect(writes).toHaveLength(2);
});
