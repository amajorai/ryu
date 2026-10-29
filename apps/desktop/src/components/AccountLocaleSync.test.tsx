import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { setLanguageMode } = await import("@/src/hooks/useLanguageMode.ts");
const { AccountLocaleSync } = await import("./AccountLocaleSync.tsx");

const german: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/account-locale",
	name: "Deutsch",
	version: "1.0.0",
	locale: "de",
	baseLocale: "en",
	direction: "ltr",
	messages: {},
};

let runtime: ReturnType<typeof useI18n> | null = null;
function Runtime() {
	const i18n = useI18n();
	useEffect(() => {
		runtime = i18n;
	}, [i18n]);
	return null;
}

let root: Root | null = null;
async function mount(saved: string[]): Promise<void> {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<I18nProvider initialPackId={null} packs={[german]}>
				<Runtime />
				<AccountLocaleSync save={(locale) => saved.push(locale)} />
			</I18nProvider>
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	runtime = null;
});

test("restoring a pack or following the OS language never saves", async () => {
	const saved: string[] = [];
	await mount(saved);
	await act(async () => {
		runtime?.selectPack(german.id);
		runtime?.setLocale("fr-FR");
	});
	expect(saved).toEqual([]);
});

test("an explicit choice saves the locale it selects", async () => {
	const saved: string[] = [];
	await mount(saved);
	await act(async () => {
		setLanguageMode("fixed");
		runtime?.selectPack(german.id);
	});
	expect(saved.at(-1)).toBe("de");
	await act(async () => {
		setLanguageMode("fixed");
		runtime?.selectPack(null);
	});
	expect(saved.at(-1)).toBe("en");
});
