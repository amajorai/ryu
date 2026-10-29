import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { DangerZoneSettings } from "../../src/components/settings/DangerZoneSettings.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { installDangerZoneFetch } from "./desktop-danger-zone-proof.mock.ts";
import "../../src/index.css";

const restoreFetch = installDangerZoneFetch();
window.addEventListener("pagehide", restoreFetch, { once: true });

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing root");
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: 0 } },
});

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<AppSurfaceProvider surface="desktop">
			<div className="min-h-screen bg-background text-foreground">
				<main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-8">
					<header>
						<p className="mb-2 text-primary text-xs tracking-(--tracking-section)">
							RYU · DESKTOP SETTINGS
						</p>
						<h1 className="font-medium text-3xl">Danger zone</h1>
						<p className="mt-2 text-muted-foreground text-sm">
							Destructive settings against the active node.
						</p>
					</header>
					<DangerZoneSettings />
				</main>
				<Toaster position="bottom-right" theme="dark" />
			</div>
		</AppSurfaceProvider>
	</QueryClientProvider>
);
