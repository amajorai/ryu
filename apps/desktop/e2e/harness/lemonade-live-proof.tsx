// Live verification mount: production Engines UI and hooks, talking to an isolated Core.
// Start Core on :47987 with RYU_PROFILE=dev, RYU_KEYCHAIN=off and a dedicated RYU_DIR.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import EnginesCatalogSection from "../../src/components/store/EnginesCatalogSection.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";
import { consumeProofClientToken } from "./proof-client-token.ts";

const node = {
	name: "Lemonade verification",
	url: window.location.origin,
	token: consumeProofClientToken(),
};
useNodeStore.setState({
	nodes: [node],
	defaultNode: node.name,
	getActiveNode: () => node,
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter>
				<main className="h-screen bg-background text-foreground">
					<EnginesCatalogSection />
				</main>
			</MemoryRouter>
		</QueryClientProvider>
	);
}
