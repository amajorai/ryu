import { HotkeysProvider, useHotkey } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { SettingsDialog } from "../../src/components/settings/SettingsDialog.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const requestUrl = input instanceof Request ? input.url : String(input);
	const pathname = new URL(requestUrl, window.location.origin).pathname;
	const headers = { "content-type": "application/json" };

	if (pathname === "/api/auth/get-session") {
		return new Response(JSON.stringify({ session: null, user: null }), {
			headers,
			status: 200,
		});
	}
	if (pathname === "/api/plugins") {
		return new Response(JSON.stringify({ apps: [] }), { headers, status: 200 });
	}
	if (pathname === "/api/plugins/contributions") {
		return new Response(JSON.stringify({ settings_tabs: [] }), {
			headers,
			status: 200,
		});
	}
	if (pathname === "/api/gateway/status") {
		return new Response(JSON.stringify({ reachable: false, url: null }), {
			headers,
			status: 200,
		});
	}
	if (pathname.startsWith("/api/")) {
		return new Response(JSON.stringify({}), { headers, status: 404 });
	}

	return realFetch(input, init);
};

function ShortcutBindings({ onAction }: { onAction: (id: string) => void }) {
	const openSettings = useSettingsDialog((state) => state.openSettings);
	const openGateway = useGatewayDialog((state) => state.openGateway);

	useEffect(() => {
		document.body.dataset.hotkeysReady = "true";
	}, []);

	useHotkey("settings.open", () => {
		onAction("settings.open");
		openSettings();
	});
	useHotkey("gateway.open", () => {
		onAction("gateway.open");
		openGateway();
	});

	return null;
}

function ProofSurface() {
	const [surface, setSurface] = useState<AppSurface>("desktop");
	const [lastAction, setLastAction] = useState("none");
	const settingsOpen = useSettingsDialog((state) => state.open);
	const settingsSection = useSettingsDialog((state) => state.section);
	const setSettingsOpen = useSettingsDialog((state) => state.setOpen);
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const setGatewayOpen = useGatewayDialog((state) => state.setOpen);
	const openSettings = useSettingsDialog((state) => state.openSettings);

	return (
		<AppSurfaceProvider surface={surface}>
			<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
				<HotkeysProvider registry={DESKTOP_HOTKEYS}>
					<ShortcutBindings onAction={setLastAction} />
					<main className="min-h-screen bg-background p-8 text-foreground">
						<div className="mx-auto flex max-w-3xl flex-col gap-5">
							<header className="rounded-2xl border bg-card p-6 shadow-sm">
								<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
									Desktop shortcut verification
								</p>
								<h1 className="mt-2 font-semibold text-2xl">
									Settings dialog shortcuts
								</h1>
								<p className="mt-2 text-muted-foreground text-sm">
									Press Ctrl+. or Cmd+. for Settings, and Ctrl+, or Cmd+, for
									Gateway settings.
								</p>
								<dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
									<div className="rounded-lg border bg-background p-3">
										<dt className="text-muted-foreground">Last action</dt>
										<dd
											className="mt-1 font-mono"
											data-testid="shortcut-last-action"
										>
											{lastAction}
										</dd>
									</div>
									<div className="rounded-lg border bg-background p-3">
										<dt className="text-muted-foreground">Surface</dt>
										<dd className="mt-1 font-mono" data-testid="proof-surface">
											{surface}
										</dd>
									</div>
									<div className="rounded-lg border bg-background p-3">
										<dt className="text-muted-foreground">Registry</dt>
										<dd className="mt-1 font-mono">Mod-aware</dd>
									</div>
								</dl>
							</header>

							<div className="flex flex-wrap gap-2">
								<button
									className="rounded-lg border bg-card px-3 py-2 text-sm"
									data-testid="switch-mobile"
									onClick={() => setSurface("mobile")}
									type="button"
								>
									Switch to mobile surface
								</button>
								<button
									className="rounded-lg border bg-card px-3 py-2 text-sm"
									data-testid="open-mobile-keyboard"
									onClick={() => openSettings("keyboard")}
									type="button"
								>
									Open mobile Keyboard Shortcuts section
								</button>
							</div>
						</div>
					</main>

					<SettingsDialog
						defaultSection={settingsSection}
						onOpenChange={setSettingsOpen}
						open={settingsOpen}
					/>
					<GatewayDialog
						defaultSection={gatewaySection}
						onOpenChange={setGatewayOpen}
						open={gatewayOpen}
					/>
				</HotkeysProvider>
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
