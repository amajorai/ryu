import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SidebarBrandBadge } from "../../src/components/layout/SidebarBrandBadge.tsx";
import { GeneralTab } from "../../src/components/settings/GeneralTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function ProofSurface() {
	return (
		<AppSurfaceProvider surface="desktop">
			<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
				<main
					className="min-h-dvh bg-background p-8 text-foreground"
					data-testid="startup-realm-proof"
				>
					<div className="mx-auto flex max-w-5xl flex-col gap-6">
						<header className="flex items-start justify-between gap-6 rounded-2xl border bg-card p-6 shadow-sm">
							<div>
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
									Desktop settings verification
								</p>
								<h1 className="mt-2 font-semibold text-2xl">Startup realm</h1>
								<p className="mt-2 max-w-xl text-muted-foreground text-sm">
									The startup choice controls the next launch; the current realm
									stays unchanged until the app is relaunched.
								</p>
							</div>
							<div className="w-56 rounded-xl border bg-background p-2">
								<p className="px-1.5 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
									Current realm
								</p>
								<SidebarBrandBadge canSwitchToConsole canSwitchToOs />
							</div>
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
			<MemoryRouter>
				<ProofSurface />
			</MemoryRouter>
		</QueryClientProvider>
	);
}
