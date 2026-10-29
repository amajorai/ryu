import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { RoutingCard } from "../../src/components/gateway/GatewayDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import type {
	GatewayConfigPatch,
	GatewayRoutingConfig,
} from "../../src/lib/api/gateway.ts";
import { parseProofJson } from "../fixture-json.ts";
import { routingProofSchema } from "./gateway-configuration-proof.contracts.ts";
import "../../src/index.css";

declare const window: Window;

const TARGET: ApiTarget = {
	token: "gateway-modality-routing-proof-token",
	url: "http://127.0.0.1:7980",
};

const STORAGE_KEY = "gateway-modality-routing-proof-config";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface ModalityProofSnapshot {
	config: { routing: GatewayRoutingConfig };
	requests: CapturedRequest[];
}

interface ModalityProofState {
	failNextConfigWrite: boolean;
	requests: CapturedRequest[];
	snapshot: () => ModalityProofSnapshot;
}

declare global {
	interface Window {
		__gatewayModalityRoutingProof: ModalityProofState;
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
			image: { model: "flux-fast", provider: "fal" },
			tts: { model: "speech-1", provider: "openai" },
		},
		model_map: {
			"friendly-code-model": {
				provider: "openai",
				provider_model: "gpt-4.1-mini",
			},
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

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

function parseBody(value: BodyInit | null | undefined) {
	if (!isNativeText(value)) {
		return null;
	}
	try {
		return parseProofJson(value);
	} catch {
		return null;
	}
}

const state: ModalityProofState = {
	failNextConfigWrite: false,
	requests: [],
	snapshot: () => ({
		config: readPersistedConfig(),
		requests: structuredClone(state.requests),
	}),
};

window.__gatewayModalityRoutingProof = state;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url = new URL(
		input instanceof Request ? input.url : String(input),
		window.location.href
	);
	if (
		url.origin === window.location.origin &&
		!url.pathname.startsWith("/api/")
	) {
		return nativeFetch(input, init);
	}
	if (!url.pathname.endsWith("/api/gateway/config")) {
		return jsonResponse({});
	}

	const method = (
		init?.method ?? (input instanceof Request ? input.method : "GET")
	).toUpperCase();
	const body = parseBody(
		init?.body ?? (input instanceof Request ? await input.clone().text() : null)
	);
	state.requests.push({ body, method, path: url.pathname });
	if (method === "PUT") {
		if (state.failNextConfigWrite) {
			state.failNextConfigWrite = false;
			return jsonResponse({ message: "gateway_fixture_write_failed" }, 503);
		}
		const patchSchema = z.object({
			routing: routingProofSchema.optional(),
		}) satisfies z.ZodType<Pick<GatewayConfigPatch, "routing">>;
		const patch = patchSchema.parse(body);
		if (patch.routing) {
			localStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({ routing: patch.routing })
			);
		}
		return jsonResponse({ ok: true });
	}
	return jsonResponse(readPersistedConfig());
};

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<EntitlementProvider>
			<QueryClientProvider client={queryClient}>
				<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
					<div className="mx-auto max-w-4xl">
						<header className="mb-6">
							<div className="text-primary text-xs tracking-widest">
								RYU · LIVE REACT PROOF
							</div>
							<h1 className="mt-2 font-semibold text-3xl">
								Gateway modality routing
							</h1>
							<p className="mt-2 max-w-2xl text-base text-muted-foreground leading-6">
								The production Routing card saves modality-specific
								provider/model assignments while preserving the rest of the
								routing configuration.
							</p>
						</header>
						<section className="rounded-2xl border border-border bg-card p-5">
							<RoutingCard
								canConfigure
								configuredProviders={[
									"anthropic",
									"openai",
									"local",
									"openrouter",
									"fal",
									"replicate",
									"modal",
									"elevenlabs",
									// Registered by the Gateway when a donated OpenAI allowance is
									// configured; a separate id from the operator's own `openai`.
									"openai-credits",
								]}
								reachable
								target={TARGET}
							/>
						</section>
					</div>
				</main>
			</QueryClientProvider>
		</EntitlementProvider>
	);
}
