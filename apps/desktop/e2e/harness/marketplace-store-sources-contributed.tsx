import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import ContributedStoreSection from "../../src/components/store/ContributedStoreSection.tsx";
import MarketplacesCatalogSection from "../../src/components/store/MarketplacesCatalogSection.tsx";
import { usePluginContributions } from "../../src/hooks/usePluginContributions.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import StorePage from "../../src/pages/StorePage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { DesktopMarketplaceHost } from "./marketplace-store-catalogs-host.tsx";
import "../../src/index.css";
queryClient.setDefaultOptions({
	queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
});
const fixtureNode = {
	name: "Local Marketplace fixture",
	token: "fixture-node-token",
	url: location.origin,
};
useNodeStore.setState({
	defaultNode: fixtureNode.name,
	nodes: [fixtureNode],
	getActiveNode: () => fixtureNode,
});
function Catalog() {
	const { store_tabs } = usePluginContributions();
	const tab = store_tabs[0];
	return tab ? <ContributedStoreSection tab={tab} /> : null;
}
const element = document.getElementById("root");
if (!element) {
	throw new Error("Missing Store proof root");
}
createRoot(element).render(
	<I18nProvider packs={[]}>
		<QueryClientProvider client={queryClient}>
			<main className="h-svh bg-background text-foreground">
				{new URLSearchParams(location.search).get("host") === "store" ? (
					<DesktopMarketplaceHost>
						<StorePage
							initialSection={
								new URLSearchParams(location.search).get("section") ??
								"marketplaces"
							}
						/>
					</DesktopMarketplaceHost>
				) : new URLSearchParams(location.search).get("section") ===
					"marketplaces" ? (
					<MarketplacesCatalogSection />
				) : (
					<Catalog />
				)}
			</main>
			<Toaster position="bottom-right" theme="dark" />
		</QueryClientProvider>
	</I18nProvider>
);
