// Story for the unswept-b settings proofs: Settings search, navigation and
// reveal, and the lazy Settings entry point. It mounts the PRODUCTION lazy
// entry points (`LazySettingsDialog`, `LazyGatewayDialog`) the way `NavUser`
// does — store-driven open state, preload on focus/pointer — with the app's
// Toaster. Every API request is a local fixture (copied from the settings
// dialog shell story so neither story can change the other) and is recorded.
import { HotkeysProvider } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/LazyGatewayDialog.tsx";
import {
	preloadSettingsDialog,
	SettingsDialog,
} from "../../src/components/settings/LazySettingsDialog.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

declare global {
	interface Window {
		__unsweptBApiCalls: Array<{ method: string; path: string }>;
		__unsweptBOpenChanges: boolean[];
		/** Plugin `settings_tabs` Core reports; a spec may change it at runtime. */
		__unsweptBSettingsTabs?: unknown[];
	}
}

// Gateway settings open only in the Console realm (`useGatewayDialog`), which
// the app's access gate grants a local node. This story has no access gate, so
// it grants Console the same way, or every Gateway result would be refused.
useProductModeStore.setState({ consoleAccess: true, requestedMode: "console" });

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const now = new Date(Date.now() + 60 * 60 * 1000).toISOString();
localStorage.setItem("ryu_session_token", "unswept-b-local-fixture-token");
window.__unsweptBApiCalls = [];
window.__unsweptBOpenChanges = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(requestUrl, window.location.origin);
	if (
		url.origin === window.location.origin &&
		!url.pathname.startsWith("/api/")
	) {
		return realFetch(input, init);
	}
	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	window.__unsweptBApiCalls.push({ method, path: url.pathname });
	const json = <Payload,>(data: Payload) =>
		new Response(JSON.stringify(data), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	switch (url.pathname) {
		case "/api/auth/get-session":
			return json({
				session: {
					createdAt: now,
					expiresAt: now,
					id: "unswept-b-session",
					userId: "unswept-b-user",
				},
				user: {
					createdAt: now,
					email: "ada@example.test",
					emailVerified: true,
					id: "unswept-b-user",
					name: "Ada Lovelace",
					updatedAt: now,
				},
			});
		case "/api/plugins":
			return json({ apps: [], plugins: [] });
		case "/api/plugins/contributions":
			return json({ settings_tabs: window.__unsweptBSettingsTabs ?? [] });
		case "/api/gateway/status":
			return json({ reachable: false, url: null });
		case "/api/sessions":
			return json({ sessions: [] });
		case "/api/control-plane/orgs":
			return json({ organizations: [] });
		default:
			// Read-only panes render their own empty states from empty 200s.
			return json({});
	}
};

function UnsweptBSettingsStory() {
	const [surface, setSurface] = useState<AppSurface>("desktop");
	const settingsOpen = useSettingsDialog((state) => state.open);
	const settingsSection = useSettingsDialog((state) => state.section);
	const setSettingsOpen = useSettingsDialog((state) => state.setOpen);
	const openSettings = useSettingsDialog((state) => state.openSettings);
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const setGatewayOpen = useGatewayDialog((state) => state.setOpen);
	const handleSettingsOpenChange = (next: boolean) => {
		window.__unsweptBOpenChanges.push(next);
		setSettingsOpen(next);
	};

	return (
		<AppSurfaceProvider surface={surface}>
			<EntitlementProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme="light"
					enableSystem={false}
				>
					<HotkeysProvider registry={DESKTOP_HOTKEYS}>
						<QueryClientProvider client={queryClient}>
							<I18nProvider>
								<MemoryRouter>
									<main className="min-h-screen bg-background p-8 text-foreground">
										<h1 className="font-semibold text-2xl">
											Settings search and lazy dialog
										</h1>
										<div className="mt-4 flex flex-wrap gap-3">
											<button
												className="rounded-lg border px-3 py-2 text-sm"
												data-testid="open-settings"
												onClick={() => openSettings()}
												onFocus={preloadSettingsDialog}
												onPointerEnter={preloadSettingsDialog}
												type="button"
											>
												Open settings
											</button>
											<button
												className="rounded-lg border px-3 py-2 text-sm"
												data-testid="open-keyboard-section"
												onClick={() => openSettings("keyboard")}
												type="button"
											>
												Open Keyboard Shortcuts
											</button>
											<button
												className="rounded-lg border px-3 py-2 text-sm"
												data-testid="switch-to-web"
												onClick={() => setSurface("web")}
												type="button"
											>
												Use the web surface
											</button>
											<output data-testid="settings-open-state">
												{settingsOpen ? "open" : "closed"}
											</output>
											<output data-testid="gateway-state">
												{gatewayOpen ? `open:${gatewaySection}` : "closed"}
											</output>
											<output data-testid="surface">{surface}</output>
										</div>
									</main>
									<SettingsDialog
										defaultSection={settingsSection}
										onOpenChange={handleSettingsOpenChange}
										open={settingsOpen}
									/>
									<GatewayDialog
										defaultSection={gatewaySection}
										onOpenChange={setGatewayOpen}
										open={gatewayOpen}
									/>
									<Toaster position="bottom-right" />
								</MemoryRouter>
							</I18nProvider>
						</QueryClientProvider>
					</HotkeysProvider>
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<UnsweptBSettingsStory />);
}
