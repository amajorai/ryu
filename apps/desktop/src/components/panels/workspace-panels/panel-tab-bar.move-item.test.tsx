import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ArrowDown01Icon, ArrowRight01Icon } = await import(
	"@hugeicons/core-free-icons"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { DIRECTIONAL_ICON_CLASS } = await import(
	"@ryu/ui/components/directional-icon.tsx"
);
const { PanelTabBar } = await import("./panel-tab-bar.tsx");

// The dock tab's "Move to …" item is one whole message per target dock, so a
// catalog translates "Move to side panel" as a sentence instead of meeting an
// English fragment ("right panel") spliced into "Move to {otherPanelLabel}".
const CATALOGS: Record<string, Record<string, string>> = {
	ar: { "Move to side panel": "نقل إلى اللوحة الجانبية" },
	ja: { "Move to bottom panel": "下部パネルに移動" },
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

async function openMoveItem(options: {
	locale: string;
	toSide: boolean;
}): Promise<HTMLElement | undefined> {
	registerLiteralCatalogLoader((locale) => CATALOGS[locale.slice(0, 2)] ?? {});
	const container = document.createElement("div");
	if (options.locale === "ar") {
		container.setAttribute("dir", "rtl");
	}
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={options.locale}
				initialPackId={null}
			>
				<PanelTabBar
					activeUid="t1"
					addTypes={[]}
					iconForKind={() => ({})}
					onActivate={() => undefined}
					onAdd={() => undefined}
					onCloseAll={() => undefined}
					onCloseOthers={() => undefined}
					onClosePanel={() => undefined}
					onCloseTab={() => undefined}
					onMoveToOtherPanel={() => undefined}
					otherPanelIcon={options.toSide ? ArrowRight01Icon : ArrowDown01Icon}
					otherPanelIconClassName={
						options.toSide ? DIRECTIONAL_ICON_CLASS : undefined
					}
					otherPanelLabel={
						options.toSide ? "Move to side panel" : "Move to bottom panel"
					}
					tabs={[{ kind: "terminal", label: "Terminal", uid: "t1" }]}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	await act(async () => {
		container
			.querySelector('[data-active="true"]')
			?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
			);
	});
	return Array.from(
		document.querySelectorAll<HTMLElement>('[role="menuitem"]')
	).find((item) => item.textContent?.includes(options.toSide ? "نقل" : "移動"));
}

describe("dock tab Move to item", () => {
	test("Arabic shows the whole translated sentence with a mirrored arrow", async () => {
		const item = await openMoveItem({ locale: "ar", toSide: true });
		expect(item?.textContent).toBe("نقل إلى اللوحة الجانبية");
		expect(item?.textContent).not.toContain("Move to");
		expect(
			item?.querySelector("svg")?.getAttribute("class")?.split(/\s+/)
		).toContain(DIRECTIONAL_ICON_CLASS);
	});

	test("Japanese bottom item is one message and its arrow stays physical", async () => {
		const item = await openMoveItem({ locale: "ja", toSide: false });
		expect(item?.textContent).toBe("下部パネルに移動");
		expect(item?.querySelector("svg")?.getAttribute("class")).not.toContain(
			DIRECTIONAL_ICON_CLASS
		);
	});
});
