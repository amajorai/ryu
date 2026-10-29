import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { GatewayDialog } from "../../src/components/gateway/LazyGatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { useSettingsDialog } from "../../src/store/useSettingsDialog.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// The Gateway always serves its redacted auth and providers sections, and the
// config response codec requires both.
const GATEWAY_CONFIG_SECTIONS = {
	auth: { api_keys: [], require_auth: true },
	providers: {
		anthropic: null,
		core: null,
		genai: { keys: [] },
		local: null,
		openai: { api_key: "***", base_url: "https://api.openai.com" },
		openrouter: null,
	},
} as const;

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const retryPolicySchema = z.object({
	enabled: z.boolean(),
	notify_only: z.boolean(),
	candidates: z.array(z.string()),
	spent_below_percent: z.number(),
});
const acpSchema = z.object({
	idle_timeout_minutes: z.number(),
	max_parallel_agents: z.number().nullable(),
	keep_computer_awake: z.boolean(),
	active_agents: z.number(),
	auto_max_parallel_agents: z.number(),
	effective_max_parallel_agents: z.number(),
});
const runtimeSchema = z.object({ acp: acpSchema, policy: retryPolicySchema });

const API_BASE = "http://127.0.0.1:7989";
const PREFERENCES_KEY = "gateway-dialog-shell-proof-preferences";
const RUNTIME_KEY = "gateway-dialog-shell-runtime";
const RUNTIME_CALLS_KEY = "gateway-dialog-shell-runtime-calls";

const NODE = {
	managed: false,
	name: "gateway-dialog-shell-proof",
	orgId: null,
	token: "gateway-dialog-shell-proof-token",
	url: API_BASE,
	userJwt: null,
};

interface CapturedRequest {
	authorization?: string | null;
	body: unknown;
	method: string;
	path: string;
}

interface CapturedTauriCall {
	args: unknown;
	command: string;
}

interface GatewayDialogShellState {
	armPreferenceFailure: (key: string) => void;
	armRuntimeFailure: (path: string, method: string) => void;
	calls: CapturedRequest[];
	snapshot: () => {
		calls: CapturedRequest[];
		preferences: Record<string, string>;
		tauriCalls: CapturedTauriCall[];
	};
	tauriCalls: CapturedTauriCall[];
}

interface GatewayDialogShellWindow extends Window {
	__gatewayDialogShellProof: GatewayDialogShellState;
	__TAURI_INTERNALS__?: {
		invoke: (
			command: string,
			args?: Parameters<typeof import("@tauri-apps/api/core").invoke>[1]
		) => Promise<undefined>;
		transformCallback: (...args: unknown[]) => number;
	};
}

declare global {
	interface Window {
		__gatewayDialogShellProof: GatewayDialogShellState;
	}
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

function initialPreferences() {
	return {
		"composio-api-key": "composio-existing-key",
		"fal-api-key": "",
		"replicate-api-key": "replicate-existing-key",
	};
}

function readPreferences(): Record<string, string> {
	const stored = localStorage.getItem(PREFERENCES_KEY);
	if (stored) {
		// SAFETY: This controlled proof persists only initialPreferences authored strings and the sole PUT writer below, which requires isNativeText(value) before every preference assignment. Its mounted dialog spec observes snapshots and changes those strings; foreign storage edits are outside this fixture.
		return JSON.parse(stored) as Record<string, string>;
	}
	const preferences = initialPreferences();
	localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
	return preferences;
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installGatewayDialogFixture(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("runtimeProof") === "true") {
		if (params.get("readOnly") === "true") {
			localStorage.setItem("ryu_session_token", "runtime-read-only-session");
		} else {
			localStorage.removeItem("ryu_session_token");
		}
	}
	if (params.get("reset") === "true") {
		localStorage.removeItem(PREFERENCES_KEY);
		localStorage.removeItem(RUNTIME_KEY);
		localStorage.removeItem(RUNTIME_CALLS_KEY);
		params.delete("reset");
		window.history.replaceState(
			null,
			"",
			`${window.location.pathname}${params.size ? `?${params}` : ""}`
		);
	}
	let failStatusReads = params.get("failStatusOnce") === "true" ? 1 : 0;
	let statusReads = 0;
	const freezeStatusAfter = Number(params.get("freezeStatusAfter") ?? "1");
	let failPreferenceKey = "";
	let runtimeFailure = "";
	let scopeDefault = {
		provider: "",
		model: "",
		effort: "",
		coordinatorProvider: "openai",
		coordinatorModel: "gpt-4o-mini",
		coordinatorEffort: "medium",
	};
	const initialRuntime = {
		acp: {
			idle_timeout_minutes: 10,
			max_parallel_agents: null,
			keep_computer_awake: true,
			active_agents: 1,
			auto_max_parallel_agents: 2,
			effective_max_parallel_agents: 2,
		},
		policy: {
			enabled: false,
			notify_only: false,
			// SAFETY: This locally authored empty array contains no incompatible entries; string-array widening gives the fixture policy candidate collection its intended element domain.
			candidates: [] as string[],
			spent_below_percent: 2,
		},
	};
	const readRuntime = () =>
		runtimeSchema.parse(
			JSON.parse(
				localStorage.getItem(RUNTIME_KEY) ?? JSON.stringify(initialRuntime)
			)
		);
	const writeRuntime = (value: z.infer<typeof runtimeSchema>) =>
		localStorage.setItem(RUNTIME_KEY, JSON.stringify(value));
	const state: GatewayDialogShellState = {
		armRuntimeFailure: (path, method) => {
			runtimeFailure = `${method}:${path}`;
		},
		armPreferenceFailure: (key) => {
			failPreferenceKey = key;
		},
		calls:
			params.get("runtimeProof") === "true"
				? JSON.parse(localStorage.getItem(RUNTIME_CALLS_KEY) ?? "[]")
				: [],
		tauriCalls: [],
		snapshot: () => ({
			calls: structuredClone(state.calls),
			preferences: structuredClone(readPreferences()),
			tauriCalls: structuredClone(state.tauriCalls),
		}),
	};
	window.__gatewayDialogShellProof = state;
	// SAFETY: The typed local state was published on window immediately above; this private write view now installs the two controlled bridge callbacks. Captured args and bridge results remain unknown.
	const tauriWindow = window as GatewayDialogShellWindow;
	tauriWindow.__TAURI_INTERNALS__ = {
		invoke: async (command, args) => {
			state.tauriCalls.push({ command: String(command), args: args ?? null });
			return undefined;
		},
		transformCallback: () => 1,
	};

	const realFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		if (url.pathname.startsWith("/api/")) {
			state.calls.push({
				body,
				method,
				path: url.pathname,
				...(params.get("runtimeProof") === "true"
					? { authorization: new Headers(init?.headers).get("authorization") }
					: undefined),
			});
			if (params.get("runtimeProof") === "true") {
				localStorage.setItem(RUNTIME_CALLS_KEY, JSON.stringify(state.calls));
			}
		}
		if (runtimeFailure === `${method}:${url.pathname}`) {
			runtimeFailure = "";
			return json({ error: "runtime_fixture_failed" }, 503);
		}
		if (params.get("scopeResetProof") === "true") {
			if (url.pathname === "/api/scope-defaults") {
				return json({
					defaults: scopeDefault.coordinatorModel
						? { global: scopeDefault }
						: {},
				});
			}
			if (url.pathname === "/api/scope-defaults/global") {
				if (method === "DELETE") {
					scopeDefault = {
						provider: "",
						model: "",
						effort: "",
						coordinatorProvider: "",
						coordinatorModel: "",
						coordinatorEffort: "",
					};
				}
				return json({ ok: true });
			}
			if (url.pathname === "/api/hierarchy/effective-defaults") {
				return json({ provider: null, model: null, effort: null, levels: [] });
			}
		}
		if (url.pathname === "/api/routing/retry-policy") {
			const runtime = readRuntime();
			if (method === "PUT") {
				writeRuntime({ ...runtime, policy: retryPolicySchema.parse(body) });
				return json({ ok: true });
			}
			return json({
				policy: runtime.policy,
				subscription_agents: ["acp:claude", "acp:codex", "acp:grok"],
			});
		}
		if (url.pathname === "/api/routing/policy") {
			return json({ rules: [], credit_providers: [] });
		}

		if (url.pathname === "/api/auth/get-session") {
			return json({ session: null, user: null });
		}
		if (url.pathname === "/api/control-plane/orgs") {
			return json({
				organizations: [
					{
						id: "runtime-org",
						name: "Runtime workspace",
						slug: "runtime",
						role: "member",
					},
				],
			});
		}
		if (url.pathname === "/api/control-plane/me/permissions") {
			return json({ permissions: [] });
		}
		if (url.pathname === "/api/gateway/status") {
			statusReads += 1;
			if (
				statusReads > freezeStatusAfter &&
				params.get("freezeStatusPoll") === "true"
			) {
				return await new Promise<Response>(() => undefined);
			}
			if (failStatusReads > 0) {
				failStatusReads -= 1;
				return json({ error: "gateway_fixture_status_failed" }, 503);
			}
			if (params.get("gatewayDown") === "true") {
				return json({ reachable: false, url: API_BASE });
			}
			return json({
				health: {
					auth_required: true,
					providers: ["openai"],
					status: "ok",
					version: "dialog-shell-proof",
				},
				metrics: {
					cache: {
						exact_hits: 2,
						hit_rate: 0.5,
						misses: 2,
						semantic_hits: 0,
					},
					composio: { calls: 0 },
					provider_health: {},
					provider_quota: {},
					providers: { errors: {}, requests: { openai: 2 } },
					requests: {
						budget_downgraded: 0,
						budget_exceeded: 0,
						budget_notified: 0,
						budget_restricted: 0,
						errors: 0,
						firewall_blocked: 0,
						rate_limited: 0,
						total: 2,
					},
					tokens: { input: 120, output: 30 },
				},
				reachable: true,
				url: API_BASE,
			});
		}
		if (url.pathname === "/api/gateway/config") {
			if (params.get("runtimeProof") === "true") {
				const runtime = readRuntime();
				if (method === "PUT") {
					const acp = z.object({ acp: acpSchema.partial() }).parse(body).acp;
					writeRuntime({
						...runtime,
						acp: {
							...runtime.acp,
							...acp,
							effective_max_parallel_agents: acp.max_parallel_agents ?? 2,
						},
					});
					return json({ ok: true });
				}
				return json({ ...GATEWAY_CONFIG_SECTIONS, acp: runtime.acp });
			}
			return json(GATEWAY_CONFIG_SECTIONS);
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
		if (
			url.pathname === "/api/preferences" ||
			url.pathname.startsWith("/api/preferences/")
		) {
			const key = decodeURIComponent(
				url.pathname.slice("/api/preferences/".length)
			);
			const preferences = readPreferences();
			if (method === "PUT") {
				if (failPreferenceKey === key) {
					failPreferenceKey = "";
					return json({ error: "gateway_fixture_write_failed" }, 503);
				}
				const preference = z.object({ value: z.string() }).safeParse(body);
				const value = preference.success ? preference.data.value : null;
				if (!isNativeText(value)) {
					return json({ error: "invalid_preference_payload" }, 400);
				}
				preferences[key] = value;
				localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
				return json({ key, ok: true, value });
			}
			return json({ key, value: preferences[key] ?? null });
		}
		if (url.pathname === "/api/agents") {
			if (params.get("runtimeProof") === "true") {
				return json({
					agents: ["claude", "codex"].map((id) => ({
						id: `acp:${id}`,
						engine: `acp:${id}`,
						name: id,
						transport: "acp",
					})),
				});
			}
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
				providers: [
					{
						accounts: [],
						active: true,
						api: "openai-completions",
						authEnv: "OPENAI_API_KEY",
						authKind: "api-key",
						configured: true,
						custom: false,
						id: "openai",
						label: "OpenAI",
						routing: "gateway",
						suggestedModels: ["gpt-4o-mini"],
						supportsDiscovery: true,
					},
				],
				thinkingLevels: ["low", "medium"],
			});
		}
		if (url.pathname === "/api/identities") {
			return json({ profiles: [] });
		}
		// Core's device-access lists; the codecs reject a body without the list.
		if (url.pathname === "/api/pair/requests") {
			return json({ requests: [] });
		}
		if (url.pathname === "/api/pair/clients") {
			return json({ clients: [] });
		}
		if (url.origin !== API_BASE && url.pathname.startsWith("/api/")) {
			return json({});
		}
		if (url.origin === API_BASE) {
			return json({});
		}
		return realFetch(input, init);
	};
}

function ProofSurface() {
	const gatewayOpen = useGatewayDialog((state) => state.open);
	const gatewaySection = useGatewayDialog((state) => state.section);
	const openGateway = useGatewayDialog((state) => state.openGateway);
	const setGatewayOpen = useGatewayDialog((state) => state.setOpen);
	const appSettingsOpen = useSettingsDialog((state) => state.open);
	const appSettingsSection = useSettingsDialog((state) => state.section);
	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<header className="mx-auto mb-4 max-w-7xl">
							<p className="text-muted-foreground text-xs uppercase tracking-wide">
								Rendered Gateway dialog proof
							</p>
							<h1 className="mt-1 font-semibold text-xl">
								Gateway shell and navigation
							</h1>
							<Button onClick={() => openGateway()} size="sm" variant="outline">
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
						<output
							data-open={String(appSettingsOpen)}
							data-section={appSettingsSection}
							data-testid="app-settings-state"
						>
							{appSettingsOpen
								? `App settings open: ${appSettingsSection}`
								: "App settings closed"}
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
const gatewayStore = useGatewayDialog.getState();
const gatewayParams = new URLSearchParams(window.location.search);
gatewayStore.openGateway(gatewayParams.get("section") ?? "overview");
if (gatewayParams.get("initialOpen") === "false") {
	gatewayStore.setOpen(false);
}
useSettingsDialog.getState().setOpen(false);
setInterfaceLevel("expert");
installGatewayDialogFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Missing proof root");
}

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<I18nProvider>
			<MemoryRouter>
				<ProofSurface />
			</MemoryRouter>
		</I18nProvider>
	</QueryClientProvider>
);
