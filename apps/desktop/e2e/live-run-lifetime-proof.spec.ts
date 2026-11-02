import { expect, test } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";

test("resumed run survives its former removal deadline without dropping other live cards", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/live-run-lifetime-proof.html");
	await expect(page.getByTestId("connections")).toHaveText("1");
	await expect(
		page.getByText("Download assets", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Build report", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Complete run", exact: true }).click();
	await expect(page.getByText("Build report", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Resume run", exact: true }).click();
	await expect(page.getByText("Build report", { exact: true })).toBeVisible();
	await page.waitForTimeout(8500);
	await expect(page.getByText("Build report", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Download assets", { exact: true })
	).toBeVisible();
	await page.getByText("Build report", { exact: true }).click();
	await expect(page.getByText("Running", { exact: true })).toBeVisible();
	await page.waitForTimeout(400);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: proofEvidencePath(
			"performance-sweep/live-run-lifetime-completed.png"
		),
		fullPage: true,
	});
});

test("contributed cards share their source and disappear when their declaration is removed", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/live-run-lifetime-proof.html?contributed=1");
	await expect(page.getByText("First activity", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Second activity", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("source-reads")).toHaveText("1");
	await page
		.getByRole("button", { name: "Remove first activity", exact: true })
		.click();
	await expect(page.getByText("First activity", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByText("Second activity", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Download assets", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("source-reads")).toHaveText("1");
	await page.getByText("Second activity", { exact: true }).click();
	await page.waitForTimeout(400);
	expect(errors).toEqual([]);
	await page.screenshot({
		path: proofEvidencePath("performance-sweep/contributed-live-completed.png"),
		fullPage: true,
	});
});
