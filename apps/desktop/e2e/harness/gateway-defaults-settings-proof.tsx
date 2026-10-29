import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { AgentSelection } from "../../src/lib/api/preferences.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const NODE = {
	managed: true,
	name: "gateway-defaults-proof",
	orgId: "defaults-proof-org",
	token: "gateway-defaults-proof-token",
	url: "http://127.0.0.1:7991",
	userJwt: null,
};
const PREFERENCES_KEY = "gateway-defaults-proof-preferences";
const INITIAL_LOCAL_SELECTION: AgentSelection = {
	agent_id: "ryu",
	provider: "local",
	model: "gemma-4-E2B-it-Q4_K_M",
	thinking_level: "",
	effort: "",
	access_mode: "",
};
const PreferencesSchema = z.record(z.string(), z.string());
type Preferences = z.infer<typeof PreferencesSchema>;

const INITIAL_PREFERENCES = {
	"default-local-agent-selection": JSON.stringify(INITIAL_LOCAL_SELECTION),
	"engine.llamacpp.sleep-idle-seconds": "300",
} satisfies Preferences;

interface CapturedRequest {
	body: ProofJsonValue;
	method: string;
	path: string;
}

interface DefaultsProofState {
	armNextPreferenceWriteFailure: (key: string) => void;
	requests: CapturedRequest[];
	snapshot: () => {
		preferences: Record<string, string>;
		requests: CapturedRequest[];
	};
}

declare global {
	interface Window {
		__gatewayDefaultsProof: DefaultsProofState;
	}
}

function readPreferences(): Preferences {
	const stored = localStorage.getItem(PREFERENCES_KEY);
	if (stored) {
		return PreferencesSchema.parse(JSON.parse(stored));
	}
	localStorage.setItem(PREFERENCES_KEY, JSON.stringify(INITIAL_PREFERENCES));
	return { ...INITIAL_PREFERENCES };
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installMocks(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("reset") === "true") {
		localStorage.removeItem(PREFERENCES_KEY);
		window.history.replaceState(null, "", window.location.pathname);
	}
	if (params.get("permission") === "denied") {
		localStorage.setItem(TOKEN_KEY, "gateway-defaults-proof-session");
	} else {
		localStorage.removeItem(TOKEN_KEY);
	}
	let failNextPreferenceWrite = "";
	let gatewayStatusReads = 0;
	const state: DefaultsProofState = {
		armNextPreferenceWriteFailure: (key) => {
			failNextPreferenceWrite = key;
		},
		requests: [],
		snapshot: () => ({
			preferences: structuredClone(readPreferences()),
			requests: structuredClone(state.requests),
		}),
	};
	window.__gatewayDefaultsProof = state;

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const path = url.pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const rawBody = z.string().safeParse(init?.body);
		const body = rawBody.success ? parseProofJson(rawBody.data) : null;
		state.requests.push({ body, method, path });

		if (path.endsWith("/api/gateway/status")) {
			gatewayStatusReads += 1;
			if (params.get("holdStatusPoll") === "true" && gatewayStatusReads > 1) {
				return await new Promise<Response>(() => undefined);
			}
			return json({
				health: { providers: [] },
				metrics: {},
				reachable: true,
				url: NODE.url,
			});
		}
		if (path.startsWith("/api/preferences/")) {
			const key = decodeURIComponent(path.slice("/api/preferences/".length));
			const preferences = readPreferences();
			if (method === "PUT") {
				if (failNextPreferenceWrite === key) {
					failNextPreferenceWrite = "";
					return json({ error: "proof_write_failed" }, 503);
				}
				const payload = z.object({ value: z.string() }).safeParse(body);
				if (!payload.success) {
					return json({ error: "invalid_preference_payload" }, 400);
				}
				preferences[key] = payload.data.value;
				localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
				return json({ key, ok: true });
			}
			return json({ key, value: preferences[key] ?? null });
		}
		if (path.endsWith("/api/agents")) {
			return json({
				agents: [
					{
						avatar_glyph: null,
						avatar_url: null,
						built_in: true,
						description: "Ryu's built-in agent.",
						engine: "local",
						id: "ryu",
						model: "gemma-4-E2B-it-Q4_K_M",
						name: "Ryu",
						recommended: true,
						transport: "openai_compat",
					},
				],
			});
		}
		if (path.endsWith("/api/engines")) {
			return json({ engines: [] });
		}
		if (path.endsWith("/api/engine/active")) {
			return json({ active: null, available: [], running: false });
		}
		if (path.endsWith("/api/pi-config/catalog")) {
			return json({
				apiTypes: ["openai-completions"],
				providers: [
					{
						api: "openai-completions",
						authEnv: "",
						authKind: "none",
						configured: true,
						custom: false,
						id: "local",
						label: "Local",
						modelOverrides: {},
						routing: "direct",
						suggestedModels: [
							"gemma-4-E2B-it-Q4_K_M",
							"qwen3.5-4b-instruct-q4_K_M",
						],
						supportsDiscovery: false,
					},
					{
						api: "openai-completions",
						authEnv: "",
						authKind: "none",
						configured: true,
						custom: false,
						id: "managed-openrouter",
						label: "Auto cloud",
						modelOverrides: {},
						routing: "gateway",
						suggestedModels: ["openrouter/auto", "anthropic/claude-sonnet-4"],
						supportsDiscovery: false,
					},
				],
				thinkingLevels: [],
			});
		}
		if (path.endsWith("/api/pi-config")) {
			return json({ config: { defaultProvider: "local", providers: {} } });
		}
		if (path === "/api/plugins") {
			return json({ apps: [] });
		}
		if (path === "/api/plugins/contributions") {
			return json({ settings_tabs: [] });
		}
		if (path.endsWith("/api/auth/get-session")) {
			return json({ session: { activeOrganizationId: "defaults-proof-org" } });
		}
		if (path.endsWith("/api/control-plane/orgs")) {
			return json({
				organizations: [
					{
						id: "defaults-proof-org",
						name: "Defaults proof org",
						role: params.get("permission") === "denied" ? "member" : "owner",
					},
				],
			});
		}
		if (path.endsWith("/api/control-plane/me/permissions")) {
			return json({
				permissions:
					params.get("permission") === "denied"
						? []
						: ["gateway.view", "gateway.configure"],
			});
		}
		if (path.endsWith("/api/sidecar/status")) {
			return json({ sidecars: [] });
		}
		if (path.endsWith("/api/models/installed")) {
			return json({ models: [] });
		}
		if (path.endsWith("/api/agents/catalog")) {
			return json({ agents: [] });
		}
		return json({});
	};
}

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { refetchOnWindowFocus: false, retry: false },
	},
});

useNodeStore.setState({
	cloudNodes: [NODE],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
setInterfaceLevel("expert");
useGatewayDialog.getState().openGateway("defaults");
installMocks();

function ProofSurface() {
	const open = useGatewayDialog((store) => store.open);
	const section = useGatewayDialog((store) => store.section);
	const setOpen = useGatewayDialog((store) => store.setOpen);

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<GatewayDialog
							defaultSection={section}
							onOpenChange={setOpen}
							open={open}
						/>
						<Toaster position="bottom-right" theme="system" />
					</main>
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
