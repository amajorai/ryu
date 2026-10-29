import { HotkeysProvider, useHotkey } from "@ryu/hotkeys/react";
import { I18nProvider } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/LazyGatewayDialog.tsx";
import { SettingsDialog } from "../../src/components/settings/LazySettingsDialog.tsx";
import {
	type AppSurface,
	AppSurfaceProvider,
} from "../../src/contexts/app-surface-context.tsx";
import { DESKTOP_HOTKEYS } from "../../src/lib/hotkeys/actions.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import "../../src/index.css";

import { WIDGET_DEFINITIONS } from "../../src/components/dashboard/widgets/registry.tsx";
import { MarkdownEditor } from "../../src/components/editor/MarkdownEditor.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { queryClient } from "../../src/lib/query-client.ts";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

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
		document.body.dataset.gatewayRequests = String(
			Number(document.body.dataset.gatewayRequests ?? "0") + 1
		);
		return new Response(JSON.stringify({ reachable: false, url: null }), {
			headers,
			status: 200,
		});
	}
	if (pathname.startsWith("/api/preferences/")) {
		return Response.json({ value: "false" });
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
	const [extra, setExtra] = useState("none");
	const [markdown, setMarkdown] = useState(
		"# Startup editor proof\n\nA complete editor loads only when opened."
	);
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
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="light" enableSystem>
					<HotkeysProvider registry={DESKTOP_HOTKEYS}>
						<ShortcutBindings onAction={setLastAction} />
						<main className="min-h-screen bg-background p-8 text-foreground">
							<div className="mx-auto flex max-w-3xl flex-col gap-5">
								<header className="rounded-2xl border bg-card p-6 shadow-sm">
									<p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
										Ryu Desktop · component proof
									</p>
									<h1 className="mt-2 font-semibold text-2xl">
										Workspace controls
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
											<dd
												className="mt-1 font-mono"
												data-testid="proof-surface"
											>
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
									<Button
										data-testid="open-settings"
										onClick={() => openSettings("general")}
										size="sm"
										type="button"
										variant="outline"
									>
										Open settings
									</Button>
									<Button
										data-testid="open-gateway"
										onClick={() =>
											useGatewayDialog.getState().openGateway("overview")
										}
										size="sm"
										type="button"
										variant="outline"
									>
										Open gateway
									</Button>
									<Button
										data-testid="open-editor"
										onClick={() => setExtra("editor")}
										size="sm"
										type="button"
										variant="outline"
									>
										Open editor
									</Button>
									<Button
										data-testid="open-map"
										onClick={() => setExtra("map")}
										size="sm"
										type="button"
										variant="outline"
									>
										Open map
									</Button>

									<Button
										data-testid="switch-mobile"
										onClick={() => setSurface("mobile")}
										size="sm"
										type="button"
										variant="outline"
									>
										Switch to mobile surface
									</Button>
									<Button
										data-testid="open-mobile-keyboard"
										onClick={() => openSettings("keyboard")}
										size="sm"
										type="button"
										variant="outline"
									>
										Open mobile Keyboard Shortcuts section
									</Button>
								</div>
							</div>
							{extra === "editor" ? (
								<div className="h-[520px] w-full" data-testid="editor-panel">
									<MarkdownEditor
										initialMarkdown={markdown}
										onChangeMarkdown={setMarkdown}
										toolbar="inline"
									/>
									<output className="sr-only" data-testid="markdown-value">
										{markdown}
									</output>
								</div>
							) : null}
							{extra === "map" ? (
								<div className="h-[400px] w-full" data-testid="map-panel">
									{WIDGET_DEFINITIONS.find(
										(widget) => widget.kind === "map"
									)?.render({
										widget: {
											id: "map-proof",
											dashboard_id: "proof",
											title: "Map",
											kind: "map",
											config: { center: [0, 20], zoom: 1.2 },
											layout: { x: 0, y: 0, w: 6, h: 5 },
											source: { type: "static", data: [] },
										},
										value: [{ lng: 0, lat: 20, label: "Reference point" }],
									})}
								</div>
							) : null}
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
			</EntitlementProvider>
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
