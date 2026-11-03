import { expect, test } from "bun:test";
import {
	BUILT_IN_LANGUAGE_PACKS,
	LANGUAGE_PACK_STORAGE_KEY,
	type LanguagePack,
} from "@ryu/i18n";
import { I18nProvider } from "@ryu/i18n/react";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	admissions,
	Consumer,
	consumer,
	costSince,
	drain,
	french,
	LANGUAGE_MODE_KEY,
	ledger,
	live,
	mount,
	projectedCatalog,
	rawControl,
	refresh,
	refuseSavedPackReads,
	registerPublicationHooks,
	setLanguageMode,
	settle,
	spanish,
} from "./LanguagePackBridge.publication.test-support.tsx";

registerPublicationHooks();
test("an unchanged empty Core live.catalog publishes nothing on mount or on refresh; only a real arrival and its removal publish", async () => {
	live.catalog = [];
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
	live.catalog = [spanish];
	const beforeArrival = { ...ledger };
	await refresh();
	expect(projectedCatalog()).toBe(`${spanish.id}=true`);
	expect(costSince(beforeArrival)).toMatchObject({
		documentScans: 1,
		publications: 1,
	});
	// Its removal is a real change too ([spanish] -> []), and publishes once.
	live.catalog = [];
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
	live.catalog = [spanish, french];
	localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, spanish.id);
	localStorage.setItem("publication-unrelated", "retained");
	setLanguageMode("fixed");
	await mount();
	const control = rawControl();
	await settle(() => control.textContent === "Instalar sin repetir");
	expect(consumer()).toBe("es:Instalar sin repetir");
	const draft = live.element!.querySelector<HTMLInputElement>(
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
	live.catalog = [
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
	const replacedSpanish = live.catalog[0]!;
	live.catalog = [french, replacedSpanish];
	const beforeReorder = { ...ledger };
	await refresh();
	expect(projectedCatalog()).toBe(`${french.id}=true,${spanish.id}=true`);
	live.catalog = [replacedSpanish, french];
	await refresh();
	expect(projectedCatalog()).toBe(`${spanish.id}=true,${french.id}=true`);
	expect(costSince(beforeReorder).publications).toBe(2);
	expect(consumer()).toBe("es:Instalar reemplazado");

	// Core disables, then re-enables, the selected pack.
	live.catalog = [{ ...live.catalog[0]!, enabled: false }, french];
	const beforeDisable = { ...ledger };
	await refresh();
	expect(consumer()).toBe("en:Install");
	expect(document.documentElement.lang).toBe("en");
	expect(costSince(beforeDisable).publications).toBe(1);
	live.catalog = [{ ...live.catalog[0]!, enabled: true }, french];
	const beforeEnable = { ...ledger };
	await refresh();
	expect(consumer()).toBe("es:Instalar reemplazado");
	expect(costSince(beforeEnable).publications).toBe(1);

	// A locale choice is not a catalog change and still publishes once.
	const beforeChoice = { ...ledger };
	// Found by its data hook: the localizer translates "Choose" under Spanish.
	const choose = live.element!.querySelector<HTMLButtonElement>(
		"[data-publication-choose]"
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
	live.catalog = [live.catalog[0]!];
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
	live.catalog = [];
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
	const readsBeforeRebuild = live.catalogReads;
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
	expect(live.catalogReads).toBe(readsBeforeRebuild);
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
	live.element = document.createElement("div");
	document.body.append(live.element);
	live.root = createRoot(live.element);
	const start = { ...ledger };
	await act(async () => live.root!.render(<EditingHost />));
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
	live.element = document.createElement("div");
	document.body.append(live.element);
	live.root = createRoot(live.element);
	await act(async () => live.root!.render(<EditingHost />));
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
	live.catalog = [spanish];
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
