import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";

import { registerTestDom } from "./test-dom-env.ts";

await registerTestDom();
const { loadReactDomClient } = await import("./test-dom-env.ts");
const { createRoot } = await loadReactDomClient();
const { I18nProvider, useI18n } = await import("./react.tsx");
const {
	activeLocale,
	claimActiveI18nRuntimeForRender,
	registerActiveI18nRuntime,
	subscribeLocale,
	translate,
	unregisterActiveI18nRuntime,
} = await import("./active-locale.ts");
const { registerLiteralCatalogLoader } = await import("./literal-catalog.ts");

registerLiteralCatalogLoader((locale) =>
	locale.startsWith("de")
		? {
				"Someone joined": "Jemand ist beigetreten",
				"{name} joined": "{name} ist beigetreten",
			}
		: null
);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let selectLocale: ((locale: string) => void) | null = null;

function LocaleSwitch() {
	const { setLocale, formatCompactAge } = useI18n();
	selectLocale = setLocale;
	return <span>{formatCompactAge(0, { now: 5 * 60_000 })}</span>;
}

afterEach(() => {
	document.body.innerHTML = "";
});

function setNavigatorLanguages(languages: readonly string[]): void {
	Object.defineProperty(globalThis.navigator, "languages", {
		configurable: true,
		get: () => languages,
	});
	Object.defineProperty(globalThis.navigator, "language", {
		configurable: true,
		get: () => languages[0] ?? "",
	});
}

describe("activeLocale outside React", () => {
	test("follows the mounted provider and falls back to English", async () => {
		expect(activeLocale()).toBe("en");
		expect(translate("{name} joined", { name: "Ada" })).toBe("Ada joined");
		const heard: string[] = [];
		const unsubscribe = subscribeLocale((locale) => heard.push(locale));
		const mount = document.createElement("div");
		document.body.append(mount);
		const root = createRoot(mount);
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de-AT"
					initialPackId={null}
				>
					<LocaleSwitch />
				</I18nProvider>
			);
		});
		// German copy from the de pack; dates and numbers keep the Austrian tag.
		expect(activeLocale()).toBe("de-AT");
		expect(mount.textContent).toBe("5 Min.");
		expect(translate("Someone joined")).toBe("Jemand ist beigetreten");
		expect(translate("{name} joined", { name: "Ada" })).toBe(
			"Ada ist beigetreten"
		);
		await act(async () => selectLocale?.("ja"));
		expect(activeLocale()).toBe("ja");
		expect(mount.textContent).toBe("5分");
		await act(async () => root.unmount());
		await settle();
		expect(activeLocale()).toBe("en");
		expect(heard).toEqual(["de-AT", "ja", "en"]);
		unsubscribe();
	});

	test("auto mode follows languagechange without persisting", async () => {
		setNavigatorLanguages(["nl-NL", "de"]);
		const { systemLocales } = await import("./locale.ts");
		const persisted: (string | null)[] = [];
		const mount = document.createElement("div");
		document.body.append(mount);
		const root = createRoot(mount);
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					followSystemLocale
					initialLocale={systemLocales()}
					initialPackId={null}
					persistPackId={(id) => {
						persisted.push(id);
					}}
				>
					<LocaleSwitch />
				</I18nProvider>
			);
		});
		expect(activeLocale()).toBe("de");
		setNavigatorLanguages(["sv", "ja", "de"]);
		await act(async () => {
			globalThis.dispatchEvent(new Event("languagechange"));
		});
		expect(activeLocale()).toBe("ja");
		setNavigatorLanguages(["en-GB", "de"]);
		await act(async () => {
			globalThis.dispatchEvent(new Event("languagechange"));
		});
		expect(activeLocale()).toBe("en-GB");
		expect(persisted).toEqual([]);
		await act(async () => root.unmount());
	});
});

function RenderTimeLocale() {
	return (
		<span>{`${activeLocale()} ${translate("{name} joined", { name: "Ada" })}`}</span>
	);
}

describe("the provider's first commit", () => {
	test("a child rendered in the same commit already sees the locale", async () => {
		const mount = document.createElement("div");
		document.body.append(mount);
		const root = createRoot(mount);
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="ja"
					initialPackId={null}
				>
					<RenderTimeLocale />
				</I18nProvider>
			);
		});
		expect(mount.textContent?.startsWith("ja ")).toBe(true);
		expect(activeLocale()).toBe("ja");
		await act(async () => root.unmount());
		await settle();
		expect(activeLocale()).toBe("en");
	});

	test("a later root gives the locale back when it unmounts", async () => {
		const first = document.createElement("div");
		const second = document.createElement("div");
		document.body.append(first, second);
		const firstRoot = createRoot(first);
		await act(async () => {
			firstRoot.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					initialPackId={null}
				>
					<RenderTimeLocale />
				</I18nProvider>
			);
		});
		expect(first.textContent).toBe("de Ada ist beigetreten");
		const secondRoot = createRoot(second);
		await act(async () => {
			secondRoot.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="ja"
					initialPackId={null}
				>
					<RenderTimeLocale />
				</I18nProvider>
			);
		});
		expect(second.textContent?.startsWith("ja ")).toBe(true);
		await act(async () => secondRoot.unmount());
		await settle();
		expect(activeLocale()).toBe("de");
		await act(async () => firstRoot.unmount());
		await settle();
		expect(activeLocale()).toBe("en");
	});
});

describe("render-time claims", () => {
	test("a claim the commit never confirms gives way to the next", async () => {
		const runtimeFor = (locale: string) => ({
			direction: "ltr" as const,
			locale,
			translate: (_id: string, _values?: unknown, fallback?: string) =>
				fallback ?? "",
		});
		const discarded = runtimeFor("de");
		const committed = runtimeFor("ja");
		claimActiveI18nRuntimeForRender(discarded);
		expect(activeLocale()).toBe("de");
		claimActiveI18nRuntimeForRender(committed);
		registerActiveI18nRuntime(committed);
		expect(activeLocale()).toBe("ja");
		unregisterActiveI18nRuntime(committed);
		await settle();
		expect(activeLocale()).toBe("en");
	});
});

describe("nested providers", () => {
	test("the outermost provider stays the active locale", async () => {
		const mount = document.createElement("div");
		document.body.append(mount);
		const root = createRoot(mount);
		const render = (nested: boolean) =>
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="de"
					initialPackId={null}
				>
					{nested ? <Nested /> : <LocaleSwitch />}
				</I18nProvider>
			);
		await act(async () => render(false));
		expect(activeLocale()).toBe("de");
		// A nested provider mounted later (a dialog, a preview) does not take over.
		await act(async () => render(true));
		expect(activeLocale()).toBe("de");
		expect(mount.textContent).toBe("5分");
		await act(async () => root.unmount());
		await settle();
		expect(activeLocale()).toBe("en");
	});
});

function Nested() {
	return (
		<I18nProvider
			autoLocalizeDom={false}
			initialLocale="ja"
			initialPackId={null}
			manageDocument={false}
		>
			<LocaleSwitch />
		</I18nProvider>
	);
}
