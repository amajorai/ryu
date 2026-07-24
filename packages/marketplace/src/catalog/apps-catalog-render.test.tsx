// Render-through-the-host tests for the shared Apps (plugins) catalog *list*.
// The section is tested by injecting a fake CatalogHost and rendering to static
// markup (no DOM, no network) — the same idiom as apps-catalog-section.test.tsx.
//
// Scope note: the detail/preview panel mounts inside a Base UI <Dialog> (see
// store-catalog-layout.tsx, default previewMode "dialog"), which portals and so
// is NOT emitted by `renderToStaticMarkup`. The list, toolbar and variant
// filtering all render inline and are covered here; the detail-panel helpers
// (safeHttpUrl / prettyPluginId / runnableKindLabel / isCompanionApp) are unit-
// tested directly in apps-catalog-helpers.test.ts.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AppsCatalogSection from "./apps-catalog-section.tsx";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstall,
} from "./host.tsx";
import type {
	AppCatalogItem,
	AppsCatalogState,
	CatalogEntry,
} from "./types.ts";

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => (
		<button data-testid="install-button" type="button">
			{children}
		</button>
	),
};

function makeEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		description: "Does a thing.",
		id: "com.example.thing",
		kinds: ["tool"],
		name: "Thing",
		tags: [],
		version: "1.0.0",
		...over,
	};
}

function makeItem(over: Partial<AppCatalogItem> = {}): AppCatalogItem {
	return {
		enabled: false,
		entry: makeEntry(over.entry),
		grants: [],
		installed: false,
		...over,
	};
}

function makeAppsState(over: Partial<AppsCatalogState> = {}): AppsCatalogState {
	return {
		activeSource: "ryu-marketplace",
		addingMarketplace: false,
		addMarketplace: () => Promise.resolve(),
		detail: null,
		detailError: null,
		detailLoading: false,
		error: null,
		fetchNextPage: () => undefined,
		hasNextPage: false,
		install: () => Promise.resolve(),
		installFromUrl: () => Promise.resolve(),
		installing: false,
		items: [],
		lifecyclePending: false,
		loading: false,
		loadingMore: false,
		query: "",
		select: () => undefined,
		selectedId: null,
		selectedItem: null,
		selectingSource: false,
		selectSource: () => undefined,
		setEnabled: () => Promise.resolve(),
		setQuery: () => undefined,
		sources: [{ displayName: "Ryu Marketplace", id: "ryu-marketplace" }],
		...over,
	};
}

function makeHost(
	state: AppsCatalogState,
	install: CatalogInstall | null = MOCK_INSTALL
): CatalogHost {
	return {
		install,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: (target) => <span>Open {target.name} in Ryu</span>,
		useAppsCatalog: () => state,
		useSkillsCatalog: () => {
			throw new Error("unused");
		},
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ url: "", token: null }),
		usePersistedToggle: (_k: string, d: boolean) =>
			[d, () => undefined] as [boolean, (v: boolean) => void],
		installSidecar: () => Promise.resolve(),
		estimateLlmfit: () =>
			Promise.resolve({
				fit_level: null,
				installed: false,
				matched: false,
				min_vram_gb: null,
				path: null,
				tps: null,
			}),
		useInstalledModels: () => [],
		ActiveModelControl: () => null,
		fitStyle: () => ({ className: "", dot: "" }),
	};
}

function render(
	state: AppsCatalogState,
	opts: {
		install?: CatalogInstall | null;
		variant?: "apps" | "plugins" | "all";
	} = {}
): string {
	return renderToStaticMarkup(
		<CatalogHostProvider
			host={makeHost(
				state,
				opts.install === undefined ? MOCK_INSTALL : opts.install
			)}
		>
			<AppsCatalogSection variant={opts.variant ?? "all"} />
		</CatalogHostProvider>
	);
}

describe("AppsCatalogSection — list states", () => {
	test("loading with no items shows a spinner, not the empty state", () => {
		const html = render(makeAppsState({ loading: true, items: [] }));
		expect(html).not.toContain("No plugins found");
		expect(html).not.toContain("Couldn't load");
	});

	test("error with no items surfaces the error message", () => {
		const html = render(
			makeAppsState({ error: "boom", items: [], loading: false })
		);
		// The apostrophe in "Couldn't" is HTML-escaped in static markup.
		expect(html).toContain("load plugins: boom");
	});

	test("empty (loaded, no items, no error) shows the empty state", () => {
		const html = render(makeAppsState({ items: [], loading: false }));
		expect(html).toContain("No plugins found");
		expect(html).toContain("Try a different search.");
	});

	test("populated list renders each card's name + description", () => {
		const items = [
			makeItem({ entry: makeEntry({ id: "a", name: "Alpha" }) }),
			makeItem({
				entry: makeEntry({ description: "Second one.", id: "b", name: "Beta" }),
			}),
		];
		const html = render(makeAppsState({ items }));
		expect(html).toContain("Alpha");
		expect(html).toContain("Beta");
		expect(html).toContain("Second one.");
	});

	test("with an install layer, list cards expose the Install action", () => {
		const html = render(makeAppsState({ items: [makeItem()] }));
		expect(html).toContain("Install");
	});

	test("read-only host (install:null) shows Details, not Install, on cards", () => {
		const html = render(makeAppsState({ items: [makeItem()] }), {
			install: null,
		});
		expect(html).toContain("Details");
	});

	test("search placeholder switches for the integrations source", () => {
		const html = render(
			makeAppsState({ activeSource: "integrations-sh", items: [makeItem()] })
		);
		expect(html).toContain("Search integrations");
	});
});

describe("AppsCatalogSection — isCompanionApp variant filter", () => {
	const appItem = makeItem({
		entry: makeEntry({
			id: "com.example.app",
			kinds: ["companion"],
			name: "Full App",
			type: "app",
		}),
	});
	const pluginItem = makeItem({
		entry: makeEntry({
			id: "com.example.plugin",
			kinds: ["tool"],
			name: "Just Plugin",
			type: "plugin",
		}),
	});
	// Legacy wire with no `type` — companion derivation from kinds.
	const legacyCompanion = makeItem({
		entry: makeEntry({
			id: "com.example.legacy",
			kinds: ["companion"],
			name: "Legacy Companion",
		}),
	});

	test("variant 'apps' shows companions only", () => {
		const html = render(makeAppsState({ items: [appItem, pluginItem] }), {
			variant: "apps",
		});
		expect(html).toContain("Full App");
		expect(html).not.toContain("Just Plugin");
	});

	test("variant 'plugins' shows non-companions only", () => {
		const html = render(makeAppsState({ items: [appItem, pluginItem] }), {
			variant: "plugins",
		});
		expect(html).toContain("Just Plugin");
		expect(html).not.toContain("Full App");
	});

	test("variant 'all' shows everything unfiltered", () => {
		const html = render(makeAppsState({ items: [appItem, pluginItem] }), {
			variant: "all",
		});
		expect(html).toContain("Full App");
		expect(html).toContain("Just Plugin");
	});

	test("legacy no-`type` companion is classed as an app via kinds", () => {
		const html = render(
			makeAppsState({ items: [legacyCompanion, pluginItem] }),
			{ variant: "apps" }
		);
		expect(html).toContain("Legacy Companion");
		expect(html).not.toContain("Just Plugin");
	});
});
