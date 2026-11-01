import { expect, test } from "@playwright/test";
import {
	DEFAULT_PROJECTLESS_FOLDER,
	failGatewayRequest,
	gatewayCalls,
	PROOF_SCREENSHOT,
	proofCalls,
	ROOT_PROOF_SCREENSHOT,
	registerGeneralProofHooks,
	STORY_URL,
	TERMINAL_PROOF_SCREENSHOT,
} from "./desktop-general-settings-proof.helpers.ts";

registerGeneralProofHooks();

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
	await expect(
		page.getByText(DEFAULT_PROJECTLESS_FOLDER, {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Change projectless task folder" })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(ROOT_PROOF_SCREENSHOT),
	});

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
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(TERMINAL_PROOF_SCREENSHOT),
	});

	// Default terminal location: a location is always chosen, the segments work
	// by keyboard, another window's choice is adopted, and a reload reads the
	// saved location back.
	const terminalRight = page.getByRole("button", {
		name: "Right",
		exact: true,
	});
	const terminalBottom = page.getByRole("button", {
		name: "Bottom",
		exact: true,
	});
	const savedTerminalLocation = () =>
		page.evaluate(() => localStorage.getItem("ryu:terminal-panel-location"));
	await expect(
		page.getByRole("group", { name: "Default terminal location" })
	).toBeVisible();
	await terminalRight.click();
	await expect(terminalRight).toHaveAttribute("aria-pressed", "true");
	await expect(savedTerminalLocation()).resolves.toBe("right");
	await terminalRight.focus();
	await page.keyboard.press("ArrowLeft");
	await expect(terminalBottom).toBeFocused();
	await page.keyboard.press("Space");
	await expect(terminalBottom).toHaveAttribute("aria-pressed", "true");
	await expect(terminalRight).toHaveAttribute("aria-pressed", "false");
	await expect(savedTerminalLocation()).resolves.toBe("bottom");
	await page.keyboard.press("ArrowRight");
	await expect(terminalRight).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(terminalRight).toHaveAttribute("aria-pressed", "true");
	await expect(savedTerminalLocation()).resolves.toBe("right");
	const otherWindow = await page.context().newPage();
	await otherWindow.goto(new URL("/", page.url()).href);
	await otherWindow.evaluate(() =>
		localStorage.setItem("ryu:terminal-panel-location", "bottom")
	);
	await expect(terminalBottom).toHaveAttribute("aria-pressed", "true");
	await otherWindow.close();
	await terminalRight.click();
	await expect(savedTerminalLocation()).resolves.toBe("right");
	await page.reload();
	await expect(
		page.getByTestId("desktop-general-settings-proof")
	).toBeVisible();
	await page.getByText("Terminal", { exact: true }).click();
	await expect(terminalRight).toHaveAttribute("aria-pressed", "true");
	await expect(terminalBottom).toHaveAttribute("aria-pressed", "false");

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
	await expect(preventSleep).toHaveAttribute("data-checked", "");
	const checkedBackground = await preventSleep.evaluate(
		(element) => getComputedStyle(element).backgroundColor
	);
	await preventSleep.click();
	await expect(preventSleep).not.toBeChecked();
	await expect(preventSleep).toHaveAttribute("data-unchecked", "");
	await expect(preventSleep).not.toHaveAttribute("data-checked");
	await expect
		.poll(() =>
			preventSleep.evaluate(
				(element) => getComputedStyle(element).backgroundColor
			)
		)
		.not.toBe(checkedBackground);
	const keepAwakeWrites = (await gatewayCalls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/api/gateway/config"
	);
	expect(keepAwakeWrites).toEqual([
		{
			body: {
				acp: {
					idle_timeout_minutes: 10,
					keep_computer_awake: false,
					max_parallel_agents: null,
				},
			},
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);

	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath(PROOF_SCREENSHOT),
	});

	expect(browserErrors, `browser errors: ${browserErrors.join(" | ")}`).toEqual(
		[]
	);
});

test("keeps a Gateway setting unchanged and explains a failed save", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(`${STORY_URL}?scenario=save-error`);
	await page.getByText("System & tray", { exact: true }).click();

	const preventSleep = page.locator(
		'[data-setting-id="general.system.prevent-sleep-while-running"] [data-slot="switch"]'
	);
	await expect(preventSleep).toBeChecked();
	await preventSleep.click();
	await expect(
		page.getByText("Couldn't update the sleep prevention setting", {
			exact: true,
		})
	).toBeVisible();
	await expect(preventSleep).toBeChecked();
	await expect(preventSleep).toHaveAttribute("data-checked", "");
	await preventSleep.click();
	await expect(preventSleep).not.toBeChecked();
	const writes = (await gatewayCalls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/api/gateway/config"
	);
	expect(writes).toEqual([
		{
			body: {
				acp: {
					idle_timeout_minutes: 10,
					keep_computer_awake: false,
					max_parallel_agents: null,
				},
			},
			method: "PUT",
			path: "/api/gateway/config",
		},
		{
			body: {
				acp: {
					idle_timeout_minutes: 10,
					keep_computer_awake: false,
					max_parallel_agents: null,
				},
			},
			method: "PUT",
			path: "/api/gateway/config",
		},
	]);
});

test("does not arm Safe Mode when Core rejects a write; a successful retry persists and restarts through fixtures", async ({
	page,
}) => {
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);
	await page.getByText("Setup & recovery", { exact: true }).click();
	const safeMode = page.getByRole("switch").first();
	await expect(
		page.getByText(/Off\. Turning it on would start the node without/)
	).toBeVisible();
	await failGatewayRequest(
		page,
		"/api/safe-mode",
		"Fixture Safe Mode write failed"
	);

	await safeMode.click();
	await expect(page.getByText(/Fixture Safe Mode write failed/)).toBeVisible();
	await expect(safeMode).not.toBeChecked();
	const rejected = (await gatewayCalls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/api/safe-mode"
	);
	expect(rejected).toEqual([
		{ body: { enabled: true }, method: "PUT", path: "/api/safe-mode" },
	]);
	expect(
		(await proofCalls(page)).some(
			(call) =>
				call.command === "set_safe_mode_sentinel" ||
				call.command === "stop_ryu_core"
		)
	).toBe(false);

	await safeMode.click();
	await expect(safeMode).toBeChecked();
	await expect(page.getByText(/Active\. Holding back 3 apps/)).toBeVisible();
	const writes = (await gatewayCalls(page)).filter(
		(call) => call.method === "PUT" && call.path === "/api/safe-mode"
	);
	expect(writes).toEqual([
		{ body: { enabled: true }, method: "PUT", path: "/api/safe-mode" },
		{ body: { enabled: true }, method: "PUT", path: "/api/safe-mode" },
	]);
	const commands = (await proofCalls(page)).filter((call) =>
		["stop_ryu_core", "get_ryu_status", "start_ryu_core"].includes(call.command)
	);
	expect(commands.map((call) => call.command)).toEqual([
		"stop_ryu_core",
		"get_ryu_status",
		"start_ryu_core",
		"get_ryu_status",
	]);
	expect(
		(await proofCalls(page)).filter(
			(call) => call.command === "set_safe_mode_sentinel"
		)
	).toEqual([]);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-general-safe-mode-retry-proof.png"),
	});
});
