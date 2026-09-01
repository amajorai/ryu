import type { AgentInput } from "@/src/lib/api/agents.ts";
import type { OnboardingAgentSuggestion } from "@/src/lib/api/onboarding-profile.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";

const FALLBACK_TOOL = "search_conversations.search";

/** Convert one reviewed onboarding recipe into the existing agent-create wire shape. */
export function buildSuggestedAgentInput(
	suggestion: OnboardingAgentSuggestion,
	selection: AgentSelection
): AgentInput {
	const model = selection.model.trim() || null;
	const modelEngine = selection.provider.trim() || null;
	return {
		chatModel: {
			engine: modelEngine,
			modelId: model,
		},
		description: suggestion.description,
		engine: "acp:pi",
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
