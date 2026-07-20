// Contract test for the CatalogHost seam on the moved Apps section: the shared
// component renders off the injected host, shows the install lifecycle when an
// install layer is provided (desktop), and swaps to the read-only "Open in Ryu"
// affordance when `install` is null (web). Renders to static markup (no DOM),
// like the other package tests in this repo.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AppsCatalogSection from "./apps-catalog-section.tsx";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstall,
} from "./host.tsx";
import type { AppCatalogItem, AppsCatalogState } from "./types.ts";

const SAMPLE_ITEM: AppCatalogItem = {
	enabled: false,
	entry: {
		description: "A sample plugin.",
		id: "com.example.sample",
		kinds: ["tool"],
		name: "Sample Plugin",
		tags: ["demo"],
		version: "1.0.0",
	},
	grants: [],
	installed: false,
};

function makeAppsState(): AppsCatalogState {
	return {
		activeSource: "ryu-marketplace",
		addingMarketplace: false,
		addMarketplace: () => Promise.resolve(),
		detail: null,
		detailError: null,
		detailLoading: false,
		error: null,
		fetchNextPage: () => {
			// no-op for the static render
		},
		hasNextPage: false,
		install: () => Promise.resolve(),
		installFromUrl: () => Promise.resolve(),
		installing: false,
		items: [SAMPLE_ITEM],
		lifecyclePending: false,
		loading: false,
		loadingMore: false,
		query: "",
		select: () => {
			// no-op
		},
		selectedId: SAMPLE_ITEM.entry.id,
		selectedItem: SAMPLE_ITEM,
		selectingSource: false,
		selectSource: () => {
			// no-op
		},
		setEnabled: () => Promise.resolve(),
		setQuery: () => {
			// no-op
		},
		sources: [{ displayName: "Ryu Marketplace", id: "ryu-marketplace" }],
	};
}

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => (
		<button data-testid="install-button" type="button">
			{children}
		</button>
	),
};

function makeHost(install: CatalogInstall | null): CatalogHost {
	return {
		install,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => {
			// no-op
		},
		renderAffordance: (target) => (
			<span data-testid="affordance">Open {target.name} in Ryu</span>
		),
		useAppsCatalog: () => makeAppsState(),
		useSkillsCatalog: () => {
			throw new Error("useSkillsCatalog not used by the Apps section");
		},
		useModelCatalog: () => {
			throw new Error("useModelCatalog not used by the Apps section");
		},
		useActiveNode: () => ({ url: "", token: null }),
		usePersistedToggle: (_key: string, defaultValue: boolean) =>
			[
				defaultValue,
				() => {
					// no-op
				},
			] as [boolean, (v: boolean) => void],
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

function render(install: CatalogInstall | null): string {
	return renderToStaticMarkup(
		<CatalogHostProvider host={makeHost(install)}>
			<AppsCatalogSection />
		</CatalogHostProvider>
	);
}

describe("CatalogHost seam — Apps section", () => {
	test("renders the selected item's name and description from the host hook", () => {
		const html = render(MOCK_INSTALL);
		expect(html).toContain("Sample Plugin");
		expect(html).toContain("A sample plugin.");
	});

	test("with an install layer, shows the Install action (desktop)", () => {
		const html = render(MOCK_INSTALL);
		expect(html).toContain("install-button");
		expect(html).toContain("Install");
		// The read-only affordance must NOT render when install is available.
		expect(html).not.toContain("Open Sample Plugin in Ryu");
	});

	test("with install:null, swaps to the Open-in-Ryu affordance (web)", () => {
		const html = render(null);
		expect(html).toContain("Open Sample Plugin in Ryu");
		// No desktop install button when the surface is read-only.
		expect(html).not.toContain("install-button");
	});
});
