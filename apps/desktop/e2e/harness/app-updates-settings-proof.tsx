import "./app-updates-settings-native.ts";
import { I18nProvider } from "@ryu/i18n/react";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { vaultHydrated } from "../../lib/auth-client.ts";
import { AppUpdatesSettings } from "../../src/components/settings/AppUpdatesSettings.tsx";
import { SettingsDialog } from "../../src/components/settings/SettingsDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

function installUpdateApiMock(): () => void {
	const nativeFetch = window.fetch.bind(window);
	// Browser fetch has no Bun-only `preconnect`; the replacement covers the call.
	window.fetch = (async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const requestUrl = new URL(url, window.location.href);
		if (requestUrl.pathname === "/api/version") {
			return Response.json({
				components: [],
				platform: "test",
				ryu_version: "1.0.0",
			});
		}
		if (requestUrl.pathname === "/api/update/check") {
			window.__appUpdateCheckUrls.push(requestUrl.toString());
			if (
				new URLSearchParams(window.location.search).get("scenario") ===
				"check-error"
			) {
				return Response.json(
					{ error: "Fixture update service failure" },
					{
						status: 500,
					}
				);
			}
			if (
				new URLSearchParams(window.location.search).get("scenario") === "cutoff"
			) {
				return Response.json({
					asset: null,
					channel: "stable",
					current: "1.0.0",
					cutoff_unresolved: false,
					error: null,
					html_url: "https://updates.example.test/releases/v1.1.0",
					latest: "1.0.0",
					latest_unrestricted: "1.1.0",
					notes: "Fixture update notes",
					restricted_by_cutoff: true,
					update_available: false,
				});
			}
			const available = ["available", "prepared"].includes(
				new URLSearchParams(window.location.search).get("scenario") ?? ""
			);
			return Response.json({
				asset: available
					? {
							kind: "installer",
							name: "Ryu-1.1.0-test",
							size: 128,
							url: "https://updates.example.test/Ryu-1.1.0-test",
						}
					: null,
				channel: requestUrl.searchParams.get("channel") ?? "stable",
				current: "1.0.0",
				error: null,
				html_url: "https://updates.example.test/releases/v1.1.0",
				latest: available ? "1.1.0" : "1.0.0",
				notes: "Fixture update notes",
				tag: available ? "v1.1.0" : null,
				update_available: available,
			});
		}
		if (requestUrl.pathname === "/api/auth/get-session") {
			return Response.json({ session: null, user: null });
		}
		if (requestUrl.pathname === "/api/plugins") {
			return Response.json({ apps: [] });
		}
		if (requestUrl.pathname === "/api/plugins/contributions") {
			return Response.json({ settings_tabs: [] });
		}
		if (requestUrl.pathname === "/api/gateway/status") {
			return Response.json({ reachable: false, url: null });
		}
		if (requestUrl.pathname.startsWith("/api/")) {
			return Response.json({}, { status: 404 });
		}
		return nativeFetch(input, init);
	}) as typeof window.fetch;
	return () => {
		window.fetch = nativeFetch;
	};
}

function ProofSurface() {
	const settingsOpen = useSettingsDialog((state) => state.open);
	const settingsSection = useSettingsDialog((state) => state.section);
	const setSettingsOpen = useSettingsDialog((state) => state.setOpen);
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false } },
			}),
		[]
	);
	useEffect(() => installUpdateApiMock(), []);

	return (
		<QueryClientProvider client={queryClient}>
			<AppSurfaceProvider surface="desktop">
				<EntitlementProvider>
					<I18nProvider>
						<I18nDirectionProvider>
							<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
								<Toaster position="bottom-right" theme="dark" />
								<main
									className="min-h-dvh bg-background p-8 text-foreground"
									data-testid="app-updates-settings-proof"
								>
									<div className="mx-auto max-w-5xl rounded-2xl border bg-card p-6 shadow-sm">
										<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
											Desktop settings verification
										</p>
										<h1 className="mt-2 font-semibold text-2xl">App updates</h1>
										<p className="mt-2 mb-6 text-muted-foreground text-sm">
											Automatic downloads, manual checks, and the release
											channel.
										</p>
										<AppUpdatesSettings />
									</div>
								</main>
								<SettingsDialog
									defaultSection={settingsSection}
									onOpenChange={setSettingsOpen}
									open={settingsOpen}
								/>
							</ThemeProvider>
						</I18nDirectionProvider>
					</I18nProvider>
				</EntitlementProvider>
			</AppSurfaceProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	const reactRoot = createRoot(root);
	// main.tsx renders only after the sealed auth vault has hydrated (an empty
	// slot first migrates a plaintext vault seeded in localStorage); the
	// account-scoped Lifetime updates row reads the active account synchronously.
	void vaultHydrated.then(() => {
		reactRoot.render(
			<MemoryRouter>
				<ProofSurface />
			</MemoryRouter>
		);
	});
}
