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
const { ContextMenu, ContextMenuContent, ContextMenuTrigger } = await import(
	"@ryu/ui/components/context-menu.tsx"
);
const { DirectionProvider } = await import("@ryu/ui/components/direction.tsx");
const { MoveTabToRegionSubmenu } = await import(
	"./move-tab-to-region-submenu.tsx"
);

const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		Bottom: "أسفل",
		Center: "الوسط",
		Left: "يسار",
		"Move to pane": "نقل إلى جزء",
		Right: "يمين",
	},
	de: {
		Bottom: "Unten",
		Center: "Mitte",
		Left: "Links",
		"Move to pane": "In Bereich verschieben",
		Right: "Rechts",
	},
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

async function openSubmenu(
	locale: "ar" | "de",
	dir: "ltr" | "rtl",
	moved: string[]
): Promise<void> {
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
					<ContextMenu defaultOpen>
						<ContextMenuTrigger>tab</ContextMenuTrigger>
						<ContextMenuContent>
							<MoveTabToRegionSubmenu onMove={(region) => moved.push(region)} />
						</ContextMenuContent>
					</ContextMenu>
				</DirectionProvider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const trigger = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((element) => element.getAttribute("aria-haspopup") === "menu");
	await act(async () => {
		trigger?.click();
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
}

function regionItems(): HTMLElement[] {
	return [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].filter((element) => element.getAttribute("aria-haspopup") !== "menu");
}

test("ar (rtl): the stored right region is labelled Left (يسار) and still moves to right", async () => {
	const moved: string[] = [];
	await openSubmenu("ar", "rtl", moved);
	expect(document.body.textContent).toContain("نقل إلى جزء");
	const labels = regionItems().map((element) => element.textContent?.trim());
	expect(labels).toEqual(["الوسط", "يسار", "أسفل"]);
	expect(document.body.textContent).not.toContain("يمين");
	await act(async () => {
		regionItems()[1]?.click();
	});
	expect(moved).toEqual(["right"]);
});

test("de (ltr): the stored right region keeps its side", async () => {
	await openSubmenu("de", "ltr", []);
	const labels = regionItems().map((element) => element.textContent?.trim());
	expect(labels).toEqual(["Mitte", "Rechts", "Unten"]);
	expect(document.body.textContent).not.toContain("Right");
});
