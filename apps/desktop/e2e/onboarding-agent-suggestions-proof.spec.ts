import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-agent-suggestions-proof.html";
const PROOF_DIR = "e2e/artifacts";
const PROOF_SCREENSHOT = "e2e/artifacts/onboarding-agent-suggestions-proof.png";
const PROOF_LOG = "e2e/artifacts/onboarding-agent-suggestions-proof.log.json";

test.describe("onboarding agent suggestions proof", () => {
	test("shows why, tools, and the prompt before selection", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(
			page.getByRole("heading", { name: "Suggested agents for your work" })
		).toBeVisible();
		await expect(
			page.getByText("Drafts from your work patterns")
		).toBeVisible();
		await expect(
			page.getByText("Release verification appeared repeatedly")
		).toBeVisible();
		await expect(
			page.getByText("Search past chats", { exact: true }).first()
		).toBeVisible();
		await expect(
			page.getByText("Search the web", { exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Select Release Desk" })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Select an agent" })
		).toBeDisabled();

		await page.getByText("View prompt setup", { exact: true }).first().click();
		await expect(page.getByTestId("suggested-prompt").first()).toContainText(
			"evidence-backed checklist"
		);
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
		await page.getByText("View prompt setup", { exact: true }).first().click();
		await expect(page.getByTestId("suggested-prompt").first()).toContainText(
			"evidence-backed checklist"
		);
		await page.getByRole("button", { name: "Select Release Desk" }).click();
		await expect(
			page.getByRole("button", { name: "Add 1 agent" })
		).toBeVisible();
		await page.getByRole("button", { name: "Add 1 agent" }).click();
		await expect(page.getByTestId("agent-suggestion-success")).toContainText(
			"Release Desk"
		);
		await expect(page.getByTestId("agent-suggestion-success")).toContainText(
			"Trial · read-only"
		);
		await expect(
			page.getByTestId("agent-suggestion-success")
		).not.toContainText("Inbox Triage");
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
