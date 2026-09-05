import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GeneralTab } from "../../src/components/settings/GeneralTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
				<main className="min-h-dvh overflow-auto bg-background p-8 text-foreground">
					<div className="mx-auto flex max-w-4xl flex-col gap-6">
						<header className="rounded-2xl border bg-card p-6 shadow-sm">
							<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
								Desktop settings · legal notices
							</p>
							<h1 className="mt-2 font-semibold text-2xl">General settings</h1>
							<p className="mt-2 text-muted-foreground text-sm">
								Review the bundled dependency notices from the bottom of
								General.
							</p>
						</header>
						<section className="rounded-2xl border bg-card p-6 shadow-sm">
							<GeneralTab />
						</section>
					</div>
				</main>
			</ThemeProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<I18nProvider>
				<MemoryRouter>
					<ProofSurface />
				</MemoryRouter>
			</I18nProvider>
		</QueryClientProvider>
	);
}
