import {
	byokProviderRegistryId,
	COMPATIBLE_CHAT_PROVIDERS,
} from "@ryuhq/core-client/agent-account-access";
import { isByokProviderSet } from "@/src/components/gateway/gateway-provider-catalog.ts";
import type {
	ByokProvider,
	GatewayProvidersConfig,
} from "@/src/lib/api/gateway.ts";

export {
	byokProviderRegistryId,
	engineModelProvider as agentEngineModelProvider,
} from "@ryuhq/core-client/agent-account-access";

// Model providers an agent's account access can allow (`provider:<id>` keys).
//
// The id is the Gateway registry id the provider is served under, because that
// is what Gateway checks on every model call (`apps/core/src/agent_access.rs`).
// It matches the BYOK slug except for Gemini, whose key lives under the `genai`
// provider, and the SDK routes, which carry their own registry id. Ryu credits
// and local engines are not your accounts and are always available, so they
// have no key.
//
// Only providers that serve an agent's model turns are listed: Core applies an
// agent's provider access to its chat turns, not to the speech, image, video,
// embedding or rerank calls it makes, so a row for one of those providers
// would change nothing.

/** One of your model providers, as an account-access row. */
export interface AgentModelProvider {
	id: string;
	label: string;
}

/**
 * The BYOK rows, typed by desktop's `ByokProvider`. Keep in step with
 * `BYOK_MODEL_PROVIDERS` in `@ryuhq/core-client/agent-account-access`, which
 * the CLI and native read; `agent-provider-access.test.ts` asserts the two
 * lists match, slug, label and order.
 */
export const BYOK_MODEL_PROVIDERS: { slug: ByokProvider; label: string }[] = [
	{ slug: "openai", label: "OpenAI" },
	{ slug: "anthropic", label: "Anthropic" },
	{ slug: "openrouter", label: "OpenRouter" },
	{ slug: "gemini", label: "Gemini" },
	{ slug: "mistral", label: "Mistral" },
	{ slug: "huggingface", label: "Hugging Face" },
	{ slug: "nvidia", label: "NVIDIA NIM" },
	{ slug: "together", label: "Together AI" },
	{ slug: "fireworks", label: "Fireworks AI" },
	{ slug: "qwen", label: "Qwen" },
	{ slug: "modal", label: "Modal" },
];

// The OpenAI-compatible chat providers Gateway registers from its direct
// provider list without a BYOK slug of their own
// (`ryu_gw_credentials::DIRECT_COMPATIBLE_PROVIDERS`), and the Gateway registry
// id a BYOK key is served under, come from the shared
// `@ryuhq/core-client/agent-account-access`.

/**
 * Your configured model providers, in a stable order: the BYOK keys, the
 * other compatible chat providers, the SDK routes that need a credential, then
 * the sign-ins Core holds for Gateway.
 */
export function agentModelProviders(
	providers: GatewayProvidersConfig | null
): AgentModelProvider[] {
	if (!providers) {
		return [];
	}
	const rows: AgentModelProvider[] = [];
	const seen = new Set<string>();
	const add = (id: string, label: string) => {
		if (!seen.has(id)) {
			seen.add(id);
			rows.push({ id, label });
		}
	};
	for (const { slug, label } of BYOK_MODEL_PROVIDERS) {
		if (isByokProviderSet(providers, slug)) {
			add(byokProviderRegistryId(slug), label);
		}
	}
	for (const [id, label] of Object.entries(COMPATIBLE_CHAT_PROVIDERS)) {
		const view = providers.compatible?.[id];
		if (view && (view.api_key_count ?? (view.api_key ? 1 : 0)) > 0) {
			add(id, label);
		}
	}
	for (const sdk of providers.genai?.sdk_providers ?? []) {
		if (sdk.configured && sdk.auth_kind !== "no_auth") {
			add(sdk.provider_id, sdk.label);
		}
	}
	// Core's sign-ins reach Gateway as two providers: `core` for the
	// subscriptions Core holds, and `kiro` for a Kiro sign-in. Gateway's config
	// only says that Core relays them, not that you signed in to any, so the
	// labels say "if any" rather than implying an account exists.
	if (providers.core?.has_token) {
		add("core", "Subscriptions you signed in to through Ryu, if any");
		add("kiro", "Kiro sign-in, if any");
	}
	return rows;
}

/**
 * Why `engine` cannot start while the agent's model providers are limited, or
 * `null` when it can. The engine list's "Ryu" choice is saved as `acp:pi`. For
 * an agent whose model providers are limited, Core runs it on Ryu's own
 * managed Pi under the agent's own identity, with its models going through
 * Ryu's Gateway (`agents::runs_limited_on_managed_pi`). Core refuses that only
 * when Ryu's Pi is set to call its provider directly (`piRouting` `"direct"`,
 * from `/api/pi-config`), because Gateway could not limit it then.
 */
export function engineRefusedWhenLimited(
	engine: string | null,
	piRouting: string | null
): string | null {
	if (engine === "acp:pi" && piRouting === "direct") {
		return "This agent's engine (Ryu in the engine list) runs on Ryu's own Pi, which is set to call its model provider directly, so Ryu can't limit which model providers it uses. It won't start while this agent's model providers are limited. Turn Gateway routing back on in Ryu's Pi settings, choose another engine, or use Acts as you or Both with Limit to selected accounts off.";
	}
	return null;
}
