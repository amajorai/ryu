import { describe, expect, test } from "bun:test";
import {
	type OnboardingAgentSuggestion,
	startProfileJob,
} from "./onboarding-profile.ts";
import { EMPTY_AGENT_SELECTION } from "./preferences.ts";

const target = {
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

describe("onboarding profile job recipes", () => {
	test("keeps structured agent suggestions from Core", async () => {
		const originalFetch = globalThis.fetch;
		const suggestion: OnboardingAgentSuggestion = {
			description: "Groups recurring release checks.",
			id: "agent-suggestion-release-desk",
			name: "Release Desk",
			reason: "Release checks appeared repeatedly.",
			systemPrompt: "Help verify releases and ask before changing anything.",
			title: "Release engineer",
			tools: ["search_conversations.search"],
		};
		globalThis.fetch = (async () =>
			Response.json({
				agentSuggestions: [suggestion],
				id: "job-1",
				state: "completed",
			})) as unknown as typeof globalThis.fetch;

		try {
			const job = await startProfileJob(target, {
				cloudSelection: EMPTY_AGENT_SELECTION,
				importedConversationIds: [],
				recentDays: 90,
				shareUserOrg: true,
				sourceIds: [],
			});
			expect(job.agentSuggestions).toEqual([suggestion]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("defaults missing recipes for older Core responses", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			Response.json({
				id: "job-2",
				state: "queued",
			})) as unknown as typeof globalThis.fetch;

		try {
			const job = await startProfileJob(target, {
				cloudSelection: EMPTY_AGENT_SELECTION,
				importedConversationIds: [],
				recentDays: 90,
				shareUserOrg: true,
				sourceIds: [],
			});
			expect(job.agentSuggestions).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
