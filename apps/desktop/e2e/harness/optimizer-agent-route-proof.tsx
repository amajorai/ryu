import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { TitleBarProvider } from "../../src/contexts/TitleBarContext.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { queryClient } from "../../src/lib/query-client.ts";
import AgentEditPage from "../../src/pages/AgentEditPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import "../../src/index.css";

const route = "/agents/optimizer-browser-agent/edit";
const node = {
	name: "Isolated optimizer node",
	url: window.location.origin,
	token: "synthetic-optimizer-node",
	userJwt: "synthetic-optimizer-user",
	managed: false,
	orgId: null,
};
useNodeStore.setState({
	nodes: [node],
	localNodes: [node],
	defaultNode: node.name,
});
useWorkspaceStore.setState({ folder: null });
// Optimizations live in the advanced editor tier, which Bot hides. A local,
// unmanaged node is granted Console by the app's access gate (App.tsx), so
// open the editor as that Console user would see it.
useProductModeStore.setState({ consoleAccess: true, requestedMode: "console" });
queryClient.clear();
const element = document.getElementById("root");
if (!element) {
	throw new Error("Agent route proof root missing");
}
createRoot(element).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<MemoryRouter initialEntries={[route]}>
				<AppSurfaceProvider surface="desktop">
					<EntitlementProvider>
						<ThemeProvider
							attribute="class"
							defaultTheme="dark"
							enableSystem={false}
						>
							<TabsProvider
								initialTab={{ path: route, title: "Agent settings" }}
							>
								<TitleBarProvider>
									<main className="min-h-screen bg-background px-6 py-8 text-foreground">
										<Routes>
											<Route
												element={<AgentEditPage />}
												path="/agents/:agentId/edit"
											/>
										</Routes>
										<Toaster position="bottom-right" theme="dark" />
									</main>
								</TitleBarProvider>
							</TabsProvider>
						</ThemeProvider>
					</EntitlementProvider>
				</AppSurfaceProvider>
			</MemoryRouter>
		</QueryClientProvider>
	</I18nProvider>
);
