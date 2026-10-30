// apps/desktop/src/components/marketplace/ConnectionsTab.tsx
//
// Marketplace → Connections: the global Composio surface. Browse the full
// toolkit catalog, see which accounts are connected, connect new ones (OAuth via
// Composio-managed auth), and drill into a toolkit's actions/triggers. Per the
// connect-on-execute history, connecting here is the *proactive* path — the
// agent editor then attaches already-connected toolkits per agent.
//
// All data lives in Core (`/api/composio/*`); this component is a thin GUI over
// the catalog + connection hooks. The Composio key itself is set in Gateway →
// Keys; when it's missing we surface an actionable prompt instead of empty grids.

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { type ChangeEvent, useMemo, useState } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	useComposioConnections,
	useComposioStatus,
	useComposioToolkits,
} from "@/src/hooks/useComposioCatalog.ts";
import type { ComposioConnection } from "@/src/lib/api/composio.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { OAuthConnections } from "./connections/OAuthConnections.tsx";
import {
	KeyMissingState,
	ToolkitResults,
} from "./connections/ToolkitResults.tsx";

export {
	OAuthConnections,
	OAuthServerCard,
} from "./connections/OAuthConnections.tsx";

export default function ConnectionsTab() {
	const { apps, loading: appsLoading } = useApps();
	const openGateway = useGatewayDialog((state) => state.openGateway);
	const status = useComposioStatus();
	const keyConfigured = status.data?.configured ?? false;

	const toolkits = useComposioToolkits(keyConfigured);
	const connections = useComposioConnections("", keyConfigured);
	const [query, setQuery] = useState("");

	// Map toolkit slug → its connection, preferring an active one.
	const connectionByToolkit = useMemo(() => {
		const map = new Map<string, ComposioConnection>();
		for (const conn of connections.data ?? []) {
			const existing = map.get(conn.toolkit);
			if (!existing || (conn.active && !existing.active)) {
				map.set(conn.toolkit, conn);
			}
		}
		return map;
	}, [connections.data]);

	const filtered = useMemo(() => {
		const term = query.trim().toLowerCase();
		const all = toolkits.data ?? [];
		if (!term) {
			return all;
		}
		return all.filter(
			(t) =>
				t.name.toLowerCase().includes(term) ||
				t.slug.toLowerCase().includes(term) ||
				(t.description?.toLowerCase().includes(term) ?? false)
		);
	}, [toolkits.data, query]);

	const oauthApps = apps.filter(
		(app) => app.enabled && app.mcpOAuthServers.length > 0
	);

	return (
		<div className="mx-auto max-w-5xl px-6 py-6">
			<div className="mb-5">
				<h2 className="font-medium text-lg">Connections</h2>
				<p className="text-muted-foreground text-sm">
					Connect your accounts once here, then attach their tools to any agent.
				</p>
			</div>

			<OAuthConnections apps={oauthApps} loading={appsLoading} />

			<div className="mt-8 mb-4">
				<h3 className="font-medium text-sm">Managed integrations</h3>
				<p className="text-muted-foreground text-xs">
					Additional account connections powered by Composio.
				</p>
			</div>

			{status.isLoading ? <SkeletonRows spacing="status" /> : null}
			{status.isLoading || keyConfigured ? null : (
				<KeyMissingState onOpenKeys={() => openGateway("keys")} />
			)}
			{!status.isLoading && keyConfigured ? (
				<>
					<div className="relative mb-5">
						<HugeiconsIcon
							className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
							icon={Search01Icon}
						/>
						<Input
							aria-label="Search integrations"
							leadingAdornment="default"
							onChange={(e: ChangeEvent<HTMLInputElement>) =>
								setQuery(e.target.value)
							}
							placeholder="Search integrations (Gmail, Slack, GitHub…)"
							value={query}
						/>
					</div>

					<ToolkitResults
						connectionByToolkit={connectionByToolkit}
						error={toolkits.error}
						isLoading={toolkits.isLoading}
						onClearQuery={() => setQuery("")}
						onRetry={() => {
							void toolkits.refetch();
						}}
						query={query}
						toolkits={filtered}
					/>
				</>
			) : null}
		</div>
	);
}
