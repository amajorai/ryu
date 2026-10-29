import { describe, expect, test } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import {
	fetchOnboardingSkills,
	saveOnboardingSkillSelection,
} from "./onboarding-skills.ts";

const target = {
	token: null,
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

const response = {
	builtInNotice:
		"Ryu's built-in skills and enabled plugin skills are not part of this selection.",
	canConfigure: true,
	configured: false,
	options: [
		{
			description: "Engineering workflows.",
			id: "mattpocock/skills",
			name: "Matt Pocock Skills",
		},
	],
	selectedPackIds: ["mattpocock/skills"],
};

describe("onboarding skill selection API", () => {
	test("reads the node-scoped recommendation catalog", async () => {
		const originalFetch = globalThis.fetch;
		let requestedUrl = "";
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input: RequestInfo | URL) => {
				requestedUrl = String(input);
				return Response.json(response);
			}
		);

		try {
			await expect(fetchOnboardingSkills(target)).resolves.toEqual(response);
			expect(requestedUrl).toBe(`${target.url}/api/onboarding/skills`);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("sends only the selected pack ids", async () => {
		const originalFetch = globalThis.fetch;
		let request: RequestInit | undefined;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				request = init;
				return Response.json({
					...response,
					configured: true,
					syncComplete: true,
					selectedPackIds: [],
				});
			}
		);

		try {
			const saved = await saveOnboardingSkillSelection(target, []);
			expect(request?.method).toBe("PUT");
			expect(request?.body).toBe(JSON.stringify({ selectedPackIds: [] }));
			expect(saved.configured).toBe(true);
			expect(saved.selectedPackIds).toEqual([]);
			expect(saved.syncComplete).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
