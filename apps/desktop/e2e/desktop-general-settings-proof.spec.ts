import { expect, test } from "@playwright/test";

const STORY_URL = "/desktop-general-settings-proof.html";
const ROOT_PROOF_SCREENSHOT =
	"e2e/artifacts/desktop-general-settings-root-proof.png";
const TERMINAL_PROOF_SCREENSHOT =
	"e2e/artifacts/desktop-general-settings-terminal-proof.png";
const PROOF_SCREENSHOT = "e2e/artifacts/desktop-general-settings-proof.png";

test.describe.configure({ timeout: 120_000 });

test("renders and persists the Desktop General settings surface", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			browserErrors.push(message.text());
		}
	});
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await expect(
		page.getByTestId("desktop-general-settings-proof")
	).toBeVisible();

	await expect(
		page.getByText("Projectless task folder", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Not set", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Change projectless task folder" })
	).toBeVisible();
	await page.screenshot({ fullPage: true, path: ROOT_PROOF_SCREENSHOT });

	await page.getByText("Tabs & panes", { exact: true }).click();
	const bottomPanel = page.locator(
		'[data-setting-id="general.interface.bottom-panel"] [data-slot="switch"]'
	);
	await expect(bottomPanel).toBeChecked();
	await bottomPanel.click();
	await expect(bottomPanel).not.toBeChecked();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:show-bottom-panel-toggle"))
	).resolves.toBe("false");

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Language", { exact: true }).click();
	const languageSelect = page.locator(
		'[data-setting-id="general.language"] [data-slot="select-trigger"]'
	);
	await expect(languageSelect.locator('[data-slot="select-value"]')).toHaveText(
		"Auto detect"
	);
	await languageSelect.click();
	await page.getByRole("option", { name: "English", exact: true }).click();
	await expect(languageSelect.locator('[data-slot="select-value"]')).toHaveText(
		"English"
	);
	await languageSelect.click();
	await page.getByRole("option", { name: "Auto detect", exact: true }).click();
	await expect(languageSelect.locator('[data-slot="select-value"]')).toHaveText(
		"Auto detect"
	);
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:language-mode"))
	).resolves.toBe("auto");

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Terminal", { exact: true }).click();
	await page.getByRole("button", { name: "Right", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Right", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Bottom", exact: true })
	).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:terminal-panel-location"))
	).resolves.toBe("right");
	await page.screenshot({ fullPage: true, path: TERMINAL_PROOF_SCREENSHOT });

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Files", { exact: true }).click();
	await expect(
		page.getByText("Default file open destination", { exact: true })
	).toBeVisible();
	await expect(page.locator("#default-file-opener-select")).toBeVisible();

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("System & tray", { exact: true }).click();
	await expect(
		page.getByText("Show in menu bar", { exact: true })
	).toBeVisible();
	const showInMenuBar = page.locator(
		'[data-setting-id="general.system.show-in-menu-bar"] [data-slot="switch"]'
	);
	await expect(showInMenuBar).toBeChecked();
	await expect(
		page.getByText("Prevent sleep while running", { exact: true })
	).toBeVisible();
	const preventSleep = page.locator(
		'[data-setting-id="general.system.prevent-sleep-while-running"] [data-slot="switch"]'
	);
	await expect(preventSleep).toBeChecked();
	await preventSleep.click();
	await expect(preventSleep).not.toBeChecked();

	await page.screenshot({
		fullPage: true,
		path: PROOF_SCREENSHOT,
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});
