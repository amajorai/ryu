import { ALL_CREDIT_POOLS, type CreditPool } from "@ryu/auth/lib/credit-pools";
import type { ReactNode } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import type { BrowserSurface } from "@/src/lib/extension-host.ts";

/** The flagship agent id (mirrors Core `DEFAULT_AGENT_ID`). */
export const RYU_AGENT_ID = "ryu";

/**
 * The synthetic "Local" row's id, and the REAL Pi provider it routes through.
 *
 * There is no `local` provider in Core's `PROVIDERS` table and there should not
 * be: talking to weights on this machine is not a credential-bearing vendor, it
 * is the governed `gateway` route pointed at whichever model the local engine is
 * currently serving. So the row is assembled here from the two endpoints that
 * already own that state — `/api/models/installed` (what is on disk) and
 * `/api/models/active` (what is loaded) — and a pick writes BOTH halves: the
 * served model (`setActiveModel`) and the Pi route (`provider: "gateway"`).
 * Writing only one is the failure mode `RyuPiConfig` already guards against —
 * a config naming a model the engine never loaded.
 */
export const LOCAL_PROVIDER_ID = "local";

export const GATEWAY_PROVIDER_ID = "gateway";

export const BROWSER_PROVIDER_ID = "browser";

/** Map a Pi provider id to the engine key its brand logo is registered under. */
const PROVIDER_ENGINE_KEY = new Map<string, string>([
	["google", "gemini"],
	["claude-pro-max", "claude"],
	["openai-codex", "codex"],
	["chatgpt", "chatgpt"],
	["anthropic", "anthropic"],
	["openai", "openai"],
	["mistral", "mistral"],
	["openrouter", "openrouter"],
]);

export function providerEngineKey(providerId: string): string {
	return PROVIDER_ENGINE_KEY.get(providerId) ?? providerId;
}

/**
 * The credit pools a user may be offered as a route ("Ryu Fast", "Ryu Frontier"),
 * straight from the pool catalog. Filtering on `visible` here is the whole point:
 * adding, hiding or renaming a pool is then a data change in
 * `@ryu/auth/lib/credit-pools`, never an edit to this picker. It also
 * deliberately excludes the pass-through `openrouter` pool, which is invisible —
 * that supply is what the ORIGINAL managed Ryu row already sells, and offering it
 * twice under two names would be the same route pretending to be a choice.
 */
const OFFERED_CREDIT_POOLS: readonly CreditPool[] = ALL_CREDIT_POOLS.filter(
	(pool) => pool.visible
);

/**
 * The pool a managed catalog row is backed by, or null for a row that is not
 * pool-backed (today: the default managed OpenRouter route, and every BYO-key
 * provider).
 *
 * `managed` is a REQUIRED part of the match, not an accelerator. A user's own
 * Bedrock or Cloudflare credential is a perfectly ordinary BYO-key provider whose
 * id collides with a pool's `gatewayProviders` entry; treating that as Ryu's
 * donated supply would relabel the user's own account "Ryu Frontier" and gate it
 * behind our subscription upsell.
 *
 * Three id spellings are accepted because Core owns the provider id and this
 * surface does not: whichever of `bedrock` / `managed-bedrock` Core publishes,
 * the row binds. Core publishes the `managed-<poolId>` form for every pool
 * (`managed-vertex`, `managed-openai-credits`, `managed-anthropic-credits`
 * included), so a new pool needs no edit here. A row that matches nothing keeps
 * today's behaviour exactly.
 */
export function creditPoolForProvider(provider: PiProvider): CreditPool | null {
	if (!provider.managed) {
		return null;
	}
	return (
		OFFERED_CREDIT_POOLS.find(
			(pool) =>
				provider.id === pool.id ||
				provider.id === `managed-${pool.id}` ||
				pool.gatewayProviders.includes(provider.id)
		) ?? null
	);
}

/**
 * Upsell copy for a pool row. Names the TIER and nothing else — the pool catalog's
 * standing rule is that a user never reads the name of the provider behind a pool,
 * so the supplier can be swapped without changing what anyone was promised.
 * There is no bring-your-own-key half: Ryu's pooled capacity is not something a
 * user can hold a key for, so offering one would be a dead end.
 */
export function poolUpsellCopy(pool: CreditPool) {
	return {
		upgrade: `${pool.label} runs on Ryu's own capacity — included with a Ryu subscription, no API keys.`,
		byoKey: null,
	};
}

export interface UseUniversalPickerParams {
	/** The active agent's live approval + thinking sections. */
	activeExtraSections: ComposerSettingsSection[];
	/** The active agent's live model section (already resolved by the host). */
	activeModelSection: ComposerSettingsSection | null;
	agentId: string | null;
	agents: AgentSummary[];
	/** Keep model rows visible for setup surfaces at every interface level. */
	forceModelPicker?: boolean;
	onCreateAgent?: () => void;
	/** Observe provider/model picks without replacing the normal provider action. */
	onProviderModelSelection?: (selection: {
		modelId: string | null;
		providerId: string;
		providerLabel: string;
	}) => void;
	onSelectAgent: (id: string) => void;
	/** Optional host override for a concrete provider/model pick. */
	onSelectProviderModel?: (providerId: string, modelId: string) => void;
	/** Optional host override for a provider thinking-level pick. */
	onSelectProviderThinking?: (providerId: string, level: string) => void;
	onSelectTeam?: (id: string) => void;
	/** Optional host override for provider picks (used by setup surfaces). */
	onUseProvider?: (providerId: string, modelId: string | null) => void;
	/** Browser-only surface used for the synthetic Browser provider selection. */
	surface?: BrowserSurface;
	teamId?: string | null;
	teams?: Team[];
}

export interface UseUniversalPickerResult {
	/** Body renderer for `ComposerSettingsMenu`'s `renderBody` prop. */
	renderBody: (
		close: () => void,
		mode?: "agents" | "models" | "all"
	) => ReactNode;
}
