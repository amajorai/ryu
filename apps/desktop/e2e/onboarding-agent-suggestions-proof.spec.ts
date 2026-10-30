import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-agent-suggestions-proof.html";
const PROOF_DIR = "e2e/artifacts";
const PROOF_SCREENSHOT = "e2e/artifacts/onboarding-agent-suggestions-proof.png";
const PROOF_LOG = "e2e/artifacts/onboarding-agent-suggestions-proof.log.json";

test.describe("onboarding agent suggestions proof", () => {
	test("shows the draft fields before it can be added", async ({ page }) => {
		await page.goto(STORY_URL);
		await expect(
			page.getByRole("heading", { name: "Suggested agents for your work" })
		).toBeVisible();
		await expect(
			page.getByText(
				"Keeps release checks together and turns them into a short brief."
			)
		).toBeVisible();
		// Each draft's review details sit behind one "Details" disclosure.
		await expect(page.getByText("Why this showed up")).toHaveCount(0);
		for (const details of await page
			.getByRole("button", { name: "Details" })
			.all()) {
			await details.click();
		}
		await expect(page.getByText("Connected apps", { exact: true })).toHaveCount(
			2
		);
		await expect(page.getByText("Gmail", { exact: true })).toHaveCount(2);
		await expect(page.getByText("Notion", { exact: true })).toHaveCount(2);
		await expect(
			page.getByTestId("agent-suggestion-avatar-agent-suggestion-release-desk")
		).toBeVisible();
		await expect(
			page
				.getByTestId("agent-suggestion-avatar-agent-suggestion-release-desk")
				.locator("[data-expressive-animation]")
		).toBeVisible();
		await expect(
			page
				.getByTestId("agent-suggestion-avatar-agent-suggestion-release-desk")
				.locator('[data-expressive-eye-scale="2"]')
		).toBeVisible();
		await expect(
			page
				.getByTestId("agent-suggestion-avatar-agent-suggestion-release-desk")
				.locator('[data-siri-orb="fill"]')
		).toBeVisible();
		await expect(
			page
				.getByTestId("agent-suggestion-avatar-agent-suggestion-release-desk")
				.locator('[data-siri-orb="surface"]')
		).toHaveCount(0);
		const gmailLogos = page.getByTestId("connected-app-gmail").locator("img");
		await expect(gmailLogos).toHaveCount(2);
		await expect(gmailLogos.first()).toBeVisible();
		const notionLogos = page.getByTestId("connected-app-notion").locator("img");
		await expect(notionLogos).toHaveCount(2);
		await expect(notionLogos.first()).toBeVisible();
		await expect(page.locator("canvas")).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Select Release Desk" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Select an agent" })
		).toBeDisabled();

		await expect(
			page.getByText("Why this showed up", { exact: true })
		).toHaveCount(2);
		await expect(
			page.getByText("Search past chats", { exact: true })
		).toHaveCount(2);
		await expect(
			page.getByText("Review prompt setup", { exact: true })
		).toHaveCount(2);
		await expect(
			page.getByText(
				"Help me verify releases with an evidence-backed checklist. Ask before any external change.",
				{ exact: true }
			)
		).toBeVisible();
		await expect(
			page.getByRole("checkbox", { name: "I reviewed Release Desk" })
		).toBeVisible();
		await expect(page.getByRole("button", { name: "Add 1 agent" })).toHaveCount(
			0
		);
		// Each draft shows how it will work, starting as "Acts as you".
		await expect(
			page
				.getByTestId("agent-suggestion-identity-agent-suggestion-release-desk")
				.getByText("Acts as you", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Change how Inbox Triage works" })
		).toBeVisible();
	});

	test("adds only the selected drafts with one confirmation", async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		const failedRequests: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error") {
				consoleErrors.push(message.text());
			}
		});
		page.on("pageerror", (error) => consoleErrors.push(String(error)));
		page.on("requestfailed", (request) => {
			failedRequests.push(
				`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`
			);
		});

		await page.setViewportSize({ width: 1280, height: 1000 });
		await page.goto(STORY_URL);
		await page.getByRole("button", { name: "Select Release Desk" }).click();
		await page
			.getByRole("checkbox", { name: "I reviewed Release Desk" })
			.click();
		await page
			.getByRole("button", { name: "Change how Release Desk works" })
			.click();
		const identityCards = page.getByRole("radiogroup", {
			name: "How should Release Desk work?",
		});
		await expect(identityCards.getByRole("radio")).toHaveCount(3);
		await identityCards.getByText("Its own identity", { exact: true }).click();
		await page
			.getByRole("button", { name: "Done choosing how Release Desk works" })
			.click();
		await expect(identityCards).toHaveCount(0);
		await expect(
			page
				.getByTestId("agent-suggestion-identity-agent-suggestion-release-desk")
				.getByText("Its own identity", { exact: true })
		).toBeVisible();
		// The unselected draft keeps its own identity behind its Details toggle.
		await page
			.getByTestId("agent-suggestion-agent-suggestion-inbox-triage")
			.getByRole("button", { name: "Details" })
			.click();
		await expect(
			page
				.getByTestId("agent-suggestion-identity-agent-suggestion-inbox-triage")
				.getByText("Acts as you", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Add 1 agent" })
		).toBeVisible();
		await page.getByRole("button", { name: "Add 1 agent" }).click();
		await expect(page.getByText("Agent added", { exact: true })).toBeVisible();
		await expect(
			page.getByText("Release Desk is ready for your next task.", {
				exact: true,
			})
		).toBeVisible();
		await expect(page.getByText("Agents added", { exact: true })).toHaveCount(
			0
		);
		const createdIdentityModes = await page.evaluate(
			() =>
				/* SAFETY: onboarding-agent-suggestions-proof.tsx sets this when Add is clicked. */ (
					window as Window & {
						__agentSuggestionsProof?: Record<string, string>;
					}
				).__agentSuggestionsProof
		);
		expect(createdIdentityModes).toEqual({ "Release Desk": "individual" });
		await expect(
			page.getByRole("heading", { name: "Suggested agents for your work" })
		).toHaveCSS("filter", "none");
		await mkdir(PROOF_DIR, { recursive: true });
		await page.screenshot({ path: PROOF_SCREENSHOT, fullPage: true });
		await writeFile(
			PROOF_LOG,
			JSON.stringify(
				{
					consoleErrors,
					failedRequests,
					createdAgents: ["Release Desk"],
					identityModes: createdIdentityModes,
					selection: ["Release Desk"],
					safetyProfile: "Trial/read-only",
				},
				null,
				2
			)
		);
		expect(consoleErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
	});
});
