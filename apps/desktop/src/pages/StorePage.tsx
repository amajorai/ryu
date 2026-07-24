import {
	CpuIcon,
	Download01Icon,
	GridIcon,
	Home01Icon,
	Link01Icon,
	UserGroupIcon,
	Wallet01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { StoreComingSoon, StoreSectionNav } from "@ryu/blocks/desktop/store";
import { StoreCatalogHeaderProvider } from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { REALM_ICONS } from "@ryu/marketplace/catalog/realm-icons";
import { useCallback, useState } from "react";
import { DesktopMarketplaceHost } from "@/src/components/marketplace/host.tsx";
import AccountSection from "@/src/components/store/AccountSection.tsx";
import AgentsCatalogSection from "@/src/components/store/AgentsCatalogSection.tsx";
import AppsCatalogSection from "@/src/components/store/AppsCatalogSection.tsx";
import { DesktopCatalogHost } from "@/src/components/store/catalog-host.tsx";
import EnginesCatalogSection from "@/src/components/store/EnginesCatalogSection.tsx";
import InstalledSection from "@/src/components/store/InstalledSection.tsx";
import IntegrationsCatalogSection from "@/src/components/store/IntegrationsCatalogSection.tsx";
import McpCatalogSection from "@/src/components/store/McpCatalogSection.tsx";
import ModelsCatalogSection from "@/src/components/store/ModelsCatalogSection.tsx";
import SkillsCatalogSection from "@/src/components/store/SkillsCatalogSection.tsx";
import StoreHome from "@/src/components/store/StoreHome.tsx";
import StoreSearchResults from "@/src/components/store/StoreSearchResults.tsx";
import {
	type StoreToolbarConfig,
	StoreToolbarProvider,
} from "@/src/components/store/storeToolbar.tsx";
import WorkflowTemplatesSection from "@/src/components/store/WorkflowTemplatesSection.tsx";
import {
	type StoreSearchRealm,
	useStoreSearch,
} from "@/src/hooks/useStoreSearch.ts";
import ToolsPage from "@/src/pages/ToolsPage.tsx";

type StoreSection =
	| "home"
	| "integrations"
	| "apps"
	| "plugins"
	| "models"
	| "skills"
	| "mcp"
	| "agents"
	| "workflows"
	| "engines"
	| "community"
	| "tools"
	| "installed"
	| "account";

const SECTIONS: {
	value: StoreSection;
	label: string;
	icon: IconSvgElement;
	group: string;
}[] = [
	// Home: the app-store landing — featured rail + a row per realm, so
	// "everything" has one front door before the per-realm sections. The
	// store-wide search lives in the nav rail, above the section list.
	{ value: "home", label: "Home", icon: Home01Icon, group: "discover" },
	// Integrations: the brand-first front door — one card per service (Notion,
	// Slack, …) merged from the integrations.sh directory and Composio's toolkit
	// catalog. Opening a brand surfaces every related Skill/MCP/Plugin in one
	// place. Sits first in the browse cluster, so the group divider falls between
	// Home and it — one separator, then Integrations atop the per-realm catalogs.
	{
		value: "integrations",
		label: "Integrations",
		icon: Link01Icon,
		group: "catalog",
	},
	// Browse — the per-realm catalogs (Core catalogs + inline paid Marketplace
	// items). Apps = plugins that ship a Companion UI surface; Plugins = the
	// rest (tools/agents/channels/policies + integration descriptors).
	{ value: "apps", label: "Apps", icon: REALM_ICONS.apps, group: "catalog" },
	{
		value: "plugins",
		label: "Plugins",
		icon: REALM_ICONS.plugins,
		group: "catalog",
	},
	{
		value: "models",
		label: "Models",
		icon: REALM_ICONS.models,
		group: "catalog",
	},
	{
		value: "skills",
		label: "Skills",
		icon: REALM_ICONS.skills,
		group: "catalog",
	},
	// MCP servers from the official registry (and registries behind the seam).
	{ value: "mcp", label: "MCP", icon: REALM_ICONS.mcp, group: "catalog" },
	{
		value: "agents",
		label: "Agents",
		icon: REALM_ICONS.agents,
		group: "catalog",
	},
	// Workflow Templates: ready-made agent-pattern workflows (evaluator-optimizer,
	// routing, orchestrator-workers, the autoresearch git-ledger loop, …).
	{
		value: "workflows",
		label: "Workflows",
		icon: REALM_ICONS.workflows,
		group: "catalog",
	},
	// Engines = all local inference runtimes, grouped inside by modality
	// (Text · Image · Speech · Embeddings). Voice lives here now, not its own tab.
	{ value: "engines", label: "Engines", icon: CpuIcon, group: "catalog" },
	// Community: third-party apps + plugins discovered from the public GitHub
	// topics `ryu-app` / `ryu-plugin`. Its OWN group, so the nav rail draws a
	// divider before it — unreviewed listings must read as a separate cluster,
	// not as a peer of the first-party catalogs above.
	{
		value: "community",
		label: "Community",
		icon: UserGroupIcon,
		group: "community",
	},
	// Manage — what you already have installed, and the nodes running it.
	// Tools = the MCP servers registered on this node and the tools they expose
	// (browse the catalog under "MCP"; manage + invoke the registered ones here).
	{ value: "tools", label: "Tools", icon: Wrench01Icon, group: "manage" },
	// Cross-node health + per-node sidecar controls live in the node selector
	// (shell); this section covers everything installed on the active node.
	{
		value: "installed",
		label: "Installed",
		icon: Download01Icon,
		group: "manage",
	},
	// Account — Marketplace money layer: licenses, selling, connections.
	{ value: "account", label: "Account", icon: Wallet01Icon, group: "account" },
];

function isStoreSection(value: string): value is StoreSection {
	return SECTIONS.some((s) => s.value === value);
}

/** Per-section two-line header (title + one-line description), shown above the
 *  active section's content pane. The typography mirrors the onboarding card
 *  headers (`onboarding.tsx` FeatureStep): a foreground `font-semibold text-lg`
 *  title over a muted `text-sm` subtext, so the whole app reads as one system. */
const SECTION_HEADERS: Record<
	StoreSection,
	{ title: string; subtitle: string }
> = {
	home: {
		title: "Home",
		subtitle: "Featured picks and fresh arrivals from across the marketplace.",
	},
	integrations: {
		title: "Integrations",
		subtitle:
			"Find the service you use, then everything that connects to it in one place.",
	},
	apps: {
		title: "Apps",
		subtitle: "Plugins that ship a companion interface you open inside Ryu.",
	},
	plugins: {
		title: "Plugins",
		subtitle: "Tools, agents, channels, and integrations that extend Ryu.",
	},
	models: {
		title: "Models",
		subtitle: "Download and manage local models to run inference on-device.",
	},
	skills: {
		title: "Skills",
		subtitle: "Reusable instructions your agents load on demand for a task.",
	},
	mcp: {
		title: "MCP",
		subtitle:
			"Connect Model Context Protocol servers to give agents new tools.",
	},
	agents: {
		title: "Agents",
		subtitle: "Prebuilt agents you can install and start using in one click.",
	},
	workflows: {
		title: "Workflows",
		subtitle: "Ready-made automation templates built on proven agent patterns.",
	},
	engines: {
		title: "Engines",
		subtitle:
			"Local inference runtimes for text, image, speech, and embeddings.",
	},
	community: {
		title: "Community",
		subtitle:
			"Third-party apps and plugins discovered from GitHub. Not reviewed by Ryu.",
	},
	tools: {
		title: "Tools",
		subtitle: "Manage and invoke the MCP tools registered on this node.",
	},
	installed: {
		title: "Installed",
		subtitle: "Everything installed on the active node, gathered in one place.",
	},
	account: {
		title: "Account",
		subtitle: "Licenses, connections, and the marketplace money layer.",
	},
};

function StoreSectionHeader({ section }: { section: StoreSection }) {
	const header = SECTION_HEADERS[section];
	return (
		<div className="shrink-0 px-4 pt-4 pb-3">
			<p className="font-semibold text-lg">{header.title}</p>
		</div>
	);
}

/** Sections that render inside {@link StoreCatalogLayout} — a centered, max-width
 *  card grid with a preview aside. For these the header lives INSIDE the layout
 *  column (via {@link StoreCatalogHeaderProvider}) so title, search and cards
 *  stay aligned even when the aside opens; the rest keep a full-width header. */
const CATALOG_SECTIONS = new Set<StoreSection>([
	"integrations",
	"apps",
	"plugins",
	"skills",
	"mcp",
	"agents",
	"workflows",
	// Community renders the same card/preview shape as Apps/Plugins, so its header
	// belongs INSIDE the centered layout column — omitting it here would render the
	// title twice (see the note below).
	"community",
	// Manage sections converted to the same App Store card/preview shape — their
	// header lives inside the centered layout column too, so it must NOT also get
	// the outer full-width StoreSectionHeader (that would render the title twice).
	"engines",
	"tools",
	"installed",
]);

/**
 * Unified Store shell, App Store-shaped: a full-width content pane above a
 * floating bottom toolbar (StoreSectionNav — the same pattern as the Library
 * page). The bar carries the section pills (grouped by purpose), the store-wide
 * search folded in, and — for the Models tab only — the rich filter panel. The
 * section is decided once on mount from `initialSection` (driven by the tab path
 * in Layout) and switched in-place from the bar. Typing in the folded search
 * shows aggregated cross-realm results in place of the section; picking a result
 * opens that realm with the query carried over. The Models tab publishes its own
 * filters up into the bar through {@link StoreToolbarProvider}.
 */
export default function StorePage({
	initialSection = "home",
	initialQuery,
}: {
	initialSection?: string;
	/** Seed the active section's search (deep-links carry it, e.g. the
	 *  integrations.sh → MCP-catalog hand-off pre-filters by server name). */
	initialQuery?: string;
}) {
	const [section, setSection] = useState<StoreSection>(
		isStoreSection(initialSection) ? initialSection : "home"
	);

	// Store-wide search, live from any section via the nav rail. A non-empty
	// query takes over the content pane with aggregated results.
	const [searchQuery, setSearchQuery] = useState("");
	const search = useStoreSearch(searchQuery);

	// When a store-wide search result opens a realm, the query rides along as that
	// section's initial search; cleared whenever a section is picked manually.
	const [sectionInitialQuery, setSectionInitialQuery] = useState<
		string | undefined
	>(initialQuery);

	// The active section publishes its toolbar here; the floating bottom nav
	// (StoreSectionNav) renders it as its expandable filter panel.
	const [toolbar, setToolbar] = useState<StoreToolbarConfig | null>(null);

	const openRealm = (realm: StoreSearchRealm, query: string) => {
		setSectionInitialQuery(query.trim() || undefined);
		setSearchQuery("");
		setSection(realm);
	};

	const selectSection = useCallback((value: string) => {
		if (isStoreSection(value)) {
			setSectionInitialQuery(undefined);
			setSearchQuery("");
			setSection(value);
		}
	}, []);

	const searching = search.hasQuery || searchQuery.trim().length > 0;
	// Between the first keystroke and the debounced query firing, show the
	// spinner instead of a premature "Nothing found".
	const searchPending = searchQuery.trim().length > 0 && !search.hasQuery;

	// The Models tab keeps its original full-width master-detail layout and
	// publishes its rich filters into the floating bottom bar's expandable panel;
	// every other (carded) section folds its filters into its own top toolbar, so
	// only Models lights up the bottom bar's filter toggle.
	const usesBottomFilterBar = section === "models";

	return (
		<DesktopMarketplaceHost>
			<DesktopCatalogHost>
				<StoreToolbarProvider value={setToolbar}>
					<div className="relative flex h-full flex-col overflow-hidden pt-12">
						<div className="min-h-0 min-w-0 flex-1 overflow-hidden">
							{searching ? (
								<StoreSearchResults
									groups={search.groups}
									isEmpty={search.isEmpty}
									loading={search.loading || searchPending}
									onOpenRealm={(realm) => openRealm(realm, searchQuery)}
								/>
							) : (
								<div className="flex h-full flex-col">
									{/* Catalog sections render their header INSIDE the centered
									    layout column (via the provider); Home renders its own
									    centered header. Only full-width master-detail sections
									    (Models, Tools, …) get the inline full-width header here. */}
									{CATALOG_SECTIONS.has(section) ||
									section === "home" ? null : (
										<StoreSectionHeader section={section} />
									)}
									<div className="min-h-0 flex-1 overflow-hidden">
										<StoreCatalogHeaderProvider
											header={<StoreSectionHeader section={section} />}
										>
											<StoreContent
												initialQuery={sectionInitialQuery}
												onOpenRealm={openRealm}
												section={section}
											/>
										</StoreCatalogHeaderProvider>
									</div>
								</div>
							)}
						</div>
						{/* Floating bottom toolbar — same pattern as the Library page
						    (StoreSectionNav): the section pills, the store-wide search
						    folded in, and (Models only) the rich filter panel. */}
						<StoreSectionNav
							active={section}
							onSelect={selectSection}
							panel={usesBottomFilterBar ? toolbar?.panel : undefined}
							panelIcon={usesBottomFilterBar ? toolbar?.panelIcon : undefined}
							panelLabel={usesBottomFilterBar ? toolbar?.panelLabel : undefined}
							search={{
								value: searchQuery,
								onChange: setSearchQuery,
								placeholder: "Search the whole marketplace…",
							}}
							sections={SECTIONS}
						/>
					</div>
				</StoreToolbarProvider>
			</DesktopCatalogHost>
		</DesktopMarketplaceHost>
	);
}

function StoreContent({
	section,
	initialQuery,
	onOpenRealm,
}: {
	section: StoreSection;
	/** Seed query carried over from the store-wide search (searchable realms only). */
	initialQuery?: string;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
}) {
	if (section === "home") {
		return <StoreHome onOpenRealm={onOpenRealm} />;
	}
	if (section === "integrations") {
		return (
			<IntegrationsCatalogSection
				initialQuery={initialQuery}
				onOpenRealm={onOpenRealm}
			/>
		);
	}
	if (section === "apps") {
		return <AppsCatalogSection initialQuery={initialQuery} variant="apps" />;
	}
	if (section === "plugins") {
		return <AppsCatalogSection initialQuery={initialQuery} variant="plugins" />;
	}
	if (section === "community") {
		return (
			<AppsCatalogSection initialQuery={initialQuery} variant="community" />
		);
	}
	if (section === "models") {
		return <ModelsCatalogSection initialQuery={initialQuery} />;
	}
	if (section === "skills") {
		return <SkillsCatalogSection initialQuery={initialQuery} />;
	}
	if (section === "mcp") {
		return <McpCatalogSection initialQuery={initialQuery} />;
	}
	if (section === "agents") {
		return <AgentsCatalogSection initialQuery={initialQuery} />;
	}
	if (section === "workflows") {
		return <WorkflowTemplatesSection initialQuery={initialQuery} />;
	}
	if (section === "engines") {
		return <EnginesCatalogSection />;
	}
	if (section === "tools") {
		return <ToolsPage />;
	}
	if (section === "installed") {
		return <InstalledSection />;
	}
	if (section === "account") {
		return <AccountSection />;
	}
	const meta = SECTIONS.find((s) => s.value === section);
	return (
		<StoreComingSoon
			icon={meta?.icon ?? GridIcon}
			label={meta?.label ?? "This"}
		/>
	);
}
