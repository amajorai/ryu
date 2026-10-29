import { describe, expect, test } from "bun:test";
import {
	fetchNodeOnboardingState,
	type OnboardingAgentSuggestion,
	resetNodeOnboardingState,
	saveNodeOnboardingState,
	startProfileJob,
} from "./onboarding-profile.ts";
import { EMPTY_AGENT_SELECTION } from "./preferences.ts";

function fixtureFetch(
	callback: (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit
	) => Promise<Response>,
	nativeFetch: typeof fetch
) {
	return Object.assign(callback, { preconnect: nativeFetch.preconnect });
}

const target = {
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

describe("onboarding profile job recipes", () => {
	test("reads the node-level setup state", async () => {
		const originalFetch = globalThis.fetch;
		let requestedUrl = "";
		globalThis.fetch = fixtureFetch(
			async (input: Parameters<typeof fetch>[0]) => {
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
			},
			originalFetch
		);

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
		globalThis.fetch = fixtureFetch(
			async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
			},
			originalFetch
		);

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
		globalThis.fetch = fixtureFetch(
			async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
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
			},
			originalFetch
		);

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
		globalThis.fetch = fixtureFetch(
			async () =>
				Response.json({
					agentSuggestions: [suggestion],
					id: "job-1",
					state: "completed",
				}),
			originalFetch
		);

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
		globalThis.fetch = fixtureFetch(
			async () =>
				Response.json({
					id: "job-2",
					state: "queued",
				}),
			originalFetch
		);

		try {
			const job = await startProfileJob(target, {
				cloudSelection: EMPTY_AGENT_SELECTION,
				importedConversationIds: [],
				recentDays: 90,
				shareUserOrg: true,
				sourceIds: [],
			});
			expect(job.agentSuggestions).toEqual([]);
			expect(job.background).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("separates the background choice from materialization", async () => {
		const originalFetch = globalThis.fetch;
		const responses = [
			// Current Core: the build materializes on its own in the foreground.
			{ background: false, id: "job-3", materialized: true, state: "building" },
			// Older Core: only "Run in background" materialized the build.
			{ id: "job-4", materialized: true, state: "building" },
		];
		globalThis.fetch = fixtureFetch(
			async () => Response.json(responses.shift()),
			originalFetch
		);
		const input = {
			cloudSelection: EMPTY_AGENT_SELECTION,
			importedConversationIds: [],
			recentDays: 90,
			shareUserOrg: false,
			sourceIds: [],
		};

		try {
			const current = await startProfileJob(target, input);
			expect(current.materialized).toBe(true);
			expect(current.background).toBe(false);
			const older = await startProfileJob(target, input);
			expect(older.background).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
