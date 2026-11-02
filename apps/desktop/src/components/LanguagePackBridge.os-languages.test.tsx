import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useI18n } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { setLanguageMode } = await import("@/src/hooks/useLanguageMode.ts");
const { LanguagePackBridge } = await import("./LanguagePackBridge.tsx");

interface TauriWindow {
	__TAURI_INTERNALS__?: unknown;
}

// What the shell answers `get_os_preferred_languages` with; null never answers.
let osLanguages: string[] | null = ["ja-JP", "en-US"];

function installShell() {
	(window as TauriWindow).__TAURI_INTERNALS__ = {
		invoke: (command: string) => {
			if (command !== "get_os_preferred_languages") {
				return Promise.reject(new Error(`unexpected ${command}`));
			}
			return osLanguages === null
				? new Promise<never>(() => undefined)
				: Promise.resolve(osLanguages);
		},
		transformCallback: () => 0,
	};
}

function Locale() {
	return <output>{useI18n().locale}</output>;
}

let root: Root | null = null;
let element: HTMLDivElement | null = null;

async function mount() {
	element = document.createElement("div");
	document.body.append(element);
	root = createRoot(element);
	await act(async () =>
		root!.render(
			<LanguagePackBridge>
				<Locale />
			</LanguagePackBridge>
		)
	);
}

function locale(): string {
	return element?.querySelector("output")?.textContent ?? "";
}

async function settle(predicate: () => boolean) {
	for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	}
	// biome-ignore lint/suspicious/noMisplacedAssertion: settle runs only inside this file's bun:test cases and fails the awaiting case on timeout.
	expect(predicate()).toBe(true);
}

afterEach(async () => {
	if (root) {
		await act(async () => root!.unmount());
	}
	root = null;
	element?.remove();
	element = null;
	(window as TauriWindow).__TAURI_INTERNALS__ = undefined;
	osLanguages = ["ja-JP", "en-US"];
});

test("auto mode follows the OS language list, not the webview's English navigator.language", async () => {
	localStorage.clear();
	setLanguageMode("auto");
	expect(navigator.language.startsWith("en")).toBe(true);
	installShell();
	await mount();
	await settle(() => locale().startsWith("ja"));

	// The next launch starts in Japanese before the shell answers.
	await act(async () => root!.unmount());
	root = null;
	element?.remove();
	osLanguages = null;
	await mount();
	expect(locale().startsWith("ja")).toBe(true);
});

test("a fixed language choice ignores the OS list", async () => {
	localStorage.clear();
	setLanguageMode("fixed");
	installShell();
	await mount();
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	expect(locale().startsWith("ja")).toBe(false);
	setLanguageMode("auto");
	localStorage.clear();
});
