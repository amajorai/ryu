import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "../../src/contexts/TitleBarContext.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import AgentEditPage from "../../src/pages/AgentEditPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const node = {
	name: "Isolated editor proof",
	url: window.location.origin,
	token: null,
};
useNodeStore.setState({
	nodes: [node],
	defaultNode: node.name,
	getActiveNode: () => node,
});
// The proof walks the full editor's tabs (Health among them). Without Console
// access the product mode resolves to Bot, whose essentials-only editor has
// no Health tab, so grant it the way a local, unbound node does.
useProductModeStore.setState({ consoleAccess: true, requestedMode: "console" });
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<EntitlementProvider>
					<TabsProvider
						initialTab={{
							path: "/library/agent/proof-agent/edit",
							title: "Edit agent",
						}}
					>
						<TitleBarProvider>
							<AgentEditPage agentIdProp="proof-agent" />
						</TitleBarProvider>
					</TabsProvider>
				</EntitlementProvider>
			</MemoryRouter>
		</QueryClientProvider>
	);
}
