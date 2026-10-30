import { expect, test } from "@playwright/test";

const STORY_URL = "/onboarding-final-step-story.html";

test.describe("onboarding final steps", () => {
	test("keeps the three icon guidance items on their own first screen", async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ height: 900, width: 1280 });
		const documentResponse = await page.goto(STORY_URL);
		expect(documentResponse?.status()).toBe(200);

		await expect(page.getByTestId("onboarding-guidance-step")).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "A few things to know" })
		).toBeVisible();
		await expect(page.getByText("Can take actions for you")).toBeVisible();
		await expect(
			page.getByText("Can keep working in the background")
		).toBeVisible();
		await expect(page.getByText("You stay in control")).toBeVisible();
		await expect(page.getByRole("switch")).toHaveCount(0);
		await expect(page.getByText("How Ryu handles your data")).toHaveCount(0);
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.getByTestId("onboarding-guidance-continue")).toHaveText(
			"Continue to privacy"
		);
		await page.screenshot({
			animations: "disabled",
			path: testInfo.outputPath("onboarding-guidance-step.png"),
		});
	});

	test("continues to a separate privacy step with diagnostics off by default", async ({
		page,
	}, testInfo) => {
		await page.setViewportSize({ height: 900, width: 1280 });
		const documentResponse = await page.goto(STORY_URL);
		expect(documentResponse?.status()).toBe(200);

		await page.getByTestId("onboarding-guidance-continue").click();
		await expect(
			page.getByRole("heading", { name: "Your privacy choices" })
		).toBeVisible();
		await expect(page.getByTestId("onboarding-final-step")).toBeVisible();
		await expect(page.getByText("How Ryu handles your data")).toHaveCount(0);
		const privacyDetails = page.getByTestId("onboarding-privacy-details");
		const getStarted = page.getByTestId("onboarding-final-continue");
		await expect(privacyDetails).toBeVisible();
		await expect(page.getByRole("switch")).toHaveCount(4);
		await expect(getStarted).toHaveText("Get started");
		await expect(privacyDetails).toHaveClass(/hover:bg-muted/);
		await expect(privacyDetails).toHaveClass(/h-10/);
		await expect(getStarted).toHaveClass(/h-10/);

		const [detailsBounds, getStartedBounds] = await Promise.all([
			privacyDetails.evaluate((element) => {
				const { height, width, x, y } = element.getBoundingClientRect();
				return { height, width, x, y };
			}),
			getStarted.evaluate((element) => {
				const { height, x, y } = element.getBoundingClientRect();
				return { height, x, y };
			}),
		]);
		expect(detailsBounds.height).toBe(getStartedBounds.height);
		expect(detailsBounds.y).toBe(getStartedBounds.y);
		const buttonGap =
			getStartedBounds.x - (detailsBounds.x + detailsBounds.width);
		expect(buttonGap).toBeGreaterThan(0);
		expect(buttonGap).toBeLessThan(24);

		const diagnosticsSwitch = page.getByRole("switch").nth(3);
		await expect(diagnosticsSwitch).not.toBeChecked();
		const axiomDisclosure = page.getByText(
			/Ryu Cloud-enrolled nodes to Ryu Axiom/
		);
		await expect(axiomDisclosure).toBeVisible();
		await expect(axiomDisclosure).toBeInViewport();
		await expect(diagnosticsSwitch).toBeInViewport();
		await page.screenshot({
			animations: "disabled",
			path: testInfo.outputPath("onboarding-privacy-step.png"),
		});
	});

	test("allows a privacy choice and completes onboarding", async ({ page }) => {
		await page.goto(STORY_URL);
		await page.getByTestId("onboarding-guidance-continue").click();

		const analyticsSwitch = page.getByRole("switch").first();
		await expect(analyticsSwitch).toBeChecked();
		await analyticsSwitch.click();
		await expect(analyticsSwitch).not.toBeChecked();

		await page.getByTestId("onboarding-final-continue").click();
		await expect(page.getByTestId("onboarding-status")).toHaveText("completed");
	});
});
