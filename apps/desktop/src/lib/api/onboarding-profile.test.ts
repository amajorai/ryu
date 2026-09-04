import { describe, expect, test } from "bun:test";
import {
	fetchNodeOnboardingState,
	type OnboardingAgentSuggestion,
	resetNodeOnboardingState,
	saveNodeOnboardingState,
	startProfileJob,
} from "./onboarding-profile.ts";
import { EMPTY_AGENT_SELECTION } from "./preferences.ts";

const target = {
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

describe("onboarding profile job recipes", () => {
	test("reads the node-level setup state", async () => {
		const originalFetch = globalThis.fetch;
		let requestedUrl = "";
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			requestedUrl = String(input);
			return Response.json({
				canConfigure: true,
				completed: false,
				completedAtMs: null,
				personalization: {
					companyContext: "",
					companyKnowledgeEnabled: false,
				},
				setupKind: null,
				version: 1,
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			await expect(fetchNodeOnboardingState(target)).resolves.toMatchObject({
				completed: false,
				setupKind: null,
			});
			expect(requestedUrl).toBe(`${target.url}/api/onboarding/state`);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("saves the selected node mode without marking it complete", async () => {
		const originalFetch = globalThis.fetch;
		let request: RequestInit | undefined;
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit
		) => {
			request = init;
			return Response.json({
				canConfigure: true,
				completed: false,
				completedAtMs: null,
				personalization: {
					companyContext: "We build reviewable tools.",
					companyKnowledgeEnabled: true,
				},
				setupKind: "team",
				version: 1,
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			await saveNodeOnboardingState(target, {
				companyContext: "We build reviewable tools.",
				companyKnowledgeEnabled: true,
				completed: false,
				setupKind: "team",
			});
			expect(request?.method).toBe("PUT");
			expect(request?.body).toBe(
				JSON.stringify({
					companyContext: "We build reviewable tools.",
					companyKnowledgeEnabled: true,
					completed: false,
					setupKind: "team",
				})
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("resets node onboarding through the dedicated delete route", async () => {
		const originalFetch = globalThis.fetch;
		let request: RequestInit | undefined;
		globalThis.fetch = (async (
			_input: RequestInfo | URL,
			init?: RequestInit
		) => {
			request = init;
			return Response.json({
				canConfigure: true,
				completed: false,
				completedAtMs: null,
				personalization: {
					companyContext: "",
					companyKnowledgeEnabled: false,
				},
				setupKind: null,
				version: 1,
			});
		}) as unknown as typeof globalThis.fetch;

		try {
			await resetNodeOnboardingState(target);
			expect(request?.method).toBe("DELETE");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

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
