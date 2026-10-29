import { useState } from "react";
import type {
	PiCatalog,
	PiProvider,
	ProviderConfigInput,
} from "../../src/lib/api/pi-config.ts";

const account = (
	accountId: string,
	label: string,
	active: boolean,
	kind = "oauth"
) => ({
	accountId,
	label,
	active,
	gatewayActive: false,
	kind,
	updatedAt: Date.now(),
});

const provider = (
	id: string,
	label: string,
	authKind: string,
	extra: Partial<PiProvider> = {}
): PiProvider => ({
	id,
	label,
	authKind,
	api: "openai-completions",
	authEnv: "",
	configured: false,
	custom: false,
	routing: "direct",
	suggestedModels: ["example-model"],
	...extra,
});

const INITIAL: PiCatalog = {
	apiTypes: ["openai-completions"],
	thinkingLevels: ["low", "medium", "high"],
	providers: [
		provider("managed-openrouter", "Ryu managed", "subscription", {
			managed: true,
			configured: true,
			routing: "gateway",
		}),
		provider("claude-pro-max", "Claude (Pro/Max · login)", "subscription", {
			api: "anthropic-messages",
			suggestedModels: [],
			supportsOAuth: true,
			configured: true,
			accounts: [
				account("claude-a", "Claude account 1", true),
				account("claude-b", "Claude account 2", false),
			],
		}),
		provider("openai-codex", "ChatGPT (Plus/Pro · login)", "subscription", {
			supportsOAuth: true,
		}),
		provider("chatgpt", "ChatGPT", "subscription", {
			supportsOAuth: true,
			configured: true,
			accounts: [
				account("chatgpt-a", "ChatGPT account 1", true),
				account("chatgpt-b", "ChatGPT account 2", false),
			],
		}),
		provider("github-copilot", "GitHub Copilot (login)", "subscription", {
			supportsOAuth: true,
		}),
		provider("kimi-coding", "Kimi Code (login)", "subscription", {
			supportsOAuth: true,
			api: "anthropic-messages",
		}),
		provider("radius", "Radius (login)", "subscription", {
			supportsOAuth: true,
			api: "pi-messages",
		}),
		provider("openrouter", "OpenRouter", "api-key", {
			supportsOAuth: true,
			configured: true,
			accounts: [account("or-key", "OpenRouter API key", true, "api_key")],
		}),
		provider("xai", "xAI", "api-key", { supportsOAuth: true }),
		provider("anthropic", "Anthropic", "api-key", {
			api: "anthropic-messages",
		}),
		provider("openai", "OpenAI", "api-key", { api: "openai-responses" }),
		provider("google", "Google Gemini", "api-key", {
			api: "google-generative-ai",
		}),
		provider("local-model-server", "Local model server", "api-key", {
			api: "openai-responses",
			configured: true,
			custom: true,
			suggestedModels: [],
		}),
		provider("chatgpt-plan", "ChatGPT plan (self-hosted)", "subscription", {
			api: "openai-responses",
			configured: true,
			supportsOAuth: true,
			routingLocked: true,
			suggestedModels: [],
			connectionState: "identity-only",
			accounts: [
				{
					...account("plan-a", "Personal ChatGPT", true),
					connectionState: "identity-only",
				},
			],
		}),
	],
};

export function useLlmProviders() {
	const [catalog, setCatalog] = useState(INITIAL);
	return {
		catalog,
		config: {
			configDir: "/test/pi",
			model: "example-model",
			provider: "managed-openrouter",
			providerRouting: {},
			routing: "gateway",
			thinkingLevel: null,
		},
		loading: false,
		error: null,
		activate: async () => ({
			configDir: "/test/pi",
			model: "example-model",
			provider: "managed-openrouter",
			routing: "gateway",
			thinkingLevel: null,
		}),
		check: async () => ({ ok: true, latencyMs: 1, modelCount: 1 }),
		configure: async (input: ProviderConfigInput) => {
			if (input.provider !== "local-model-server" || !input.apiKey?.trim()) {
				return catalog;
			}
			const next = {
				...catalog,
				providers: catalog.providers.map((item) =>
					item.id === input.provider
						? {
								...item,
								accounts: [
									account("local-key", "Local API key", true, "api_key"),
								],
							}
						: item
				),
			};
			setCatalog(next);
			return next;
		},
		remove: async () => catalog,
		discover: async (input) =>
			input.provider === "chatgpt-plan"
				? catalog.providers.find((item) => item.id === "chatgpt-plan")
						?.connectionState === "authorized"
					? {
							models: [{ id: "plan-model", name: "ChatGPT plan model" }],
							source: "discovery",
						}
					: { models: [], source: "unavailable" }
				: input.provider === "claude-pro-max"
					? {
							models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" }],
							source: "pi",
						}
					: input.provider === "local-model-server"
						? {
								models: [{ id: "local-a" }, { id: "local-b" }],
								source: "saved",
							}
						: {
								models: [{ id: "example-model", name: "Example model" }],
								source: "suggestions",
							},
		toggleModelEnabled: async () => catalog,
		switchAccount: async (providerId: string, accountId: string) => {
			const next = {
				...catalog,
				providers: catalog.providers.map((item) =>
					item.id === providerId
						? {
								...item,
								accounts: item.accounts?.map((entry) => ({
									...entry,
									active: entry.accountId === accountId,
								})),
							}
						: item
				),
			};
			setCatalog(next);
			return next;
		},
		removeAccount: async () => catalog,
		reload: () =>
			setCatalog((previous) => ({
				...previous,
				providers: previous.providers.map((item) =>
					item.id === "chatgpt-plan"
						? {
								...item,
								connectionState: "authorized",
								accounts: item.accounts?.map((entry) => ({
									...entry,
									connectionState: "authorized",
								})),
							}
						: item
				),
			})),
	};
}

export function useEntitlementContext() {
	return {
		verdict: { managedInference: true },
		requestUpgrade: () => undefined,
	};
}

export function useActiveNode() {
	return { url: "http://127.0.0.1:7980", token: null, userJwt: null };
}

export function OrgBillingContext() {
	return (
		<div className="rounded-lg bg-muted/35 px-3 py-2 text-sm">
			Local workspace · Gateway provider credits
		</div>
	);
}

export function AgentModelsSettings() {
	return null;
}
export function CapabilityProvidersSettings() {
	return null;
}
