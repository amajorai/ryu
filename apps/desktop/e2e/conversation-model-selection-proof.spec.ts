import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("a provider/model marker loads for a second participant", async ({
	page,
}) => {
	test.setTimeout(120_000);

	await page.goto(
		"/conversation-model-selection-proof.html?participant=Owner",
		{
			timeout: 120_000,
			waitUntil: "domcontentloaded",
		}
	);
	await expect(page.getByTestId("current-selection")).toContainText(
		"No model has been recorded yet",
		{ timeout: 60_000 }
	);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await page.getByRole("button", { name: "Switch provider and model" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(
		page.getByText("Provider and model changed").first()
	).toBeVisible();
	await expect(
		page.getByText("OpenRouter · openai/gpt-5-mini").first()
	).toBeVisible();

	await page.goto(
		"/conversation-model-selection-proof.html?participant=Teammate",
		{ timeout: 120_000, waitUntil: "domcontentloaded" }
	);
	await expect(page.getByTestId("current-selection")).toContainText(
		"OpenRouter · openai/gpt-5-mini"
	);
	await expect(
		page.getByText("Provider and model changed").first()
	).toBeVisible();
	await expect(
		page.getByText("OpenRouter · openai/gpt-5-mini").first()
	).toBeVisible();

	const proofPath = path.resolve(
		process.cwd(),
		"../../docs/proof/conversation-model-selection/shared-model-marker.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({ fullPage: true, path: proofPath });
});
