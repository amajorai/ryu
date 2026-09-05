// Contract test for the CatalogHost seam on the moved Apps section: the shared
// component renders off the injected host, shows the install lifecycle when an
// install layer is provided (desktop), and swaps to the read-only "Open in Ryu"
// affordance when `install` is null (web). Renders to static markup (no DOM),
// like the other package tests in this repo.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import AppsCatalogSection, {
	AuthBridgeConsent,
	filterAppsByStability,
	matchesCatalogTag,
} from "./apps-catalog-section.tsx";
import StoreItemAction, {
	StoreItemOverflowMenu,
} from "./chrome/store-item-action.tsx";
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
		installing: null,
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
	test("hides unstable rows by default and reveals them when opted in", () => {
		const beta: AppCatalogItem = {
			...SAMPLE_ITEM,
			entry: {
				...SAMPLE_ITEM.entry,
				id: "com.example.beta",
				stability: "beta",
			},
		};
		const preview: AppCatalogItem = {
			...SAMPLE_ITEM,
			entry: {
				...SAMPLE_ITEM.entry,
				id: "com.example.preview",
				stability: "preview",
			},
		};

		expect(filterAppsByStability([SAMPLE_ITEM, beta, preview], false)).toEqual([
			SAMPLE_ITEM,
		]);
		expect(filterAppsByStability([SAMPLE_ITEM, beta, preview], true)).toEqual([
			SAMPLE_ITEM,
			beta,
			preview,
		]);

		const installedStableOnly = filterAppsByStability(
			[
				{ ...SAMPLE_ITEM, installed: true },
				{ ...beta, installed: true },
				{ ...preview, installed: false },
			],
			false
		).filter((item) => item.installed);
		expect(installedStableOnly.map((item) => item.entry.id)).toEqual([
			SAMPLE_ITEM.entry.id,
		]);
	});

	test("tag filtering matches explicit manifest tags and preserves the all-tags state", () => {
		expect(matchesCatalogTag(SAMPLE_ITEM, null)).toBe(true);
		expect(matchesCatalogTag(SAMPLE_ITEM, "demo")).toBe(true);
		expect(matchesCatalogTag(SAMPLE_ITEM, "browser")).toBe(false);
	});

	test("auth-bridge enable consent discloses credential and traffic custody", () => {
		const html = renderToStaticMarkup(
			<AuthBridgeConsent
				providers={[
					{
						id: "chatgpt-bridge",
						label: "ChatGPT subscription",
						models: ["gpt-5"],
					},
				]}
			/>
		);
		expect(html).toContain("Handles provider credentials and traffic");
		expect(html).toContain("read requests and responses routed through it");
		expect(html).toContain("ChatGPT subscription (gpt-5)");
	});

	test("renders the selected item's name and description from the host hook", () => {
		const html = render(MOCK_INSTALL);
		expect(html).toContain("Sample Plugin");
		expect(html).toContain("A sample plugin.");
	});

	test("with an install layer, list rows show the Get action (desktop)", () => {
		const html = render(MOCK_INSTALL);
		expect(html).toContain("Get");
		expect(html).not.toContain("Open Sample Plugin in Ryu");
	});

	test("with install:null, list rows fall back to Details (read-only web)", () => {
		const html = render(null);
		expect(html).toContain("Details");
	});

	test("StoreItemAction shows Get when not installed and no affordance", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction installed={false} onInstall={() => undefined} />
		);
		expect(html).toContain("Get");
		expect(html).not.toContain("Open Sample Plugin in Ryu");
	});

	test("StoreItemAction swaps to the read-only affordance when one is passed (web)", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				affordance={<span>Open Sample Plugin in Ryu</span>}
				installed={false}
			/>
		);
		expect(html).toContain("Open Sample Plugin in Ryu");
		// No desktop install button when the surface is read-only.
		expect(html).not.toContain("Add<");
	});

	// The Settings route only ever renders when the surface resolved a destination
	// for the item. A menu row that opens nothing (or a dialog's default page) is
	// worse than no row, so absence of a handler must mean absence of the control.
	test("a read-only affordance gets no overflow when nothing can be opened", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				affordance={<span>Open Sample Plugin in Ryu</span>}
				installed={false}
			/>
		);
		expect(html).not.toContain("More actions");
	});

	test("a settings destination adds the overflow beside a static affordance", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				affordance={<span>Open Sample Plugin in Ryu</span>}
				installed={false}
				onOpenSettings={() => undefined}
			/>
		);
		expect(html).toContain("More actions");
	});

	test("a locked (built-in) item still reaches its settings", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction installed locked onOpenSettings={() => undefined} />
		);
		// The word now lives on the status glyph's `aria-label`, not as visible
		// text. That is the ONLY place it can be asserted from here — and the only
		// place a screen reader can reach it — because `TooltipContent` is portaled
		// and `renderToStaticMarkup` never emits a portal.
		expect(html).toContain('aria-label="Built in"');
		expect(html).toContain("More actions");
	});

	// ── host-floor (engines) incompatibility ──────────────────────────────────
	//
	// The listing must still RENDER — it used to vanish from the catalog entirely,
	// leaving no way to discover that updating would bring it back — while the
	// install verb is withheld, because Core refuses the install anyway.

	test("an incompatible listing shows Unavailable instead of Add", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				incompatible="Requires Ryu >=0.2.0 (you have 0.1.12)"
				installed={false}
				onInstall={() => undefined}
			/>
		);
		expect(html).toContain("Unavailable");
		expect(html).not.toContain(">Add<");
	});

	test("the reason travels with the control so the user learns what to update", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				incompatible="Requires Ryu >=0.2.0 (you have 0.1.12)"
				installed={false}
			/>
		);
		// Asserted on `aria-label`, not `title`: a hover-only tooltip is unreachable
		// by keyboard and invisible on touch, so the accessible name is the one that
		// proves the reason actually reaches a user.
		expect(html).toContain(
			'aria-label="Requires Ryu &gt;=0.2.0 (you have 0.1.12)"'
		);
	});

	/** An installed-but-held-back plugin must stay removable — it is on disk, it is
	 *  not running, and Remove is the only verb that still makes sense. */
	test("an installed incompatible plugin keeps a manage menu", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				enabled={false}
				incompatible="Requires Ryu >=0.2.0 (you have 0.1.12)"
				installed
				onUninstall={() => undefined}
			/>
		);
		expect(html).toContain("Unavailable");
		expect(html).toContain("Manage");
	});

	/** A compatible listing must be completely unaffected — `incompatible` is the
	 *  only thing that suppresses Add, and an advisory-only verdict yields null. */
	test("a compatible listing is untouched", () => {
		const html = renderToStaticMarkup(
			<StoreItemAction
				incompatible={null}
				installed={false}
				onInstall={() => undefined}
			/>
		);
		expect(html).toContain("Get");
		expect(html).not.toContain("Unavailable");
	});

	test("StoreItemOverflowMenu renders nothing when it would be empty", () => {
		expect(renderToStaticMarkup(<StoreItemOverflowMenu />)).toBe("");
	});
});
