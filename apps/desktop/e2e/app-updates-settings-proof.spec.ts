import { expect, test } from "@playwright/test";

const STORY_URL = "/app-updates-settings-proof.html";

test.describe.configure({ timeout: 60_000 });

const browserErrors = new WeakMap<import("@playwright/test").Page, string[]>();
test.beforeEach(({ page }) => {
	const errors: string[] = [];
	browserErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(async ({ page }) => {
	expect(browserErrors.get(page) ?? []).toEqual([]);
	expect(await page.evaluate(() => window.__appUpdateUnknownCommands)).toEqual(
		[]
	);
});

test("saves automatic downloads and checks the selected release channel", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(STORY_URL);
	await expect(page.getByTestId("app-updates-settings-proof")).toBeVisible();

	const automaticDownload = page.getByRole("switch", {
		name: "Download app updates automatically",
	});
	await expect(automaticDownload).toBeChecked();
	await automaticDownload.click();
	await expect(automaticDownload).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.__appUpdateIpcCommands.includes(
					"set_app_update_download_preference"
				)
			)
		)
		.toBe(true);

	expect(await page.evaluate(() => window.__appUpdateUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(automaticDownload).not.toBeChecked();
	await page.getByRole("button", { name: "Check for updates" }).click();
	await expect(
		page.getByText("Ryu is up to date", { exact: true })
	).toBeVisible();

	const channel = page.locator("#release-channel-select");
	await channel.click();
	await page.getByRole("option", { name: "Beta", exact: true }).click();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:release-channel"))
	).resolves.toBe("beta");
	await page.getByRole("button", { name: "Check for updates" }).click();
	await expect
		.poll(() => page.evaluate(() => window.__appUpdateCheckUrls.length))
		.toBe(2);
	await expect(
		page.evaluate(() => window.__appUpdateCheckUrls.at(-1))
	).resolves.toContain("channel=beta");
});

test("books and cancels an available update and surfaces check failures", async ({
	page,
}, testInfo) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(`${STORY_URL}?scenario=available`);
	await page.getByRole("button", { name: "Check for updates" }).click();
	await page
		.getByRole("button", { name: "Install later", exact: true })
		.click();
	await expect(
		page
			.getByTestId("app-updates-settings-proof")
			.getByText(/v1\.1\.0 will install the next time you open Ryu/)
	).toBeVisible();
	await expect
		.poll(() =>
			page.evaluate(() =>
				window.__appUpdateIpcCommands.includes("set_pending_app_update")
			)
		)
		.toBe(true);
	await page.waitForTimeout(700);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("desktop-app-updates-proof.png"),
	});
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(
		page
			.getByTestId("app-updates-settings-proof")
			.getByText(/v1\.1\.0 will install the next time you open Ryu/)
	).not.toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.__pendingAppUpdate))
		.toBeNull();

	await page.goto(`${STORY_URL}?scenario=check-error`);
	await page.getByRole("button", { name: "Check for updates" }).click();
	await expect(
		page.getByText("Couldn't check for updates", { exact: true })
	).toBeVisible();
});

test("installs a verified prepared update only after the explicit action", async ({
	page,
}, testInfo) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(`${STORY_URL}?scenario=prepared`);
	await expect(
		page.getByText("v1.1.0 is downloaded and signature-verified.")
	).toBeVisible();
	const install = page.getByRole("button", {
		name: "Install and restart",
		exact: true,
	});
	await expect(install).toBeVisible();
	const updateActions = () =>
		page.evaluate(() =>
			window.__appUpdateIpcCommands.filter(
				(command) =>
					command === "install_prepared_app_update" ||
					command === "plugin:process|restart"
			)
		);
	await expect(updateActions()).resolves.toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: testInfo.outputPath("desktop-app-update-ready-proof.png"),
	});
	await install.click();
	await expect(
		page.getByText("Update installer finished", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Restarting Ryu to load the new release…", { exact: true })
	).toBeVisible();
	await expect(install).not.toBeVisible();
	await expect
		.poll(updateActions)
		.toEqual(["install_prepared_app_update", "plugin:process|restart"]);
});

test("Extend updates opens the Billing section from an expired-window notice", async ({
	page,
}, testInfo) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.goto(`${STORY_URL}?scenario=cutoff`);
	await page.getByRole("button", { name: "Check for updates" }).click();
	await expect(
		page.getByText("Ryu is up to date for your updates window", { exact: true })
	).toBeVisible();

	await page.getByRole("link", { name: "Extend updates", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(
		dialog.getByRole("heading", { name: "Billing", exact: true })
	).toBeVisible();
	await expect(
		dialog.getByRole("button", { name: "Billing", exact: true })
	).toHaveAttribute("data-active");
	await page.screenshot({
		path: testInfo.outputPath("desktop-extend-updates-billing.png"),
		fullPage: true,
	});
});

test("refused automatic-download writes restore the saved switch and explicit retry survives independent reload", async ({
	page,
}) => {
	await page.goto(STORY_URL);
	const toggle = page.getByRole("switch", {
		name: "Download app updates automatically",
	});
	await expect(toggle).toBeChecked();
	await page.evaluate(() =>
		window.__appUpdateFailures.push("set_app_update_download_preference")
	);
	await toggle.click();
	await expect(
		page.getByText("Could not save the automatic-download setting", {
			exact: true,
		})
	).toBeVisible();
	await expect(toggle).toBeChecked();
	expect(
		await page.evaluate(() => localStorage.getItem("proof:automatic-download"))
	).toBeNull();
	expect(
		await page.evaluate(() =>
			window.__appUpdateIpcCalls.filter(
				(c) => c.command === "set_app_update_download_preference"
			)
		)
	).toEqual([
		{
			command: "set_app_update_download_preference",
			args: { enabled: false },
			acknowledged: false,
		},
	]);
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect
		.poll(() =>
			page.evaluate(() => localStorage.getItem("proof:automatic-download"))
		)
		.toBe("false");
	expect(
		await page.evaluate(() =>
			window.__appUpdateIpcCalls.filter(
				(c) => c.command === "set_app_update_download_preference"
			)
		)
	).toEqual([
		{
			command: "set_app_update_download_preference",
			args: { enabled: false },
			acknowledged: false,
		},
		{
			command: "set_app_update_download_preference",
			args: { enabled: false },
			acknowledged: true,
		},
	]);
	expect(await page.evaluate(() => window.__appUpdateUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(toggle).not.toBeChecked();
});
