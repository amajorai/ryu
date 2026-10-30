import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("proves the managed Bot desktop shell keeps Build controls hidden", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto("/bot-product-shell-proof.html?reset=1");

	await expect(page.locator('[data-product="ryu-bot"]')).toBeVisible();
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Ryu", { exact: true })
	).toBeVisible();
	await expect(
		page.getByTestId("product-mode-lockup").getByText("Bot", { exact: true })
	).toBeVisible();
	await expect(page.getByTestId("bot-connection-status")).toContainText(
		"Connected"
	);
	await expect(page.getByTestId("bot-chat-header")).toContainText("Ryu");
	await expect(page.getByTestId("bot-chat-header-avatar")).toBeVisible();
	await expect(page.getByTestId("bot-chat-header-name")).toContainText("Ryu");
	await expect(page.getByTestId("bot-managed-default")).toHaveText(
		"Ryu-managed models"
	);
	await expect(
		page.getByText("Plan my weekend", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("menuitem", { name: "New section" })).toHaveCount(
		0
	);
	await expect(
		page.getByRole("menuitem", { name: "Import a past agent thread" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Agent, model and mode settings" })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Choose provider and model" })
	).toHaveCount(0);

	const composer = page.locator("textarea").first();
	await composer.fill("@");
	await expect(page.getByRole("listbox")).toHaveCount(0);
	await composer.fill("Hello from Bot");
	await composer.press("Enter");
	await expect(page.getByTestId("bot-sent-message")).toHaveText(
		"Hello from Bot"
	);

	await page.screenshot({
		path: test.info().outputPath("ryu-bot-product-proof.png"),
		fullPage: true,
	});
});

for (const { activity, label } of [
	{ activity: "thinking", label: "Thinking…" },
	{ activity: "working", label: "Searching the web…" },
	{ activity: "typing", label: "Typing…" },
]) {
	test(`shows the bot's live ${activity} state inside its name bubble`, async ({
		page,
	}) => {
		await page.setViewportSize({ height: 900, width: 1440 });
		await page.goto(
			`/bot-product-shell-proof.html?reset=1&activity=${activity}`
		);

		await expect(
			page
				.getByTestId("bot-chat-header-name")
				.getByTestId("bot-chat-header-status")
		).toHaveText(label);

		await page.getByTestId("bot-chat-header").screenshot({
			path: test.info().outputPath(`ryu-bot-header-${activity}.png`),
		});
	});
}

test("shows only the name in the bubble while the bot is idle", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto("/bot-product-shell-proof.html?reset=1");

	await expect(page.getByTestId("bot-chat-header-name")).toHaveText("Ryu");
	await expect(page.getByTestId("bot-chat-header-name")).toHaveAttribute(
		"data-state",
		"idle"
	);
	await expect(page.getByTestId("bot-chat-header-status")).toHaveCount(0);
});
