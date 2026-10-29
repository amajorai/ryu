import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ProfileTab } from "../../src/components/settings/ProfileTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import "../../src/index.css";

function ProfileSettingsProof() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<Toaster position="bottom-right" theme="dark" />
					<main
						className="min-h-dvh bg-background p-8 text-foreground"
						data-testid="profile-tab-settings-proof"
					>
						<div className="mx-auto max-w-4xl space-y-6">
							<header className="rounded-2xl border bg-card p-6 shadow-sm">
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
									Desktop settings verification
								</p>
								<h1 className="mt-2 font-semibold text-2xl">Profile</h1>
								<p className="mt-2 text-muted-foreground text-sm">
									Account identity and node-local personalization.
								</p>
							</header>
							<section className="rounded-2xl border bg-card p-6 shadow-sm">
								<ProfileTab />
							</section>
						</div>
					</main>
				</ThemeProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<MemoryRouter>
			<ProfileSettingsProof />
		</MemoryRouter>
	);
}
