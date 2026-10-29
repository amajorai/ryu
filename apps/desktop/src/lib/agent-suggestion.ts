import type { AgentIdentityMode, AgentInput } from "@/src/lib/api/agents.ts";
import type { OnboardingAgentSuggestion } from "@/src/lib/api/onboarding-profile.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";

const FALLBACK_TOOL = "search_conversations.search";

/** Every suggested agent runs on the "Ryu" engine. */
export const SUGGESTED_AGENT_ENGINE = "acp:pi";

/**
 * The identity mode a suggestion starts with: "Acts as you", the same card the
 * New agent dialog preselects. Suggestions come from the user's own recurring
 * work, and the onboarding card shows the mode with a Change control.
 */
export const DEFAULT_SUGGESTED_IDENTITY_MODE: AgentIdentityMode = "managed";

/** The identity mode chosen for one suggestion, or the default. */
export function suggestionIdentityMode(
	modes: ReadonlyMap<string, AgentIdentityMode>,
	suggestionId: string
): AgentIdentityMode {
	return modes.get(suggestionId) ?? DEFAULT_SUGGESTED_IDENTITY_MODE;
}

/**
 * Convert one reviewed onboarding recipe into the existing agent-create wire
 * shape. Account access is left unset (no limit within the mode), as the New
 * agent dialog does, until the user narrows it in the editor.
 */
export function buildSuggestedAgentInput(
	suggestion: OnboardingAgentSuggestion,
	selection: AgentSelection,
	identityMode: AgentIdentityMode = DEFAULT_SUGGESTED_IDENTITY_MODE
): AgentInput {
	const model = selection.model.trim() || null;
	const modelEngine = selection.provider.trim() || null;
	return {
		chatModel: {
			engine: modelEngine,
			modelId: model,
		},
		description: suggestion.description,
		engine: SUGGESTED_AGENT_ENGINE,
		identityMode,
		model,
		name: suggestion.name,
		persona: {
			display_name: null,
			tone: null,
		},
		safetyProfile: "read_only",
		systemPrompt: suggestion.systemPrompt,
		title: suggestion.title,
		tools: suggestion.tools.length > 0 ? suggestion.tools : [FALLBACK_TOOL],
	};
}
