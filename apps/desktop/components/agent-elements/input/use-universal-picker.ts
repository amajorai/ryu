"use client";

// Builds the universal picker's grouped body (Ryu Portal · Providers · External
// Agents) and hands `useComposerAgentControls` a `renderBody` it can pass to
// `ComposerSettingsMenu`. This hook owns the extra data the legacy sibling-section
// picker never needed:
//   - Pi provider catalog + active config (`usePiConfig`) → the Providers section,
//     with per-provider `configured` gating and the active route highlighted.
//   - The installable agents catalog (`useAgentsCatalog`) → the not-installed
//     external agents rendered greyed with an Install button.
//   - The Gateway dialog opener (`useGatewayDialog`) → the "Configure credentials"
//     link target for an unconfigured provider.
//
// The active agent's LIVE model/approval/thinking sections are passed in (they
// wire to the host's live handlers) and nested under whichever row is active, so
// changing the current target's model still updates the running turn. Non-active
// external agents are probed lazily inside the body (see `ExternalAgentSettings`).

import { createElement, type ReactNode, useCallback, useMemo } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import {
	type ProviderEntry,
	type TeamEntry,
	UniversalPickerBody,
	type UniversalPickerData,
} from "@/components/agent-elements/input/universal-picker-body.tsx";
import { useEntitlementContext } from "@/src/contexts/entitlement-context.tsx";
import { useAgentsCatalog } from "@/src/hooks/useAgentsCatalog.ts";
import { usePiConfig } from "@/src/hooks/usePiConfig.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import { useAgentAutoDialog } from "@/src/store/useAgentAutoDialog.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

/** The flagship agent id (mirrors Core `DEFAULT_AGENT_ID`). */
const RYU_AGENT_ID = "ryu";

/** Map a Pi provider id to the engine key its brand logo is registered under. */
const PROVIDER_ENGINE_KEY: Record<string, string> = {
	google: "gemini",
	"claude-pro-max": "claude",
	"openai-codex": "codex",
	anthropic: "anthropic",
	openai: "openai",
	mistral: "mistral",
	openrouter: "openrouter",
};

function providerEngineKey(providerId: string): string {
	return PROVIDER_ENGINE_KEY[providerId] ?? providerId;
}

export interface UseUniversalPickerParams {
	/** The active agent's live approval + thinking sections. */
	activeExtraSections: ComposerSettingsSection[];
	/** The active agent's live model section (already resolved by the host). */
	activeModelSection: ComposerSettingsSection | null;
	agentId: string | null;
	agents: AgentSummary[];
	onCreateAgent?: () => void;
	onSelectAgent: (id: string) => void;
	onSelectTeam?: (id: string) => void;
	teamId?: string | null;
	teams?: Team[];
}

export interface UseUniversalPickerResult {
	/** Body renderer for `ComposerSettingsMenu`'s `renderBody` prop. */
	renderBody: (close: () => void) => ReactNode;
}

export function useUniversalPicker(
	params: UseUniversalPickerParams
): UseUniversalPickerResult {
	const {
		agents,
		agentId,
		teamId = null,
		teams = [],
		onSelectAgent,
		onSelectTeam,
		onCreateAgent,
		activeModelSection,
		activeExtraSections,
	} = params;

	const { config, catalog, save } = usePiConfig();
	const catalogAgents = useAgentsCatalog();
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const openAgentAutoConfig = useAgentAutoDialog((s) => s.openAgentAutoConfig);
	const { verdict, requestUpgrade } = useEntitlementContext();
	// True only with an active PAID managed plan. The managed provider is always
	// `configured` server-side (wallet-gated at the Gateway), so the composer upsell
	// gates on the entitlement here, not on `configured`. `verdict` is null until the
	// first resolution; treat unresolved as "no plan" (shows the upsell, flips when ready).
	const hasManagedPlan = verdict?.managedInference ?? false;

	const piProviders = useMemo(() => catalog?.providers ?? [], [catalog]);
	const thinkingLevels = useMemo(
		() => catalog?.thinkingLevels ?? [],
		[catalog]
	);

	// The provider rows shown in the picker: every Pi provider except the bare
	// `gateway` pseudo-provider (that IS the Ryu Portal local/gateway route). The
	// managed `managed-openrouter` provider IS shown here — as the subscription upsell
	// row when unsubscribed, or the full OpenRouter model list when subscribed.
	const shownProviders = useMemo(
		() => piProviders.filter((p) => p.id !== "gateway"),
		[piProviders]
	);

	const isRyuActive = agentId === RYU_AGENT_ID;
	// A provider row is the active target when the Ryu agent's Pi config routes to a
	// provider we show; otherwise (gateway / local) Ryu Portal is the active target.
	const activeProviderId =
		isRyuActive &&
		config &&
		shownProviders.some((p) => p.id === config.provider)
			? config.provider
			: null;
	const ryuActive = isRyuActive && activeProviderId === null;

	const saveProvider = useCallback(
		(
			providerId: string,
			model: string | null,
			thinkingLevel: string | null
		) => {
			onSelectAgent(RYU_AGENT_ID);
			save({
				provider: providerId,
				model,
				thinkingLevel: thinkingLevel ?? config?.thinkingLevel ?? null,
			}).catch(() => {
				// A failed save leaves the previous config in place; the query
				// invalidation the mutation triggers re-reads ground truth.
			});
		},
		[onSelectAgent, save, config]
	);

	const renderBody = useCallback(
		(close: () => void): ReactNode => {
			const ryuAgent =
				agents.find((a) => a.id === RYU_AGENT_ID) ??
				agents.find((a) => a.recommended) ??
				null;

			const installedExternal = agents.filter(
				(a) => a.transport === "acp" && a.id !== ryuAgent?.id && !a.recommended
			);

			const availableExternal = catalogAgents.agents.filter(
				(e) => !e.added && e.id !== ryuAgent?.id
			);

			const providers: ProviderEntry[] = shownProviders.map((p) => {
				const isActive = activeProviderId === p.id;
				return {
					id: p.id,
					label: p.label,
					engineKey: providerEngineKey(p.id),
					authKind: p.authKind,
					managed: Boolean(p.managed),
					supportsDiscovery: p.supportsDiscovery !== false,
					// The managed provider is always `configured` (wallet-gated at the
					// Gateway); when the user has no paid plan, show the upsell instead.
					upsell: Boolean(p.managed) && !hasManagedPlan,
					configured: p.configured,
					isActive,
					currentModel: isActive ? (config?.model ?? null) : null,
					currentThinking: isActive ? (config?.thinkingLevel ?? null) : null,
					models: p.suggestedModels.map((m) => ({ id: m, name: m })),
				};
			});

			const teamEntries: TeamEntry[] = teams.map((t) => ({
				id: t.id,
				name: t.name,
				isActive: teamId === t.id,
				engines: t.members.map((id) => {
					const member = agents.find((a) => a.id === id);
					return member ? engineForAgent(member) : null;
				}),
			}));

			const data: UniversalPickerData = {
				activeAgentId: agentId,
				agents,
				activeModelSection,
				activeExtraSections,
				ryuAgent,
				ryuActive,
				providers,
				installedExternal,
				availableExternal,
				installPendingId: catalogAgents.pendingId,
				teams: teamEntries,
				thinkingLevels,
				onSelectAgent: (id) => onSelectAgent(id),
				onSelectTeam: onSelectTeam ? (id) => onSelectTeam(id) : undefined,
				onCreateAgent,
				onInstallExternal: (id) => {
					catalogAgents.install(id).catch(() => {
						// Install errors surface via the catalog hook's error state.
					});
				},
				onConfigureAuto: () => openAgentAutoConfig(),
				onConfigureCredentials: () => openGateway("providers"),
				onUpgrade: () => requestUpgrade(),
				onUseProvider: (providerId) => {
					const p = providers.find((x) => x.id === providerId);
					saveProvider(
						providerId,
						p?.currentModel ?? p?.models[0]?.id ?? null,
						null
					);
				},
				onSelectProviderModel: (providerId, modelId) =>
					saveProvider(providerId, modelId, null),
				onSelectProviderThinking: (providerId, level) => {
					const p = providers.find((x) => x.id === providerId);
					saveProvider(
						providerId,
						p?.currentModel ?? p?.models[0]?.id ?? null,
						level
					);
				},
			};

			return createElement(UniversalPickerBody, { data, close });
		},
		[
			agents,
			agentId,
			activeModelSection,
			activeExtraSections,
			ryuActive,
			activeProviderId,
			shownProviders,
			hasManagedPlan,
			thinkingLevels,
			config,
			teams,
			teamId,
			catalogAgents,
			onSelectAgent,
			onSelectTeam,
			onCreateAgent,
			openGateway,
			openAgentAutoConfig,
			requestUpgrade,
			saveProvider,
		]
	);

	return { renderBody };
}
