import type { ReactNode } from "react";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { Team } from "@/src/lib/api/teams.ts";
import type { BrowserSurface } from "@/src/lib/extension-host.ts";

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
