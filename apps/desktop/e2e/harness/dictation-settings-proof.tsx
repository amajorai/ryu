declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
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
import type { PiCatalog } from "../../src/lib/api/pi-config.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const API_BASE = "http://127.0.0.1:7974";
const PREFERENCES_KEY = "dictation-settings-proof-preferences";
const APP_ENABLED_KEY = "dictation-settings-proof-app-enabled";
const NODE = {
	managed: false,
	name: "dictation-settings-proof",
	orgId: null,
	token: "dictation-settings-proof-token",
	url: API_BASE,
	userJwt: null,
};

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number | null;
}

interface CapturedTauriCall {
	args: unknown;
	command: string;
}

interface DictationProofSnapshot {
	appEnabled: boolean;
	preferences: Record<string, string>;
	requests: CapturedRequest[];
	tauriCalls: CapturedTauriCall[];
}

interface DictationProofState {
	armFailure: (method: string, path: string, status?: number) => void;
	requests: CapturedRequest[];
	snapshot: () => DictationProofSnapshot;
	tauriCalls: CapturedTauriCall[];
}

declare global {
	interface Window {
		__dictationSettingsProof: DictationProofState;
	}
}

const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
});

function readPreferences(): Record<string, string> {
	try {
		const stored = localStorage.getItem(PREFERENCES_KEY);
		return stored ? JSON.parse(stored) : {};
	} catch {
		return {};
	}
}

function savePreferences(preferences: Record<string, string>): void {
	localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function dictationManifest(enabled: boolean) {
	return {
		built_in: true,
		companion: null,
		enabled,
		id: "@ryu/dictation",
		installed: true,
		installed_version: "0.1.14",
		local_only: true,
		name: "Dictation",
		permission_grants: [],
		runnables: [
			{
				id: "policy-dictation",
				kind: "policy",
				name: "System-wide dictation (on/off)",
			},
		],
		// Core's list_apps handler always stamps these two built-in fields, and
		// the Desktop wire schema requires them.
		sidecar_name: null,
		version: "0.1.14",
		windows_first: false,
	};
}

function dictationSettingsTab(enabled: boolean) {
	return {
		app_enabled: enabled,
		id: "dictation.settings",
		plugin: "@ryu/dictation",
		scope: "node",
		title: "Dictation",
		view: "dictation",
	};
}

function initialCatalog(): PiCatalog {
	return {
		agentModelOverrides: {},
		apiTypes: ["openai-completions"],
		providers: [
			{
				active: true,
				api: "openai-completions",
				authEnv: "",
				authKind: "none",
				configured: true,
				custom: false,
				id: "local",
				label: "Local",
				modelOverrides: {},
				routing: "direct",
				suggestedModels: ["qwen-local"],
				supportsDiscovery: false,
			},
		],
		thinkingLevels: ["low", "high"],
	};
}

function installFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		localStorage.removeItem(PREFERENCES_KEY);
		localStorage.removeItem(APP_ENABLED_KEY);
		params.delete("reset");
		const query = params.toString();
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}`
		);
	}
	let appEnabled =
		localStorage.getItem(APP_ENABLED_KEY) !== "false" &&
		params.get("disabled") !== "true";
	if (params.get("disabled") === "true") {
		localStorage.setItem(APP_ENABLED_KEY, "false");
	}
	const failures = new Map<string, number>();
	if (params.get("failFirstDictationRead") === "true") {
		failures.set("GET /api/preferences/dictation", 503);
	}
	const requests: CapturedRequest[] = [];
	const tauriCalls: CapturedTauriCall[] = [];
	const state: DictationProofState = {
		armFailure: (method, path, status = 503) => {
			failures.set(
				`${method.toUpperCase()} ${decodeURIComponent(path)}`,
				status
			);
		},
		requests,
		snapshot: () => ({
			appEnabled,
			preferences: structuredClone(readPreferences()),
			requests: structuredClone(requests),
			tauriCalls: structuredClone(tauriCalls),
		}),
		tauriCalls,
	};
	window.__dictationSettingsProof = state;
	useGatewayDialog.setState({ open: false, section: "overview" });
	const tauriWindow = window;
	const proofTauriKernel = {
		invoke: async <Arguments,>(command: string, args?: Arguments) => {
			tauriCalls.push({ args: args ?? null, command });
			return undefined;
		},
		transformCallback: () => 1,
	};
	// SAFETY: This browser fixture installs the exact complete private kernel constructed above.
	// This mutation view owns that two-method fixture slot, not the public Tauri SDK result ABI.
	(
		tauriWindow as Omit<typeof window, "__TAURI_INTERNALS__"> & {
			__TAURI_INTERNALS__: typeof proofTauriKernel;
		}
	).__TAURI_INTERNALS__ = proofTauriKernel;

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = input instanceof Request ? input : null;
		const rawUrl = isNativeText(input)
			? input
			: input instanceof URL
				? input.toString()
				: (request?.url ?? input.toString());
		const url = new URL(rawUrl, window.location.href);
		const path = decodeURIComponent(url.pathname);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const record: CapturedRequest = {
			body,
			method,
			path,
			status: null,
		};
		if (path.startsWith("/api/")) {
			requests.push(record);
		}
		const failureKey = `${method} ${path}`;
		const failureStatus = failures.get(failureKey);
		if (failureStatus !== undefined) {
			failures.delete(failureKey);
			record.status = failureStatus;
			return json(
				{ error: "dictation_settings_fixture_failure" },
				failureStatus
			);
		}

		if (path === "/api/auth/get-session") {
			record.status = 200;
			return json({ session: null, user: null });
		}
		if (path === "/api/gateway/status") {
			record.status = 200;
			return json({ reachable: false, url: API_BASE });
		}
		if (path === "/api/plugins") {
			record.status = 200;
			return json({ apps: [dictationManifest(appEnabled)] });
		}
		if (path === "/api/plugins/contributions") {
			record.status = 200;
			return json({ settings_tabs: [dictationSettingsTab(appEnabled)] });
		}
		if (path === "/api/plugins/@ryu/dictation/enable" && method === "POST") {
			appEnabled = true;
			localStorage.setItem(APP_ENABLED_KEY, "true");
			record.status = 200;
			return json({
				app: {
					approved_grants: [],
					created_at: null,
					enabled: true,
					id: "@ryu/dictation",
					updated_at: null,
					version: "0.1.14",
				},
			});
		}
		if (path.startsWith("/api/preferences/")) {
			const key = path.slice("/api/preferences/".length);
			const preferences = readPreferences();
			if (method === "PUT") {
				const parsedValue = z.object({ value: z.string() }).safeParse(body);
				const value = parsedValue.success ? parsedValue.data.value : null;
				if (!isNativeText(value)) {
					record.status = 400;
					return json({ error: "invalid_preference_payload" }, 400);
				}
				preferences[key] = value;
				savePreferences(preferences);
				record.status = 200;
				return json({ key, ok: true, value });
			}
			record.status = 200;
			return json({ key, value: preferences[key] ?? null });
		}
		if (path === "/api/pi-config/catalog") {
			record.status = 200;
			return json(initialCatalog());
		}
		if (path === "/api/agents") {
			record.status = 200;
			return json({ agents: [] });
		}
		if (path === "/api/engines") {
			record.status = 200;
			return json({ engines: [] });
		}
		if (path === "/api/engines/active") {
			record.status = 200;
			return json({ engine: null });
		}
		if (path.startsWith("/api/")) {
			record.status = 404;
			return json({ error: `Unhandled fixture API: ${method} ${path}` }, 404);
		}
		record.status = 404;
		return json(
			{ error: `Unexpected fixture request: ${method} ${path}` },
			404
		);
	};
}

function ProofSurface() {
	const open = useGatewayDialog((state) => state.open);
	const section = useGatewayDialog((state) => state.section);
	const setOpen = useGatewayDialog((state) => state.setOpen);
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="mx-auto min-h-screen max-w-5xl bg-background p-8 text-foreground">
						<header className="mb-6">
							<p className="text-muted-foreground text-xs tracking-widest">
								RYU · DICTATION SETTINGS PROOF
							</p>
							<h1 className="mt-2 font-semibold text-2xl">
								Dictation settings
							</h1>
							<p className="mt-2 max-w-2xl text-muted-foreground text-sm">
								Production Gateway settings dialog with local Core preferences,
								app lifecycle and model fixtures. Audio capture and
								operating-system shortcut registration are not invoked.
							</p>
							<button
								className="mt-4 rounded-lg border bg-card px-3 py-2 text-sm"
								onClick={() => useGatewayDialog.getState().openGateway()}
								type="button"
							>
								Open Gateway settings
							</button>
						</header>
					</main>
					<GatewayDialog
						defaultSection={section}
						onOpenChange={setOpen}
						open={open}
					/>
					<Toaster position="bottom-right" theme="system" />
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
setInterfaceLevel("expert");
installFixture();

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
