import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { TabsContext } = await import("@/src/contexts/TabsContext.tsx");
const { SpaceScopeMenu } = await import("./sidebar-scope-menus.tsx");

type TabsValue = NonNullable<
	Parameters<typeof TabsContext.Provider>[0]["value"]
>;
type MenuSpace = Parameters<typeof SpaceScopeMenu>[0]["space"];

// The scope picker hands the menu the stored Space row. A system Space keeps its
// English seed name in Core, so the menu must localize it before placing it in
// the translated "{name} options" label (the DOM localizer never re-matches a
// value filled into a sentence or an aria label).
const DE: Record<string, string> = {
	"{name} options": "Optionen für {name}",
	Uploads: "Hochgeladene Dateien",
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

function space(name: string, system: boolean): MenuSpace {
	return {
		createdAt: 0,
		description: null,
		documentCount: 0,
		icon: null,
		id: `space-${name}`,
		name,
		system,
	} as unknown as MenuSpace;
}

async function renderMenuLabel(row: MenuSpace): Promise<string | null> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const tabs = { updateTabsIconWhere: () => undefined } as unknown as TabsValue;
	const noop = () => undefined;
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<TabsContext.Provider value={tabs}>
					<SpaceScopeMenu
						canDelete
						canMakePrivate
						contributedRows={[]}
						onAdd={noop}
						onOpen={noop}
						onOpenInNewTab={noop}
						onOpenInNewWindow={noop}
						onRename={async () => undefined}
						onRequestDelete={noop}
						onRequestVisibilityChange={noop}
						setSpaceIcon={async () => undefined}
						space={row}
					/>
				</TabsContext.Provider>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return (
		container.querySelector("[aria-label]")?.getAttribute("aria-label") ?? null
	);
}

test("a German scope menu names the system Uploads Space in German", async () => {
	expect(await renderMenuLabel(space("Uploads", true))).toBe(
		"Optionen für Hochgeladene Dateien"
	);
});

test("a user Space keeps its own name inside the German label", async () => {
	expect(await renderMenuLabel(space("Uploads", false))).toBe(
		"Optionen für Uploads"
	);
});
