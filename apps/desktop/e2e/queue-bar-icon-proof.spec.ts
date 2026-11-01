import { TaskAdd01Icon } from "@hugeicons/core-free-icons";
import { expect, test } from "@playwright/test";

const STORY_URL = "/queue-bar-icon-proof.html";

// Since bfdc154e42 (P3) the composer's icons are Hugeicons: the queue header's
// Lucide `list-end` became `TaskAdd01Icon`. Compare the rendered paths with the
// icon's own data so the proof still pins one specific glyph.
const EXPECTED_PATHS = TaskAdd01Icon.flatMap(([tag, attributes]) =>
	tag === "path" && typeof attributes.d === "string" ? [attributes.d] : []
);

test("uses the Hugeicons task-add icon for queued messages", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);

	await expect(
		page.getByText("Queued messages", { exact: true })
	).toBeVisible();
	await expect(page.locator('svg[class*="lucide"]')).toHaveCount(0);
	const icon = page
		.locator("svg")
		.filter({ has: page.locator(`path[d="${EXPECTED_PATHS[0]}"]`) });
	await expect(icon).toHaveCount(1);
	await expect(icon).toBeVisible();
	expect(
		await icon
			.locator("path")
			.evaluateAll((paths) => paths.map((path) => path.getAttribute("d")))
	).toEqual(EXPECTED_PATHS);

	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("queue-bar-task-add-proof.png"),
	});
});
