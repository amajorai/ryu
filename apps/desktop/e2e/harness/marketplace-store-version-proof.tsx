import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import AppsCatalogSection from "../../src/components/store/AppsCatalogSection.tsx";
import { DesktopCatalogHost } from "../../src/components/store/catalog-host.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

useNodeStore.setState({
	nodes: [
		{
			name: "Local",
			url: location.origin,
			token: "store-version-node-token",
			userJwt: "store-version-delegation",
		},
	],
	defaultNode: "Local",
	autoSelect: false,
	autoSelectedNode: null,
	tabOverrides: {},
});
const client = new QueryClient({
	defaultOptions: {
		queries: { retry: false, refetchOnWindowFocus: false },
		mutations: { retry: false },
	},
});
document.documentElement.classList.add("dark");
const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing Store version proof root");
}
createRoot(root).render(
	<QueryClientProvider client={client}>
		<I18nProvider>
			<ThemeProvider attribute="class" defaultTheme="dark">
				<MemoryRouter>
					<EntitlementProvider>
						<TabsProvider initialTab={{ path: "/store/plugins" }}>
							<SkillDistributionProvider>
								<DesktopCatalogHost>
									<main className="h-screen min-h-0 bg-background text-foreground">
										<AppsCatalogSection
											initialSelectedId="com.example.versioned-plugin"
											variant="plugins"
										/>
									</main>
									<Toaster />
								</DesktopCatalogHost>
							</SkillDistributionProvider>
						</TabsProvider>
					</EntitlementProvider>
				</MemoryRouter>
			</ThemeProvider>
		</I18nProvider>
	</QueryClientProvider>
);
