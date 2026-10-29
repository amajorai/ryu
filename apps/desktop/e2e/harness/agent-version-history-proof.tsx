import { I18nProvider } from "@ryu/i18n/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "../../src/contexts/TitleBarContext.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import AgentEditPage from "../../src/pages/AgentEditPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const nodes = ["a", "b"].map((scope) => ({
	name: `version-scope-${scope}`,
	url: `${window.location.origin}/scope-${scope}`,
	token: `version-bearer-${scope}`,
	userJwt: `version-user-${scope}`,
	managed: false,
	orgId: null,
}));
useNodeStore.setState({
	nodes,
	localNodes: nodes,
	defaultNode: nodes[0]!.name,
});
useProductModeStore.setState({ consoleAccess: true, requestedMode: "console" });
queryClient.clear();
queryClient.setDefaultOptions({
	queries: { retry: false, refetchOnWindowFocus: false },
});
function Fixture() {
	return (
		<AppSurfaceProvider surface="desktop">
			<I18nProvider>
				<MemoryRouter>
					<QueryClientProvider client={queryClient}>
						<EntitlementProvider>
							<TabsProvider
								initialTab={{
									path: "/library/agent/version-proof/edit",
									title: "Version restore proof",
								}}
							>
								<TitleBarProvider>
									<nav aria-label="Fixture authority">
										<button
											type="button"
											onClick={() =>
												useNodeStore.setState({ defaultNode: nodes[1]!.name })
											}
										>
											Use scope B
										</button>
									</nav>
									<AgentEditPage agentIdProp="version-proof" />
								</TitleBarProvider>
							</TabsProvider>
						</EntitlementProvider>
					</QueryClientProvider>
				</MemoryRouter>
			</I18nProvider>
		</AppSurfaceProvider>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing actual agent editor proof root");
createRoot(root).render(<Fixture />);
