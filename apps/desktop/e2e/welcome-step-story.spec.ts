import { expect, test } from "@playwright/test";

const STORY_URL = "/welcome-step-story.html";

test.describe("onboarding welcome step", () => {
	test("serves the entrypoint and every declared asset", async ({ page }) => {
		const documentResponse = await page.goto(STORY_URL);
		expect(documentResponse?.status()).toBe(200);

		const assetUrls = await page
			.locator("script[src], link[rel='stylesheet']")
			.evaluateAll((elements) =>
				elements
					.map(
						(element) =>
							element.getAttribute("src") ?? element.getAttribute("href")
					)
					.filter((url): url is string => Boolean(url))
			);

		expect(assetUrls.length).toBeGreaterThan(0);
		for (const assetUrl of assetUrls) {
			const assetStatus = await page.evaluate(async (url) => {
				const response = await fetch(url);
				return response.status;
			}, assetUrl);
			expect(assetStatus, `${assetUrl} should be served`).toBe(200);
		}
	});

	test("fades from the greeting into the welcome, then advances", async ({
		page,
	}) => {
		test.setTimeout(30_000);
		await page.goto(STORY_URL);

		const heading = page.getByRole("heading");
		await expect(heading).toHaveText("Hi, I'm Ryu.");
		await expect(page.getByRole("button")).toHaveCount(1);
		await expect(
			page.getByRole("button", { name: "Skip the introduction" })
		).toBeVisible();
		await expect(heading).toContainText("Welcome to", { timeout: 5000 });
		await expect(page.getByTestId("onboarding-status")).toHaveText(
			"completed",
			{ timeout: 6000 }
		);
	});

	test("skips the intro from the button and from the keyboard", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		await expect(page.getByTestId("onboarding-status")).toHaveText("active");
		await page.getByRole("button", { name: "Skip the introduction" }).click();
		await expect(page.getByTestId("onboarding-status")).toHaveText("completed");

		await page.goto(STORY_URL);
		await expect(page.getByTestId("onboarding-status")).toHaveText("active");
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("onboarding-status")).toHaveText("completed");
	});

	test("shows only the welcome line when reduced motion is on", async ({
		page,
	}) => {
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto(STORY_URL);
		await expect(page.getByTestId("onboarding-welcome-beat")).toHaveAttribute(
			"data-beat",
			"welcome"
		);
		await expect(page.getByTestId("onboarding-status")).toHaveText(
			"completed",
			{ timeout: 6000 }
		);
	});

	test("renders the dark triangle prism backdrop", async ({ page }) => {
		await page.goto(`${STORY_URL}?theme=dark`);
		const prism = page.getByTestId("onboarding-prism-background");
		await expect(prism).toHaveAttribute("data-variant", "triangle-prism");
		await expect(prism.locator("canvas")).toHaveCount(1);
		const box = await prism.locator("canvas").boundingBox();
		expect(box?.width ?? 0).toBeGreaterThan(0);
		expect(box?.height ?? 0).toBeGreaterThan(0);
		await page.screenshot({
			path: "e2e/artifacts/onboarding-triangle-prism-proof.png",
			animations: "disabled",
		});
	});

	test("renders the Prism background behind the onboarding welcome", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const prism = page.getByTestId("onboarding-prism-background");
		await expect(prism.locator("canvas")).toHaveCount(1);
		await expect(page.getByRole("heading")).toHaveText("Hi, I'm Ryu.");
		await page.evaluate(
			() =>
				new Promise<void>((resolve) => {
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				})
		);
		const fallbackBackground = await prism
			.locator("canvas")
			.evaluate((canvas) =>
				canvas.parentElement
					? getComputedStyle(canvas.parentElement).backgroundImage
					: ""
			);
		expect(fallbackBackground).toContain("radial-gradient");
		await page.screenshot({
			path: "e2e/artifacts/onboarding-prism-background-proof.png",
			animations: "disabled",
		});
	});

	test("resumes the saved permission step after the app is reopened", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?resume-proof=1`);
		await expect(page.getByTestId("onboarding-phase")).toHaveText("intro");

		await page
			.getByRole("button", { name: "Simulate macOS permission handoff" })
			.evaluate((button) => {
				if (!(button instanceof HTMLButtonElement)) {
					throw new Error("Expected proof element to be an HTMLButtonElement.");
				}
				return button.click();
			});
		await expect(page.getByTestId("onboarding-phase")).toHaveText("mic");

		await page.reload();
		await expect(page.getByTestId("onboarding-phase")).toHaveText("mic");
	});
});
