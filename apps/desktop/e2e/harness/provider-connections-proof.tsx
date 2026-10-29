import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { LlmProvidersSettings } from "../../src/components/settings/LlmProvidersSettings.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={new QueryClient()}>
			<Toaster position="bottom-right" theme="system" />
			<main className="min-h-screen bg-background px-5 py-8 text-foreground sm:px-10">
				<div className="mx-auto max-w-4xl space-y-5">
					<header className="space-y-1">
						<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Gateway · LLM providers
						</p>
						<h1 className="font-semibold text-2xl">Provider connections</h1>
					</header>
					<LlmProvidersSettings />
				</div>
			</main>
		</QueryClientProvider>
	);
}
