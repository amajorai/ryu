import { expect, type Locator, type Page, test } from "@playwright/test";

const STORY_URL = "/onboarding-choose-story.html?choose-only";

test.describe("onboarding choose step — game-lobby runtime choices", () => {
	test("shows three simple, equal choices without technical jargon", async ({
		page,
	}) => {
		await page.goto(STORY_URL);
		const column = page.getByTestId("column-light");
		const cloud = column.getByTestId("onboarding-cloud-choice");
		const local = column.getByTestId("onboarding-local-choice");
		const existing = column.getByTestId("onboarding-existing-node-choice");

		await expect(
			column.getByText("Where should Ryu do the work?", { exact: true })
		).toBeVisible();
		await expect(
			cloud.getByRole("heading", { name: "Let Ryu handle it", exact: true })
		).toBeVisible();
		await expect(
			cloud.getByText("See team plans", { exact: true })
		).toBeVisible();

		await expect(
			local.getByRole("heading", { name: "Set it up yourself", exact: true })
		).toBeVisible();
		await expect(
			local.getByText(
				"Private and offline. You manage downloads, updates, and performance.",
				{ exact: true }
			)
		).toBeVisible();
		await expect(
			existing.getByRole("heading", {
				name: "Bring your own server",
				exact: true,
			})
		).toBeVisible();
		await expect(
			existing.getByText(
				"Connect to a server your team runs. Your team handles updates and access.",
				{ exact: true }
			)
		).toBeVisible();
		await expect(column.getByText(/managed path/i)).toHaveCount(0);
		await expect(
			column.getByText("Recommended for teams", { exact: true })
		).toHaveCount(0);

		// Each story column is half the viewport, so the step's own container is
		// under the 42rem row threshold: the cards stack at full width even though
		// the viewport is wide enough for a viewport breakpoint to put them in a row.
		const boxes = await cardBoxes(page.getByTestId("column-light"));
		expect(boxes[0].x).toBe(boxes[1].x);
		expect(boxes[1].x).toBe(boxes[2].x);
		expect(boxes[0].width).toBe(boxes[1].width);
		expect(boxes[1].width).toBe(boxes[2].width);
		expect(boxes[0].y + boxes[0].height).toBeLessThan(boxes[1].y);
		expect(boxes[1].y + boxes[1].height).toBeLessThan(boxes[2].y);
	});

	test("puts the three cards in one equal row when the column has room", async ({
		page,
	}) => {
		await page.goto(`${STORY_URL}&single`);
		const boxes = await cardBoxes(page.getByTestId("column-dark"));
		expect(boxes[0].y).toBe(boxes[1].y);
		expect(boxes[1].y).toBe(boxes[2].y);
		expect(boxes[0].height).toBe(boxes[1].height);
		expect(boxes[1].height).toBe(boxes[2].height);
		expect(boxes[0].x + boxes[0].width).toBeLessThan(boxes[1].x);
		expect(boxes[1].x + boxes[1].width).toBeLessThan(boxes[2].x);
	});
});

test.describe("onboarding choose step: language control", () => {
	const LANGUAGE_URL = "/onboarding-choose-story.html?language&surface=web";

	test("a language chosen here re-renders the step, and Arabic flips it", async ({
		page,
	}) => {
		await page.goto(LANGUAGE_URL);
		const trigger = page.getByTestId("onboarding-language-trigger");
		// The step title is not asserted here: the shared shell morphs it in word
		// segments, which translate one by one. A card heading is plain text.
		const localHeading = (name: string) =>
			page
				.getByTestId("onboarding-local-choice")
				.getByRole("heading", { name, exact: true });
		await expect(trigger).toHaveText("English");
		await expect(localHeading("Set it up yourself")).toBeVisible();
		const width = page.viewportSize()?.width ?? 0;
		const ltr = await requiredBox(trigger);
		expect(ltr.x + ltr.width).toBeCloseTo(width - 24, 0);

		await chooseLanguage(page, "日本語");
		await expect(trigger).toHaveText("日本語");
		await expect(localHeading("自分でセットアップ")).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("lang", "ja");

		await chooseLanguage(page, "العربية");
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(localHeading("إعداده بنفسك")).toBeVisible();
		expect((await requiredBox(trigger)).x).toBeCloseTo(24, 0);

		// Back to following the system, which is English in this browser.
		await trigger.click();
		await page.getByRole("menuitemradio").first().click();
		await expect(localHeading("Set it up yourself")).toBeVisible();
		await expect(trigger).toHaveText("English");
		expect(
			await page.evaluate(() => [
				localStorage.getItem("ryu:language-mode"),
				localStorage.getItem("ryu:language-pack"),
			])
		).toEqual(["auto", null]);
	});

	for (const viewport of [
		{ name: "desktop", width: 1280, height: 720 },
		{ name: "phone", width: 390, height: 844 },
	]) {
		test(`the control covers none of the step at ${viewport.name} width`, async ({
			page,
		}) => {
			await page.setViewportSize(viewport);
			await page.goto(LANGUAGE_URL);
			const control = await requiredBox(
				page.getByTestId("onboarding-language-trigger")
			);
			const frame = page.getByTestId("choose-with-language");
			for (const part of [
				frame.getByRole("heading", { level: 1 }),
				frame.getByTestId("onboarding-cloud-choice"),
			]) {
				const box = await requiredBox(part);
				const apart =
					box.x >= control.x + control.width ||
					box.x + box.width <= control.x ||
					box.y >= control.y + control.height ||
					box.y + box.height <= control.y;
				expect(apart, `${JSON.stringify(box)} is under the control`).toBe(true);
			}
		});
	}

	test("the desktop window keeps it beside the caption buttons", async ({
		page,
	}) => {
		await page.goto("/onboarding-choose-story.html?language");
		const width = page.viewportSize()?.width ?? 0;
		const box = await requiredBox(
			page.getByTestId("onboarding-language-trigger")
		);
		// This browser reports Windows: a top bar reserves 12rem at the right.
		expect(box.x + box.width).toBeLessThanOrEqual(width - 192);
	});
});

async function chooseLanguage(page: Page, name: string) {
	await page.getByTestId("onboarding-language-trigger").click();
	await page.getByRole("menuitemradio", { name, exact: true }).click();
	await expect(page.getByTestId("onboarding-language-menu")).toBeHidden();
}

async function requiredBox(locator: Locator) {
	const box = await locator.boundingBox();
	if (box === null) {
		throw new Error("An element of the choose step did not render.");
	}
	return box;
}

async function cardBoxes(column: Locator) {
	const boxes = await Promise.all(
		[
			"onboarding-cloud-choice",
			"onboarding-local-choice",
			"onboarding-existing-node-choice",
		].map((testId) => column.getByTestId(testId).boundingBox())
	);
	return boxes.map((box) => {
		if (box === null) {
			throw new Error("A choice card did not render.");
		}
		return box;
	});
}
