import { describe, expect, test } from "bun:test";
import { buildSuggestedAgentInput } from "./agent-suggestion.ts";
import type { OnboardingAgentSuggestion } from "./api/onboarding-profile.ts";
import { EMPTY_AGENT_SELECTION } from "./api/preferences.ts";

const suggestion: OnboardingAgentSuggestion = {
	description: "Groups recurring release checks.",
	id: "agent-suggestion-release-desk",
	name: "Release Desk",
	reason: "Release checks appeared repeatedly.",
	systemPrompt: "Help verify releases and ask before changing anything.",
	title: "Release engineer",
	tools: ["search_conversations.search", "web.search"],
};

describe("onboarding agent recipe payload", () => {
	test("creates a safe Ryu agent with the reviewed prompt and tools", () => {
		const input = buildSuggestedAgentInput(suggestion, {
			...EMPTY_AGENT_SELECTION,
			provider: "openrouter",
			model: "openai/gpt-5-mini",
		});

		expect(input).toMatchObject({
			chatModel: {
				engine: "openrouter",
				modelId: "openai/gpt-5-mini",
			},
			engine: "acp:pi",
			model: "openai/gpt-5-mini",
			name: "Release Desk",
			safetyProfile: "read_only",
			systemPrompt: suggestion.systemPrompt,
			title: "Release engineer",
			tools: suggestion.tools,
		});
	});

	test("keeps a usable read-only search tool when a recipe has none", () => {
		const input = buildSuggestedAgentInput(
			{ ...suggestion, tools: [] },
			EMPTY_AGENT_SELECTION
		);

		expect(input.tools).toEqual(["search_conversations.search"]);
		expect(input.safetyProfile).toBe("read_only");
	});
});
