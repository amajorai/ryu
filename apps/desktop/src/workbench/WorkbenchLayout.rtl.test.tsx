import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	createDefaultWorkbench,
	type WorkbenchItem,
} from "@ryu/workbench/model";
import { serializeWorkbenchSnapshot } from "@ryu/workbench/persistence";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { DirectionProvider, I18nDirectionProvider } = await import(
	"@ryu/ui/components/direction.tsx"
);
const { DesktopWorkbenchProvider, useDesktopWorkbench } = await import(
	"./DesktopWorkbenchContext.tsx"
);
const { WORKBENCH_STORAGE_KEY } = await import(
	"./desktop-workbench-persistence.ts"
);
const { WorkbenchLayout } = await import("./WorkbenchLayout.tsx");
const { WorkbenchSlotProvider } = await import("./workbench-slots.tsx");

// Fixture catalogs: the DOM localizer is off, so the components themselves
// must resolve these whole messages.
const CATALOGS: Record<string, Record<string, string>> = {
	ar: {
		"Resize Bottom": "تغيير حجم اللوحة السفلية",
		"Resize Left": "تغيير حجم اللوحة اليسرى",
		"Resize Right": "تغيير حجم اللوحة اليمنى",
	},
	de: {
		Bottom: "Unten",
		Center: "Mitte",
		Left: "Links",
		"Move to {region}": "Nach {region} verschieben",
		Right: "Rechts",
	},
	ja: {
		"Resize Bottom": "下部パネルのサイズを変更",
		"Resize Left": "左パネルのサイズを変更",
		"Resize Right": "右パネルのサイズを変更",
	},
};

const IDS = {
	bottomGroupId: "bottom-main",
	centerGroupId: "center-main",
	leftGroupId: "left-main",
	navigationId: "navigation",
	rightGroupId: "right-main",
};

function item(
	id: string,
	title: string,
	preferredRegion: WorkbenchItem["preferredRegion"]
): WorkbenchItem {
	return {
		closable: true,
		duplicable: false,
		id,
		pinned: false,
		preferredRegion,
		scope: { kind: "window" },
		source: { kind: "shell", panel: id },
		title,
	};
}

const ACTIVE_BY_REGION: Record<string, string> = {
	bottom: "bottom-item",
	center: "center-item",
	right: "right-item",
};

function visibleFourRegionState() {
	const state = createDefaultWorkbench(IDS);
	return {
		...state,
		groups: state.groups.map((group) => {
			const activeItemId = ACTIVE_BY_REGION[group.region];
			return activeItemId
				? { ...group, activeItemId, itemIds: [activeItemId] }
				: group;
		}),
		items: [
			...state.items,
			item("center-item", "Chat", "center"),
			item("right-item", "Files", "right"),
			item("bottom-item", "Terminal", "bottom"),
		],
		openRegions: { bottom: true, center: true, left: true, right: true },
	};
}

let container: HTMLDivElement;
let root: Root;
let workbench: ReturnType<typeof useDesktopWorkbench> | undefined;

function StateProbe() {
	workbench = useDesktopWorkbench();
	return null;
}

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => CATALOGS[locale.slice(0, 2)] ?? {});
	localStorage.clear();
	localStorage.setItem(
		WORKBENCH_STORAGE_KEY,
		JSON.stringify(serializeWorkbenchSnapshot(visibleFourRegionState()))
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	workbench = undefined;
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function renderLayout({
	dir = "ltr",
	locale = "en",
}: {
	dir?: "ltr" | "rtl" | "locale";
	locale?: string;
}) {
	const tree: ReactNode = (
		<DesktopWorkbenchProvider
			makeId={(prefix) => prefix}
			persistenceDelayMs={60_000}
			storage={localStorage}
		>
			<WorkbenchSlotProvider>
				<WorkbenchLayout centerContent={<div>Current page</div>} />
				<StateProbe />
			</WorkbenchSlotProvider>
		</DesktopWorkbenchProvider>
	);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				{dir === "locale" ? (
					<I18nDirectionProvider>{tree}</I18nDirectionProvider>
				) : (
					<DirectionProvider direction={dir}>{tree}</DirectionProvider>
				)}
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(30);
	});
}

function separator(region: "left" | "right" | "bottom"): HTMLElement {
	const element = container.querySelector<HTMLElement>(
		`[role="separator"][data-resize-region="${region}"]`
	);
	if (!element) {
		throw new Error(`no ${region} separator`);
	}
	return element;
}

describe("workbench separators across locales and directions", () => {
	test("places separators by region id, not by their English accessible name", async () => {
		await renderLayout({ locale: "ja" });

		expect(separator("left").getAttribute("aria-label")).toBe(
			"左パネルのサイズを変更"
		);
		expect(separator("right").getAttribute("aria-label")).toBe(
			"右パネルのサイズを変更"
		);
		expect(separator("bottom").getAttribute("aria-label")).toBe(
			"下部パネルのサイズを変更"
		);
		const css = readFileSync(
			new URL("./WorkbenchLayout.module.css", import.meta.url),
			"utf8"
		);
		for (const region of ["left", "right", "bottom"]) {
			expect(css).toContain(`[data-resize-region="${region}"]`);
		}
		expect(css).not.toContain("aria-label");
	});

	test("names separators by the side they appear on under RTL", async () => {
		await renderLayout({ dir: "rtl" });

		expect(separator("left").getAttribute("aria-label")).toBe("Resize Right");
		expect(separator("right").getAttribute("aria-label")).toBe("Resize Left");
		expect(separator("bottom").getAttribute("aria-label")).toBe(
			"Resize Bottom"
		);
	});

	test("takes the mirrored names from the Arabic locale's own direction", async () => {
		await renderLayout({ dir: "locale", locale: "ar" });

		expect(separator("left").getAttribute("aria-label")).toBe(
			"تغيير حجم اللوحة اليمنى"
		);
		expect(separator("right").getAttribute("aria-label")).toBe(
			"تغيير حجم اللوحة اليسرى"
		);
	});

	test("mirrors the pointer resize sign of the side regions under RTL", async () => {
		await renderLayout({ dir: "rtl" });
		const startLeft = workbench?.state.sizes.left ?? 0;
		const startRight = workbench?.state.sizes.right ?? 0;

		// Left sits on screen-right under RTL: dragging rightward shrinks it.
		await act(async () => {
			separator("left").dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, clientX: 500 })
			);
			window.dispatchEvent(new PointerEvent("pointermove", { clientX: 540 }));
			window.dispatchEvent(new PointerEvent("pointerup", { clientX: 540 }));
		});
		expect(workbench?.state.sizes.left).toBe(startLeft - 40);

		// Right sits on screen-left under RTL: dragging rightward grows it.
		await act(async () => {
			separator("right").dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, clientX: 300 })
			);
			window.dispatchEvent(new PointerEvent("pointermove", { clientX: 340 }));
			window.dispatchEvent(new PointerEvent("pointerup", { clientX: 340 }));
		});
		expect(workbench?.state.sizes.right).toBe(startRight + 40);
	});

	test("moves a side separator in the arrow-key direction under RTL", async () => {
		await renderLayout({ dir: "rtl" });
		const startLeft = workbench?.state.sizes.left ?? 0;
		const startRight = workbench?.state.sizes.right ?? 0;

		await act(async () => {
			separator("left").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
			);
			separator("right").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
			);
		});
		expect(workbench?.state.sizes.left).toBe(startLeft + 10);
		expect(workbench?.state.sizes.right).toBe(startRight - 10);
	});
});

async function openTabMenu(itemId: string): Promise<HTMLElement[]> {
	await act(async () => {
		container
			.querySelector(`[data-workbench-tab="${itemId}"]`)
			?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
			);
	});
	return Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	);
}

describe("workbench region menu labels", () => {
	test("translates the Move to region items in German", async () => {
		await renderLayout({ locale: "de" });
		const labels = (await openTabMenu("center-item")).map(
			(element) => element.textContent ?? ""
		);

		expect(labels).toContain("Nach Rechts verschieben");
		expect(labels).toContain("Nach Unten verschieben");
		expect(labels.some((label) => label.startsWith("Move to"))).toBe(false);
	});

	test("Move to Left targets the region drawn on screen-left under RTL", async () => {
		await renderLayout({ dir: "rtl" });
		const moveLeft = (await openTabMenu("center-item")).find(
			(element) => element.textContent === "Move to Left"
		);
		expect(moveLeft).toBeDefined();

		await act(async () => {
			moveLeft?.click();
		});
		const rightGroup = workbench?.state.groups.find(
			(group) => group.region === "right"
		);
		expect(rightGroup?.itemIds).toContain("center-item");
	});
});
