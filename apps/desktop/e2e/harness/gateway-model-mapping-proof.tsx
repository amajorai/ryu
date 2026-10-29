import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { RoutingCard } from "../../src/components/gateway/GatewayDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import type {
	GatewayAuthConfig,
	GatewayProvidersConfig,
	GatewayRoutingConfig,
} from "../../src/lib/api/gateway.ts";
import { parseProofJson } from "../fixture-json.ts";
import { routingProofSchema } from "./gateway-configuration-proof.contracts.ts";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: "gateway-model-mapping-proof-token",
	url: "http://127.0.0.1:7980",
};

const STORAGE_KEY = "gateway-model-mapping-proof-config";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface GatewayModelMappingProofState {
	failNextConfigRead: boolean;
	failNextConfigWrite: boolean;
	requests: CapturedRequest[];
	snapshot: () => {
		config: { routing: GatewayRoutingConfig };
		requests: CapturedRequest[];
	};
}

declare global {
	interface Window {
		__gatewayModelMappingProof: GatewayModelMappingProofState;
	}
}

function initialRouting(): GatewayRoutingConfig {
	return {
		default_provider: "anthropic",
		eval_routing: {
			candidates: ["anthropic", "openai"],
			enabled: true,
			explore_ratio: 0.25,
		},
		fallback_chain: ["openai", "local"],
		modality_map: {
			image: { model: "fal-flux-pro", provider: "fal" },
			tts: { provider: "elevenlabs" },
		},
		model_map: {
			"friendly-code-model": {
				provider: "openai",
				provider_model: "gpt-4.1-mini",
			},
			"plain-local-model": { provider: "local" },
		},
		provider_tiers: { anthropic: 2, local: 0, openai: 1 },
		smart_routing: {
			cache_by_session: true,
			classifier_model: "local-classifier",
			embedding_model: "nomic-embed-text-v1.5",
			enabled: true,
			rules: [{ description: "Code requests", model: "friendly-code-model" }],
			similarity_threshold: 0.32,
			strategy: "keyword",
			timeout_ms: 1500,
		},
	};
}

function readPersistedConfig() {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored) {
		return z.object({ routing: routingProofSchema }).parse(JSON.parse(stored));
	}
	const config = { routing: initialRouting() };
	localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
	return config;
}

// The Gateway always serves its redacted auth and providers sections beside
// routing, and the config response codec requires both.
const REDACTED_AUTH: GatewayAuthConfig = { api_keys: [], require_auth: false };
const REDACTED_PROVIDERS: GatewayProvidersConfig = {
	anthropic: { api_key: "***", base_url: "https://api.anthropic.com" },
	core: null,
	genai: { keys: [] },
	local: { base_url: "http://127.0.0.1:11434" },
	openai: { api_key: "***", base_url: "https://api.openai.com" },
	openrouter: { api_key: "***", base_url: "https://openrouter.ai/api/v1" },
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
	const state: GatewayModelMappingProofState = {
		failNextConfigRead: query.get("failRead") === "true",
		failNextConfigWrite: false,
		requests: [],
		snapshot() {
			return {
				config: readPersistedConfig(),
				requests: structuredClone(state.requests),
			};
		},
	};
	window.__gatewayModelMappingProof = state;

	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const { pathname } = new URL(rawUrl, window.location.href);
		const method = (init?.method ?? "GET").toUpperCase();
		const body = isNativeText(init?.body) ? parseProofJson(init.body) : null;
		state.requests.push({ body, method, path: pathname });

		if (pathname.endsWith("/api/gateway/config")) {
			if (method === "PUT") {
				if (state.failNextConfigWrite) {
					state.failNextConfigWrite = false;
					return jsonResponse({ message: "gateway_fixture_write_failed" }, 503);
				}
				const patch = z
					.object({ routing: routingProofSchema.optional() })
					.parse(body);
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
			return jsonResponse({
				auth: REDACTED_AUTH,
				providers: REDACTED_PROVIDERS,
				...readPersistedConfig(),
			});
		}
		return jsonResponse({});
	};
}

function ProofArtifact() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false },
				},
			}),
		[]
	);
	const query = new URLSearchParams(window.location.search);
	const reachable = query.get("unreachable") !== "true";
	const canConfigure = query.get("readOnly") !== "true";
	const configuredProviders =
		query.get("noProviders") === "true"
			? []
			: ["openai", "anthropic", "local", "openrouter"];

	return (
		<EntitlementProvider>
			<QueryClientProvider client={queryClient}>
				<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
					<div className="mx-auto max-w-4xl">
						<header className="mb-6">
							<div className="text-primary text-xs tracking-(--tracking-table-label)">
								RYU · LIVE REACT PROOF
							</div>
							<h1 className="mt-2 font-semibold text-3xl">
								Gateway model mappings
							</h1>
							<p className="mt-2 max-w-2xl text-base text-muted-foreground leading-6">
								Rendered Routing card backed by a stateful Gateway config
								fixture. Mapping writes preserve the full routing configuration
								and survive reload.
							</p>
						</header>
						<section className="rounded-2xl border border-border bg-card p-5">
							<RoutingCard
								canConfigure={canConfigure}
								configuredProviders={configuredProviders}
								reachable={reachable}
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
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
