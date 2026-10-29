import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const STORY_URL = "/provider-account-switch-proof.html";

test("renders account-target callbacks and the supplied admin-disabled Gateway option", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	await page.getByTestId("provider-account-trigger").click();

	await expect(page.getByText("ada@acme.example")).toBeVisible();
	await expect(page.getByText("grace@acme.example")).toBeVisible();
	await expect(page.getByText("Team OpenRouter")).toBeVisible();
	await expect(page.getByText("Lab OpenRouter")).toBeVisible();
	await expect(page.getByText("Member OpenAI")).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("provider-account-switch-root-proof.png"),
		fullPage: true,
	});

	await page.getByRole("option", { name: /Lab OpenRouter/ }).click();
	await expect(
		page.getByRole("option", { name: "Use for yourself" })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Set for Gateway" })
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("provider-account-switch-admin-target-proof.png"),
		fullPage: true,
	});
	await page.getByRole("option", { name: "Set for Gateway" }).click();
	await expect(page.getByTestId("last-action")).toHaveText(
		"Gateway: Lab OpenRouter"
	);

	await page.getByTestId("provider-account-trigger").click();
	await page.getByRole("option", { name: /grace@acme.example/ }).click();
	await expect(
		page.getByRole("option", { name: "Use for yourself" })
	).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Set for Gateway" })
	).toHaveCount(0);
	await page.getByRole("option", { name: "Use for yourself" }).click();
	await expect(page.getByTestId("last-action")).toHaveText(
		"You: grace@acme.example"
	);

	await page.getByTestId("provider-account-trigger").click();
	await page.getByRole("option", { name: /Member OpenAI/ }).click();
	const lockedGateway = page.getByRole("option", {
		name: "Set for Gateway (admin only)",
	});
	await expect(lockedGateway).toBeVisible();
	await expect(lockedGateway).toHaveAttribute("data-disabled", "true");
	await page.screenshot({
		path: testInfo.outputPath("provider-account-switch-target-proof.png"),
		fullPage: true,
	});
});

test("renders rename callbacks and retains fixture labels while reopening the picker", async ({
	page,
}, testInfo) => {
	await page.goto(STORY_URL);
	await page.getByTestId("provider-account-trigger").click();

	await page
		.getByRole("button", { name: "Rename account ada@acme.example" })
		.click();
	await page
		.getByRole("textbox", { name: "Label for ada@acme.example" })
		.fill("Work Claude");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("option", { name: /Work Claude/ })).toBeVisible();
	await expect(page.getByTestId("last-action")).toHaveText(
		"Renamed: Work Claude"
	);

	await page
		.getByRole("button", { name: "Rename account grace@acme.example" })
		.click();
	await page
		.getByRole("textbox", { name: "Label for grace@acme.example" })
		.fill("Personal Claude");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(
		page.getByRole("option", { name: "Personal Claude" })
	).toBeVisible();

	await page.keyboard.press("Escape");
	await page.getByTestId("provider-account-trigger").click();
	await expect(page.getByRole("option", { name: /Work Claude/ })).toBeVisible();
	await expect(
		page.getByRole("option", { name: "Personal Claude" })
	).toBeVisible();
	await page.screenshot({
		path: testInfo.outputPath("provider-account-labels-proof.png"),
		fullPage: true,
	});
});
