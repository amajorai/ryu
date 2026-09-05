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
		installing: null,
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
	install: CatalogInstall | null = MOCK_INSTALL,
	communityState: AppsCatalogState = makeAppsState()
): CatalogHost {
	return {
		install,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: (target) => <span>Open {target.name} in Ryu</span>,
		// The section calls this hook TWICE — once for the first-party catalog and
		// once with `origin: "community"` for the shelf. Returning one state for both
		// would make every community assertion vacuous, so dispatch on the option.
		useAppsCatalog: (_q, options) =>
			options?.origin === "community" ? communityState : state,
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
		community?: AppsCatalogState;
		install?: CatalogInstall | null;
		variant?: "apps" | "plugins" | "all";
	} = {}
): string {
	return renderToStaticMarkup(
		<CatalogHostProvider
			host={makeHost(
				state,
				opts.install === undefined ? MOCK_INSTALL : opts.install,
				opts.community ?? makeAppsState()
			)}
		>
			<AppsCatalogSection variant={opts.variant ?? "all"} />
		</CatalogHostProvider>
	);
}

/** A GitHub topic-discovered listing, carrying the trust triple Core stamps.
 *  `type` is what the apps/plugins split reads (the community projector derives
 *  it from the `ryu-app` vs `ryu-plugin` topic), so it is set explicitly here. */
function makeCommunityItem(
	type: "app" | "plugin",
	over: Partial<CatalogEntry> = {}
): AppCatalogItem {
	return makeItem({
		entry: makeEntry({
			descriptor_only: true,
			id: `gh:acme/${type}-repo`,
			name: type === "app" ? "Community App" : "Community Plugin",
			origin: "community",
			reviewed: false,
			type,
			...over,
		}),
	});
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
		expect(html).toContain("Couldn&#x27;t load plugins");
		expect(html).toContain("boom");
		expect(html).toContain("Try again");
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

	test("with an install layer, list cards expose the Get action", () => {
		const html = render(makeAppsState({ items: [makeItem()] }));
		expect(html).toContain("Get");
	});

	test("a paid listing keeps its price disclosure and Get action", () => {
		const html = render(
			makeAppsState({
				items: [
					makeItem({
						entry: makeEntry({
							pricing: { amountMinor: 900, currency: "usd", kind: "one_time" },
						}),
					}),
				],
			})
		);
		expect(html).toContain("9.00");
		expect(html).toContain("Get");
		expect(html).not.toContain("Upgrade to use");
	});

	test("read-only host (install:null) shows Details, not Get, on cards", () => {
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

// The Community tab was removed; unreviewed GitHub topic-discovered listings now
// render as a trailing shelf inside Apps and Plugins. These lock in the two things
// that merge can silently get wrong: the shelf must obey the SAME apps/plugins
// split as the first-party grid (or one tab swallows everything), and the trust
// disclosure must travel with it (or unreviewed rows sit beside vetted ones with
// nothing marking them).
describe("AppsCatalogSection — community shelf", () => {
	const firstParty = makeItem({
		entry: makeEntry({ id: "com.example.first", name: "First Party" }),
	});

	test("community listings render under their own heading with the trust notice", () => {
		const html = render(makeAppsState({ items: [firstParty] }), {
			community: makeAppsState({ items: [makeCommunityItem("plugin")] }),
			variant: "plugins",
		});
		expect(html).toContain("First Party");
		expect(html).toContain("Community Plugin");
		expect(html).toContain("From the community");
		expect(html).toContain("Not reviewed by Ryu");
	});

	test("the shelf obeys the tab's apps/plugins split", () => {
		const community = makeAppsState({
			items: [makeCommunityItem("app"), makeCommunityItem("plugin")],
		});
		const appsHtml = render(makeAppsState({ items: [] }), {
			community,
			variant: "apps",
		});
		expect(appsHtml).toContain("Community App");
		expect(appsHtml).not.toContain("Community Plugin");

		const pluginsHtml = render(makeAppsState({ items: [] }), {
			community,
			variant: "plugins",
		});
		expect(pluginsHtml).toContain("Community Plugin");
		expect(pluginsHtml).not.toContain("Community App");
	});

	test("an empty community feed renders no shelf at all", () => {
		const html = render(makeAppsState({ items: [firstParty] }));
		expect(html).toContain("First Party");
		expect(html).not.toContain("From the community");
	});

	test("community rows are browse-only — Details, never Add", () => {
		const html = render(makeAppsState({ items: [] }), {
			community: makeAppsState({ items: [makeCommunityItem("plugin")] }),
			variant: "plugins",
		});
		expect(html).toContain("Community Plugin");
		expect(html).toContain("Details");
	});

	test("the shelf still shows when the first-party feed is empty or failed", () => {
		const community = makeAppsState({ items: [makeCommunityItem("plugin")] });
		const emptyHtml = render(makeAppsState({ items: [] }), {
			community,
			variant: "plugins",
		});
		expect(emptyHtml).toContain("Community Plugin");
		// Nothing matched first-party, but the shelf did — so the "nothing here"
		// empty state must not claim the tab is empty.
		expect(emptyHtml).not.toContain("No plugins found");

		const errorHtml = render(makeAppsState({ error: "boom", items: [] }), {
			community,
			variant: "plugins",
		});
		expect(errorHtml).toContain("Couldn&#x27;t load plugins");
		expect(errorHtml).toContain("boom");
		expect(errorHtml).toContain("Try again");
		expect(errorHtml).toContain("Community Plugin");
	});

	test("a community row is never rendered in the first-party grid", () => {
		// Belt-and-braces: if a source ever leaked an unreviewed row into the
		// first-party feed, it must be dropped there rather than shown bare.
		const html = render(
			makeAppsState({ items: [firstParty, makeCommunityItem("plugin")] }),
			{ variant: "plugins" }
		);
		expect(html).toContain("First Party");
		expect(html).not.toContain("Community Plugin");
	});
});

// A community MARKETPLACE entry carries a grouping stamp (`catalog_source_id` /
// `catalog_source_name` — the `ryu-marketplace` repo it was discovered from), so
// the community area renders it under its marketplace's sub-heading inside a
// bigger "Community Marketplaces" section, instead of in the flat standalone
// shelf. Standalone topic-discovered repos carry no stamp and keep the old shelf.
describe("AppsCatalogSection — community marketplaces", () => {
	function makeMarketplaceEntry(
		name: string,
		marketplace: { id: string; name: string },
		over: Partial<CatalogEntry> = {}
	): AppCatalogItem {
		return makeCommunityItem("plugin", {
			catalog_source_id: marketplace.id,
			catalog_source_name: marketplace.name,
			id: `ghmp:${marketplace.id}:${name}`,
			name,
			...over,
		});
	}

	test("marketplace entries render under a big 'Community Marketplaces' header with a sub-heading per marketplace", () => {
		const html = render(makeAppsState({ items: [] }), {
			community: makeAppsState({
				items: [
					makeMarketplaceEntry("Thing Tool", {
						id: "acme/bazaar",
						name: "The Bazaar",
					}),
					makeMarketplaceEntry("Other Tool", {
						id: "acme/bazaar",
						name: "The Bazaar",
					}),
				],
			}),
			variant: "plugins",
		});
		// The bigger section header and the per-marketplace sub-heading both read.
		expect(html).toContain("Community Marketplaces");
		expect(html).toContain("The Bazaar");
		// Both entries render, and the trust disclosure travels with the section.
		expect(html).toContain("Thing Tool");
		expect(html).toContain("Other Tool");
		expect(html).toContain("Not reviewed by Ryu");
		// A marketplace entry is still browse-only — Details, never Add.
		expect(html).toContain("Details");
		expect(html).not.toContain("From the community");
	});

	test("standalone repos keep the flat 'From the community' shelf", () => {
		const html = render(makeAppsState({ items: [] }), {
			community: makeAppsState({
				items: [makeCommunityItem("plugin")],
			}),
			variant: "plugins",
		});
		expect(html).toContain("From the community");
		expect(html).toContain("Community Plugin");
		expect(html).not.toContain("Community Marketplaces");
	});

	test("marketplace entries and standalone repos render side by side, one notice", () => {
		const html = render(makeAppsState({ items: [] }), {
			community: makeAppsState({
				items: [
					makeMarketplaceEntry("Bazaar Thing", {
						id: "acme/bazaar",
						name: "The Bazaar",
					}),
					makeCommunityItem("plugin", { name: "Solo Plugin" }),
				],
			}),
			variant: "plugins",
		});
		expect(html).toContain("Community Marketplaces");
		expect(html).toContain("The Bazaar");
		expect(html).toContain("Bazaar Thing");
		expect(html).toContain("From the community");
		expect(html).toContain("Solo Plugin");
		// One trust notice covers the whole community area — not one per shelf.
		expect(html.match(/Not reviewed by Ryu/g)?.length).toBe(1);
	});

	test("marketplace entries obey the tab's apps/plugins split", () => {
		const appEntry = makeMarketplaceEntry(
			"Bazaar App",
			{ id: "acme/bazaar", name: "The Bazaar" },
			{ type: "app" }
		);
		const pluginsHtml = render(makeAppsState({ items: [] }), {
			community: makeAppsState({ items: [appEntry] }),
			variant: "plugins",
		});
		expect(pluginsHtml).not.toContain("Bazaar App");

		const appsHtml = render(makeAppsState({ items: [] }), {
			community: makeAppsState({ items: [appEntry] }),
			variant: "apps",
		});
		expect(appsHtml).toContain("Community Marketplaces");
		expect(appsHtml).toContain("The Bazaar");
		expect(appsHtml).toContain("Bazaar App");
	});
});

// The blue check on the card. Three axes live on the same row and merging any
// two of them is the failure this block exists to catch: `reviewed` is "did Ryu
// vet this LISTING's code" and drives the amber community notice,
// `verification` is "did the manifest SIGNATURE verify" (install trust, and the
// axis that owns the bare word `verified` on the web marketplace's wire), and
// `org_verified` is "is the PUBLISHING ORGANIZATION identity-checked" and drives
// this badge. They are independent, so a verified org's unreviewed community
// listing must carry BOTH of the signals this file can see.
//
// Assertions read the badge's `aria-label`, not its tooltip: `TooltipContent`
// goes through a Base UI Portal and so is not emitted by `renderToStaticMarkup`
// at all — which is also why the accessible name is on the trigger span in the
// first place.
describe("AppsCatalogSection — verified organizations", () => {
	test("a verified publisher's listing carries the tier-qualified check", () => {
		const html = render(
			makeAppsState({
				items: [
					makeItem({
						entry: makeEntry({
							name: "Verified Thing",
							org_verified: true,
							org_verified_tier: "official",
						}),
					}),
				],
			})
		);
		expect(html).toContain("Verified Thing");
		expect(html).toContain("Verified organization — Official");
	});

	test("the gold publisher mark is an icon without a badge shell", () => {
		const html = render(
			makeAppsState({
				items: [
					makeItem({
						entry: makeEntry({
							org_verified: true,
							publisher_trust: "gold",
						}),
					}),
				],
			})
		);

		expect(html).toContain("Officially verified by Ryu staff");
		expect(html).not.toContain("t-plan-badge-sheen");
		expect(html).not.toContain("bg-[linear-gradient");
	});

	test("an unknown tier still renders the check, unqualified", () => {
		const html = render(
			makeAppsState({
				items: [
					makeItem({
						entry: makeEntry({
							org_verified: true,
							org_verified_tier: "enterprise-2027",
						}),
					}),
				],
			})
		);
		expect(html).toContain("Verified organization");
		// The raw token is never printed — a tier this build does not know is a
		// missing qualifier, not a label.
		expect(html).not.toContain("enterprise-2027");
	});

	test("no badge when the flag is false, absent, or only a tier is present", () => {
		const off = render(
			makeAppsState({
				items: [makeItem({ entry: makeEntry({ org_verified: false }) })],
			})
		);
		expect(off).not.toContain("Verified organization");

		const absent = render(
			makeAppsState({ items: [makeItem({ entry: makeEntry() })] })
		);
		expect(absent).not.toContain("Verified organization");

		// A tier without the flag is a privilege the server never granted — the
		// same posture `mandatory` takes. It must render nothing.
		const tierOnly = render(
			makeAppsState({
				items: [
					makeItem({ entry: makeEntry({ org_verified_tier: "official" }) }),
				],
			})
		);
		expect(tierOnly).not.toContain("Verified organization");
	});

	test("a verified org's COMMUNITY listing shows both signals at once", () => {
		const html = render(makeAppsState({ items: [] }), {
			community: makeAppsState({
				items: [
					makeCommunityItem("plugin", {
						org_verified: true,
						org_verified_tier: "community",
					}),
				],
			}),
			variant: "plugins",
		});
		expect(html).toContain("Community Plugin");
		// The listing is unreviewed …
		expect(html).toContain("Not reviewed by Ryu");
		// … and its publisher is nonetheless identity-checked. Collapsing the two
		// into one "trusted" flag would drop one of these.
		expect(html).toContain("Verified organization — Community");
	});

	test("a camelCase `orgVerifiedTier` on the CARD does not qualify the badge", () => {
		// The card payload is snake_case (see the casing contract on CatalogEntry).
		// If the producer ever emitted the detail's spelling here, this must lose
		// the qualifier — a visible test failure — rather than silently render an
		// unqualified check that nobody notices.
		const entry = makeEntry({ org_verified: true });
		(entry as unknown as Record<string, unknown>).orgVerifiedTier = "official";
		const html = render(makeAppsState({ items: [makeItem({ entry })] }));
		expect(html).toContain("Verified organization");
		expect(html).not.toContain("Verified organization — Official");
	});
});
