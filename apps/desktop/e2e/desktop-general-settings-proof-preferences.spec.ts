import { expect, test } from "@playwright/test";
import {
	assertAccountStoreBoundary,
	COVERAGE_ACCOUNT,
	chooseOption,
	evidencePath,
	failNativeCommand,
	proofCalls,
	registerGeneralProofHooks,
	STORY_URL,
	settingSwitch,
	togglePreference,
} from "./desktop-general-settings-proof.helpers.ts";

registerGeneralProofHooks();

test("saves the interactive tab, chat, terminal, and file preferences", async ({
	page,
}) => {
	page.setDefaultTimeout(5000);
	page.setDefaultNavigationTimeout(30_000);
	await page.setViewportSize({ height: 1000, width: 1440 });
	await page.addInitScript((account) => {
		if (sessionStorage.getItem("general-proof:account-seeded")) {
			return;
		}
		localStorage.setItem("ryu_accounts", JSON.stringify([account]));
		sessionStorage.setItem("general-proof:account-seeded", "true");
	}, COVERAGE_ACCOUNT);
	await page.goto(STORY_URL);

	await chooseOption(page, "startup-behavior-select", "The Home page");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_behavior"))
	).resolves.toBe("home");
	await chooseOption(page, "startup-realm-select", "Agent");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:startup-realm"))
	).resolves.toBe("console");
	await chooseOption(page, "startup-selection-mode-select", "Use defaults");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_selection_mode"))
	).resolves.toBe("defaults");
	await chooseOption(
		page,
		"startup-default-account-select",
		"Coverage Account"
	);
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_default_account"))
	).resolves.toBe("coverage-user");
	await chooseOption(page, "startup-default-account-select", "Ask at startup");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_default_account"))
	).resolves.toBeNull();
	await failNativeCommand(
		page,
		"set_default_node",
		"Fixture node write failed"
	);
	await chooseOption(page, "startup-default-node-select", "local");
	await expect(
		page.getByText("Couldn't update the default node", { exact: true })
	).toBeVisible();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_default_node"))
	).resolves.toBeNull();
	expect(
		await page.evaluate(() =>
			localStorage.getItem("general-proof:native-default-node")
		)
	).toBeNull();
	await chooseOption(page, "startup-default-node-select", "local");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_default_node"))
	).resolves.toBe("local");
	expect(
		await page.evaluate(() =>
			localStorage.getItem("general-proof:native-default-node")
		)
	).toBe("local");
	expect(
		(await proofCalls(page)).filter(
			(call) => call.command === "set_default_node"
		)
	).toEqual([
		{ command: "set_default_node", args: { name: "local" } },
		{ command: "set_default_node", args: { name: "local" } },
	]);
	await chooseOption(page, "startup-default-node-select", "Ask at startup");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_startup_default_node"))
	).resolves.toBeNull();

	await page.getByText("Tabs & panes", { exact: true }).click();
	const openCurrent = settingSwitch(page, "open-in-current-tab-toggle");
	await togglePreference(
		page,
		openCurrent,
		"ryu_tab_open_behavior",
		(checked) => (checked ? "current" : "new")
	);

	await chooseOption(page, "tab-switch-behavior-select", "Most recently used");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_tab_switch_behavior"))
	).resolves.toBe("recent");

	await chooseOption(page, "tab-layout-select", "Vertical tabs");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_tab_layout"))
	).resolves.toBe("vertical");
	await expect(settingSwitch(page, "fit-tabs-toggle")).toBeDisabled();
	await chooseOption(page, "tab-layout-select", "Horizontal tabs");
	await expect(settingSwitch(page, "fit-tabs-toggle")).toBeEnabled();

	const floatingTabs = settingSwitch(page, "floating-tabs-toggle");
	await togglePreference(page, floatingTabs, "ryu:floating-tabs");
	const autoHideTitleBar = settingSwitch(page, "auto-hide-titlebar-toggle");
	await togglePreference(page, autoHideTitleBar, "ryu:auto-hide-titlebar");
	const fitTabs = settingSwitch(page, "fit-tabs-toggle");
	if (await fitTabs.isChecked()) {
		await fitTabs.click();
	}
	await expect(fitTabs).not.toBeChecked();
	await fitTabs.click();
	await expect(fitTabs).toBeChecked();
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_tab_sizing"))
	).resolves.toBe("fit");
	await chooseOption(page, "tab-unload-select", "After 15 minutes");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_tab_unload_minutes"))
	).resolves.toBe("15");
	const perTabNode = settingSwitch(page, "tab-override-toggle");
	await togglePreference(page, perTabNode, "ryu_node_tab_override_enabled");
	const bottomPanel = settingSwitch(page, "show-bottom-panel-toggle");
	const bottomBefore = await bottomPanel.isChecked();
	await bottomPanel.click();
	await expect(bottomPanel).toBeChecked({ checked: !bottomBefore });
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:show-bottom-panel-toggle"))
	).resolves.toBe(String(!bottomBefore));

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Chats", { exact: true }).click();
	await chooseOption(
		page,
		"availability-manual-status-select",
		"Do not disturb"
	);
	await expect(
		page.evaluate(() => {
			const value = localStorage.getItem("ryu:user-availability");
			return value ? JSON.parse(value).manualStatus : null;
		})
	).resolves.toBe("do-not-disturb");
	const afkDetection = settingSwitch(page, "availability-afk-detection-toggle");
	const afkBefore = await afkDetection.isChecked();
	await afkDetection.click();
	await expect(afkDetection).toBeChecked({ checked: !afkBefore });
	await expect(
		page.evaluate(() => {
			const value = localStorage.getItem("ryu:user-availability");
			return value ? JSON.parse(value).afkDetectionEnabled : null;
		})
	).resolves.toBe(!afkBefore);
	if (afkBefore) {
		await afkDetection.click();
		await expect(afkDetection).toBeChecked();
	}
	await chooseOption(
		page,
		"availability-afk-timeout-select",
		"After 15 minutes"
	);
	await expect(
		page.evaluate(() => {
			const value = localStorage.getItem("ryu:user-availability");
			return value ? JSON.parse(value).afkTimeoutMinutes : null;
		})
	).resolves.toBe(15);
	const importThreads = settingSwitch(page, "auto-import-threads-toggle");
	await togglePreference(page, importThreads, "ryu:auto-import-agent-threads");
	const importSetup = settingSwitch(page, "auto-import-setup-toggle");
	await togglePreference(page, importSetup, "ryu:auto-import-agent-setup");
	await chooseOption(page, "composer-send-shortcut-select", "Shift + Enter");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu:composer-send-shortcut"))
	).resolves.toBe("shift-enter");
	await chooseOption(page, "queue-drain-mode-select", "Latest first");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_queue_drain_mode"))
	).resolves.toBe("latest-first");
	await chooseOption(
		page,
		"composer-selection-apply-mode-select",
		"On the next user message"
	);
	await expect(
		page.evaluate(() =>
			localStorage.getItem("ryu:composer-selection-apply-mode")
		)
	).resolves.toBe("next-user-message");

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Terminal", { exact: true }).click();
	await chooseOption(page, "terminal-shell-select", "Bash");
	await expect(
		page.locator("#terminal-shell-select [data-slot='select-value']")
	).toHaveText("Bash");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_workspace_terminal_shell"))
	).resolves.toBe("bash");

	await page.getByRole("button", { name: "General", exact: true }).click();
	await page.getByText("Files", { exact: true }).click();
	await chooseOption(page, "default-file-opener-select", "VS Code");
	await expect(
		page.locator("#default-file-opener-select [data-slot='select-value']")
	).toHaveText("VS Code");
	await expect(
		page.evaluate(() =>
			localStorage.getItem("ryu_workspace_default_file_opener")
		)
	).resolves.toBe("vscode");
	await page
		.getByRole("heading", { exact: true, name: "Files" })
		.first()
		.click();
	await expect(
		page.getByRole("option", { exact: true, name: "Zed" })
	).not.toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: test.info().outputPath("desktop-general-preferences-proof.png"),
	});
	await assertAccountStoreBoundary(page);
	expect(await page.evaluate(() => window.__generalUnknownCommands)).toEqual(
		[]
	);
	await page.reload();
	await expect(
		page.getByTestId("desktop-general-settings-proof")
	).toBeVisible();
	await expect(
		page.locator("#startup-realm-select [data-slot='select-value']")
	).toHaveText("Agent");
	// The reloaded vault is read back from the sealed slot, never from web storage.
	await assertAccountStoreBoundary(page, true);
	await test.info().attach("reloaded-account-store-boundary", {
		body: JSON.stringify(
			await page.evaluate(() => ({
				calls: window.__generalNativeStoreCalls,
				unknownCommands: window.__generalUnknownCommands,
				accountControlDisabled: document.querySelector<HTMLButtonElement>(
					"#startup-default-account-select"
				)?.disabled,
			})),
			null,
			2
		),
		contentType: "application/json",
	});
	await page.locator("#startup-default-account-select").click();
	await expect(
		page.getByRole("option", { name: "Coverage Account", exact: true })
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.evaluate(() => localStorage.getItem("ryu_queue_drain_mode"))
	).resolves.toBe("latest-first");
	await expect(
		page.evaluate(() =>
			localStorage.getItem("ryu_workspace_default_file_opener")
		)
	).resolves.toBe("vscode");
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("desktop-general-preferences-persisted"),
	});
});
