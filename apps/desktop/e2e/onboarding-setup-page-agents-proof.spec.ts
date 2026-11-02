import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { parseProofJson } from "./fixture-json.ts";
import { PreferenceFixtureSchema } from "./onboarding-fixture-contract.ts";
import {
	chooseOrg,
	EVIDENCE,
	fixture,
	localDefault,
	PROOF_URL,
} from "./onboarding-setup-page-proof.fixture.ts";

// The activation steps follow privacy (4f7563c79d): the task picker offers app
// tasks, a task preview asks to connect its app, and the managed task starts
// once that connection is in place.
test("production owner activation confirms connection permission, claims reward and retries the first task", async ({
	page,
}) => {
	const f = await fixture(page, { paid: true, failedQuest: true });
	try {
		await localDefault(page);
		await chooseOrg(page);
		await expect(
			page.getByRole("heading", { name: "Set your cloud default" })
		).toBeVisible();
		await page
			.getByRole("button", { name: "Save default", exact: true })
			.click();
		await page
			.getByRole("button", { name: "Continue to privacy", exact: true })
			.click();
		await page.getByRole("button", { name: "Not now", exact: true }).click();
		await page.getByTestId("onboarding-final-continue").click();
		await expect(
			page.getByRole("heading", { name: "What would you like Ryu to do?" })
		).toBeVisible();
		await page
			.getByRole("list")
			.locator(":scope > *")
			.filter({ hasText: "Find the next task in Notion" })
			.getByRole("button", { name: "Preview task", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "Find the next task in Notion" })
		).toBeVisible();
		const connect = page.getByRole("button", {
			name: "Connect Notion for this task",
			exact: true,
		});
		await connect.click();
		const permission = page.getByTestId("connection-permission-dialog");
		await permission
			.getByRole("button", { name: "Cancel", exact: true })
			.click();
		expect(f.calls.some((c) => c.path.endsWith("/initiate"))).toBe(false);
		await connect.click();
		await permission
			.getByRole("button", { name: "Continue to connect", exact: true })
			.click();
		await expect(permission).not.toBeVisible();
		expect(f.calls.find((c) => c.path.endsWith("/initiate"))).toMatchObject({
			authorization: "Bearer setup-proof-node-token",
			body: { access_level: "risk_based", toolkit: "notion" },
		});
		expect((await f.read()).rewardClaims).toEqual([
			{ appSlug: "notion", connectionId: "new-notion" },
		]);
		expect(
			f.calls.find((c) => c.path.endsWith("/rewards/claim"))
		).toMatchObject({
			authorization: "Bearer onboarding-fixture-session",
			body: { appSlug: "notion", connectionId: "new-notion" },
		});
		const start = page.getByRole("button", {
			name: "Start managed task",
			exact: true,
		});
		await start.click();
		await expect(page.getByRole("alert")).toHaveText("/api/quests failed: 503");
		expect((await f.read()).quests).toEqual([]);
		await start.click();
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
			// Node setup hands off to the local default (the skills step sits
			// before node setup's local default only on a fresh flow).
			await expect(
				page.getByRole("heading", { name: "Set your local default" })
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
				// A paid plan goes from the organization straight to the cloud
				// default (4f7563c79d).
				await chooseOrg(page);
				await expect(
					page.getByRole("heading", { name: "Set your cloud default" })
				).toBeVisible();
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
							: "A few things to know",
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
