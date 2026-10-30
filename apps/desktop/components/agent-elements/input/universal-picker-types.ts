import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type {
	ProviderAccount,
	ProviderAccountTarget,
} from "@/components/agent-elements/input/provider-account-section.tsx";
import type { AgentCatalogEntry, AgentSummary } from "@/src/lib/api/agents.ts";
import type { PickerRef } from "@/src/lib/picker-favorites.ts";

/** A Pi provider row for the Providers section (built by `useUniversalPicker`). */
export interface ProviderEntry {
	/** Every account this provider holds in the sealed vault (labels only). Lets
	 * the submenu list, switch and remove sign-ins. */
	accounts?: ProviderAccount[];
	/** Pi auth kind: "subscription" (OAuth login) | "api-key" | "none". */
	authKind: string;
	/** Browser-provider capability status, when this is the extension's synthetic row. */
	browserCapabilities?: {
		actionSupport: boolean;
		chatSupport: boolean;
		visionSupport: boolean;
	};
	/** Whether a usable credential is stored (drives the models-vs-configure body). */
	configured: boolean;
	/** The provider's current model when it is the active target, else null. */
	currentModel: string | null;
	/** The provider's current thinking level when active, else null. */
	currentThinking: string | null;
	/**
	 * Enumerate this row's full model list under a DIFFERENT registry id. Set only
	 * for the default managed Ryu row, which carries no `models_url` of its own and
	 * borrows the public OpenRouter catalog it actually routes to.
	 *
	 * Absent means "discover under `id`, and only if `supportsDiscovery`". That
	 * default is load-bearing now that several managed rows exist: a pool-backed
	 * managed row (Ryu Fast / Ryu Frontier) that inherited OpenRouter's catalog
	 * would offer models its own supply cannot serve, and every one of those picks
	 * would fail at the gateway.
	 */
	discoveryProviderId?: string;
	/** Engine key for the brand logo (anthropic / openai / gemini / …). */
	engineKey: string;
	/**
	 * Models to tag "Free" in this row's model list: the Ryu Router models free
	 * credit pays for, set only on the Ryu Router row and only while the user
	 * holds free credit.
	 */
	freeModelIds?: ReadonlySet<string>;
	/** Whether API-key accounts for this provider can be installed in the Gateway. */
	gatewayAccountSupported?: boolean;
	id: string;
	/** True when this provider is the Ryu agent's active route. */
	isActive: boolean;
	label: string;
	/** True for the Ryu-managed provider (included with the plan, no key). Drives
	 * the upsell body when the user has no active subscription (`configured` false). */
	managed: boolean;
	/** Explicit model visibility overrides; absent ids remain enabled. */
	modelOverrides?: Record<string, boolean>;
	/** Selectable models (from the provider's suggested set; live-discovered ids
	 * are merged in on open for discovery-capable providers like OpenRouter). */
	models: ComposerSettingItem[];
	/**
	 * The user's FREE CREDIT (every active grant, summed; nearest expiry), shown
	 * on the Ryu Router row. Absent when there is none.
	 *
	 * Strictly granted money — the wallet's subscription/top-up buckets have
	 * their own home (the account menu / node selector). Free credit is spent
	 * automatically, first, on models tagged "Free".
	 */
	poolGrant?: {
		/** When this pool's grant money lapses, ISO, or null if it does not. */
		expiresAt: string | null;
		remainingMicroUsd: number;
	};
	/** Browser runtime status shown beside the provider's current model. */
	status?: "ready" | "not-prepared" | "preparing" | "failed" | "unsupported";
	statusMessage?: string;
	/** Whether Core can dynamically enumerate this provider's full model list. */
	supportsDiscovery: boolean;
	/** The managed provider with no active paid plan → show the subscription upsell
	 * instead of the model list. The managed provider is always `configured` (it is
	 * wallet-gated server-side), so upsell is gated on the entitlement, not `configured`. */
	upsell: boolean;
	/**
	 * Overrides the upsell body's copy. Absent = the default managed row's wording,
	 * which names OpenRouter because that row IS the managed OpenRouter route.
	 *
	 * A pool-backed managed row must override both halves: its tier is not
	 * OpenRouter, and naming the supplier behind a pool breaks the rule that a user
	 * only ever reads the pool's own tier name.
	 */
	upsellCopy?: {
		/** Sub-label under "Use your own key", or null to drop that row — a pool's
		 *  supply is not something a user can hold a key for. */
		byoKey: string | null;
		/** Sub-label under "Upgrade to Ryu". */
		upgrade: string;
	};
}

/** A team row for the optional Teams section. */
export interface TeamEntry {
	engines: (string | null)[];
	id: string;
	isActive: boolean;
	name: string;
}

/**
 * Sentinel composer agent id for the "Auto" row (Plane B — Core resolves the real
 * agent per-turn). Distinct from Ryu smart-route (Plane A, a model pick) and
 * `openrouter/auto` (an upstream model id).
 */
export const AUTO_AGENT_ID = "auto";

export interface UniversalPickerData {
	activeAgentId: string | null;
	/** The active agent's live model section (approval/thinking live too). Only
	 * meaningful for the currently-selected target — nested under whichever row is
	 * active so its picks wire straight to the host's live handlers. */
	activeExtraSections: ComposerSettingsSection[];
	activeModelSection: ComposerSettingsSection | null;
	agents: AgentSummary[];
	/** Not-installed external agents (catalog entries with `added === false`). */
	availableExternal: AgentCatalogEntry[];
	/** Whether the caller may set a provider account for the shared Gateway. */
	canSetGatewayAccount?: boolean;
	/**
	 * Plain selectable agents that are neither the flagship nor ACP externals
	 * (custom store agents, `transport` null). Rendered as flat pick rows — they
	 * advertise no model/thinking config to drill into. Defaults to none.
	 */
	customAgents?: AgentSummary[];
	/** Keep model rows visible for setup surfaces at every interface level. */
	forceModelPicker?: boolean;
	/**
	 * Suppress the "Auto" (Plane B) row. The composer always offers Auto so a turn
	 * can be routed per-rule; a controlled settings *field* (which persists one
	 * concrete model/agent id) has nowhere to store the sentinel, so it hides it.
	 * Defaults to false — the composer is unaffected.
	 */
	hideAuto?: boolean;
	/** Installed external ACP agents (transport `acp`, excluding the flagship). */
	installedExternal: AgentSummary[];
	/** Id of the external agent whose install is in flight, or null. */
	installPendingId: string | null;
	onConfigureCredentials: () => void;
	onCreateAgent?: () => void;
	onInstallExternal: (id: string) => void;
	/** Remove an ACP agent account. */
	onRemoveAgentAccount: (agentId: string, accountId: string) => void;
	/** Remove an account from a Pi provider. */
	onRemoveProviderAccount: (providerId: string, accountId: string) => void;
	onRemoveRecent?: (ref: PickerRef) => void;
	onSelectAgent: (id: string) => void;
	onSelectProviderModel: (providerId: string, modelId: string) => void;
	onSelectProviderThinking: (providerId: string, level: string) => void;
	onSelectRecentModel?: (
		providerId: string,
		modelId: string,
		effort?: string
	) => void;
	onSelectTeam?: (id: string) => void;
	/** Switch an ACP agent's active account (`provider` required for the managed
	 *  Pi's accounts, which live in a provider scope). */
	onSwitchAgentAccount: (
		agentId: string,
		accountId: string,
		provider?: string
	) => void;
	/** Switch the active account for a Pi provider (sealed vault + materialize). */
	onSwitchProviderAccount: (
		providerId: string,
		accountId: string,
		target?: ProviderAccountTarget
	) => void;
	/** Open the subscription upgrade / paywall (managed-provider upsell). */
	onUpgrade: () => void;
	onUseProvider: (providerId: string) => void;
	providers: ProviderEntry[];
	recentRefs?: readonly PickerRef[];
	ryuActive: boolean;
	/** The flagship Ryu agent, or null if somehow absent from the registry. */
	ryuAgent: AgentSummary | null;
	teams: TeamEntry[];
	/** Provider thinking levels (Pi `thinkingLevels`) for the provider rows. */
	thinkingLevels: string[];
}
