import { expect, type Locator, test } from "@playwright/test";

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
