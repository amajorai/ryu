import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { TtsEngineSettings } from "../../src/components/settings/TtsEngineSettings.tsx";
import "../../src/index.css";

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={new QueryClient()}>
			<main className="mx-auto mt-20 max-w-3xl rounded-2xl border bg-background p-6 text-foreground shadow-sm">
				<TtsEngineSettings />
			</main>
		</QueryClientProvider>
	);
}
