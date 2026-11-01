import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { parseProofJson } from "./fixture-json.ts";
import { PreferenceFixtureSchema } from "./onboarding-fixture-contract.ts";
import {
	chooseOrg,
	EVIDENCE,
	fixture,
	localDefault,
	PROOF_URL,
	SUGGESTIONS,
	toProfile,
} from "./onboarding-setup-page-proof.fixture.ts";

async function toSuggestions(page: Page) {
	await toProfile(page);
	await page
		.getByRole("button", { name: "Build my profile", exact: true })
		.click();
	await expect(
		page.getByText("Your profile and 2 agent drafts are ready", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Continue", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Suggested agents for your work" })
	).toBeVisible();
}

test("production suggested agents require prompt review and retry only the failed persisted draft", async ({
	page,
}) => {
	const f = await fixture(page, {
		paid: true,
		suggestions: true,
		failedAgentCreate: true,
	});
	try {
		await toSuggestions(page);
		await expect(
			page.getByRole("button", { name: "Select an agent", exact: true })
		).toBeDisabled();
		for (const draft of SUGGESTIONS) {
			const card = page.getByTestId(`agent-suggestion-${draft.id}`);
			await card
				.getByRole("button", { name: `Select ${draft.name}`, exact: true })
				.click();
			await expect(card.getByTestId("suggested-prompt")).toHaveText(
				draft.systemPrompt
			);
			await card.locator("summary").click();
			await expect(card.getByTestId("suggested-prompt")).not.toBeVisible();
			await card.locator("summary").click();
		}
		await expect(
			page.getByRole("button", {
				name: "Review 2 selected drafts",
				exact: true,
			})
		).toBeDisabled();
		expect(
			f.calls.some((c) => c.method === "POST" && c.path === "/api/agents")
		).toBe(false);
		for (const draft of SUGGESTIONS) {
			await page
				.getByRole("checkbox", {
					name: `I reviewed ${draft.name}`,
					exact: true,
				})
				.click();
		}
		await page
			.getByRole("button", { name: "Add 2 agents", exact: true })
			.click();
		await expect(page.getByRole("alert")).toHaveText(
			"Added 1. Couldn't add Research helper. Try again or skip."
		);
		expect((await f.read()).agents.map((a) => a.name)).toEqual([
			"Inbox helper",
		]);
		await expect(page.getByTestId("agent-suggestion-draft-0")).toHaveCount(0);
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-agent-partial-retry.png"
			),
			fullPage: true,
		});
		await page
			.getByRole("button", { name: "Add 1 agent", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		const writes = f.calls.filter(
			(c) => c.method === "POST" && c.path === "/api/agents"
		);
		expect(writes).toHaveLength(3);
		expect((await f.read()).agents.map((a) => a.name)).toEqual([
			"Inbox helper",
			"Research helper",
		]);
		for (const [index, call] of writes.entries()) {
			const draft = SUGGESTIONS[index === 0 ? 0 : 1];
			expect(call.authorization).toBe("Bearer setup-proof-node-token");
			expect(call.body).toEqual({
				name: draft.name,
				title: draft.title,
				description: draft.description,
				system_prompt: draft.systemPrompt,
				engine: "acp:pi",
				model: "openrouter/auto",
				chat_model: {
					engine: "managed-openrouter",
					model_id: "openrouter/auto",
				},
				tools: draft.tools,
				persona: { display_name: null, tone: null },
				safety_profile: "read_only",
			});
		}
		await page.screenshot({
			path: path.join(
				EVIDENCE,
				"onboarding-production-suggested-agents-completed.png"
			),
			fullPage: true,
		});
	} finally {
		await f.close();
	}
});

test("production suggested agent deselection and skip do not create agents", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, suggestions: true });
	try {
		await toSuggestions(page);
		await page
			.getByRole("button", { name: "Select Inbox helper", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Deselect Inbox helper", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Select an agent", exact: true })
		).toBeDisabled();
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		expect(
			f.calls.some((c) => c.method === "POST" && c.path === "/api/agents")
		).toBe(false);
		expect((await f.read()).agents).toEqual([]);
	} finally {
		await f.close();
	}
});

test("production owner activation confirms connection permission, claims reward and retries the first task", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedQuest: true });
	try {
		await toProfile(page);
		await page
			.getByRole("button", { name: "Skip for now", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Choose how you talk to Ryu" })
		).toBeVisible();
		await page.getByRole("button", { name: "Skip", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Make it yours" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Set your preferences" })
		).toBeVisible();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page.getByTestId("onboarding-final-continue").click();
		await page.getByRole("radio", { name: "Search", exact: true }).click();
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "Recommended for you" })
		).toBeVisible();
		const notion = page
			.locator("div.rounded-2xl")
			.filter({ has: page.getByText("Notion", { exact: true }) })
			.filter({
				has: page.getByRole("button", {
					name: "Connect · +$0.50",
					exact: true,
				}),
			});
		await notion
			.getByRole("button", { name: "Connect · +$0.50", exact: true })
			.click();
		const permission = page.getByTestId("connection-permission-dialog");
		await permission
			.getByRole("button", { name: "Cancel", exact: true })
			.click();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await notion
			.getByRole("button", { name: "Connect · +$0.50", exact: true })
			.click();
		await permission
			.getByRole("button", { name: "Continue to connect", exact: true })
			.click();
		await expect(permission).not.toBeVisible();
		expect((await f.read()).rewardClaims).toEqual([
			{ appSlug: "notion", connectionId: "new-notion" },
		]);
		expect(
			f.calls.find((c) => c.path.endsWith("/rewards/claim"))
		).toMatchObject({
			authorization: "Bearer onboarding-fixture-session",
			body: { appSlug: "notion", connectionId: "new-notion" },
		});
		await page.getByRole("button", { name: "Continue", exact: true }).click();
		await page
			.getByRole("button", { name: "See your first task", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Continue to task", exact: true })
			.click();
		await page.getByRole("button", { name: "Start task", exact: true }).click();
		await expect(page.getByRole("alert")).toHaveText("/api/quests failed: 503");
		expect((await f.read()).quests).toEqual([]);
		await page.getByRole("button", { name: "Start task", exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_complete")
				)
			)
			.toBe("true");
		const writes = f.calls.filter(
			(c) => c.method === "POST" && c.path === "/api/quests"
		);
		expect(writes).toHaveLength(2);
		expect(writes[0].body).toEqual(writes[1].body);
		expect(writes[1].authorization).toBe("Bearer setup-proof-node-token");
		expect((await f.read()).quests).toHaveLength(1);
		expect(
			parseProofJson(
				await page.evaluate(
					() => localStorage.getItem("ryu_onboarding_activation_task") ?? "null"
				)
			)
		).toMatchObject({ id: "quest-proof" });
	} finally {
		await f.close();
	}
});

for (const kind of ["personal", "team"] as const) {
	test(`production node context ${kind} retries a failed state save and persists only its scope`, async ({
		page,
	}) => {
		const f = await fixture(page, { failedNodeSetup: true });
		try {
			await page.addInitScript(() =>
				localStorage.setItem("ryu_desktop_onboarding_phase", "node-setup")
			);
			await page.goto(PROOF_URL);
			await expect(
				page.getByRole("button", { name: "Continue", exact: true })
			).toBeDisabled();
			await page
				.getByRole("radio", {
					name: kind === "team" ? "Team or company use" : "Personal use",
					exact: true,
				})
				.click();
			await page
				.getByLabel(
					kind === "team"
						? "More information about your company"
						: "More information about you"
				)
				.fill("Reviewable setup context");
			// A personal note is part of every thread's system prompt, so the
			// step confirms the prompt-cache reset before each attempt.
			const continueNodeSetup = async () => {
				await page
					.getByRole("button", { name: "Continue", exact: true })
					.click();
				if (kind === "personal") {
					await page
						.getByRole("alertdialog")
						.getByRole("button", { name: "Apply now", exact: true })
						.click();
				}
			};
			await continueNodeSetup();
			await expect(page.getByRole("alert")).toHaveText(
				"/api/onboarding/state failed: 503"
			);
			expect((await f.read()).nodeSetup).toBeNull();
			await continueNodeSetup();
			await expect(
				page.getByRole("button", {
					name: "Continue with no optional packs",
					exact: true,
				})
			).toBeVisible();
			const writes = f.calls.filter(
				(c) => c.method === "PUT" && c.path === "/api/onboarding/state"
			);
			expect(writes).toHaveLength(2);
			for (const call of writes) {
				expect(call).toMatchObject({
					authorization: "Bearer setup-proof-node-token",
					body: {
						companyContext: kind === "team" ? "Reviewable setup context" : "",
						companyKnowledgeEnabled: kind === "team",
						completed: false,
						setupKind: kind,
					},
				});
			}
			expect((await f.read()).nodeSetup).toEqual(writes[1].body);
			const personalWrites = f.calls.filter(
				(c) => c.method === "PUT" && c.path.includes("personalization")
			);
			expect(personalWrites).toHaveLength(kind === "personal" ? 1 : 0);
		} finally {
			await f.close();
		}
	});
}

for (const lane of ["local", "cloud"] as const) {
	test(`production ${lane} default failed save preserves draft and retries identical persisted selection`, async ({
		page,
	}) => {
		const f = await fixture(page, { failedLaneSave: lane, paid: true });
		try {
			if (lane === "cloud") {
				await localDefault(page);
				await chooseOrg(page);
				await expect(
					page.getByRole("heading", { name: "Connect your accounts" })
				).toBeVisible();
				await page
					.getByRole("button", { name: "Continue", exact: true })
					.click();
			} else {
				await page.goto(PROOF_URL);
				await page
					.getByRole("button", {
						name: "Continue with no optional packs",
						exact: true,
					})
					.click();
			}
			await page
				.getByRole("button", {
					name: `Choose default ${lane} agent`,
					exact: true,
				})
				.click();
			await page
				.getByRole("textbox", { name: "Custom model id" })
				.fill(`fixture/${lane}-retry`);
			await page
				.getByRole("button", { name: "Use this model", exact: true })
				.click();
			const heading = page.getByRole("heading", {
				name: `Set your ${lane} default`,
			});
			const save = page.getByRole("button", {
				name: "Save default",
				exact: true,
			});
			await save.click();
			await expect(page.getByRole("alert")).toHaveText(
				`Could not save your ${lane} default. Try again.`
			);
			await expect(heading).toBeVisible();
			await expect(save).toBeEnabled();
			await page
				.getByRole("button", {
					name: `Choose default ${lane} agent`,
					exact: true,
				})
				.click();
			await expect(
				page.getByRole("textbox", { name: "Custom model id" })
			).toHaveValue(`fixture/${lane}-retry`);
			await page
				.getByRole("button", { name: "Use this model", exact: true })
				.click();
			const key = `default-${lane}-agent-selection`;
			expect((await f.read()).preferences[key]).toBeUndefined();
			expect(
				await page.evaluate(() =>
					localStorage.getItem("ryu_desktop_onboarding_phase")
				)
			).toBe(`${lane}-default`);
			await mkdir(EVIDENCE, { recursive: true });
			await page.screenshot({
				path: path.join(EVIDENCE, `onboarding-${lane}-save-error.png`),
				fullPage: true,
			});
			await save.click();
			await expect(
				page.getByRole("heading", {
					name:
						lane === "local"
							? "Choose your organization"
							: "Import existing threads",
				})
			).toBeVisible();
			await expect(page.getByRole("alert")).toHaveCount(0);
			const expectedSelection = {
				access_mode: "",
				agent_id: lane === "local" ? "" : "ryu",
				effort: "",
				model: `fixture/${lane}-retry`,
				provider: "",
				thinking_level: "",
			};
			const writes = f.calls.filter(
				(c) => c.method === "PUT" && c.path === `/api/preferences/${key}`
			);
			expect(writes).toHaveLength(2);
			for (const call of writes) {
				expect(call.authorization).toBe("Bearer setup-proof-node-token");
				expect(call.body).toEqual(writes[0].body);
				expect(
					parseProofJson(PreferenceFixtureSchema.parse(call.body).value)
				).toEqual(expectedSelection);
			}
			expect(parseProofJson((await f.read()).preferences[key])).toEqual(
				expectedSelection
			);
			await page.screenshot({
				path: path.join(
					EVIDENCE,
					`onboarding-${lane}-save-retry-completed.png`
				),
				fullPage: true,
			});
		} finally {
			await f.close();
		}
	});
}
