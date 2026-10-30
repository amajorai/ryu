// apps/desktop/src/components/store/IntegrationsCatalogSection.tsx
//
// The Integrations Store tab: a brand-first front door. One card per service
// (Notion, Slack, GitHub, …), merged by Core from the integrations.sh directory,
// Composio's toolkit catalog, and the public tool catalogs (Ryu's own and
// Treg's, each row labelled by source). Selecting a
// brand opens a preview that gathers
// everything which connects to it — Skills, MCP servers, Plugins, Agents — by
// running the store-wide search for the brand name and grouping the hits per
// realm, each with a "See all" jump into that realm's own tab (pre-filtered).
//
// The brand card itself is still a pointer rather than an installable unit, but
// its preview is NOT read-only: every normalized provider option carries the
// action it can honestly take — connect, import REST/GraphQL, find an MCP
// server, or open an agent setup chat. The catalog stays one list even when a
// service exists in only one source.

import StoreCatalogLayout from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { useState } from "react";
import { useIntegrationsCatalog } from "@/src/hooks/useIntegrationsCatalog.ts";
import type { StoreSearchRealm } from "@/src/hooks/useStoreSearch.ts";
import { IntegrationDetailPanel } from "./IntegrationsCatalogSection-detail.tsx";
import { IntegrationList } from "./IntegrationsCatalogSection-list.tsx";

export default function IntegrationsCatalogSection({
	initialQuery = "",
	onOpenRealm,
	onOpenConnections,
	onOpenInstallChat,
}: {
	initialQuery?: string;
	onOpenRealm: (realm: StoreSearchRealm, query: string) => void;
	onOpenConnections: () => void;
	onOpenInstallChat: (prompt: string) => void;
}) {
	const {
		integrations,
		loading,
		error,
		fetchNextPage,
		hasNextPage,
		loadingMore,
		query,
		setQuery,
	} = useIntegrationsCatalog(initialQuery);

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = integrations.find((it) => it.id === selectedId) ?? null;

	return (
		<StoreCatalogLayout
			detail={
				selected ? (
					<IntegrationDetailPanel
						brand={selected}
						onOpenConnections={onOpenConnections}
						onOpenInstallChat={onOpenInstallChat}
						onOpenRealm={onOpenRealm}
					/>
				) : null
			}
			detailTitle={selected?.name ?? "Integration"}
			hasSelection={selected != null}
			list={
				<IntegrationList
					error={error}
					fetchNextPage={fetchNextPage}
					hasNextPage={hasNextPage}
					integrations={integrations}
					loading={loading}
					loadingMore={loadingMore}
					onClearSearch={() => setQuery("")}
					onRetry={fetchNextPage}
					onSelect={setSelectedId}
					selectedId={selectedId}
				/>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search integrations (Notion, Slack, GitHub…)",
			}}
		/>
	);
}
