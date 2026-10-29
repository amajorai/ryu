import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { UsageCostSection } from "../../src/components/gateway/UsageCostSection.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import type { ApiTarget } from "../../src/lib/api/client.ts";
import type { GatewayMetrics } from "../../src/lib/api/gateway.ts";
import type { ProfileStats } from "../../src/lib/api/profile.ts";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { parseProofJson } from "../fixture-json.ts";
import { gatewayRoutingProofSchema } from "./gateway-proof-contracts.ts";
import "../../src/index.css";

const TARGET: ApiTarget = {
	token: "gateway-usage-cost-proof-token",
	url: "http://127.0.0.1:7980",
};

const SESSION_TOKEN_KEY = "ryu_session_token";
const CONFIG_KEY = "gateway-usage-cost-proof-config";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
}

interface UsageCostProofState {
	failConfigReads: number;
	failNextConfigWrite: boolean;
	failNextStatsRead: boolean;
	profileStatsPending: boolean;
	providerCreditRequests: string[];
	releaseProfileStats: () => void;
	releaseProviderCredits: () => void;
	requests: CapturedRequest[];
	snapshot: () => {
		config: {
			routing: ReturnType<typeof readConfig>["routing"];
			providers: ReturnType<typeof initialConfig>["providers"];
		};
		requests: CapturedRequest[];
		providerCreditRequests: string[];
	};
}

declare global {
	interface Window {
		__usageCostProof: UsageCostProofState;
	}
}

function initialRouting() {
	return gatewayRoutingProofSchema.parse({
		default_provider: "anthropic",
		fallback_chain: ["openai", "openrouter"],
		model_map: {
			"friendly-code-model": {
				provider: "openai",
				provider_model: "gpt-4.1-mini",
			},
		},
		provider_tiers: { anthropic: 0, openai: 1, vendor_internal: 2 },
		// The Gateway serves the full smart-routing view; the config response
		// codec rejects a partial one.
		smart_routing: {
			cache_by_session: false,
			classifier_model: "local-classifier",
			embedding_model: "nomic-embed-text-v1.5",
			enabled: true,
			rules: [],
			similarity_threshold: 0.42,
			strategy: "embedding",
			timeout_ms: 1500,
		},
		modality_map: { image: { provider: "fal", model: "flux-schnell" } },
		eval_routing: {
			candidates: ["anthropic", "openai"],
			enabled: true,
			explore_ratio: 0.15,
		},
	});
}

function initialConfig() {
	return {
		// Redacted views as the Gateway serves them: every provider slot is present
		// (null when unconfigured) and a configured one carries its masked key.
		providers: {
			anthropic: {
				api_key: "***",
				api_key_count: 1,
				base_url: "https://api.anthropic.com",
			},
			core: null,
			genai: null,
			local: null,
			openai: {
				api_key: "***",
				api_key_count: 0,
				base_url: "https://api.openai.com",
			},
			openrouter: {
				api_key: "***",
				api_key_count: 3,
				base_url: "https://openrouter.ai/api/v1",
			},
		},
		routing: initialRouting(),
	};
}

const storedProviderViewSchema = z.object({
	api_key: z.string(),
	api_key_count: z.number(),
	base_url: z.string(),
});
const storedConfigSchema = z.object({
	providers: z.object({
		anthropic: storedProviderViewSchema,
		core: z.null(),
		genai: z.null(),
		local: z.null(),
		openai: storedProviderViewSchema,
		openrouter: storedProviderViewSchema,
	}),
	routing: gatewayRoutingProofSchema,
});
function readConfig() {
	const stored = localStorage.getItem(CONFIG_KEY);
	if (stored) {
		return storedConfigSchema.parse(JSON.parse(stored));
	}
	const config = initialConfig();
	localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
	return config;
}

function populatedStats(): ProfileStats {
	return {
		byFeatureTotals: {
			agentSeconds: 90,
			chat: 4,
			island: 2,
			predictAccepted: 1,
		},
		insights: {
			activeDays: 5,
			averageRequestsPerActiveDay: 30,
			averageTokensPerActiveDay: 2000,
			favoriteModel: "gpt-4.1",
			peakDay: { day: "2026-09-25", tokens: 4000 },
			peakHourUtc: "12",
			topModels: [
				{ count: 1234, id: "gpt-4.1" },
				{ count: 42, id: "claude-sonnet-4-5" },
			],
			topPlugins: [],
			topSkills: [],
			transport: { acp: 0, gateway: 7, openAiCompat: 0, other: 0 },
		},
		totals: {
			agentSeconds: 90,
			costMicroUsd: 12_340_000,
			inputTokens: 1001,
			outputTokens: 2344,
			requestCount: 1234,
			sessionCount: 8,
		},
	};
}

function emptyStats(): ProfileStats {
	return {
		...populatedStats(),
		insights: { ...populatedStats().insights, topModels: [] },
		totals: {
			agentSeconds: 0,
			costMicroUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			requestCount: 0,
			sessionCount: 0,
		},
	};
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

function providerCredits(providerId: string, mode: string | null) {
	if (mode === "edges") {
		if (providerId === "openrouter") {
			return {
				available: false,
				meters: [],
				provider_id: providerId,
				reason: "not_logged_in",
			};
		}
		if (providerId === "deepseek") {
			return {
				available: false,
				meters: [],
				provider_id: providerId,
				reason: null,
			};
		}
		return {
			available: true,
			meters: [
				{
					label: "Credit balance",
					values: [{ kind: "dollars", number: 0 }],
				},
			],
			provider_id: providerId,
		};
	}
	if (providerId === "openrouter") {
		return {
			available: true,
			meters: [
				{
					label: "Credit balance",
					values: [{ kind: "dollars", number: 12.34 }],
				},
			],
			provider_id: providerId,
		};
	}
	if (providerId === "deepseek") {
		return {
			available: false,
			meters: [],
			provider_id: providerId,
			reason: "rate_limited",
			retry_after_seconds: 30,
		};
	}
	return {
		available: false,
		meters: [],
		provider_id: providerId,
		reason: "token_expired",
	};
}

function installApiFixture(): void {
	const params = new URLSearchParams(window.location.search);
	const pendingCreditResponses: (() => void)[] = [];
	const state: UsageCostProofState = {
		failNextConfigWrite: false,
		failConfigReads: Number(params.get("failConfigReads") ?? 0),
		failNextStatsRead: params.get("stats") === "error",
		profileStatsPending: params.get("stats") === "pending",
		providerCreditRequests: [],
		requests: [],
		releaseProviderCredits() {
			for (const release of pendingCreditResponses.splice(0)) {
				release();
			}
		},
		releaseProfileStats: () => undefined,
		snapshot() {
			return {
				config: readConfig(),
				requests: structuredClone(state.requests),
				providerCreditRequests: [...state.providerCreditRequests],
			};
		},
	};
	window.__usageCostProof = state;
	localStorage.setItem(SESSION_TOKEN_KEY, "usage-cost-proof-session");

	const node = {
		name: "usage-cost-proof",
		url: TARGET.url,
		token: TARGET.token,
	};
	useNodeStore.setState({
		defaultNode: node.name,
		localNodes: [node],
		nodes: [node],
	});

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
					return jsonResponse({ error: "fixture_write_failed" }, 503);
				}
				const patch = z
					.object({ routing: gatewayRoutingProofSchema.optional() })
					.nullable()
					.parse(body);
				if (patch?.routing) {
					const next = { ...readConfig(), routing: patch.routing };
					localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
				}
				return jsonResponse({ ok: true });
			}
			if (state.failConfigReads > 0) {
				state.failConfigReads -= 1;
				return jsonResponse({ error: "fixture_read_failed" }, 503);
			}
			// The Gateway always serves its redacted auth section beside the
			// providers; the config response codec requires both.
			return jsonResponse({
				auth: { api_keys: [], require_auth: false },
				...readConfig(),
			});
		}

		if (pathname.endsWith("/api/profile/me/stats")) {
			if (state.profileStatsPending) {
				return await new Promise<Response>((resolve) => {
					state.releaseProfileStats = () => {
						state.profileStatsPending = false;
						resolve(jsonResponse(populatedStats()));
					};
				});
			}
			if (state.failNextStatsRead) {
				state.failNextStatsRead = false;
				return jsonResponse({ message: "profile_fixture_read_failed" }, 503);
			}
			return jsonResponse(
				params.get("stats") === "empty" ? emptyStats() : populatedStats()
			);
		}

		const creditsMatch = pathname.match(/\/api\/providers\/([^/]+)\/credits$/);
		if (creditsMatch) {
			const providerId = decodeURIComponent(creditsMatch[1] ?? "");
			state.providerCreditRequests.push(providerId);
			if (params.get("credits") === "pending") {
				return await new Promise<Response>((resolve) => {
					pendingCreditResponses.push(() =>
						resolve(
							jsonResponse(providerCredits(providerId, params.get("credits")))
						)
					);
				});
			}
			return jsonResponse(providerCredits(providerId, params.get("credits")));
		}

		if (pathname.endsWith("/api/auth/token")) {
			return jsonResponse({ token: "usage-cost-proof-identity-jwt" });
		}
		if (pathname.endsWith("/api/control-plane/orgs")) {
			return jsonResponse({
				organizations: [
					{
						createdAt: "2025-01-01T00:00:00.000Z",
						id: "org-proof",
						isPersonal: false,
						name: "Example Organization",
						role: "owner",
						slug: "example-organization",
					},
				],
			});
		}
		if (pathname.endsWith("/api/auth/get-session")) {
			return jsonResponse({ session: { activeOrganizationId: "org-proof" } });
		}
		if (pathname.endsWith("/api/billing/subscription-status")) {
			return jsonResponse({
				entitlement: null,
				plan: null,
				subscription: null,
			});
		}
		return jsonResponse({});
	};
}

function metricsForPage(): GatewayMetrics | null {
	const quotaMode = new URLSearchParams(window.location.search).get("quota");
	if (quotaMode === "empty") {
		return null;
	}
	return {
		cache: { exactHits: 0, hitRate: 0, misses: 0, semanticHits: 0 },
		composioCalls: 0,
		providerHealth: {},
		providerQuota:
			quotaMode === "partial"
				? {
						genai: {
							limit: null,
							rateLimited: false,
							remaining: null,
							resetAt: null,
							resetInSecs: null,
							retryAfter: null,
							updatedAt: null,
						},
						openai: {
							limit: 100,
							rateLimited: false,
							remaining: null,
							resetAt: null,
							resetInSecs: 30,
							retryAfter: null,
							updatedAt: null,
						},
					}
				: {
						openai: {
							limit: 1000,
							rateLimited: false,
							remaining: 876,
							resetAt: null,
							resetInSecs: 61,
							retryAfter: null,
							updatedAt: null,
						},
						anthropic: {
							limit: 5000,
							rateLimited: true,
							remaining: 12,
							resetAt: null,
							resetInSecs: 125,
							retryAfter: 125,
							updatedAt: null,
						},
					},
		providers: { errors: {}, requests: {} },
		requests: {
			budgetDowngraded: 0,
			budgetExceeded: 0,
			budgetNotified: 0,
			budgetRestricted: 0,
			errors: 0,
			firewallBlocked: 0,
			rateLimited: 1,
			total: 1,
		},
		tokens: { input: 0, output: 0 },
	};
}

function ProofArtifact() {
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { refetchOnWindowFocus: false, retry: false },
				},
			}),
		[]
	);
	const reachable =
		new URLSearchParams(window.location.search).get("reachable") !== "false";

	return (
		<EntitlementProvider>
			<QueryClientProvider client={queryClient}>
				<main className="dark min-h-screen bg-background px-8 py-8 text-foreground">
					<div className="mx-auto max-w-5xl">
						<header className="mb-6">
							<div className="text-primary text-xs tracking-eyebrow">
								RYU · LIVE REACT PROOF
							</div>
							<h1 className="mt-2 font-semibold text-3xl">
								Gateway usage and cost
							</h1>
							<p className="mt-2 max-w-3xl text-base text-muted-foreground leading-6">
								Actual UsageCostSection rendered against stateful Core and
								profile API fixtures. Settings writes persist across reload and
								the full routing payload is checked.
							</p>
						</header>
						<UsageCostSection
							configuredProviders={reachable ? ["openai", "anthropic"] : []}
							metrics={reachable ? metricsForPage() : null}
							reachable={reachable}
							target={TARGET}
						/>
					</div>
				</main>
			</QueryClientProvider>
		</EntitlementProvider>
	);
}

installApiFixture();
createRoot(document.getElementById("root")!).render(<ProofArtifact />);
