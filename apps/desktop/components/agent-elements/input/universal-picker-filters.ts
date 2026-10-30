import { useContext, useState } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import type { UniversalPickerBodyBaseScope } from "./universal-picker-body-scope.ts";
import {
	matches,
	recentAgents,
	recentModels,
	SEARCH_THRESHOLD,
} from "./universal-picker-recents.tsx";
import { AUTO_AGENT_ID } from "./universal-picker-types.ts";

export type UseUniversalPickerFiltersInput = UniversalPickerBodyBaseScope;

/** The search query, the filtered agents, providers and recents, and which sections show. */
export function useUniversalPickerFilters({
	data,
	mode,
}: UseUniversalPickerFiltersInput) {
	const [query, setQuery] = useState("");
	const commandNavigation = useProviderCommandNavigation();
	const q = query.trim().toLowerCase();
	// Read the tabs context RAW rather than through `useTabsContext`, which throws
	// outside a provider. This body is also mounted by settings-shaped fields
	// (`AgentSelectionField`, `AgentModelPickerField`) that a future surface could
	// render outside the workspace shell; a null context just hides the
	// marketplace row instead of taking the whole picker down with it.
	const tabsCtx = useContext(TabsContext);
	const openAgentsCatalog = tabsCtx
		? () => tabsCtx.openTab("/store/agents", { title: "Customize" })
		: null;
	const {
		agents,
		activeModelSection,
		activeExtraSections,
		availableExternal,
		customAgents = [],
		installedExternal,
		installPendingId,
		onConfigureCredentials,
		onCreateAgent,
		onInstallExternal,
		onRemoveRecent,
		onSelectAgent,
		onSelectProviderModel,
		onSelectProviderThinking,
		onSelectRecentModel,
		onSelectTeam,
		onSwitchProviderAccount,
		onRemoveProviderAccount,
		onSwitchAgentAccount,
		onRemoveAgentAccount,
		onUpgrade,
		onUseProvider,
		providers,
		recentRefs,
		ryuAgent,
		ryuActive,
		teams,
		thinkingLevels,
	} = data;
	const showAgents = mode !== "models";
	const showProviders = mode !== "agents";
	// Total rows across all sections — the search box only earns its space once the
	// list is long enough to need filtering. Counts the FLATTENED search space
	// (providers, installable agents), not the compact root.
	const totalRows =
		(ryuAgent ? 1 : 0) +
		providers.length +
		installedExternal.length +
		customAgents.length +
		availableExternal.length +
		teams.length;
	const showSearch = totalRows >= SEARCH_THRESHOLD;

	const filteredProviders = providers.filter((p) => matches(q, p.label, p.id));
	const filteredInstalled = installedExternal.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredCustom = customAgents.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredAvailable = availableExternal.filter((a) =>
		matches(q, a.name, a.id, a.description)
	);
	const filteredTeams = teams.filter((t) => matches(q, t.name, t.id));
	const recentModelRows = recentModels(recentRefs, providers);
	const recentAgentRows = recentAgents(recentRefs, agents, ryuAgent);
	const ryuVisible = ryuAgent ? matches(q, ryuAgent.name, "ryu") : false;
	// The "Auto" row is always offered (empty query) and stays findable by search —
	// unless a settings field suppresses it (`hideAuto`).
	const autoVisible =
		!data.hideAuto && matches(q, "auto routes best agent by your rules");
	const autoActive = data.activeAgentId === AUTO_AGENT_ID;

	// The Ryu agent is the active target whether it routes through the portal
	// (gateway/local) or through one of its providers — the root row reflects both.
	const ryuRowActive = ryuActive || providers.some((p) => p.isActive);

	// The active agent's LIVE model/approval/thinking sections (wired to the host's
	// live handlers). Rendered under whichever row is the active target — Ryu or
	// the active external agent — so tuning the current target updates the running
	// turn directly, instead of a second `useComposerAcpSections` instance whose picks
	// wouldn't reach the host until a remount.
	const activeSections: ComposerSettingsSection[] = [
		...(activeModelSection ? [activeModelSection] : []),
		...activeExtraSections,
	];

	const nothingMatches =
		showAgents &&
		!(autoVisible || ryuVisible) &&
		filteredInstalled.length === 0 &&
		filteredCustom.length === 0 &&
		filteredAvailable.length === 0 &&
		filteredTeams.length === 0 &&
		(!showProviders || filteredProviders.length === 0);
	return {
		query,
		setQuery,
		commandNavigation,
		q,
		openAgentsCatalog,
		agents,
		activeModelSection,
		availableExternal,
		installPendingId,
		onConfigureCredentials,
		onCreateAgent,
		onInstallExternal,
		onRemoveRecent,
		onSelectAgent,
		onSelectProviderModel,
		onSelectProviderThinking,
		onSelectRecentModel,
		onSelectTeam,
		onSwitchProviderAccount,
		onRemoveProviderAccount,
		onSwitchAgentAccount,
		onRemoveAgentAccount,
		onUpgrade,
		onUseProvider,
		providers,
		ryuAgent,
		ryuActive,
		thinkingLevels,
		showAgents,
		showProviders,
		showSearch,
		filteredProviders,
		filteredInstalled,
		filteredCustom,
		filteredAvailable,
		filteredTeams,
		recentModelRows,
		recentAgentRows,
		ryuVisible,
		autoVisible,
		autoActive,
		ryuRowActive,
		activeSections,
		nothingMatches,
	} as const;
}
