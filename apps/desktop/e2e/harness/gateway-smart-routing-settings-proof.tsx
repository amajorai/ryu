import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";

declare const window: Window;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { SmartRoutingCard } from "../../src/components/gateway/GatewayDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import {
	CLASSIFY_MODEL_ID,
	DEFAULT_SMART_ROUTING,
	type GatewayRoutingConfig,
} from "../../src/lib/api/gateway.ts";
import type { PiCatalog } from "../../src/lib/api/pi-config.ts";
import { setInterfaceLevel } from "../../src/lib/interface-level.ts";
import { parseProofJson } from "../fixture-json.ts";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: "gateway-smart-routing-proof-token",
	url: "http://127.0.0.1:7980",
};

const STORAGE_KEY = "gateway-smart-routing-proof-config";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface SmartRoutingProofState {
	failNextConfigRead: boolean;
	failNextConfigWrite: boolean;
	omitSmartRoutingOnNextConfigRead: boolean;
	requests: CapturedRequest[];
	setRemoteSmartRoutingEnabled: (enabled: boolean) => void;
	snapshot: () => {
		config: { routing: GatewayRoutingConfig };
		requests: CapturedRequest[];
	};
}

declare global {
	interface Window {
		__gatewaySmartRoutingProof: SmartRoutingProofState;
	}
}

function initialRouting(): GatewayRoutingConfig {
	const query = new URLSearchParams(window.location.search);
	const withLocalClassifier = query.get("withLocalClassifier") === "true";
	const smartRouting =
		query.get("missing") === "smart"
			? undefined
			: {
					...DEFAULT_SMART_ROUTING,
					enabled: withLocalClassifier,
					embedding_model: "nomic-embed-text-v1.5",
					rules: [
						{
							description: "Code and debugging requests",
							model: "claude-sonnet-4-5",
							weight: 1,
						},
					],
					strategy: withLocalClassifier
						? ("llm" as const)
						: ("embedding" as const),
				};
	return {
		default_provider: "anthropic",
		fallback_chain: ["openai"],
		model_map: {
			"friendly-code-model": {
				provider: "openai",
				provider_model: "gpt-4.1-mini",
			},
		},
		provider_tiers: { anthropic: 0, openai: 1 },
		...(smartRouting ? { smart_routing: smartRouting } : undefined),
	};
}

const SmartRoutingSchema = z.object({
	cache_by_session: z.boolean(),
	classifier_model: z.string(),
	default_model: z.string().nullable().optional(),
	embedding_model: z.string(),
	enabled: z.boolean(),
	rules: z.array(
		z.object({
			description: z.string(),
			model: z.string(),
			weight: z.number().optional(),
		})
	),
	similarity_threshold: z.number(),
	strategy: z.enum(["llm", "embedding", "keyword"]),
	timeout_ms: z.number(),
	router_type: z
		.enum([
			"llm_classifier",
			"passthrough",
			"random",
			"stage_router",
			"escalation",
		])
		.optional(),
	random_seed: z.number().nullable().optional(),
	stage_capable_model: z.string().optional(),
	stage_efficient_model: z.string().optional(),
	stage_picker: z.enum(["capable_first", "efficient_first"]).optional(),
	stage_confidence_threshold: z.number().optional(),
	stage_recent_message_window: z.number().optional(),
	escalation_weak_model: z.string().optional(),
	escalation_strong_model: z.string().optional(),
	escalation_judge_model: z.string().optional(),
	escalation_confirmations: z.number().optional(),
	escalation_recent_message_window: z.number().optional(),
	escalation_message_chars: z.number().optional(),
});
const RoutingSchema = z.object({
	default_provider: z.enum([
		"openai",
		"anthropic",
		"local",
		"openrouter",
		"core",
		"genai",
		"mistral",
		"huggingface",
		"nvidia",
		"together",
		"fireworks",
	]),
	fallback_chain: z.array(
		z.enum([
			"openai",
			"anthropic",
			"local",
			"openrouter",
			"core",
			"genai",
			"mistral",
			"huggingface",
			"nvidia",
			"together",
			"fireworks",
		])
	),
	model_map: z.record(
		z.string(),
		z.object({
			provider: z.string(),
			provider_model: z.string().nullable().optional(),
		})
	),
	provider_tiers: z.record(z.string(), z.number()).optional(),
	smart_routing: SmartRoutingSchema.optional(),
}) satisfies z.ZodType<GatewayRoutingConfig>;
const ConfigSchema = z.object({ routing: RoutingSchema });

function readPersistedConfig() {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		return ConfigSchema.parse(JSON.parse(stored));
	}
	const config = { routing: initialRouting() };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	return config;
}

const CATALOG: PiCatalog = {
	apiTypes: ["openai-completions"],
	providers: [
		{
			api: "openai-completions",
			authEnv: "OPENAI_API_KEY",
			authKind: "api-key",
			configured: true,
			custom: false,
			id: "openai",
			label: "OpenAI",
			routing: "direct",
			suggestedModels: ["gpt-4o-mini", "gpt-4.1-mini"],
		},
	],
	thinkingLevels: [],
};

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function installGatewayMock(): void {
	const query = new URLSearchParams(window.location.search);
	const state: SmartRoutingProofState = {
		failNextConfigRead: query.get("failRead") === "true",
		failNextConfigWrite: false,
		omitSmartRoutingOnNextConfigRead: false,
		requests: [],
		setRemoteSmartRoutingEnabled(enabled) {
			const config = readPersistedConfig();
			if (config.routing.smart_routing) {
				config.routing.smart_routing.enabled = enabled;
			}
			localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
		},
		snapshot() {
			return {
				config: readPersistedConfig(),
				requests: structuredClone(state.requests),
			};
		},
	};
	window.__gatewaySmartRoutingProof = state;

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(rawUrl, window.location.href);
		const path = url.pathname;
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		state.requests.push({ body, method, path });

		if (path.endsWith("/api/gateway/config")) {
			if (method === "PUT") {
				if (state.failNextConfigWrite) {
					state.failNextConfigWrite = false;
					return jsonResponse({ message: "gateway_fixture_write_failed" }, 503);
				}
				const patch = ConfigSchema.partial().parse(body);
				if (patch.routing) {
					localStorage.setItem(
						STORAGE_KEY,
						JSON.stringify({ routing: patch.routing })
					);
				}
				return jsonResponse({ ok: true });
			}
			if (state.failNextConfigRead) {
				state.failNextConfigRead = false;
				return jsonResponse({ message: "gateway_fixture_read_failed" }, 503);
			}
			const config = readPersistedConfig();
			if (state.omitSmartRoutingOnNextConfigRead) {
				state.omitSmartRoutingOnNextConfigRead = false;
				const routing = { ...config.routing, smart_routing: undefined };
				return jsonResponse({ routing });
			}
			return jsonResponse(config);
		}
		if (path.endsWith("/api/pi-config/catalog")) {
			return jsonResponse(CATALOG);
		}
		if (path.endsWith("/api/agents")) {
			return jsonResponse([]);
		}
		if (path.endsWith("/api/engines")) {
			return jsonResponse({ engines: [] });
		}
		if (path.endsWith("/api/engine/active")) {
			return jsonResponse({ active: null, available: [], running: false });
		}
		if (path.endsWith("/api/sidecar/status")) {
			const classifyTier = query.get("classifyTier");
			return jsonResponse({
				sidecars:
					classifyTier === "idle" ||
					classifyTier === "running" ||
					classifyTier === "unweighted"
						? [
								{
									name: "llamacpp-classify",
									running: classifyTier === "running",
								},
							]
						: [],
			});
		}
		if (path.endsWith("/api/models/installed")) {
			const classifyTier = query.get("classifyTier");
			return jsonResponse({
				models:
					classifyTier === "idle" || classifyTier === "running"
						? [{ stem: CLASSIFY_MODEL_ID }]
						: [],
			});
		}
		if (path.includes("/api/preferences/") || path.endsWith("/api/gating")) {
			return jsonResponse({});
		}
		return jsonResponse({});
	};
}

function ProofArtifact() {
	const query = new URLSearchParams(window.location.search);
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false },
				},
			}),
		[]
	);

	return (
		<EntitlementProvider>
			<QueryClientProvider client={queryClient}>
				<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
					<div className="mx-auto max-w-4xl">
						<header className="mb-6">
							<div className="text-primary text-xs tracking-table-label">
								RYU · LIVE REACT PROOF
							</div>
							<h1 className="mt-2 font-semibold text-3xl">
								Gateway smart routing settings
							</h1>
							<p className="mt-2 max-w-2xl text-base text-muted-foreground leading-6">
								Rendered Smart routing card backed by a stateful Gateway config
								fixture. Writes persist across reloads and expose their request
								bodies for assertions.
							</p>
						</header>
						<section className="rounded-2xl border border-border bg-card p-5">
							<SmartRoutingCard
								canConfigure={query.get("canConfigure") !== "false"}
								reachable={query.get("reachable") !== "false"}
								target={TARGET}
							/>
						</section>
					</div>
				</main>
			</QueryClientProvider>
		</EntitlementProvider>
	);
}

installGatewayMock();
setInterfaceLevel("expert");
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
