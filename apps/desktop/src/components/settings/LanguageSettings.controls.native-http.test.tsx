import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	BUILT_IN_LANGUAGE_PACKS,
	LANGUAGE_PACK_STORAGE_KEY,
	type LanguagePack,
	languagePackArchive,
} from "@ryu/i18n";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

// Retain Bun's network stack across DOM registration: Settings and the Bridge
// talk to this fixture node through the production SDK over loopback HTTP.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeFile = globalThis.File;
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
const { LanguagePackBridge } = await import("../LanguagePackBridge.tsx");
const { LanguageSettings } = await import("./LanguageSettings.tsx");

const french: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/controls-french",
	name: "Controls French",
	version: "1.2.0",
	locale: "fr",
	baseLocale: "en",
	direction: "ltr",
	messages: { "common.install": "Installer contrôlé" },
	enabled: true,
};
const hebrew: LanguagePack = {
	...french,
	id: "coverage/controls-hebrew",
	name: "Controls Hebrew",
	version: "2.0.0",
	locale: "he",
	direction: "rtl",
	messages: {
		"common.install": "התקנה מבוקרת",
		"common.marketplace": "חנות",
	},
	enabled: false,
};
const initialCatalog = () => [{ ...french }, { ...hebrew }];
let catalog = initialCatalog();
const writes: string[] = [];
const admissions: string[] = [];
let holdEnable = false;
let releaseEnable: (() => void) | null = null;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const route = new URL(request.url).pathname;
		admissions.push(
			`${request.method} ${route} ${request.headers.get("authorization")}`
		);
		if (route === "/api/language-packs/installed" && request.method === "GET") {
			return NativeResponse.json({ packs: catalog });
		}
		const enable =
			/^\/api\/marketplace\/packages\/language_pack\/(.+)\/enable$/u.exec(
				route
			);
		if (enable && request.method === "POST") {
			const id = decodeURIComponent(enable[1]!);
			writes.push(`enable ${id}`);
			const acknowledge = () => {
				catalog = catalog.map((pack) =>
					pack.id === id ? { ...pack, enabled: true } : pack
				);
				return NativeResponse.json({ ok: true });
			};
			if (holdEnable) {
				holdEnable = false;
				return new Promise<Response>((resolve) => {
					releaseEnable = () => resolve(acknowledge());
				});
			}
			return acknowledge();
		}
		if (route === "/api/language-packs/import" && request.method === "POST") {
			// Core refuses this malformed archive; record the exact bytes it got.
			const body = (await request.json()) as { archive_base64: string };
			const bytes = Array.from(atob(body.archive_base64), (value) =>
				value.charCodeAt(0)
			);
			writes.push(`import ${bytes.join(",")}`);
			return NativeResponse.json(
				{ error: "archive rejected" },
				{ status: 422 }
			);
		}
		writes.push(`undeclared ${request.method} ${route}`);
		return new NativeResponse("undeclared route", { status: 404 });
	},
});
useNodeStore.setState({
	autoSelect: false,
	defaultNode: "language-controls-proof",
	nodes: [
		{
			name: "language-controls-proof",
			url: server.url.origin,
			token: "language-controls-token",
		},
	],
});

function Consumer() {
	const { locale, t } = useI18n();
	const location = useLocation();
	return (
		<>
			<output data-controls-consumer="">
				{locale}:{t("common.install")}
			</output>
			<output data-controls-location="">{location.pathname}</output>
		</>
	);
}

let root: Root | null = null;
let element: HTMLDivElement | null = null;

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
	return element!.querySelector("[data-controls-consumer]")!.textContent;
}
function location() {
	return element!.querySelector("[data-controls-location]")!.textContent;
}
function trigger() {
	return element!.querySelector<HTMLButtonElement>('[role="combobox"]')!;
}
function shownChoice() {
	return trigger().querySelector('[data-slot="select-value"]')!.textContent;
}
function button(name: string) {
	const match = Array.from(element!.querySelectorAll("button")).find(
		(candidate) =>
			(candidate.getAttribute("aria-label") ?? candidate.textContent) === name
	);
	if (!match) {
		throw new Error(`No button named ${name}`);
	}
	return match;
}
function fileInput() {
	return element!.querySelector<HTMLInputElement>('input[type="file"]')!;
}
/** The status and Export control of one pack's row in "Available language packs". */
function packRow(name: string) {
	return button(`Export ${name}`).parentElement!.textContent;
}
function optionNames() {
	return Array.from(document.querySelectorAll('[role="option"]')).map(
		(option) => option.textContent
	);
}
async function openPicker() {
	await act(async () => trigger().click());
	await settle(() => optionNames().length > 0);
}
async function choose(name: string) {
	await openPicker();
	const option = Array.from(
		document.querySelectorAll<HTMLElement>('[role="option"]')
	).find((candidate) => candidate.textContent === name)!;
	await act(async () => option.click());
}
async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<MemoryRouter initialEntries={["/settings/language"]}>
				<LanguagePackBridge>
					<LanguageSettings />
					<Consumer />
				</LanguagePackBridge>
			</MemoryRouter>
		)
	);
	await settle(() => element!.textContent!.includes(hebrew.name));
}
async function unmount() {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
}

afterEach(async () => {
	releaseEnable?.();
	releaseEnable = null;
	holdEnable = false;
	await unmount();
	localStorage.clear();
	setLanguageMode("auto");
	catalog = initialCatalog();
	writes.length = 0;
});
afterAll(async () => {
	await server.stop(true);
	if (ownsDomRegistration) {
		await GlobalRegistrator.unregister();
	}
});

test("the language picker lists Auto detect, English and every installed pack; each pick is saved, projected and marked Active, and survives a remount", async () => {
	setLanguageMode("auto");
	localStorage.setItem("controls-unrelated", "retained");
	await mount();
	expect(shownChoice()).toBe("Auto detect");
	await openPicker();
	expect(optionNames()).toEqual([
		"Auto detect",
		"English",
		...BUILT_IN_LANGUAGE_PACKS.map((pack) => pack.name),
		french.name,
		hebrew.name,
	]);
	// A Core-disabled pack is offered (picking it asks Core to enable it) and
	// its row says so; the enabled one says nothing until it is chosen.
	expect(packRow(hebrew.name)).toContain(
		"This pack is installed but disabled."
	);
	expect(packRow(french.name)).not.toContain("Active");
	expect(element!.textContent).toContain("fr · Left to right · Version 1.2.0");
	expect(element!.textContent).toContain("he · Right to left · Version 2.0.0");
	await act(async () =>
		document
			.querySelector<HTMLElement>('[role="option"]')!
			.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			)
	);

	await choose(french.name);
	await settle(() => consumer() === "fr:Installer contrôlé");
	expect(shownChoice()).toBe(french.name);
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(french.id);
	expect(packRow(french.name)).toContain("Active");
	expect(element!.textContent).toContain("1 translated string · Left to right");

	await choose("English");
	await settle(() => consumer() === "en:Install");
	expect(shownChoice()).toBe("English");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();
	expect(packRow(french.name)).not.toContain("Active");
	expect(element!.textContent).not.toContain("translated string");

	await choose("Auto detect");
	await settle(() => consumer() === "en-US:Install");
	expect(shownChoice()).toBe("Auto detect");
	expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("auto");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();

	// Picking a pack again, then remounting, restores it from storage.
	await choose(french.name);
	await settle(() => consumer() === "fr:Installer contrôlé");
	await unmount();
	await mount();
	await settle(() => consumer() === "fr:Installer contrôlé");
	expect(shownChoice()).toBe(french.name);
	// Choosing among enabled packs never writes to Core.
	expect(writes).toEqual([]);
	expect(localStorage.getItem("controls-unrelated")).toBe("retained");
	expect(
		admissions.every((entry) =>
			entry.endsWith(" Bearer language-controls-token")
		)
	).toBe(true);
});

test("while Core enables a chosen pack, the picker and Import are disabled and cannot start another operation; the acknowledgment re-enables both and selects the pack", async () => {
	setLanguageMode("auto");
	await mount();
	const chooserOpens: string[] = [];
	fileInput().addEventListener("click", () => chooserOpens.push("open"));
	holdEnable = true;
	await choose(hebrew.name);
	await settle(() => releaseEnable !== null);
	await settle(() => trigger().disabled);
	expect(button("Import").disabled).toBe(true);
	// Neither control starts a second operation while the write is pending.
	await act(async () => button("Import").click());
	expect(chooserOpens).toEqual([]);
	await act(async () => trigger().click());
	expect(optionNames()).toEqual([]);
	expect(writes).toEqual([`enable ${hebrew.id}`]);
	expect(consumer()).toBe("en-US:Install");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBeNull();

	await act(async () => {
		releaseEnable!();
		releaseEnable = null;
	});
	await settle(() => consumer() === "he:התקנה מבוקרת");
	expect(trigger().disabled).toBe(false);
	expect(button("Import").disabled).toBe(false);
	expect(shownChoice()).toBe(hebrew.name);
	expect(document.documentElement.dir).toBe("rtl");
	expect(localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY)).toBe(hebrew.id);
	expect(packRow(hebrew.name)).not.toContain(
		"This pack is installed but disabled."
	);
	await act(async () => button("Import").click());
	expect(chooserOpens).toEqual(["open"]);
	// The other pack was not written.
	expect(writes).toEqual([`enable ${hebrew.id}`]);
	expect(catalog.find((pack) => pack.id === french.id)).toEqual(french);
});

test("Import opens the archive chooser and resets it for the same file, Export downloads each pack's exact archive without Core writes, and Marketplace opens its route", async () => {
	setLanguageMode("auto");
	await mount();
	const input = fileInput();
	expect(input.accept).toBe(".ryupack,application/zip");
	expect(input.className).toContain("sr-only");
	const chooserOpens: string[] = [];
	input.addEventListener("click", () => chooserOpens.push("open"));
	await act(async () => button("Import").click());
	expect(chooserOpens).toEqual(["open"]);
	// Dismissing the chooser without a file sends nothing and changes nothing.
	Object.defineProperty(input, "files", { configurable: true, value: [] });
	await act(async () =>
		input.dispatchEvent(new window.Event("change", { bubbles: true }))
	);
	expect(writes).toEqual([]);
	expect(element!.querySelector('[role="alert"]')).toBeNull();
	// A chosen file's bytes are handed to Core, and the chooser is cleared so
	// the same file can be chosen again. The browser reports the chosen path.
	Object.defineProperty(input, "files", {
		configurable: true,
		value: [
			new NativeFile([new Uint8Array([1, 2, 3])], "x.ryupack", {
				type: "application/zip",
			}),
		],
	});
	const valueWrites: string[] = [];
	let chosenPath = "C:\\fakepath\\x.ryupack";
	Object.defineProperty(input, "value", {
		configurable: true,
		get: () => chosenPath,
		set: (next: string) => {
			valueWrites.push(next);
			chosenPath = next;
		},
	});
	await act(async () =>
		input.dispatchEvent(new window.Event("change", { bubbles: true }))
	);
	await settle(() => writes.length === 1);
	expect(writes).toEqual(["import 1,2,3"]);
	await settle(() => element!.querySelector('[role="alert"]') !== null);
	expect(element!.querySelector('[role="alert"]')!.textContent).toBe(
		"/api/language-packs/import failed: 422"
	);
	expect(valueWrites).toEqual([""]);
	expect(input.value).toBe("");
	expect(button("Import").disabled).toBe(false);

	// Export: capture the Blob handed to the browser and the anchor it clicks.
	const nativeCreate = URL.createObjectURL;
	const nativeRevoke = URL.revokeObjectURL;
	const blobs = new Map<string, Blob>();
	const revoked: string[] = [];
	const downloads: { href: string; name: string }[] = [];
	const captureDownload = (event: Event) => {
		const anchor = event.target;
		if (anchor instanceof HTMLAnchorElement && anchor.download) {
			downloads.push({ href: anchor.href, name: anchor.download });
			event.preventDefault();
		}
	};
	URL.createObjectURL = (blob: Blob) => {
		const url = nativeCreate(blob);
		blobs.set(url, blob);
		return url;
	};
	URL.revokeObjectURL = (url: string) => {
		revoked.push(url);
		nativeRevoke(url);
	};
	document.addEventListener("click", captureDownload, true);
	try {
		for (const pack of [french, hebrew]) {
			await act(async () => button(`Export ${pack.name}`).click());
		}
		expect(downloads.map((download) => download.name)).toEqual([
			"controls-french-1.2.0.ryupack",
			"controls-hebrew-2.0.0.ryupack",
		]);
		const exported = await Promise.all(
			downloads.map(async (download) =>
				Array.from(
					new Uint8Array(await blobs.get(download.href)!.arrayBuffer())
				)
			)
		);
		expect(exported).toEqual([
			Array.from(languagePackArchive(french)),
			Array.from(languagePackArchive(hebrew)),
		]);
		// Each Blob URL is released after the browser has taken the download.
		await settle(() => revoked.length === 2);
		expect(revoked).toEqual(downloads.map((download) => download.href));
		expect(element!.querySelectorAll("a[download]")).toHaveLength(0);
	} finally {
		document.removeEventListener("click", captureDownload, true);
		URL.createObjectURL = nativeCreate;
		URL.revokeObjectURL = nativeRevoke;
	}
	expect(writes).toEqual(["import 1,2,3"]);
	expect(catalog).toEqual(initialCatalog());

	expect(location()).toBe("/settings/language");
	await act(async () => button("Marketplace").click());
	expect(location()).toBe("/marketplace");
});
