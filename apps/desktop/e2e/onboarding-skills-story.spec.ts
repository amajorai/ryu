import path from "node:path";
import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-skills-story.html";
const PROOF_PATH = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/onboarding-skills/jakubkrehel-skills-pack.png"
);

test.describe("onboarding optional skill selection", () => {
	test("shows the recommended collections selected by default", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(page.getByText("Choose recommended skills")).toBeVisible();
		await expect(
			page.getByTestId("onboarding-skills-selected-count")
		).toHaveText("21 of 21 selected");
		await expect(
			page.getByRole("button", { name: "Select all", exact: true })
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Unselect all" })
		).toBeVisible();
		await expect(
			page.getByText(
				"Ryu's built-in skills and skills contributed by enabled Ryu plugins"
			)
		).toBeVisible();
		await expect(
			page.getByTestId("onboarding-skill-pack-wshobson-agents")
		).toHaveAttribute("aria-pressed", "true");
		await expect(
			page.getByTestId("onboarding-skill-pack-jakubkrehel-skills")
		).toHaveAttribute("aria-pressed", "true");
		await expect(
			page.getByText("Ryu Health Audit", { exact: true })
		).toHaveCount(0);
		await page.waitForTimeout(1500);
		await page.screenshot({ path: PROOF_PATH, fullPage: true });
	});

	test("select all and unselect all control the saved selection", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await page
			.getByRole("button", { name: "Unselect all", exact: true })
			.click();
		await expect(
			page.getByTestId("onboarding-skills-selected-count")
		).toHaveText("0 of 21 selected");
		await page.getByTestId("onboarding-skill-pack-wshobson-agents").click();
		await expect(
			page.getByTestId("onboarding-skills-selected-count")
		).toHaveText("1 of 21 selected");
		await page.getByRole("button", { name: "Select all", exact: true }).click();
		await expect(
			page.getByTestId("onboarding-skills-selected-count")
		).toHaveText("21 of 21 selected");
		await page.getByTestId("onboarding-skill-pack-wshobson-agents").click();
		await expect(
			page.getByTestId("onboarding-skills-selected-count")
		).toHaveText("20 of 21 selected");
		await page
			.getByRole("button", { name: "Install 20 packs & continue" })
			.click();
		await expect(page.getByTestId("skills-selection-saved")).toContainText(
			"20 optional collections selected"
		);
	});
});
