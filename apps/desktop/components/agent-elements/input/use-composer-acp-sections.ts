"use client";

// The desktop binding of the shared composer ACP-sections derivation
// (`@ryu/blocks/composer/composer-acp-sections`) — the Model selector and the
// "thinking"/approval + agent-advertised config selectors, from an agent's
// advertised session config (`useAcpConfig`, keyed by agentId, NOT a live chat
// session). ChatPage, the launchpad, and the Ask Ryu dock all call this and feed
// its `modelSection` / `extraSections` straight into `useComposerAgentControls`,
// so every surface shows the SAME Agent · Model · Thinking dropdown — even before
// a chat exists.
//
// Everything common with the island's composer (the dedup rules, the
// `acpMode`/`acpModel`/`acpOptionValues` state machine, the per-agent
// seeding/reset, and adoption of Core's two streamed write-back channels) lives
// in the shared primitive. What is bound here is what only the desktop has:
//
//   - persistence (`src/lib/acp-selections.ts` → `ACP_SELECTION_STORE`);
//   - friendly-mode model display names;
//   - the per-agent enabled-model overrides from the Pi catalog;
//   - the grouped/searchable model submenu with installed-model merge and
//     per-model subscription quotas;
//   - the "Detecting…" loading state while an ACP agent's config is probed;
//   - the reasoning-off capability override that suppresses the thinking picker.
//
// Selections persist per-agent to localStorage (the same store the spawned chat
// reads on `session/new`), so a model/mode picked on the launchpad is honoured by
// the new chat. ChatPage additionally reads the returned effective values
// (`acpMode` / `acpModel` / `acpOptionValues`) onto its per-turn request body.

import type {
	AcpConfigOption,
	AcpSectionsResult,
	AcpSelectionStore,
	ComposerModelSection,
	StreamedAcpConfig,
	StreamedAcpControl,
} from "@ryu/blocks/composer/composer-acp-sections.ts";
import { useAcpSections } from "@ryu/blocks/composer/composer-acp-sections.ts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import {
	groupModelItems,
	mergeInstalledModels,
} from "@/components/agent-elements/input/model-groups.ts";
import { createModelMenuRenderer } from "@/components/agent-elements/input/model-menu-content.tsx";
import type { ModelOption } from "@/components/agent-elements/types.ts";
import { useAcpConfig } from "@/src/hooks/useAcpConfig.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgentCapabilities } from "@/src/hooks/useAgentCapabilities.ts";
import { useFriendlyMode } from "@/src/hooks/useFriendlyMode.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import {
	getAcpConfig,
	getAcpMode,
	getAcpModel,
	setAcpConfigValue,
	setAcpMode,
	setAcpModel,
} from "@/src/lib/acp-selections.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import { getActiveModel, listInstalledModels } from "@/src/lib/api/models.ts";
import { filterEnabledModels } from "@/src/lib/api/pi-config.ts";
import { friendlyModelDisplay } from "@/src/lib/catalog/friendly.ts";

/**
 * The desktop's localStorage-backed persistence, as the shared hook's injected
 * store. Module-level so its identity is stable across renders (the hook lists
 * it as an effect/callback dependency).
 */
const ACP_SELECTION_STORE: AcpSelectionStore = {
	getAcpConfig,
	getAcpMode,
	getAcpModel,
	setAcpConfigValue,
	setAcpMode,
	setAcpModel,
};

/** Flat model rows → grouped, searchable submenu (Pi lists are long). */
function withGroupedModelMenu(
	section: ComposerModelSection,
	installedStems: string[],
	activeStem?: string | null,
	/**
	 * The subscription agent whose per-model quotas the rows should show. Null for
	 * Ryu (Gateway-routed models have no vendor window) and for any agent with no
	 * readable subscription usage.
	 */
	usageAgentId?: string | null
): ComposerModelSection {
	if (section.items.length === 0) {
		return section;
	}
	const merged = mergeInstalledModels(
		section.items,
		installedStems,
		activeStem
	);
	const grouped = groupModelItems(merged);
	return {
		...section,
		items: merged,
		renderContent: createModelMenuRenderer(
			grouped,
			section.value,
			usageAgentId
		),
	};
}

export interface ComposerAcpSectionsParams {
	/** The active agent (drives the advertised config + ACP detection). */
	agentId: string | null;
	/** Live agent registry — used only to detect the active agent's transport. */
	agents: AgentSummary[];
	/** Effective engine model id (for the non-ACP fallback picker). */
	engineModel: string | null;
	/** Engine-catalog model options — the fallback picker for non-ACP agents. */
	modelOptions: ModelOption[];
	/** Persist an engine-catalog model pick (non-ACP fallback). */
	onEngineModelChange: (modelId: string) => void;
	/**
	 * Announce a session control the USER just picked (labels, not ids). A chat
	 * surface passes this to tell the user WHEN the pick lands: the selections are
	 * sticky and ride the next turn's request body, so nothing visibly changes
	 * until they send again. Surfaces with no turn to apply to — the per-agent
	 * submenu in the universal picker, which builds these sections for agents that
	 * are not even active — leave it out.
	 */
	onSelectionApplied?: (setting: string, value: string) => void;
	/**
	 * Ryu Work mode has no approval picker. Derive a safe hidden default from the
	 * active agent's advertised permission options when requested.
	 */
	preferSimpleApprovalDefaults?: boolean;
	/**
	 * Session-config values the AGENT asked the client to update, observed on the
	 * live chat stream (Core's `data-ryu-acp-config` part). Session-scoped
	 * surfaces (launchpad/dock) leave this undefined. See the shared primitive.
	 */
	streamedConfig?: StreamedAcpConfig | null;
	/**
	 * The agent's config option DEFINITIONS as re-published on the live chat
	 * stream (Core's `data-ryu-acp-config-options` part), which supersede the
	 * probed set when present.
	 *
	 * Distinct from `streamedConfig`, which carries option VALUES the agent asked
	 * the client to change. This is the option list itself — the answer to
	 * `session/set_config_option`, which by protocol returns the FULL refreshed
	 * set. It is the only channel by which an option that exists solely for
	 * another option's value (codex's reasoning effort, revealed once a model
	 * that has one is selected) can appear against the LIVE session: the probe
	 * that normally supplies these runs in a throwaway session of its own.
	 *
	 * Session-scoped surfaces (launchpad/dock) leave this undefined and keep
	 * using the probe alone.
	 */
	streamedConfigOptions?: AcpConfigOption[] | null;
	/** Accepted conversation-scoped model/effort control from Core's live stream. */
	streamedControl?: StreamedAcpControl | null;
	/**
	 * An agent-INITIATED permission-mode change observed on the live chat stream
	 * (Core's `data-ryu-acp-mode` part). Session-scoped surfaces leave it undefined.
	 */
	streamedMode?: string | null;
	/** The emission identity (`messageId:partIndex`) of {@link streamedMode}. */
	streamedModeKey?: string | null;
}

export interface ComposerAcpSectionsResult
	extends Omit<AcpSectionsResult, "activeAgentIsAcp"> {
	/** Whether the active agent's reasoning is overridden off (hides thinking picker). */
	reasoningOff: boolean;
}

/**
 * Builds the composer's Model + Approval + config picker sections from the active
 * agent's advertised ACP session config. Session-independent (works on the
 * launchpad and dock before any chat exists); picks persist per-agent.
 */
export function useComposerAcpSections({
	agentId,
	agents,
	modelOptions,
	engineModel,
	onEngineModelChange,
	onSelectionApplied,
	preferSimpleApprovalDefaults = false,
	streamedMode,
	streamedModeKey,
	streamedConfig,
	streamedConfigOptions,
	streamedControl,
}: ComposerAcpSectionsParams): ComposerAcpSectionsResult {
	const activeNode = useActiveNode();
	const isRyuAgent = agentId === "ryu";

	const installedQuery = useQuery({
		queryKey: ["models", "installed", activeNode.url],
		queryFn: () =>
			listInstalledModels({
				url: activeNode.url,
				token: activeNode.token ?? null,
				userJwt: activeNode.userJwt ?? null,
			}),
		enabled: isRyuAgent,
		staleTime: 60_000,
	});
	const activeModelQuery = useQuery({
		queryKey: ["models", "active", activeNode.url],
		queryFn: () =>
			getActiveModel({
				url: activeNode.url,
				token: activeNode.token ?? null,
				userJwt: activeNode.userJwt ?? null,
			}),
		enabled: isRyuAgent,
		staleTime: 30_000,
	});
	const installedStems = useMemo(
		() => (installedQuery.data ?? []).map((m) => m.stem).filter(Boolean),
		[installedQuery.data]
	);
	// The active agent's per-model visibility, from the same Pi catalog the
	// provider rows read (shared query key ⇒ no extra request). An agent's models
	// come over ACP, so this is the only place its toggles can be applied.
	const { catalog: piCatalog } = usePiConfig();
	const agentModelOverrides = agentId
		? piCatalog?.agentModelOverrides?.[agentId]
		: undefined;
	const activeStem = activeModelQuery.data?.active ?? null;

	// What this agent's config-option pickers currently hold, straight from the
	// per-agent store the pickers below write through. Read every render (a pick
	// re-renders through `useAcpSections`' own state) and keyed by value so a
	// fresh object identity is not mistaken for a change.
	//
	// These are sent to the probe because an agent's advertised option SET is not
	// a constant of its binary: ACP lets `session/set_config_option` answer with a
	// refreshed list, and opencode uses that to offer its reasoning `effort`
	// option only while the session's model has effort levels. Probing with no
	// picks therefore reports a real but incomplete set — which is exactly why
	// opencode showed a Model picker and no Effort one. Nothing here knows an
	// agent's name or an option's id: whatever the user picked is replayed.
	const selectionsKey = JSON.stringify(
		Object.entries(agentId ? getAcpConfig(agentId) : {}).sort(([a], [b]) =>
			a.localeCompare(b)
		)
	);
	const acpSelections = useMemo<Record<string, string> | null>(() => {
		// SAFETY: selectionsKey is JSON.stringify of sorted Object.entries from
		// getAcpConfig's string dictionary above, so parsing restores string pairs.
		const entries = JSON.parse(selectionsKey) as [string, string][];
		return entries.length > 0 ? Object.fromEntries(entries) : null;
	}, [selectionsKey]);

	// The active agent's advertised permission modes / reasoning-effort config
	// options / models. A picker renders only for what the agent reports.
	const { config: probedSessionConfig, loading: acpConfigLoading } =
		useAcpConfig(agentId, acpSelections);
	// The live session's own answer wins over the probe's. The probe runs in a
	// SEPARATE throwaway session, so it can never see an option the agent revealed
	// in response to a pick applied to the real one. Only `configOptions` is
	// replaced — models and modes still come from the probe, which is the only
	// thing that reports them before a chat exists.
	// Scoped to the agent the options were published FOR. The caller clears its
	// streamed state on an agent switch, but this is the load-bearing half: an
	// override that outlived its agent would pin the new agent's pickers to the
	// previous one's option list, and the probe — which is correct — would be
	// silently discarded.
	const streamedForAgent = useRef<string | null>(null);
	if (streamedConfigOptions) {
		streamedForAgent.current = agentId ?? null;
	}
	const streamedIsForThisAgent = streamedForAgent.current === (agentId ?? null);
	const acpSessionConfig = useMemo(() => {
		if (
			!(streamedConfigOptions && probedSessionConfig && streamedIsForThisAgent)
		) {
			return probedSessionConfig;
		}
		return { ...probedSessionConfig, configOptions: streamedConfigOptions };
	}, [probedSessionConfig, streamedConfigOptions, streamedIsForThisAgent]);
	// The active agent's effective capabilities — a reasoning-off override
	// suppresses the thinking picker (Jan-style). Pass the engine model so
	// vision/tools detection follows the composer's model selection, and the SAME
	// ACP picks the config read used: `reasoning` comes off the same probe, so
	// probing them apart would advertise an effort option and then hide it.
	const { capabilities } = useAgentCapabilities(
		agentId,
		engineModel,
		acpSelections
	);
	const reasoningOff = capabilities?.reasoning === false;

	const [friendly] = useFriendlyMode();
	const modelDisplayName = useCallback(
		(raw: string) => (friendly ? friendlyModelDisplay(raw).label : raw),
		[friendly]
	);
	// The active agent's per-model visibility overrides (Settings → Providers →
	// Agents). Applies to whichever model branch wins: an agent advertises its
	// models over ACP rather than through a Pi provider, so a provider's
	// `modelOverrides` never covers this list. The branch's own current value is
	// always kept, so a hidden-but-selected model never vanishes.
	const filterModelItems = useCallback(
		(items: ComposerSettingItem[], current: string | null | undefined) =>
			filterEnabledModels(items, agentModelOverrides, current),
		[agentModelOverrides]
	);

	const {
		acpMode,
		acpModel,
		acpOptionValues,
		activeAgentIsAcp,
		extraSections,
		modelSection,
		simpleApprovalDefaults,
	} = useAcpSections({
		acpSessionConfig,
		agentId,
		agents,
		engineModel,
		filterModelItems,
		modelDisplayName,
		modelOptions,
		onEngineModelChange,
		onSelectionApplied,
		preferSimpleApprovalDefaults,
		reasoningOff,
		store: ACP_SELECTION_STORE,
		streamedConfig,
		streamedControl,
		streamedMode,
		streamedModeKey,
	});

	return useMemo<ComposerAcpSectionsResult>(() => {
		// While an ACP agent's advertised config is still being probed (`useAcpConfig`
		// spawns the agent subprocess on first fetch, up to ~30s + retries), mark the
		// section loading so the composer shows a "Detecting…" spinner instead of
		// silently hiding an empty picker — the "selectors just missing on agent
		// switch, no loading state" gap.
		const decorated: ComposerModelSection = {
			...withGroupedModelMenu(
				modelSection,
				isRyuAgent ? installedStems : [],
				isRyuAgent ? activeStem : null,
				// Only an external ACP harness runs on its own vendor subscription, so
				// only its models can carry a per-model quota.
				activeAgentIsAcp ? agentId : null
			),
			loading: activeAgentIsAcp && acpConfigLoading,
		};
		return {
			modelSection: decorated,
			extraSections,
			acpMode,
			acpModel,
			acpOptionValues,
			simpleApprovalDefaults,
			reasoningOff,
		};
	}, [
		acpMode,
		acpModel,
		acpOptionValues,
		simpleApprovalDefaults,
		acpConfigLoading,
		activeAgentIsAcp,
		agentId,
		activeStem,
		extraSections,
		installedStems,
		isRyuAgent,
		modelSection,
		reasoningOff,
	]);
}
