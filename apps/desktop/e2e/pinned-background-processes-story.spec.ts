import { expect, type Page, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/pinned-background-processes-story.html";

async function openBackgroundProcesses(page: Page) {
	await page.goto(STORY_URL);
	await page.waitForSelector("body[data-harness-ready='1']");
	const section = page.getByRole("button", {
		name: /^Background processes/,
	});
	await expect(section).toBeVisible();
	await section.click();
	return section;
}

test("keeps pinned-summary headers text-only", async ({ page }) => {
	await page.goto(STORY_URL);
	await page.waitForSelector("body[data-harness-ready='1']");

	await expect(page.getByRole("button", { name: "Environment" })).toBeVisible();
	await expect(
		page.locator('[data-slot="bouncy-accordion-item-icon"]')
	).toHaveCount(0);
	await expect(page.locator('[data-slot="cowork-section-count"]')).toHaveCount(
		1
	);
	await expect(
		page.getByRole("button", { name: /^Background processes 2/ })
	).toBeVisible();
});

test("lists every running background process in the pinned summary", async ({
	page,
}) => {
	const section = await openBackgroundProcesses(page);
	await expect(section).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByText("python3 -m http.server 5180")).toBeVisible();
	await expect(page.getByText("bun run dev:local")).toBeVisible();
	await expect(page.getByText("/workspace/demo", { exact: false })).toHaveCount(
		2
	);
});

test("reveals Stop on hover and sends the process stop request", async ({
	page,
}) => {
	await openBackgroundProcesses(page);
	const row = page
		.locator("div.group")
		.filter({ hasText: "python3 -m http.server 5180" })
		.first();
	const stop = row.getByRole("button", {
		name: "Stop python3 -m http.server 5180",
	});

	await expect(stop).toHaveCSS("opacity", "0");
	await row.hover();
	await expect
		.poll(async () =>
			Number(
				await stop.evaluate((element) => getComputedStyle(element).opacity)
			)
		)
		.toBeGreaterThan(0);
	await stop.click();

	await expect
		.poll(() =>
			page.evaluate(
				() =>
					(
						window as Window & {
							__backgroundFixture?: { stopRequests: string[] };
						}
					).__backgroundFixture?.stopRequests.join(",") ?? ""
			)
		)
		.toBe("fixture:preview");
	await expect(page.getByText("python3 -m http.server 5180")).not.toBeVisible();
	await expect(page.getByText("bun run dev:local")).toBeVisible();
});
