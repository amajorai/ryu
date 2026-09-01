import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-agent-suggestions-proof.html";
const PROOF_DIR = "e2e/artifacts";
const PROOF_SCREENSHOT = "e2e/artifacts/onboarding-agent-suggestions-proof.png";
const PROOF_LOG = "e2e/artifacts/onboarding-agent-suggestions-proof.log.json";

test.describe("onboarding agent suggestions proof", () => {
	test("shows the agent name, description, and connected apps", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(
			page.getByRole("heading", { name: "Suggested agents for your work" })
		).toBeVisible();
		await expect(
			page.getByText(
				"Keeps release checks together and turns them into a short brief."
			)
		).toBeVisible();
		await expect(page.getByText("Connected apps", { exact: true })).toHaveCount(
			0
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
				.locator('[data-expressive-eye-scale="1.55"]')
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

		await expect(page.getByText("Why this showed up")).toHaveCount(0);
		await expect(
			page.getByText("Search past chats", { exact: true })
		).toHaveCount(0);
		await expect(
			page.getByText("View prompt setup", { exact: true })
		).toHaveCount(0);
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
