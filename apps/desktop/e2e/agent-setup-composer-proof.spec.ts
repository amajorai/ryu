import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("agent setup merges Markdown instructions with the universal picker", async ({
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

	await page.goto("/agent-setup-composer-proof.html");
	await page.waitForLoadState("networkidle");
	await expect(page.getByTestId("agent-setup-composer")).toBeVisible();
	await expect(page.getByTestId("agent-setup-picker")).toBeVisible();
	await expect(page.getByTestId("selection-summary")).toContainText("acp:pi");

	const editor = page
		.getByTestId("agent-setup-composer")
		.locator("[contenteditable='true']")
		.first();
	await editor.click();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.type("# Updated agent\n\nUse Markdown and stay concise.");
	await expect(page.getByTestId("saved-state")).toContainText("Updated agent");

	await page.getByRole("button", { name: "Choose provider and model" }).click();
	await expect(page.getByText("OpenRouter", { exact: true })).toBeVisible();
	await page.getByText("OpenRouter", { exact: true }).click();
	await page.getByRole("option", { name: /Model openai\/gpt-5-mini/ }).click();
	await expect(
		page.getByRole("option", { name: "openai/gpt-5-mini" })
	).toBeVisible();
	await page.getByRole("option", { name: "openai/gpt-5-mini" }).click();
	await expect(page.getByTestId("saved-state")).toContainText(
		"openai/gpt-5-mini"
	);
	await expect(page.getByTestId("saved-state")).toContainText(
		'"modelEngine": "openrouter"'
	);

	await page
		.getByRole("button", { name: "Expand instructions editor" })
		.click();
	await expect(page.getByTestId("agent-setup-full-editor")).toBeVisible();
	await expect(
		page.getByTestId("agent-setup-full-editor").getByRole("button", {
			name: "Open editor tools",
		})
	).toBeVisible();
	await page.getByRole("button", { name: "Open editor tools" }).click();
	await expect(
		page.getByRole("button", { name: "Open Format tools" })
	).toBeVisible();
	await page.getByRole("button", { name: "Open Format tools" }).click();
	await expect(page.getByRole("button", { name: /Bold/ })).toBeVisible();
	await expect(
		page
			.getByTestId("agent-setup-full-editor")
			.locator("[contenteditable='true']")
	).toHaveCount(1);
	await expect(
		page.getByTestId("agent-setup-full-editor").getByRole("button", {
			name: /Done/i,
		})
	).toBeVisible();

	await page.screenshot({
		path: test.info().outputPath("agent-setup-composer-proof.png"),
		fullPage: true,
	});

	// The shared footer also owns the agent target. Exercise a second agent after
	// capturing the stable expanded-editor frame, so the proof covers both halves
	// without changing the product frame the user reviews.
	await page.getByRole("button", { name: /Done/i }).click();
	const settingsTrigger = page
		.getByTestId("agent-setup-composer")
		.getByRole("button", { name: /Chat settings/ });
	await settingsTrigger.click();
	await expect(
		page.getByRole("menuitem", { name: "Claude Code", exact: true })
	).toBeVisible();
	await page
		.getByRole("menuitem", { name: "Claude Code", exact: true })
		.click();
	await page
		.getByRole("menuitem", { name: "Use Claude Code", exact: true })
		.click();
	await expect(page.getByTestId("saved-state")).toContainText(
		'"engine": "claude"'
	);
	await writeFile(
		test.info().outputPath("agent-setup-composer-proof.log.json"),
		JSON.stringify({ consoleErrors, failedRequests }, null, 2)
	);

	expect(consoleErrors).toEqual([]);
	expect(failedRequests).toEqual([]);
});
