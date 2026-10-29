import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { UsageHistoryDashboard } from "../../src/components/usage/UsageHistoryDashboard.tsx";
import "@fontsource-variable/inter";
import "@fontsource-variable/geist";
import "./usage-history-proof.css";

const client = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={client}>
			<main className="min-h-screen bg-background p-5 text-foreground sm:p-8">
				<div className="mx-auto max-w-6xl">
					<UsageHistoryDashboard
						target={{ url: window.location.origin, token: null, userJwt: null }}
					/>
				</div>
			</main>
		</QueryClientProvider>
	);
}
