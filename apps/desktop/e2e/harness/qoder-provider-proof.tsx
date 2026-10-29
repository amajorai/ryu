import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RyuPiConfig } from "../../src/components/agents/RyuPiConfig.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<main className="mx-auto my-12 max-w-3xl p-6">
				<RyuPiConfig />
			</main>
		</QueryClientProvider>
	);
}
