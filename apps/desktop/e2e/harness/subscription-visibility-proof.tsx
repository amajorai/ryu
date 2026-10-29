import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubscriptionUsageDashboard } from "../../src/components/usage/SubscriptionUsageDashboard.tsx";
import { IsActiveTabProvider } from "../../src/contexts/TabsContext.tsx";
import { useActiveNode } from "../../src/hooks/useActiveNode.ts";
import { useSubscriptionCostUsage } from "../../src/hooks/useSubscriptionCostUsage.ts";
import { useSubscriptionUsage } from "../../src/hooks/useSubscriptionUsage.ts";
import { toTarget } from "../../src/lib/api/client.ts";
import type { PiCatalog } from "../../src/lib/api/pi-config.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const node = { name: "usage-proof", url: location.origin, token: null };
useNodeStore.setState({
	localNodes: [node],
	nodes: [node],
	defaultNode: node.name,
});
const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const catalog: PiCatalog = {
	apiTypes: [],
	thinkingLevels: [],
	providers: [
		{
			id: "codex",
			label: "ChatGPT",
			authKind: "subscription",
			api: "",
			authEnv: "",
			configured: true,
			custom: false,
			routing: "direct",
			suggestedModels: [],
			managed: false,
			accounts: [
				{
					accountId: "personal",
					label: "Personal",
					kind: "oauth",
					active: true,
				},
				{
					accountId: "work",
					label: "Work",
					kind: "oauth",
					active: true,
				},
			],
		},
		{
			id: "claude",
			label: "Claude",
			authKind: "subscription",
			api: "",
			authEnv: "",
			configured: true,
			custom: false,
			routing: "direct",
			suggestedModels: [],
			managed: false,
			accounts: [
				{
					accountId: "team",
					label: "Work",
					kind: "oauth",
					active: true,
				},
			],
		},
	],
};

function Usage() {
	const usage = useSubscriptionUsage(catalog);
	const node = useActiveNode();
	const target = useMemo(
		() => toTarget(node),
		[node.token, node.url, node.userJwt]
	);
	const costUsage = useSubscriptionCostUsage(target);
	return (
		<SubscriptionUsageDashboard
			accounts={usage.accounts}
			catalogLoading={false}
			costTrackingError={costUsage.trackingError}
			costTrackingUpdating={costUsage.trackingUpdating}
			costUsage={costUsage.usage}
			costUsageError={costUsage.error}
			costUsageLoading={costUsage.loading}
			onRefresh={() => {
				usage.refresh();
				costUsage.refresh();
			}}
			onSetCostTracking={costUsage.setTrackingEnabled}
			refreshing={usage.refreshing || costUsage.refreshing}
		/>
	);
}
function Story() {
	const [active, setActive] = useState(false);
	return (
		<QueryClientProvider client={client}>
			<main className="min-h-screen bg-background p-8 text-foreground">
				<div className="mb-6 flex gap-2">
					<Button onClick={() => setActive(!active)}>
						{active ? "Hide usage" : "Show usage"}
					</Button>
				</div>
				<IsActiveTabProvider isActive={active}>
					<div hidden={!active}>
						<Usage />
					</div>
				</IsActiveTabProvider>
			</main>
		</QueryClientProvider>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
