import {
	CpuIcon,
	Download01Icon,
	GridIcon,
	Home01Icon,
	Package01Icon,
	PlugSocketIcon,
	PuzzleIcon,
	Robot01Icon,
	ServerStack01Icon,
	Wallet01Icon,
	WorkflowSquare01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { StoreComingSoon, StoreSectionNav } from "@ryu/blocks/desktop/store";
import { useCallback, useState } from "react";
import { DesktopMarketplaceHost } from "@/src/components/marketplace/host.tsx";
import AccountSection from "@/src/components/store/AccountSection.tsx";
import AgentsCatalogSection from "@/src/components/store/AgentsCatalogSection.tsx";
import AppsCatalogSection from "@/src/components/store/AppsCatalogSection.tsx";
import { DesktopCatalogHost } from "@/src/components/store/catalog-host.tsx";
import EnginesCatalogSection from "@/src/components/store/EnginesCatalogSection.tsx";
import InstalledSection from "@/src/components/store/InstalledSection.tsx";
import McpCatalogSection from "@/src/components/store/McpCatalogSection.tsx";
import ModelsCatalogSection from "@/src/components/store/ModelsCatalogSection.tsx";
import SkillsCatalogSection from "@/src/components/store/SkillsCatalogSection.tsx";
import StoreAsideLayout from "@/src/components/store/StoreAsideLayout.tsx";
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
	| "apps"
	| "plugins"
	| "models"
	| "skills"
	| "mcp"
	| "agents"
	| "workflows"
	| "engines"
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
	// Browse — the per-realm catalogs (Core catalogs + inline paid Marketplace
	// items). Apps = plugins that ship a Companion UI surface; Plugins = the
	// rest (tools/agents/channels/policies + integration descriptors).
	{ value: "apps", label: "Apps", icon: GridIcon, group: "catalog" },
	{
		value: "plugins",
		label: "Plugins",
		icon: PlugSocketIcon,
		group: "catalog",
	},
	{ value: "models", label: "Models", icon: Package01Icon, group: "catalog" },
	{ value: "skills", label: "Skills", icon: PuzzleIcon, group: "catalog" },
	// MCP servers from the official registry (and registries behind the seam).
	{ value: "mcp", label: "MCP", icon: ServerStack01Icon, group: "catalog" },
	{ value: "agents", label: "Agents", icon: Robot01Icon, group: "catalog" },
	// Workflow Templates: ready-made agent-pattern workflows (evaluator-optimizer,
	// routing, orchestrator-workers, the autoresearch git-ledger loop, …).
	{
		value: "workflows",
		label: "Workflows",
		icon: WorkflowSquare01Icon,
		group: "catalog",
	},
	// Engines = all local inference runtimes, grouped inside by modality
	// (Text · Image · Speech · Embeddings). Voice lives here now, not its own tab.
	{ value: "engines", label: "Engines", icon: CpuIcon, group: "catalog" },
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
								<StoreContent
									initialQuery={sectionInitialQuery}
									onOpenRealm={openRealm}
									section={section}
								/>
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
	if (section === "apps") {
		return <AppsCatalogSection initialQuery={initialQuery} variant="apps" />;
	}
	if (section === "plugins") {
		return <AppsCatalogSection initialQuery={initialQuery} variant="plugins" />;
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
		return (
			<StoreAsideLayout>
				<ToolsPage />
			</StoreAsideLayout>
		);
	}
	if (section === "installed") {
		return (
			<StoreAsideLayout>
				<InstalledSection />
			</StoreAsideLayout>
		);
	}
	if (section === "account") {
		return (
			<StoreAsideLayout>
				<AccountSection />
			</StoreAsideLayout>
		);
	}
	const meta = SECTIONS.find((s) => s.value === section);
	return (
		<StoreComingSoon
			icon={meta?.icon ?? GridIcon}
			label={meta?.label ?? "This"}
		/>
	);
}
