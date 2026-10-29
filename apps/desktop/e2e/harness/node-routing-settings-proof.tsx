import { I18nProvider } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const PREFERENCES_STORAGE_KEY = "node-routing-settings-proof.core-preferences";
const NODE_ROUTING_KEY = "node-routing-prefs";
const NODE = {
	managed: false,
	name: "node-routing-settings-proof",
	orgId: null,
	token: "node-routing-proof-token",
	url: window.location.origin,
	userJwt: null,
};

interface CoreCall {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface ProofState {
	armNextSaveFailure: () => void;
	calls: CoreCall[];
	failedSaves: number;
	preferences: Record<string, string>;
	releaseRoutingRead: () => void;
	routingReadStarted: boolean;
	snapshot: () => {
		calls: CoreCall[];
		failedSaves: number;
		preferences: Record<string, string>;
	};
}

declare global {
	interface Window {
		__nodeRoutingSettingsProof: ProofState;
	}
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function loadPreferences(): Record<string, string> {
	const stored = localStorage.getItem(PREFERENCES_STORAGE_KEY);
	if (stored) {
		return JSON.parse(stored);
	}

	const query = new URLSearchParams(window.location.search);
	const preferences =
		query.get("seed") === "existing"
			? {
					[NODE_ROUTING_KEY]: JSON.stringify({
						fallback: ["openai"],
						firewall: {
							custom_patterns: [
								{
									kind: "secret",
									name: "legacy_id",
									regex: "legacy-token",
								},
							],
						},
					}),
				}
			: {};
	localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
	return preferences;
}

function installCoreFixture(): void {
	const query = new URLSearchParams(window.location.search);
	let releaseFirstRoutingRead: () => void = () => undefined;
	let failNextSave = false;
	const delayRoutingRead = query.get("delayRoutingRead") === "true";
	const state: ProofState = {
		armNextSaveFailure: () => {
			failNextSave = true;
		},
		calls: [],
		failedSaves: 0,
		preferences: loadPreferences(),
		releaseRoutingRead: () => releaseFirstRoutingRead(),
		routingReadStarted: false,
		snapshot: () => ({
			calls: structuredClone(state.calls),
			failedSaves: state.failedSaves,
			preferences: structuredClone(state.preferences),
		}),
	};
	window.__nodeRoutingSettingsProof = state;

	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async () => undefined,
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs this exact complete private two-method kernel.
	// The mutation view owns only that fixture slot, not a public Tauri result contract.
	(
		tauriWindow as Omit<typeof tauriWindow, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		if (
			url.origin !== window.location.origin ||
			!url.pathname.startsWith("/api/")
		) {
			return realFetch(input, init);
		}

		const method = (init?.method ?? "GET").toUpperCase();
		const headers = new Headers(init?.headers);
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		state.calls.push({
			authorization: headers.get("authorization"),
			body,
			method,
			path: url.pathname,
		});

		if (url.pathname === "/api/auth/get-session") {
			return json({ session: null, user: null });
		}
		if (url.pathname === "/api/gateway/status") {
			return json({
				health: {
					auth_required: true,
					providers: ["openai"],
					status: "ok",
					version: "node-routing-proof",
				},
				metrics: {
					cache: {
						exact_hits: 0,
						hit_rate: 0,
						misses: 0,
						semantic_hits: 0,
					},
					composio: { calls: 0 },
					provider_health: {},
					provider_quota: {},
					providers: { errors: {}, requests: {} },
					requests: {
						budget_downgraded: 0,
						budget_exceeded: 0,
						budget_notified: 0,
						budget_restricted: 0,
						errors: 0,
						firewall_blocked: 0,
						rate_limited: 0,
						total: 0,
					},
					tokens: { input: 0, output: 0 },
				},
				reachable: true,
				url: window.location.origin,
			});
		}
		if (url.pathname === "/api/gateway/config") {
			return json({
				auth: { api_keys: [], require_auth: true },
				providers: [],
			});
		}
		if (url.pathname === "/api/gateway/doctor") {
			return json({
				counts: { errors: 0, info: 0, warnings: 0 },
				findings: [],
				reachable: true,
				readOnly: true,
			});
		}
		if (url.pathname === "/api/plugins") {
			return json({ apps: [] });
		}
		if (url.pathname === "/api/plugins/contributions") {
			return json({ settings_tabs: [] });
		}
		if (url.pathname === "/api/composio/status") {
			return json({ configured: false });
		}
		if (url.pathname === "/api/webhook-ingress/backend") {
			return json({ available: ["none"], backend: "none", default: "none" });
		}
		if (url.pathname === "/api/agents") {
			return json({ agents: [] });
		}
		if (url.pathname === "/api/engines") {
			return json({ engines: [] });
		}
		if (url.pathname === "/api/engine/active") {
			return json({ active: null, available: [], running: false });
		}
		if (url.pathname === "/api/pi-config") {
			return json({
				config: {
					configDir: "/fixture/pi-config",
					model: "gpt-4o-mini",
					provider: "openai",
					routing: "gateway",
					thinkingLevel: null,
				},
			});
		}
		if (url.pathname === "/api/pi-config/catalog") {
			return json({
				apiTypes: ["openai-completions"],
				providers: [],
				thinkingLevels: ["low", "medium"],
			});
		}
		if (url.pathname === "/api/identities") {
			return json({ profiles: [] });
		}
		if (
			url.pathname === "/api/preferences" ||
			url.pathname.startsWith("/api/preferences/")
		) {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			if (
				key === NODE_ROUTING_KEY &&
				method === "GET" &&
				delayRoutingRead &&
				!state.routingReadStarted
			) {
				state.routingReadStarted = true;
				await new Promise<void>((resolve) => {
					releaseFirstRoutingRead = resolve;
				});
			}
			if (method === "PUT") {
				if (key === NODE_ROUTING_KEY && failNextSave) {
					failNextSave = false;
					state.failedSaves += 1;
					return json({ error: "routing_preferences_write_failed" }, 503);
				}
				const value =
					z.object({ value: z.string() }).safeParse(body).data?.value ?? null;
				if (!isNativeText(value)) {
					return json({ error: "invalid_preference_payload" }, 400);
				}
				state.preferences[key] = value;
				localStorage.setItem(
					PREFERENCES_STORAGE_KEY,
					JSON.stringify(state.preferences)
				);
				return json({ key, ok: true, value });
			}
			if (key in state.preferences) {
				return json({ key, value: state.preferences[key] });
			}
			return json({ error: "preference_not_set" }, 404);
		}
		return json({});
	};
}

function ProofSurface() {
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const setGatewayOpen = useGatewayDialog((state) => state.setOpen);
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<header className="mx-auto mb-4 max-w-7xl">
							<p className="text-muted-foreground text-xs uppercase tracking-wide">
								Rendered Gateway settings proof
							</p>
							<h1 className="mt-1 font-semibold text-xl">
								Node routing preferences
							</h1>
							<Button
								onClick={() =>
									useGatewayDialog.getState().openGateway("overview")
								}
							>
								Open Gateway settings
							</Button>
						</header>
						<output
							data-open={String(gatewayOpen)}
							data-section={gatewaySection}
							data-testid="gateway-state"
						>
							{gatewayOpen ? "Gateway open" : "Gateway closed"}
						</output>
						<GatewayDialog
							defaultSection={gatewaySection}
							onOpenChange={setGatewayOpen}
							open={gatewayOpen}
						/>
						<Toaster position="bottom-right" theme="dark" />
					</main>
				</ThemeProvider>
			</EntitlementProvider>
		</AppSurfaceProvider>
	);
}

useNodeStore.setState({
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
useGatewayDialog.setState({ open: false, section: "overview" });
useSettingsDialog.getState().setOpen(false);
setInterfaceLevel("expert");
installCoreFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<I18nProvider>
			<I18nDirectionProvider>
				<MemoryRouter>
					<ProofSurface />
				</MemoryRouter>
			</I18nDirectionProvider>
		</I18nProvider>
	</QueryClientProvider>
);
