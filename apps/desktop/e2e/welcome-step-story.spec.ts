import { expect, type Page, test } from "@playwright/test";

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
		// Skip and the language control are the only two controls.
		await expect(page.getByRole("button")).toHaveCount(2);
		await expect(
			page.getByRole("button", { name: "Skip the introduction" })
		).toBeVisible();
		await expect(page.getByTestId("onboarding-language-trigger")).toHaveText(
			"English"
		);
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

const LANGUAGE_MODE_KEY = "ryu:language-mode";

async function chooseLanguage(page: Page, name: string) {
	await page.getByTestId("onboarding-language-trigger").click();
	await page.getByRole("menuitemradio", { name, exact: true }).click();
	await expect(page.getByTestId("onboarding-language-menu")).toBeHidden();
}

async function languageBox(page: Page) {
	const box = await page
		.getByTestId("onboarding-language-trigger")
		.boundingBox();
	if (box === null) {
		throw new Error("The language control did not render.");
	}
	return box;
}

test.describe("onboarding welcome language control", () => {
	test("holds the welcome while its menu is open, and Escape closes it without skipping", async ({
		page,
	}) => {
		test.setTimeout(40_000);
		await page.goto(STORY_URL);
		const beat = page.getByTestId("onboarding-welcome-beat");
		const status = page.getByTestId("onboarding-status");
		await expect(beat).toHaveText("Hi, I'm Ryu.");

		await page.getByTestId("onboarding-language-trigger").click();
		const menu = page.getByTestId("onboarding-language-menu");
		await expect(menu).toBeVisible();
		// Following the system is the default, and says which language that is.
		await expect(
			menu.getByRole("menuitemradio", { name: /^Auto detect\s*English$/ })
		).toHaveAttribute("aria-checked", "true");
		// Only languages that apply at once: the 11 official ones and English.
		await expect(menu.getByRole("menuitemradio")).toHaveCount(13);

		// Longer than both beats together (5.4 s): the greeting must still be up.
		await page.waitForTimeout(6000);
		await expect(beat).toHaveText("Hi, I'm Ryu.");
		await expect(status).toHaveText("active");

		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(status).toHaveText("active");

		// The beat starts over, then the welcome runs to the end as before.
		await expect(beat).toContainText("Welcome to", { timeout: 5000 });
		await expect(status).toHaveText("completed", { timeout: 6000 });
	});

	test("a chosen language re-renders the welcome at once and is saved", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const beat = page.getByTestId("onboarding-welcome-beat");
		const trigger = page.getByTestId("onboarding-language-trigger");
		await expect(beat).toHaveText("Hi, I'm Ryu.");

		await chooseLanguage(page, "日本語");
		await expect(beat).toHaveText("こんにちは、Ryu です。");
		await expect(trigger).toHaveText("日本語");
		await expect(page.locator("html")).toHaveAttribute("lang", "ja");
		expect(
			await page.evaluate(
				(key) => [
					localStorage.getItem(key),
					localStorage.getItem("ryu:language-pack"),
				],
				LANGUAGE_MODE_KEY
			)
		).toEqual(["fixed", "official/ja"]);
		await expect(page.getByTestId("onboarding-status")).toHaveText("active");

		// The choice survives a reload, as it does from Settings.
		await page.reload();
		await expect(trigger).toHaveText("日本語");
		await expect(beat).toHaveText("こんにちは、Ryu です。");
	});

	test("Arabic flips the layout at once, and the control keeps clear of the window controls", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const width = page.viewportSize()?.width ?? 0;
		const skip = page.getByTestId("onboarding-welcome-skip");

		// This browser reports Windows: the caption buttons own the top right,
		// so the control sits beside them (the 12rem a top bar reserves).
		const ltr = await languageBox(page);
		expect(ltr.x + ltr.width).toBeLessThanOrEqual(width - 192);
		expect(ltr.x).toBeGreaterThan(width / 2);
		expect((await skip.boundingBox())?.x).toBeGreaterThan(width / 2);

		await chooseLanguage(page, "العربية");
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		// Right to left, the name is wrapped in bidi isolates (U+2068, U+2069).
		await expect(page.getByTestId("onboarding-welcome-beat")).toHaveText(
			/^مرحبًا، أنا [⁦-⁩]?Ryu[⁦-⁩]?\.$/
		);
		// Right to left the control is at the left edge, like Skip below it.
		const rtl = await languageBox(page);
		expect(rtl.x).toBeCloseTo(24, 0);
		expect((await skip.boundingBox())?.x).toBeCloseTo(24, 0);
	});

	test("in a browser, with no window controls, the control is in the corner", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}?surface=web`);
		const width = page.viewportSize()?.width ?? 0;
		const box = await languageBox(page);
		expect(box.x + box.width).toBeCloseTo(width - 24, 0);
		expect(box.y).toBeCloseTo(12, 0);
	});

	test("at phone width the languages open in a sheet and still apply", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`${STORY_URL}?surface=web`);
		await chooseLanguage(page, "Français");
		await expect(page.getByTestId("onboarding-welcome-beat")).toHaveText(
			"Bonjour, je suis Ryu."
		);
		await expect(page.getByTestId("onboarding-status")).toHaveText("active");
	});
});

test.describe("onboarding welcome language control on macOS", () => {
	test.use({
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
	});

	test("clears the traffic lights when the language reads right to left", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const width = page.viewportSize()?.width ?? 0;
		// Left to right the traffic lights are in the other corner.
		const ltr = await languageBox(page);
		expect(ltr.x + ltr.width).toBeCloseTo(width - 24, 0);

		await chooseLanguage(page, "العربية");
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		// The lights stay at the physical left, so the control starts after
		// the 6rem a top bar reserves for them.
		expect((await languageBox(page)).x).toBeCloseTo(96, 0);
	});
});
