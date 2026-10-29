import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import EnginesCatalogSection from "../../src/components/store/EnginesCatalogSection.tsx";
import LibraryPage from "../../src/pages/LibraryPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

const node = {
	name: "Library engine fixture",
	token: "fixture-node-token",
	url: window.location.origin,
};
useNodeStore.setState({
	defaultNode: node.name,
	getActiveNode: () => node,
	nodes: [node],
});
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const root = document.getElementById("root");
const store =
	new URLSearchParams(window.location.search).get("surface") === "store";
if (!root) {
	throw new Error("Library engine fixture root is missing");
}
createRoot(root).render(
	<I18nProvider packs={[]}>
		<QueryClientProvider client={queryClient}>
			<SkillDistributionProvider>
				<main
					aria-label={store ? "Store engines" : "Library"}
					className="h-svh bg-background text-foreground"
				>
					{store ? (
						<EnginesCatalogSection />
					) : (
						<LibraryPage initialSection="engines" />
					)}
				</main>
				<Toaster />
			</SkillDistributionProvider>
		</QueryClientProvider>
	</I18nProvider>
);
