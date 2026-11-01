import { expect, test } from "@playwright/test";
import {
	DEFAULT_PROJECTLESS_FOLDER,
	evidencePath,
	failFolderDialog,
	failNativeCommand,
	gatewayCalls,
	proofCalls,
	registerGeneralProofHooks,
	STORY_URL,
	setFolderSelection,
	settingSwitch,
} from "./desktop-general-settings-proof.helpers.ts";

registerGeneralProofHooks();

test("uses native folder and lifecycle controls and completes setup recovery actions", async ({
	page,
}) => {
	test.setTimeout(30_000);
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.goto(STORY_URL);

	await expect(
		page.getByRole("button", { name: "Change projectless task folder" })
	).toBeVisible();
	await setFolderSelection(page, null);
	await page
		.getByRole("button", { name: "Change projectless task folder" })
		.click();
	await expect(
		page.getByText(DEFAULT_PROJECTLESS_FOLDER, { exact: true })
	).toBeVisible();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:projectless-task-folder"))
	).resolves.toBeNull();

	await failFolderDialog(page, "Fixture folder dialog failure");
	await page
		.getByRole("button", { name: "Change projectless task folder" })
		.click();
	await expect(
		page.getByText("Couldn't choose the projectless task folder", {
			exact: true,
		})
	).toBeVisible();
	await expect(
		page.getByText(DEFAULT_PROJECTLESS_FOLDER, { exact: true })
	).toBeVisible();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:projectless-task-folder"))
	).resolves.toBeNull();

	await setFolderSelection(page, "/Users/test/Projectless");
	await page
		.getByRole("button", { name: "Change projectless task folder" })
		.click();
	await expect(
		page.getByText("/Users/test/Projectless", { exact: true })
	).toBeVisible();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:projectless-task-folder"))
	).resolves.toBe("/Users/test/Projectless");
	await page
		.getByRole("button", { name: "Reset projectless task folder" })
		.click();
	await expect(
		page.getByText(DEFAULT_PROJECTLESS_FOLDER, { exact: true })
	).toBeVisible();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:projectless-task-folder"))
	).resolves.toBeNull();
	const folderPickerCalls = (await proofCalls(page)).filter(
		(call) => call.command === "plugin:dialog|open"
	);
	expect(folderPickerCalls.map((call) => call.args)).toEqual([
		{
			options: {
				directory: true,
				multiple: false,
				title: "Choose projectless task folder",
			},
		},
		{
			options: {
				directory: true,
				multiple: false,
				title: "Choose projectless task folder",
			},
		},
		{
			options: {
				directory: true,
				multiple: false,
				title: "Choose projectless task folder",
			},
		},
	]);

	await page.getByText("System & tray", { exact: true }).click();
	// The fifth switch, "Use hardware acceleration", joined this page before
	// Ryu Quiet (07d403e33). It stores the choice natively and only applies it
	// after a restart, which the row says until the user restarts.
	await expect(page.getByRole("switch")).toHaveCount(6);
	const hardwareAcceleration = settingSwitch(
		page,
		"hardware-acceleration-toggle"
	);
	await expect(hardwareAcceleration).toBeChecked();
	await hardwareAcceleration.click();
	await expect(hardwareAcceleration).not.toBeChecked();
	await expect(
		page.getByText("Restart Ryu to turn hardware acceleration off.", {
			exact: true,
		})
	).toBeVisible();
	await hardwareAcceleration.click();
	await expect(hardwareAcceleration).toBeChecked();
	await expect(
		page.getByText("Restart Ryu to turn hardware acceleration off.", {
			exact: true,
		})
	).toHaveCount(0);
	const launchAtLogin = settingSwitch(page, "launch-at-login-toggle");
	const startHidden = settingSwitch(page, "start-hidden-toggle");
	await expect(startHidden).toBeDisabled();
	await failNativeCommand(page, "plugin:autostart|enable");
	await launchAtLogin.click();
	await expect(
		page.getByText("Couldn't update the launch-at-login setting", {
			exact: true,
		})
	).toBeVisible();
	await expect(launchAtLogin).not.toBeChecked();
	await expect(startHidden).toBeDisabled();
	await launchAtLogin.click();
	await expect(launchAtLogin).toBeChecked();
	await expect(startHidden).toBeEnabled();
	await failNativeCommand(page, "set_start_hidden");
	await startHidden.click();
	await expect(
		page.getByText("Couldn't update the start-hidden setting", { exact: true })
	).toBeVisible();
	await expect(startHidden).not.toBeChecked();
	await startHidden.click();
	await expect(startHidden).toBeChecked();
	const closeToTray = settingSwitch(page, "close-to-tray-toggle");
	await failNativeCommand(page, "set_close_to_tray");
	await closeToTray.click();
	await expect(
		page.getByText("Couldn't update the close-to-tray setting", {
			exact: true,
		})
	).toBeVisible();
	await expect(closeToTray).toBeChecked();
	await closeToTray.click();
	await expect(closeToTray).not.toBeChecked();
	const showInMenuBar = settingSwitch(page, "show-in-menu-bar-toggle");
	await failNativeCommand(page, "set_hide_tray_icon");
	await showInMenuBar.click();
	await expect(
		page.getByText("Couldn't update the tray icon setting", { exact: true })
	).toBeVisible();
	await expect(showInMenuBar).toBeChecked();
	await showInMenuBar.click();
	await expect(showInMenuBar).not.toBeChecked();
	await expect(closeToTray).toBeDisabled();
	await showInMenuBar.click();
	await expect(showInMenuBar).toBeChecked();
	await expect(closeToTray).toBeEnabled();
	await closeToTray.click();
	await expect(closeToTray).toBeChecked();
	const lifecycleCalls = (await proofCalls(page)).filter((call) =>
		[
			"plugin:autostart|enable",
			"set_start_hidden",
			"set_close_to_tray",
			"set_hide_tray_icon",
		].includes(call.command)
	);
	expect(lifecycleCalls.map((call) => call.command)).toEqual([
		"plugin:autostart|enable",
		"plugin:autostart|enable",
		"set_start_hidden",
		"set_start_hidden",
		"set_close_to_tray",
		"set_close_to_tray",
		"set_hide_tray_icon",
		"set_hide_tray_icon",
		"set_hide_tray_icon",
		"set_close_to_tray",
	]);
	const callsFor = (command: string) =>
		lifecycleCalls
			.filter((call) => call.command === command)
			.map((call) => call.args ?? null);
	expect(callsFor("set_start_hidden")).toEqual([
		{ hidden: true },
		{ hidden: true },
	]);
	expect(callsFor("set_close_to_tray")).toEqual([
		{ enabled: false },
		{ enabled: false },
		{ enabled: true },
	]);
	expect(callsFor("set_hide_tray_icon")).toEqual([
		{ hidden: true },
		{ hidden: true },
		{ hidden: false },
	]);

	expect(await page.evaluate(() => window.__generalUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await page.getByText("System & tray", { exact: true }).click();
	await expect(settingSwitch(page, "launch-at-login-toggle")).toBeChecked();
	await expect(settingSwitch(page, "start-hidden-toggle")).toBeChecked();
	await expect(settingSwitch(page, "close-to-tray-toggle")).toBeChecked();
	await expect(settingSwitch(page, "show-in-menu-bar-toggle")).toBeChecked();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-general-system-tray-persisted"),
	});

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Setup & recovery", { exact: true }).click();
	await page.evaluate(() => {
		localStorage.setItem("ryu_desktop_onboarding_complete", "true");
		localStorage.setItem("ryu_setup_seen", "true");
		localStorage.setItem("ryu_default_agent", "proof-agent");
		for (const key of [
			"ryu_light_preset",
			"ryu_dark_preset",
			"ryu_ui_font",
			"ryu_heading_font",
			"ryu_code_font",
			"ryu_contrast",
			"ryu_radius",
			"ryu_spacing",
			"ryu_ui_scale",
			"ryu_card_spacing",
			"ryu_chat_width",
		]) {
			localStorage.setItem(key, "proof-value");
		}
	});
	await page.getByRole("button", { name: "Reset onboarding" }).click();
	await expect(page.getByTestId("proof-current-path")).toHaveText(
		"/onboarding"
	);
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_desktop_onboarding_complete"))
	).resolves.toBeNull();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_setup_seen"))
	).resolves.toBeNull();
	for (const key of [
		"ryu_default_agent",
		"ryu_light_preset",
		"ryu_dark_preset",
		"ryu_ui_font",
		"ryu_heading_font",
		"ryu_code_font",
		"ryu_contrast",
		"ryu_radius",
		"ryu_spacing",
		"ryu_ui_scale",
		"ryu_card_spacing",
		"ryu_chat_width",
	]) {
		await expect(
			page.evaluate((storageKey) => localStorage.getItem(storageKey), key)
		).resolves.toBeNull();
	}

	const safeMode = settingSwitch(page, "safe-mode");
	await safeMode.click();
	await expect(safeMode).toBeChecked();
	await expect(
		page.getByText(/Active\. Holding back 3 apps, 12 skills and 2 MCP servers/)
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-general-safe-mode-armed"),
	});
	expect(
		(await gatewayCalls(page)).filter(
			(call) => call.path === "/api/safe-mode" && call.method === "PUT"
		)
	).toEqual([
		{ body: { enabled: true }, method: "PUT", path: "/api/safe-mode" },
	]);
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-general-setup-recovery-proof.png"),
	});
	await page.getByRole("button", { name: "Leave Safe Mode" }).click();
	await expect(safeMode).not.toBeChecked();
	expect(
		(await gatewayCalls(page)).filter(
			(call) => call.path === "/api/safe-mode" && call.method === "PUT"
		)
	).toEqual([
		{ body: { enabled: true }, method: "PUT", path: "/api/safe-mode" },
		{ body: { enabled: false }, method: "PUT", path: "/api/safe-mode" },
	]);
	const safeModeCalls = (await proofCalls(page)).filter((call) =>
		["stop_ryu_core", "get_ryu_status", "start_ryu_core"].includes(call.command)
	);
	expect(safeModeCalls.map((call) => call.command)).toEqual([
		"stop_ryu_core",
		"get_ryu_status",
		"start_ryu_core",
		"get_ryu_status",
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
});
