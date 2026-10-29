import { I18nProvider } from "@ryu/i18n/react";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { z } from "zod";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_SESSION_BUDGET,
	type GatewayConfig,
} from "../../src/lib/api/gateway.ts";
import { useProductModeStore } from "../../src/lib/product-mode.ts";
import { useGatewayDialog } from "../../src/store/useGatewayDialog.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

// Gateway opens only in Console; grant the access App's ProductModeAccessSync
// would grant a local node.
useProductModeStore.setState({ requestedMode: "console", consoleAccess: true });

const NODE = {
	name: "guardrails-proof",
	token: "guardrails-proof-token",
	url: "http://127.0.0.1:7983",
};
const CONFIG_KEY = "gateway-guardrails-proof-config";
const PREFERENCES_KEY = "gateway-guardrails-proof-preferences";

const PolicySchema = z.enum(["block", "warn_and_continue", "sanitize"]);
const PatternSchema = z.object({
	kind: z.enum(["pii", "secret", "prompt_injection"]),
	name: z.string(),
	regex: z.string(),
});
const InspectorSchema = z.object({
	action: PolicySchema,
	enabled: z.boolean(),
	min_chars: z.number(),
	mode: z.enum(["injection", "dlp", "both"]),
	model: z.string(),
	timeout_ms: z.number(),
});
const EvaluatorSchema = z.object({
	enabled: z.boolean(),
	id: z.string(),
	inlineAction: PolicySchema.nullable().optional(),
	locked: z.boolean().optional(),
	offline: z
		.object({
			judgeModel: z.string().nullable().optional(),
			threshold: z.number(),
		})
		.nullable()
		.optional(),
});
const FirewallSchema = z.object({
	alert: z.enum(["silent", "warn", "fanout", "email"]),
	custom_patterns: PatternSchema.array(),
	enabled: z.boolean(),
	evaluators: EvaluatorSchema.array().optional(),
	inspector: InspectorSchema,
	locked_fields: z.string().array(),
	log_detections: z.boolean(),
	policy: PolicySchema,
	redact_pii: z.boolean(),
	redact_secrets: z.boolean(),
	scan_inbound: z.boolean(),
	scan_outbound: z.boolean(),
	wrap_untrusted_tool_results: z.boolean().optional(),
});
const OverlaySchema = FirewallSchema.partial().extend({
	alert: z.enum(["silent", "warn", "fanout", "email"]).nullish(),
	enabled: z.boolean().nullish(),
	inspector: InspectorSchema.nullish(),
	log_detections: z.boolean().nullish(),
	policy: PolicySchema.nullish(),
	redact_pii: z.boolean().nullish(),
	redact_secrets: z.boolean().nullish(),
	scan_inbound: z.boolean().nullish(),
	scan_outbound: z.boolean().nullish(),
	wrap_untrusted_tool_results: z.boolean().nullish(),
});
// This proof owns guardrail mutations; other Gateway sections retain their authored seed values.
const GuardrailConfigSchema = z.object({
	firewall: FirewallSchema,
	firewall_agent_overlays: z.record(z.string(), OverlaySchema),
	firewall_org_overlays: z.record(z.string(), OverlaySchema),
	pipeline_stages: z.string().array().optional(),
});
const GuardrailPatchSchema = GuardrailConfigSchema.partial();
const PreferencesSchema = z.record(z.string(), z.string());

function readPreferences(): Record<string, string> {
	return PreferencesSchema.parse(
		JSON.parse(
			localStorage.getItem(PREFERENCES_KEY) ??
				'{"exec-approval-mode":"enforce","security-scanner-agent":""}'
		)
	);
}

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status?: number;
}

interface GuardrailsProofState {
	failNextConfigRead: boolean;
	failNextConfigWrite: boolean;
	failNextPreferenceWrite: boolean;
	requests: CapturedRequest[];
	snapshot: () => {
		config: GatewayConfig;
		preferences: Record<string, string>;
		requests: CapturedRequest[];
	};
}

declare global {
	interface Window {
		__gatewayGuardrailsProof: GuardrailsProofState;
	}
}

function initialConfig(): GatewayConfig {
	return {
		acp: DEFAULT_GATEWAY_ACP,
		auth: { api_keys: [], require_auth: false },
		budgets: {
			agents: {},
			session: DEFAULT_SESSION_BUDGET,
			users: {},
		},
		computer_use: DEFAULT_GATEWAY_COMPUTER_USE,
		firewall: {
			alert: "silent",
			custom_patterns: [],
			enabled: true,
			evaluators: [],
			inspector: {
				action: "block",
				enabled: false,
				min_chars: 40,
				mode: "both",
				model: "gemma-3-270m-it",
				timeout_ms: 1500,
			},
			locked_fields: ["scan_inbound"],
			log_detections: true,
			policy: "warn_and_continue",
			redact_pii: true,
			redact_secrets: false,
			scan_inbound: true,
			scan_outbound: true,
		},
		firewall_agent_overlays: {
			"agent-kept": { policy: "block", scan_outbound: true },
		},
		firewall_org_overlays: {
			"org-kept": { policy: "sanitize", scan_inbound: true },
		},
		pipeline_stages: ["firewall", "dlp", "inspector", "inline-input"],
		providers: {
			anthropic: null,
			core: null,
			genai: null,
			local: null,
			openai: null,
			openrouter: null,
		},
		routing: {
			default_provider: "openai",
			fallback_chain: [],
			model_map: {},
		},
	};
}

function readConfig(): GatewayConfig {
	const stored = localStorage.getItem(CONFIG_KEY);
	if (stored) {
		return {
			...initialConfig(),
			...GuardrailConfigSchema.parse(JSON.parse(stored)),
		};
	}
	const config = initialConfig();
	localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
	return config;
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installMocks(): void {
	const params = new URLSearchParams(window.location.search);
	if (params.get("permission") === "denied") {
		localStorage.setItem(TOKEN_KEY, "guardrails-proof-session");
	} else {
		localStorage.removeItem(TOKEN_KEY);
	}
	const state: GuardrailsProofState = {
		failNextConfigRead: params.get("failRead") === "true",
		failNextConfigWrite: false,
		failNextPreferenceWrite: false,
		requests: [],
		snapshot: () => ({
			config: readConfig(),
			preferences: readPreferences(),
			requests: structuredClone(state.requests),
		}),
	};
	window.__gatewayGuardrailsProof = state;

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const path = url.pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		const request: CapturedRequest = { body, method, path };
		state.requests.push(request);

		if (path.endsWith("/api/gateway/status")) {
			return json({
				health: { providers: [] },
				metrics: {},
				reachable: params.get("unreachable") !== "true",
				url: NODE.url,
			});
		}
		if (path.endsWith("/api/gateway/config")) {
			if (method === "PUT") {
				if (state.failNextConfigWrite) {
					state.failNextConfigWrite = false;
					request.status = 503;
					return json({ message: "guardrails_fixture_write_failed" }, 503);
				}
				const patch = GuardrailPatchSchema.parse(body);
				const config = { ...readConfig(), ...patch };
				if (
					patch.firewall?.custom_patterns?.some(
						(pattern) => pattern.regex === "["
					)
				) {
					request.status = 422;
					return json({ error: "invalid custom pattern: invalid regex" }, 422);
				}
				localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
				request.status = 200;
				return json({ ok: true });
			}
			if (state.failNextConfigRead) {
				state.failNextConfigRead = false;
				request.status = 503;
				return json({ message: "guardrails_fixture_read_failed" }, 503);
			}
			request.status = 200;
			return json(readConfig());
		}
		if (path.endsWith("/api/gateway/evaluators")) {
			return json({
				evaluators: [
					{
						builtin: true,
						capabilities: { inline: true, offline: false },
						category: "security",
						description: "Fixture detector for behavior proof.",
						enforced: true,
						higherIsBetter: false,
						id: "coverage-pii-detector",
						impl: { kind: "builtin", detector: "pii" },
						inline: { action: "warn_and_continue" },
						name: "Coverage PII detector",
						target: "input",
					},
				],
			});
		}
		if (path.endsWith("/api/gateway/exec-approval-mode")) {
			return json({ value: "enforce" });
		}
		if (path.includes("/api/preferences/")) {
			const key = path.split("/").at(-1) ?? "";
			if (method === "PUT") {
				if (
					params.get("permission") === "denied" ||
					state.failNextPreferenceWrite
				) {
					state.failNextPreferenceWrite = false;
					request.status = params.get("permission") === "denied" ? 403 : 503;
					return json({ message: "preference_write_failed" }, request.status);
				}
				const preferences = readPreferences();
				preferences[key] = z.object({ value: z.string() }).parse(body).value;
				localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
				request.status = 200;
				return json({ ok: true });
			}
			if (params.get("failPreferenceRead") === key) {
				request.status = 503;
				return json({ message: "preference_read_failed" }, 503);
			}
			request.status = 200;
			return json({ value: readPreferences()[key] ?? null });
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
		if (path.endsWith("/api/agents")) {
			return json({
				agents:
					params.get("withAgent") === "true"
						? [
								{
									id: "coverage-agent",
									name: "Coverage Agent",
									engine: null,
									description: "A user-authored fixture agent.",
								},
							]
						: [],
			});
		}
		if (path.endsWith("/api/agents/coverage-agent")) {
			return json({
				agent: {
					id: "coverage-agent",
					name: "Coverage Agent",
					engine: "openai-compat",
					lifecycle_status: "ready",
				},
			});
		}
		if (path.endsWith("/api/engines")) {
			return json({ engines: [] });
		}
		if (path.endsWith("/api/engine/active")) {
			return json({ active: null, available: [], running: false });
		}
		if (path.endsWith("/api/pi-config")) {
			return json({ config: { defaultProvider: "openai", providers: {} } });
		}
		if (path === "/api/plugins") {
			return json({ apps: [] });
		}
		if (path === "/api/plugins/contributions") {
			return json({ settings_tabs: [] });
		}
		if (path === "/api/auth/get-session") {
			return json({ session: null, user: null });
		}
		if (path.endsWith("/api/control-plane/orgs")) {
			return json({
				organizations: [{ id: "proof-org", name: "Proof org", role: "member" }],
			});
		}
		if (path.endsWith("/api/control-plane/me/permissions")) {
			return json({ permissions: [] });
		}
		if (path.endsWith("/api/auth/get-session")) {
			return json({ session: { activeOrganizationId: "proof-org" } });
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
	cloudNodes: [],
	defaultNode: NODE.name,
	localNodes: [NODE],
	nodes: [NODE],
});
useGatewayDialog.getState().openGateway("guardrails");
installMocks();

function ProofSurface() {
	const gatewayOpen = useGatewayDialog((store) => store.open);
	const gatewaySection = useGatewayDialog((store) => store.section);
	const setGatewayOpen = useGatewayDialog((store) => store.setOpen);

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<TooltipProvider delay={0}>
							<GatewayDialog
								defaultSection={gatewaySection}
								onOpenChange={setGatewayOpen}
								open={gatewayOpen}
							/>
						</TooltipProvider>
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
