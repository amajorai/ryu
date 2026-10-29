import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import IdentitiesPage from "../../src/pages/IdentitiesPage.tsx";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<main className="h-screen bg-background text-foreground">
				<IdentitiesPage initialProfileId="work" />
			</main>
		</QueryClientProvider>
	);
}
