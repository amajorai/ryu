import { Package01Icon } from "@hugeicons/core-free-icons";
import { StoreComingSoon } from "@ryu/blocks/desktop/store.tsx";
import { MARKETPLACE_SECTION_TABS } from "@ryu/marketplace/catalog/chrome/marketplace-sections";
import { CreatorsTab } from "@ryu/marketplace/creators";
import type { MarketplaceCreatorListing } from "@ryu/marketplace/creators/types";
import ConnectionsTab from "@/src/components/marketplace/ConnectionsTab.tsx";
import LicensesTab from "@/src/components/marketplace/LicensesTab.tsx";
import SellTab from "@/src/components/marketplace/SellTab.tsx";
import AgentsCatalogSection from "@/src/components/store/AgentsCatalogSection.tsx";
import AppsCatalogSection from "@/src/components/store/AppsCatalogSection.tsx";
import ContributedStoreSection from "@/src/components/store/ContributedStoreSection.tsx";
import EnginesCatalogSection from "@/src/components/store/EnginesCatalogSection.tsx";
import IntegrationsCatalogSection from "@/src/components/store/IntegrationsCatalogSection.tsx";
import MarketplaceBrowseSection from "@/src/components/store/MarketplaceBrowseSection.tsx";
import MarketplacesCatalogSection from "@/src/components/store/MarketplacesCatalogSection.tsx";
import McpCatalogSection from "@/src/components/store/McpCatalogSection.tsx";
import ModelsCatalogSection from "@/src/components/store/ModelsCatalogSection.tsx";
import SkillsCatalogSection from "@/src/components/store/SkillsCatalogSection.tsx";
import StoreHome from "@/src/components/store/StoreHome.tsx";
import { WallpaperCatalogSection } from "@/src/components/wallpaper/WallpaperCatalogSection.tsx";
import type { StoreSearchRealm } from "@/src/hooks/useStoreSearch.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import {
	type StoreSection,
	WALLPAPERS_STORE_SECTION,
} from "./store-sections.ts";

/** The active Store section's body: a built-in catalog, a money tab, or an
 *  app-registered tab rendered from its declarative spec. */
export function StoreContent({
	section,
	initialQuery,
	initialSelectedId,
	initialMarketplaceItem,
	onOpenRealm,
	onOpenConnections,
	onOpenInstallChat,
	onOpenMarketplaceItem,
	onOpenAgentAccountAccess,
	onBrowseHome,
	contributedTab,
}: {
	/** The app-registered tab this section belongs to, if it is not a built-in. */
	contributedTab: PluginStoreTab | null;
	section: StoreSection;
	/** Seed query carried over from the store-wide search (searchable realms only). */
	initialQuery?: string;
	/** Open this item's preview on arrival — a Home shelf card's id. Forwarded only
	 *  to the six sections that own a per-item preview; Integrations, Engines,
	 *  Account and app-registered tabs have no such concept. */
	initialSelectedId?: string;
	/** One-shot Marketplace result forwarded to the cross-kind paid Browse view. */
	initialMarketplaceItem?: { id: string; kind: string };
	onOpenRealm: (
		realm: StoreSearchRealm,
		query: string,
		itemId?: string
	) => void;
	onOpenConnections: () => void;
	onOpenInstallChat: (prompt: string) => void;
	onOpenMarketplaceItem: (listing: MarketplaceCreatorListing) => void;
	/** Open an installed Agent Template's editor at Account access. */
	onOpenAgentAccountAccess: (agent: { id: string; name: string }) => void;
	onBrowseHome: () => void;
}) {
	if (section === WALLPAPERS_STORE_SECTION) {
		return (
			<WallpaperCatalogSection initialQuery={initialQuery} mode="marketplace" />
		);
	}
	if (section === "home") {
		return <StoreHome onOpenRealm={onOpenRealm} />;
	}
	if (section === "bundles") {
		return <MarketplaceBrowseSection onlyKind="bundle" />;
	}
	if (section === "integrations") {
		return (
			<IntegrationsCatalogSection
				initialQuery={initialQuery}
				onOpenConnections={onOpenConnections}
				onOpenInstallChat={onOpenInstallChat}
				onOpenRealm={onOpenRealm}
			/>
		);
	}
	if (section === "apps") {
		return (
			<AppsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
				variant="apps"
			/>
		);
	}
	if (section === "plugins") {
		return (
			<AppsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
				variant="plugins"
			/>
		);
	}
	if (section === "models") {
		return (
			<ModelsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "skills") {
		return (
			<SkillsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "mcp") {
		return (
			<McpCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
			/>
		);
	}
	if (section === "agents") {
		return (
			<AgentsCatalogSection
				initialQuery={initialQuery}
				initialSelectedId={initialSelectedId}
				onOpenAgentAccountAccess={onOpenAgentAccountAccess}
			/>
		);
	}
	if (section === "creators") {
		return (
			<div className="mx-auto w-full max-w-4xl px-4 pt-2">
				<CreatorsTab onOpenListing={onOpenMarketplaceItem} />
			</div>
		);
	}
	if (section === "engines") {
		return <EnginesCatalogSection />;
	}
	if (section === "workflows") {
		if (contributedTab) {
			return (
				<ContributedStoreSection
					initialQuery={initialQuery}
					tab={contributedTab}
				/>
			);
		}
		return <MarketplaceBrowseSection onlyKind="workflow" />;
	}
	if (section === "themes") {
		return <MarketplaceBrowseSection onlyKind="theme" />;
	}
	if (section === "marketplaces") {
		return <MarketplacesCatalogSection />;
	}
	if (section === "browse") {
		return (
			<MarketplaceBrowseSection
				initialItem={initialMarketplaceItem}
				initialQuery={initialQuery}
			/>
		);
	}
	if (section === "connections") {
		return <ConnectionsTab />;
	}
	if (section === "licenses") {
		return <LicensesTab />;
	}
	if (section === "sell") {
		return <SellTab />;
	}
	// App-registered tab. EVERY one renders from its declarative spec — there is no
	// per-plugin component table any more. The Workflows tab was the last holder of
	// one, purely so its preview could draw the template graph; that is now the
	// `spec.detail.graph` primitive, which any app can declare (see
	// `ContributedStoreSection`). A first-party escape hatch here is exactly what
	// makes a "you can own a Store section" promise untrue for everyone else.
	if (contributedTab) {
		return (
			<ContributedStoreSection
				initialQuery={initialQuery}
				tab={contributedTab}
			/>
		);
	}
	const meta = MARKETPLACE_SECTION_TABS.find((s) => s.value === section);
	return (
		<StoreComingSoon
			icon={meta?.icon ?? Package01Icon}
			label={meta?.label ?? "This"}
			onBrowse={onBrowseHome}
		/>
	);
}
