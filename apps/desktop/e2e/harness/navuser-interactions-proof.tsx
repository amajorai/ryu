import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../contexts/auth-context.tsx";
import { NavUser } from "../../src/components/layout/NavUser.tsx";
import {
	APP_SURFACES,
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useAppStore } from "../../src/store/useAppStore.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import {
	EntitlementProvider,
	SpacesProvider,
	TabsProvider,
} from "./navuser-interactions-proof.contexts.tsx";
import { navUserProofState } from "./navuser-interactions-proof.runtime.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

const searchParams = new URLSearchParams(window.location.search);
const requestedMode = searchParams.get("product") === "bot" ? "bot" : "os";
// The shared tree also runs as apps/webapp, Telegram, and the extension
// dashboard; `?surface=` mounts the menu as that host would.
const requestedSurfaceParam = searchParams.get("surface");
const requestedSurface: AppSurface =
	APP_SURFACES.find((surface) => surface === requestedSurfaceParam) ??
	"desktop";
// OS opens only with the `ui.interface_os` rollout; grant the access App's
// rollout sync would grant an account that has it.
useProductModeStore.setState({
	consoleAccess: true,
	osAccess: true,
	requestedMode,
});
useAppStore.setState({
	isAuthenticated: false,
	oidcUser: null,
});
useSettingsDialog.setState({ open: false, section: "general" });
navUserProofState();

function ProofSurface() {
	const [hiddenChrome, setHiddenChrome] = useState<Set<string>>(
		() => new Set()
	);
	const [hideHistory, setHideHistory] = useState<string[]>([]);
	const settingsOpen = useSettingsDialog((state) => state.open);
	const settingsSection = useSettingsDialog((state) => state.section);
	const onHideChrome = (key: "inbox" | "user" | "downloads" | "settings") => {
		setHideHistory((current) => [...current, key]);
		setHiddenChrome((current) => new Set([...current, key]));
	};

	return (
		<main className="min-h-screen bg-background p-10 text-foreground">
			<header className="mx-auto mb-6 max-w-4xl">
				<p className="text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
					Ryu Desktop · Account navigation proof
				</p>
				<h1 className="mt-2 font-semibold text-3xl">Account navigation</h1>
			</header>
			<section
				aria-label="Desktop sidebar footer"
				className="mx-auto flex max-w-4xl items-center justify-end rounded-2xl border bg-sidebar p-4"
			>
				<NavUser
					hiddenChrome={hiddenChrome}
					notificationLayout="split"
					onHideChrome={onHideChrome}
				/>
			</section>
			<output className="sr-only" data-testid="hidden-chrome">
				{JSON.stringify(hideHistory)}
			</output>
			<output className="sr-only" data-testid="open-tabs">
				{JSON.stringify(navUserProofState().openTabs)}
			</output>
			<output className="sr-only" data-testid="settings-state">
				{JSON.stringify({ open: settingsOpen, section: settingsSection })}
			</output>
		</main>
	);
}

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing #root mount element");
}

createRoot(root).render(
	<I18nProvider>
		<QueryClientProvider client={queryClient}>
			<MemoryRouter>
				<AppSurfaceProvider surface={requestedSurface}>
					<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
						<AuthProvider>
							<EntitlementProvider>
								<TabsProvider>
									<SpacesProvider>
										<ProofSurface />
									</SpacesProvider>
								</TabsProvider>
							</EntitlementProvider>
						</AuthProvider>
					</ThemeProvider>
				</AppSurfaceProvider>
			</MemoryRouter>
			<Toaster position="bottom-right" />
		</QueryClientProvider>
	</I18nProvider>
);
