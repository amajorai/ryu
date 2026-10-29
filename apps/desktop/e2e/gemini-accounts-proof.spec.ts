import path from "node:path";
import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

test("Fal provider keys support masked multiple accounts", async ({ page }) => {
	await page.goto("/gemini-accounts-proof.html?provider=fal", {
		waitUntil: "commit",
	});
	await expect(page.getByText("Account 2 · key hidden")).toBeVisible({
		timeout: 70_000,
	});
	await page.getByLabel("Fal API key").fill("third-fal-secret");
	await page.getByRole("button", { name: "Add account" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toBeVisible();
	await page.getByRole("button", { name: "Remove Fal account 1" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toHaveCount(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/fal-accounts/fal-accounts.png"
		),
		fullPage: true,
	});
});

test("Replicate provider keys support masked multiple accounts", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=replicate", {
		waitUntil: "commit",
	});
	await expect(page.getByText("Account 2 · key hidden")).toBeVisible({
		timeout: 70_000,
	});
	await page.getByLabel("Replicate API key").fill("third-replicate-secret");
	await page.getByRole("button", { name: "Add account" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toBeVisible();
	await page
		.getByRole("button", { name: "Remove Replicate account 1" })
		.click();
	await expect(page.getByText("Account 3 · key hidden")).toHaveCount(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/replicate-accounts/replicate-accounts.png"
		),
		fullPage: true,
	});
});

test("Modal provider keys support masked multiple accounts and removal", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=modal", {
		waitUntil: "commit",
	});
	await expect(page.getByText("Account 2 · key hidden")).toBeVisible({
		timeout: 70_000,
	});
	await page.getByLabel("Modal API key").fill("third-modal-secret");
	await page.getByRole("button", { name: "Add account" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toBeVisible();
	await page.getByRole("button", { name: "Remove Modal account 1" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toHaveCount(0);
	await expect(page.getByText("Account 2 · key hidden")).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/modal-accounts/modal-accounts.png"
		),
		fullPage: true,
	});
});

test("Gemini provider keys show multiple accounts and support add and remove", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/gemini-accounts-proof.html", { waitUntil: "commit" });
	await expect(
		page.getByRole("heading", { name: "Upstream provider accounts" })
	).toBeVisible({ timeout: 70_000 });
	await expect(page.getByText("Account 1 · key hidden")).toBeVisible();
	await expect(page.getByText("Account 2 · key hidden")).toBeVisible();
	await page.getByLabel("Gemini API key").fill("third-secret");
	await page.getByRole("button", { name: "Add account" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toBeVisible();
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/gemini-accounts/gemini-accounts.png"
		),
		fullPage: true,
	});
	await page.getByRole("button", { name: "Remove Gemini account 1" }).click();
	await expect(page.getByText("Account 3 · key hidden")).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("Named accounts retain name, priority and disabled state on reload", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=fal&named", {
		waitUntil: "commit",
	});
	await page.getByLabel("Fal Account 2 name").fill("Backup images");
	await page.getByLabel("Fal Account 2 priority").fill("10");
	await page.getByRole("switch", { name: "Enable Fal Account 2" }).click();
	await page.getByRole("button", { name: "Save account" }).nth(1).click();
	await expect(page.getByLabel("Fal Backup images name")).toHaveValue(
		"Backup images"
	);
	await page.reload();
	await expect(page.getByLabel("Fal Backup images priority")).toHaveValue("10");
	await expect(
		page.getByRole("switch", { name: "Enable Fal Backup images" })
	).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: "Save account" }).nth(1)
	).toBeDisabled();
	await expect(page.getByText("first-secret")).toHaveCount(0);
	await expect(page.getByText("second-secret")).toHaveCount(0);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/named-provider-accounts/desktop.png"
		),
		fullPage: true,
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/named-provider-accounts/mobile.png"
		),
		fullPage: true,
	});
});

test("Recraft account controls show named image accounts", async ({ page }) => {
	await page.goto("/gemini-accounts-proof.html?provider=recraft&named", {
		waitUntil: "commit",
	});
	await expect(page.getByLabel("Recraft API key")).toBeVisible({
		timeout: 70_000,
	});
	await page.getByLabel("Recraft Account 1 name").fill("Design studio");
	await page.getByLabel("Recraft Account 1 priority").fill("5");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(page.getByLabel("Recraft Design studio priority")).toHaveValue(
		"5"
	);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/recraft-accounts/desktop.png"
		),
		fullPage: true,
	});
});

test("Live account save accepts applied settings without a Gateway restart", async ({
	page,
}) => {
	let sent: unknown;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/api/gateway/providers", async (route) => {
		sent = route.request().postDataJSON();
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				accountsApplied: true,
				gateway_restarted: false,
			}),
		});
	});
	await page.goto("/gemini-accounts-proof.html?provider=fal&named&live", {
		waitUntil: "commit",
	});
	await page.getByLabel("Fal Account 1 name").fill("Cache affinity");
	await page.getByLabel("Fal Account 1 priority").fill("10");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(page.getByLabel("Fal Cache affinity name")).toHaveValue(
		"Cache affinity"
	);
	expect(sent).toEqual({
		provider: "fal",
		account_action: "configure",
		accountId: "a".repeat(64),
		accountPolicy: { name: "Cache affinity", enabled: true, priority: 10 },
	});
	expect(errors).toEqual([]);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/live-account-settings/desktop.png"
		),
		fullPage: true,
	});
});

test("Stability accounts use the bundled SVGL mark", async ({ page }) => {
	await page.goto("/gemini-accounts-proof.html?provider=stability&named", {
		waitUntil: "commit",
	});
	await expect(page.getByLabel("Stability AI API key")).toBeVisible({
		timeout: 70_000,
	});
	const logo = page.locator('img[src="/logos/stability-ai.svg"]');
	await expect(logo).toBeVisible();
	await expect
		.poll(() =>
			logo.evaluate(
				(image) => image instanceof HTMLImageElement && image.naturalWidth > 0
			)
		)
		.toBe(true);
	await page.getByLabel("Stability AI Account 1 name").fill("Image account");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(page.getByLabel("Stability AI Image account name")).toHaveValue(
		"Image account"
	);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/stability-accounts/desktop.png"
		),
		fullPage: true,
	});
});

test("BFL accounts expose private named connection controls", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=bfl&named", {
		waitUntil: "commit",
	});
	await expect(page.getByLabel("Black Forest Labs API key")).toBeVisible({
		timeout: 70_000,
	});
	await page
		.getByLabel("Black Forest Labs Account 1 name")
		.fill("FLUX project");
	await page.getByLabel("Black Forest Labs Account 1 priority").fill("10");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(
		page.getByLabel("Black Forest Labs FLUX project priority")
	).toHaveValue("10");
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/bfl-accounts/desktop.png"
		),
		fullPage: true,
	});
});

test("MiniMax accounts expose private named connection controls", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=minimax&named", {
		waitUntil: "commit",
	});
	await expect(page.getByLabel("MiniMax API key")).toBeVisible({
		timeout: 70_000,
	});
	await page.getByLabel("MiniMax Account 1 name").fill("Image project");
	await page.getByLabel("MiniMax Account 1 priority").fill("10");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(page.getByLabel("MiniMax Image project priority")).toHaveValue(
		"10"
	);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/minimax-accounts/desktop.png"
		),
		fullPage: true,
	});
});

test("Runway accounts expose private named connection controls", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=runway&named", {
		waitUntil: "commit",
	});
	await expect(page.getByLabel("Runway API key")).toBeVisible({
		timeout: 70_000,
	});
	const logo = page.locator("img[src*=runway]");
	await expect(logo).toBeVisible();
	await expect
		.poll(() =>
			logo.evaluate(
				(image: HTMLImageElement) => image.complete && image.naturalWidth > 0
			)
		)
		.toBe(true);
	await page.getByLabel("Runway Account 1 name").fill("Image project");
	await page.getByLabel("Runway Account 1 priority").fill("10");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(page.getByLabel("Runway Image project priority")).toHaveValue(
		"10"
	);
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/runway-accounts/desktop.png"
		),
		fullPage: true,
	});
});

test("Topaz accounts expose private named video connection controls", async ({
	page,
}) => {
	await page.goto("/gemini-accounts-proof.html?provider=topaz&named", {
		waitUntil: "commit",
	});
	await expect(page.getByLabel("Topaz Labs API key")).toBeVisible({
		timeout: 70_000,
	});
	await page
		.getByLabel("Topaz Labs Account 1 name")
		.fill("Enhancement project");
	await page.getByLabel("Topaz Labs Account 1 priority").fill("10");
	await page.getByRole("button", { name: "Save account" }).first().click();
	await expect(
		page.getByLabel("Topaz Labs Enhancement project priority")
	).toHaveValue("10");
	await page.screenshot({
		path: path.resolve(
			import.meta.dirname,
			"../../../docs/proof/topaz-accounts/desktop.png"
		),
		fullPage: true,
	});
});
