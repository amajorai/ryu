import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register({ url: "http://localhost/" });
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { GeneralTabTerminalPage } = await import(
	"./GeneralTab-terminal-files-pages.tsx"
);
const { TAB_SWITCH_OPTIONS } = await import("./GeneralTab-options.ts");

const CATALOGS: Record<string, Record<string, string>> = {
	ar: { Bottom: "أسفل", Left: "يسار", Right: "يمين" },
	de: { Bottom: "Unten", Left: "Links", Right: "Rechts" },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function locationLabels(
	locale: "ar" | "de",
	dir: "ltr" | "rtl"
): Promise<string[]> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? (CATALOGS[locale] ?? {}) : {}
	);
	container = document.createElement("div");
	container.dir = dir;
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<DirectionProvider direction={dir}>
					<GeneralTabTerminalPage />
				</DirectionProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const group = container.querySelector(
		'[aria-label="Default terminal location"]'
	);
	return [...(group?.querySelectorAll("button") ?? [])].map(
		(button) => button.textContent?.trim() ?? ""
	);
}

test("ar (rtl): the trailing terminal location names the side it is drawn on", async () => {
	expect(await locationLabels("ar", "rtl")).toEqual(["أسفل", "يسار"]);
});

test("de (ltr): the trailing terminal location stays Right, translated", async () => {
	expect(await locationLabels("de", "ltr")).toEqual(["Unten", "Rechts"]);
});

test("the tab-cycling order names no physical direction", () => {
	const labels = TAB_SWITCH_OPTIONS.map((option) => option.label).join(" ");
	expect(labels).toContain("In tab order");
	expect(labels).not.toMatch(/left|right/i);
});
