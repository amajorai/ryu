import { expect, test } from "@playwright/test";

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

		const boxes = await Promise.all(
			[cloud, local, existing].map((card) => card.boundingBox())
		);
		expect(boxes.every((box) => box !== null)).toBe(true);
		expect(boxes[0]?.y).toBe(boxes[1]?.y);
		expect(boxes[1]?.y).toBe(boxes[2]?.y);
		expect(boxes[0]?.height).toBe(boxes[1]?.height);
		expect(boxes[1]?.height).toBe(boxes[2]?.height);
	});
});
