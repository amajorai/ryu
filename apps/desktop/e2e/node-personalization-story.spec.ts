import { expect, test } from "@playwright/test";

const STORY_URL = "/node-personalization-story.html";

test.describe("node personalization onboarding", () => {
	test("keeps personal details and team knowledge visibly separate", async ({
		page,
	}) => {
		await page.setViewportSize({ height: 1000, width: 1280 });
		await page.goto(STORY_URL);
		await expect(
			page.getByRole("heading", { name: "How will you use this node?" })
		).toBeVisible();
		await expect(page.getByText("Personal use", { exact: true })).toBeVisible();
		await expect(
			page.getByText("Team or company use", { exact: true })
		).toBeVisible();
		await expect(
			page.getByText("Keep personal details private to this node.", {
				exact: true,
			})
		).toBeVisible();
		await expect(
			page.getByText("Build shared company knowledge for this node.", {
				exact: true,
			})
		).toBeVisible();
		await expect(
			page.getByLabel("More information about your company")
		).toBeVisible();
		await expect(
			page.getByText("Build shared company knowledge next", { exact: true })
		).toHaveCount(0);
		await expect(
			page
				.getByTestId("onboarding-node-setup")
				.locator('[data-slot="card-footer"]')
		).not.toHaveClass(/(?:^| )border-t(?: |$)/);
		const personalRadio = await page
			.getByRole("radio", { name: "Personal use" })
			.boundingBox();
		const teamRadio = await page
			.getByRole("radio", { name: "Team or company use" })
			.boundingBox();
		expect(personalRadio).not.toBeNull();
		expect(teamRadio).not.toBeNull();
		expect(
			Math.abs((personalRadio?.y ?? 0) - (teamRadio?.y ?? 0))
		).toBeLessThan(2);

		await page
			.getByLabel("More information about your company")
			.fill("We build reviewable finance tools for operations teams.");
		await page.getByRole("radio", { name: "Personal use" }).click();
		await expect(page.getByLabel("More information about you")).toBeVisible();
		await expect(
			page.getByLabel("More information about your company")
		).toHaveCount(0);

		await page.getByRole("radio", { name: "Team or company use" }).click();
		await expect(
			page.getByLabel("More information about your company")
		).toBeVisible();
		await page
			.getByLabel("More information about your company")
			.fill("We build reviewable finance tools for operations teams.");
		await page.getByRole("button", { name: "Continue" }).click();
		await expect(page.getByTestId("node-personalization-status")).toHaveText(
			"saved: team"
		);
		await page.locator(".scroll-fade").evaluate((element) => {
			element.scrollTop = 0;
		});

		await page.screenshot({
			animations: "disabled",
			fullPage: true,
			path: "e2e/artifacts/node-personalization-proof.png",
		});
	});
});
