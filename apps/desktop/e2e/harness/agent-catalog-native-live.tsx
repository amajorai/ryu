import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import AgentsCatalogSection from "../../src/components/store/AgentsCatalogSection.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={new QueryClient()}>
			<Toaster position="bottom-right" theme="system" />
			<main className="min-h-screen bg-background p-6 text-foreground">
				<AgentsCatalogSection
					initialQuery="Kiro"
					initialSelectedId="acp:kiro"
				/>
			</main>
		</QueryClientProvider>
	);
}
