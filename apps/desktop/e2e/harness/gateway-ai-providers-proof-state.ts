// Persisted proof state and Core response helpers for the Gateway AI
// providers harness (split out of gateway-ai-providers-proof.tsx).
import { z } from "zod";
import type { PiCatalog, PiConfig } from "../../src/lib/api/pi-config.ts";
import {
	gatewayRoutingProofSchema,
	piCatalogProofSchema,
	piConfigProofSchema,
} from "./gateway-proof-contracts.ts";

export const NODE = {
	managed: false,
	name: "gateway-ai-providers-proof",
	orgId: null,
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};
export const STORAGE_KEY = "gateway-ai-providers-proof-state";

export interface RequestRecord {
	body: unknown;
	method: string;
	path: string;
}

export interface TauriCallRecord {
	args?: unknown;
	command: string;
	failed: boolean;
}

export interface ProofSnapshot {
	catalog: PiCatalog;
	config: PiConfig;
	gatewayConfig: { routing: z.infer<typeof gatewayRoutingProofSchema> };
	navigation: Array<{ open: boolean; section: string }>;
	preferences: Record<string, string>;
	requests: RequestRecord[];
	settingsNavigation: Array<{ open: boolean; section: string }>;
	tauriCalls: TauriCallRecord[];
}

export interface ProofState {
	armFailure: (operation: string) => void;
	failNextExternalLaunch: () => void;
	requests: RequestRecord[];
	snapshot: () => ProofSnapshot;
}

declare global {
	interface Window {
		__gatewayAiProvidersProof: ProofState;
	}
}

const account = {
	accountId: "openai-work",
	active: true,
	gatewayActive: false,
	kind: "api_key",
	label: "work@example.com",
	updatedAt: 1_790_000_000_000,
};

function initialCatalog(): PiCatalog {
	return {
		agentModelOverrides: {},
		apiTypes: ["openai-completions", "openai-responses"],
		providers: [
			{
				accounts: [structuredClone(account)],
				active: false,
				api: "openai-completions",
				authEnv: "OPENAI_API_KEY",
				authKind: "api-key",
				configured: false,
				custom: false,
				id: "openai",
				label: "OpenAI",
				modelOverrides: {},
				routing: "direct",
				suggestedModels: ["gpt-4o-mini", "gpt-4.1-mini"],
				supportsDiscovery: true,
			},
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
			{
				active: false,
				api: "anthropic-messages",
				authEnv: "",
				authKind: "subscription",
				configured: false,
				custom: false,
				id: "claude-code",
				label: "Claude Code",
				modelOverrides: {},
				routing: "gateway",
				routingLocked: true,
				suggestedModels: ["claude-sonnet-4"],
				supportsDiscovery: false,
			},
			{
				active: false,
				api: "openai-completions",
				authEnv: "",
				authKind: "none",
				configured: true,
				creditPool: "openrouter",
				custom: false,
				id: "managed-openrouter",
				label: "Ryu Managed",
				managed: true,
				modelOverrides: {},
				routing: "gateway",
				routingLocked: true,
				suggestedModels: ["openrouter/auto"],
				supportsDiscovery: false,
			},
		],
		thinkingLevels: ["low", "high"],
	};
}

function initialConfig(): PiConfig {
	return {
		configDir: "/fixture/pi-config",
		model: "qwen-local",
		provider: "local",
		providerRouting: { openai: "direct" },
		routing: "direct",
		thinkingLevel: null,
	};
}

function initialGatewayConfig() {
	return {
		routing: gatewayRoutingProofSchema.parse({
			default_provider: "openai",
			fallback_chain: ["local"],
			model_map: {},
			modality_map: {
				image: { model: "flux-fast", provider: "fal" },
				stt: { provider: "local" },
				tts: { model: "speech-1", provider: "openai" },
				video: { model: "video-fast", provider: "replicate" },
			},
		}),
	};
}

function freshSnapshot(): ProofSnapshot {
	return {
		catalog: initialCatalog(),
		config: initialConfig(),
		gatewayConfig: initialGatewayConfig(),
		navigation: [],
		preferences: { "replicate-api-key": "", "fal-api-key": "fal-fixture-key" },
		requests: [],
		settingsNavigation: [],
		tauriCalls: [],
	};
}

const requestRecordSchema = z.object({
	body: z.json(),
	method: z.string(),
	path: z.string(),
});
const navigationSchema = z.array(
	z.object({ open: z.boolean(), section: z.string() })
);
const proofSnapshotSchema = z.object({
	catalog: piCatalogProofSchema,
	config: piConfigProofSchema,
	gatewayConfig: z.object({ routing: gatewayRoutingProofSchema }),
	navigation: navigationSchema,
	preferences: z.record(z.string(), z.string()),
	requests: z.array(requestRecordSchema),
	settingsNavigation: navigationSchema,
	tauriCalls: z.array(
		z.object({
			args: z.json().optional(),
			command: z.string(),
			failed: z.boolean(),
		})
	),
});
export function readPersisted(): ProofSnapshot {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (!stored) {
		const initial = freshSnapshot();
		localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
		return initial;
	}
	return proofSnapshotSchema.parse(JSON.parse(stored));
}

export function persist(next: ProofSnapshot): void {
	localStorage.setItem(
		STORAGE_KEY,
		JSON.stringify({ ...next, requests: [], tauriCalls: [] })
	);
}

export function json<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

export function catalogWithActive(
	catalog: PiCatalog,
	config: PiConfig
): PiCatalog {
	return {
		...catalog,
		providers: catalog.providers.map((provider) => ({
			...provider,
			active: provider.id === config.provider,
		})),
	};
}
