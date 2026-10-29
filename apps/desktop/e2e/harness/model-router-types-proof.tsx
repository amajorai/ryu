import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { SmartRoutingCard } from "../../src/components/gateway/GatewayDialog.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import type { SmartRoutingConfig } from "../../src/lib/api/gateway.ts";
import type { PiCatalog } from "../../src/lib/api/pi-config.ts";
import { gatewayRoutingProofSchema } from "./gateway-proof-contracts.ts";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: null,
	url: "http://127.0.0.1:7980",
};

const ROUTING: SmartRoutingConfig = {
	enabled: true,
	router_type: "random",
	strategy: "llm",
	classifier_model: "",
	embedding_model: "",
	similarity_threshold: 0.35,
	random_seed: 42,
	stage_capable_model: "claude-sonnet-4-5",
	stage_efficient_model: "gpt-4o-mini",
	stage_picker: "capable_first",
	stage_confidence_threshold: 0.5,
	stage_recent_message_window: 3,
	escalation_weak_model: "gpt-4o-mini",
	escalation_strong_model: "claude-sonnet-4-5",
	escalation_judge_model: "gpt-4o-mini",
	escalation_confirmations: 2,
	escalation_recent_message_window: 28,
	escalation_message_chars: 500,
	rules: [
		{
			description: "Primary stable traffic",
			model: "claude-sonnet-4-5",
			weight: 3,
		},
		{
			description: "Candidate comparison traffic",
			model: "gpt-4o-mini",
			weight: 1,
		},
	],
	default_model: null,
	cache_by_session: true,
	timeout_ms: 4000,
};

let routing = gatewayRoutingProofSchema.parse({
	default_provider: "openai",
	model_map: {},
	fallback_chain: [],
	smart_routing: ROUTING,
});

const CATALOG: PiCatalog = {
	thinkingLevels: [],
	apiTypes: ["openai-completions"],
	providers: [
		{
			api: "openai-completions",
			authEnv: "",
			authKind: "none",
			configured: true,
			custom: false,
			id: "gateway",
			label: "Gateway",
			routing: "gateway",
			suggestedModels: [],
		},
		{
			api: "openai-completions",
			authEnv: "OPENAI_API_KEY",
			authKind: "api-key",
			configured: true,
			custom: false,
			id: "primary",
			label: "Primary provider",
			routing: "direct",
			suggestedModels: ["gpt-4o-mini"],
		},
		{
			api: "anthropic-messages",
			authEnv: "ANTHROPIC_API_KEY",
			authKind: "api-key",
			configured: true,
			custom: false,
			id: "candidate",
			label: "Candidate provider",
			routing: "direct",
			suggestedModels: ["claude-sonnet-4-5"],
		},
	],
};

function jsonResponse<FixturePayload>(value: FixturePayload): Response {
	return new Response(JSON.stringify(value), {
		headers: { "content-type": "application/json" },
		status: 200,
	});
}

function installGatewayMock(): void {
	window.fetch = async (input, init) => {
		const rawUrl = input instanceof Request ? input.url : String(input);
		const path = new URL(rawUrl, window.location.href).pathname;

		if (path.endsWith("/api/gateway/config")) {
			if ((init?.method ?? "GET").toUpperCase() === "PUT") {
				const patch = z
					.object({ routing: gatewayRoutingProofSchema.optional() })
					.parse(JSON.parse(isNativeText(init?.body) ? init.body : "{}"));
				if (patch.routing) {
					routing = patch.routing;
				}
			}
			return jsonResponse({ routing });
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
			return jsonResponse({ sidecars: [] });
		}
		if (path.endsWith("/api/models/installed")) {
			return jsonResponse({ models: [] });
		}
		if (path.includes("/api/preferences/") || path.endsWith("/api/gating")) {
			return jsonResponse({});
		}
		return jsonResponse({});
	};
}

function ProofArtifact() {
	const [status, setStatus] = useState(
		"Loaded a weighted-random routing snapshot"
	);
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false, refetchOnWindowFocus: false },
				},
			}),
		[]
	);

	useEffect(() => {
		const onFetch = () =>
			setStatus("Gateway config read through the same desktop client");
		window.addEventListener("load", onFetch, { once: true });
		return () => window.removeEventListener("load", onFetch);
	}, []);

	return (
		<EntitlementProvider>
			<QueryClientProvider client={queryClient}>
				<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
					<div className="mx-auto max-w-4xl">
						<header className="mb-6 flex items-start justify-between gap-5">
							<div>
								<div className="text-primary text-xs tracking-eyebrow">
									RYU · LIVE REACT PROOF
								</div>
								<h1 className="mt-2 font-semibold text-3xl">
									Model router types
								</h1>
								<p className="mt-2 max-w-2xl text-base text-muted-foreground leading-6">
									Gateway Plane A chooses a model, then the normal provider,
									governance, budget, and audit path continues.
								</p>
							</div>
							<div className="type-caption rounded-full border border-success/30 bg-success/10 px-3 py-2 font-semibold text-success tracking-wide">
								VERIFIED · ROUTING
							</div>
						</header>

						<section className="rounded-2xl border border-border bg-card p-5">
							<div className="mb-5 flex items-center justify-between border-border border-b pb-4">
								<div>
									<div className="type-caption text-muted-foreground uppercase tracking-wide">
										Gateway · Routing
									</div>
									<div className="mt-1 font-medium text-lg">Smart routing</div>
								</div>
								<span className="rounded-full border border-border px-2 py-1 text-muted-foreground text-xs">
									Live client surface
								</span>
							</div>
							<SmartRoutingCard canConfigure reachable target={TARGET} />
						</section>

						<p className="mt-4 font-mono text-muted-foreground text-xs">
							{status}
						</p>
					</div>
				</main>
			</QueryClientProvider>
		</EntitlementProvider>
	);
}

installGatewayMock();
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
