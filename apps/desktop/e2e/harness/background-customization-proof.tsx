import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { LanguagePackBridge } from "../../src/components/LanguagePackBridge.tsx";
import { AppearanceTab } from "../../src/components/settings/AppearanceTab.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { initBackgroundCustomization } from "../../src/hooks/useBackgroundCustomization.ts";
import { initTheme } from "../../src/hooks/useThemePreset.ts";
import "../../src/index.css";

function installLocalApiFixtures(): void {
	const nativeFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const pathname = new URL(url, window.location.href).pathname;
		if (pathname === "/api/language-packs/installed") {
			return Response.json({ packs: [] });
		}
		if (
			pathname === "/api/plugins" ||
			pathname === "/api/plugins/contributions"
		) {
			return Response.json(pathname === "/api/plugins" ? { apps: [] } : {});
		}
		return nativeFetch(input, init);
	};
}

function AppearanceBoot() {
	useEffect(() => {
		// Match Desktop's real app boot: preference config applies immediately,
		// then each persisted IndexedDB image hydrates as a per-window object URL.
		initTheme();
		initBackgroundCustomization();
	}, []);
	return null;
}

function ProofSurface() {
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
				<LanguagePackBridge>
					<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
						<AppearanceBoot />
						<Toaster position="bottom-right" theme="dark" />
						<main
							className="min-h-dvh bg-background p-8 text-foreground"
							data-testid="background-customization-proof"
						>
							<div className="mx-auto max-w-6xl rounded-2xl border bg-card p-6 shadow-sm">
								<h1 className="mb-6 font-semibold text-2xl">Appearance</h1>
								<AppearanceTab />
							</div>
						</main>
					</ThemeProvider>
				</LanguagePackBridge>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

installLocalApiFixtures();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<MemoryRouter>
			<ProofSurface />
		</MemoryRouter>
	);
}
