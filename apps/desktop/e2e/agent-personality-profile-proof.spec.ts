import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("assigns and saves a personality profile on one agent", async ({
	page,
}) => {
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") {
			consoleErrors.push(message.text());
		}
	});
	page.on("pageerror", (error) => consoleErrors.push(String(error)));
	page.on("requestfailed", (request) => {
		failedRequests.push(
			`${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`
		);
	});

	await page.goto("/agent-personality-profile-proof.html");
	await expect(
		page.getByText("Personality & tone", { exact: true })
	).toBeVisible();
	await expect(page.locator("#agent-personality-profile")).toBeVisible();

	await page.locator("#agent-personality-profile").click();
	await expect(
		page.getByRole("option", { name: "Concise", exact: true })
	).toBeVisible();
	await page.getByRole("option", { name: "Concise", exact: true }).click();
	await page.locator("#agent-personality-profile").press("Escape");
	await expect(page.locator("#agent-personality-profile")).toContainText(
		"Concise"
	);

	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByTestId("saved-profile")).toHaveText("Concise");
	await page
		.getByRole("heading", { name: "Agent personality profiles" })
		.click();

	await page.screenshot({
		path: test.info().outputPath("agent-personality-profile-proof.png"),
		fullPage: true,
	});
	await writeFile(
		test.info().outputPath("agent-personality-profile-proof.log.json"),
		JSON.stringify({ consoleErrors, failedRequests }, null, 2)
	);

	expect(consoleErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
});
