import { z } from "zod";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { TOKEN_KEY } from "../../lib/auth-client.ts";
import { GatewayDialog } from "../../src/components/gateway/GatewayDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import {
	DEFAULT_GATEWAY_ACP,
	DEFAULT_GATEWAY_COMPUTER_USE,
	DEFAULT_SESSION_BUDGET,
	type Evaluator,
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
	name: "gateway-inline-evaluator-proof",
	token: "gateway-inline-evaluator-proof-token",
	url: "http://127.0.0.1:5341",
};
const CONFIG_KEY = "gateway-inline-evaluator-proof-config";
const CATALOG_KEY = "gateway-inline-evaluator-proof-catalog";

type ConfigWithCustomEvaluators = GatewayConfig & {
	custom_evaluators?: Evaluator[];
};

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface EvaluatorProofState {
	failNextConfigWrite: boolean;
	requests: CapturedRequest[];
	restartCount: number;
	snapshot: () => {
		catalog: Evaluator[];
		config: ConfigWithCustomEvaluators;
		requests: CapturedRequest[];
		restartCount: number;
	};
}

declare global {
	interface Window {
		__gatewayInlineEvaluatorProof: EvaluatorProofState;
	}
}

function initialConfig(): ConfigWithCustomEvaluators {
	return {
		acp: DEFAULT_GATEWAY_ACP,
		auth: { api_keys: [], require_auth: false },
		budgets: { agents: {}, session: DEFAULT_SESSION_BUDGET, users: {} },
		computer_use: DEFAULT_GATEWAY_COMPUTER_USE,
		custom_evaluators: [],
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
			locked_fields: [],
			log_detections: true,
			policy: "warn_and_continue",
			redact_pii: true,
			redact_secrets: true,
			scan_inbound: true,
			scan_outbound: true,
		},
		firewall_agent_overlays: {},
		firewall_org_overlays: {},
		pipeline_stages: ["firewall", "dlp", "inspector", "inline-input"],
		providers: {
			anthropic: null,
			core: null,
			genai: null,
			local: null,
			openai: null,
			openrouter: null,
		},
		routing: { default_provider: "openai", fallback_chain: [], model_map: {} },
	};
}

const evaluatorProofSchema = z.object({
	builtin: z.boolean(),
	capabilities: z.object({ inline: z.boolean(), offline: z.boolean() }),
	category: z.enum([
		"security",
		"safety",
		"quality",
		"conversation",
		"trajectory",
		"image",
		"voice",
		"custom",
	]),
	description: z.string(),
	enforced: z.boolean(),
	higherIsBetter: z.boolean(),
	id: z.string(),
	impl: z.discriminatedUnion("kind", [
		z.object({ kind: z.literal("regex"), patterns: z.array(z.string()) }),
		z.object({ kind: z.literal("heuristic") }),
		z.object({ kind: z.literal("llm_judge"), rubric: z.string() }),
		z.object({
			kind: z.literal("code"),
			lang: z.enum(["js", "python"]),
			source: z.string(),
		}),
		z.object({ kind: z.literal("builtin"), detector: z.string() }),
	]),
	inline: z
		.object({ action: z.enum(["block", "warn_and_continue", "sanitize"]) })
		.nullable()
		.optional(),
	name: z.string(),
	offline: z
		.object({
			judgeModel: z.string().nullable().optional(),
			threshold: z.number(),
		})
		.nullable()
		.optional(),
	target: z.enum([
		"input",
		"output",
		"conversation",
		"trajectory",
		"image",
		"audio",
	]),
});
// This editor fixture accepts only evaluator writes; other gateway settings retain
// their authored baseline throughout save/restart round trips.
const evaluatorPatchSchema = z.strictObject({
	custom_evaluators: z.array(evaluatorProofSchema).optional(),
});
function readConfig(): ConfigWithCustomEvaluators {
	const stored = localStorage.getItem(CONFIG_KEY);
	if (stored) {
		return {
			...initialConfig(),
			...z
				.object({ custom_evaluators: z.array(evaluatorProofSchema).optional() })
				.parse(JSON.parse(stored)),
		};
	}
	const config = initialConfig();
	localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
	return config;
}

function builtinEvaluators(): Evaluator[] {
	return [
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
	];
}

function registeredEvaluators(): Evaluator[] {
	const stored = localStorage.getItem(CATALOG_KEY);
	return stored ? z.array(evaluatorProofSchema).parse(JSON.parse(stored)) : [];
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

const state: EvaluatorProofState = {
	failNextConfigWrite: false,
	requests: [],
	restartCount: 0,
	snapshot: () => ({
		catalog: [...builtinEvaluators(), ...registeredEvaluators()],
		config: readConfig(),
		requests: structuredClone(state.requests),
		restartCount: state.restartCount,
	}),
};

window.__gatewayInlineEvaluatorProof = state;
localStorage.removeItem(TOKEN_KEY);

const nativeFetch = globalThis.fetch.bind(globalThis);
window.fetch = async (input, init) => {
	const rawUrl = input instanceof Request ? input.url : String(input);
	const url = new URL(rawUrl, window.location.href);
	const path = url.pathname;
	const method = (init?.method ?? "GET").toUpperCase();
	const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
	state.requests.push({ body, method, path });

	if (path.endsWith("/api/gateway/status")) {
		return json({
			health: { providers: [] },
			metrics: {},
			reachable: true,
			url: NODE.url,
		});
	}
	if (path.endsWith("/api/gateway/config")) {
		if (method === "PUT") {
			if (state.failNextConfigWrite) {
				state.failNextConfigWrite = false;
				return json({ message: "evaluator_fixture_write_failed" }, 503);
			}
			const patch = evaluatorPatchSchema.parse(body);
			const config = {
				...readConfig(),
				...patch,
			};
			localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
			return json({ ok: true });
		}
		return json(readConfig());
	}
	if (path.endsWith("/api/gateway/evaluators")) {
		return json({
			evaluators: [...builtinEvaluators(), ...registeredEvaluators()],
		});
	}
	if (path.endsWith("/api/gateway/restart") && method === "POST") {
		state.restartCount += 1;
		localStorage.setItem(
			CATALOG_KEY,
			JSON.stringify(readConfig().custom_evaluators ?? [])
		);
		return json({ success: true });
	}
	if (path.endsWith("/api/gateway/exec-approval-mode")) {
		return json({ value: "enforce" });
	}
	if (path.endsWith("/api/preferences/exec-approval-mode")) {
		return json({ value: "enforce" });
	}
	if (path.endsWith("/api/preferences/catalog-scan-agent")) {
		return json({ value: "" });
	}
	if (path.includes("/api/preferences/")) {
		return method === "PUT" ? json({ ok: true }) : json({ value: null });
	}
	if (path.endsWith("/api/sidecar/status")) {
		return json({ sidecars: [] });
	}
	if (path.endsWith("/api/models/installed")) {
		return json({ models: [] });
	}
	if (path.endsWith("/api/agents/catalog") || path.endsWith("/api/agents")) {
		return json({ agents: [] });
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
	if (path.endsWith("/api/auth/get-session")) {
		return json({ session: null, user: null });
	}
	if (path.endsWith("/api/control-plane/orgs")) {
		return json({ organizations: [] });
	}
	if (path.endsWith("/api/control-plane/me/permissions")) {
		return json({ permissions: [] });
	}
	return nativeFetch(input, init);
};

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

function ProofSurface() {
	const gatewayOpen = useGatewayDialog((store) => store.open);
	const gatewaySection = useGatewayDialog((store) => store.section);
	const setGatewayOpen = useGatewayDialog((store) => store.setOpen);

	return (
		<AppSurfaceProvider surface="desktop">
			<EntitlementProvider>
				<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
					<main className="min-h-screen bg-background p-8 text-foreground">
						<GatewayDialog
							defaultSection={gatewaySection}
							onOpenChange={setGatewayOpen}
							open={gatewayOpen}
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

export type GatewayInlineEvaluatorProofPublisher = EvaluatorProofState;
