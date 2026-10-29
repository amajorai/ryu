import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { PluginDocument } from "../src/lib/api/plugin-wire-values.ts";

const runtimeErrors = new WeakMap<import("@playwright/test").Page, string[]>();

test.afterEach(async ({ page }) => {
	expect(runtimeErrors.get(page) ?? []).toEqual([]);
	expect(await page.evaluate(() => window.__GENERAL_NATIVE_STORE_MODE__)).toBe(
		NATIVE_STORE_MODE
	);
	expect(await page.evaluate(() => window.__generalUnknownCommands)).toEqual(
		[]
	);
});

const STORY_URL = "/desktop-general-settings-proof.html";
const NATIVE_STORE_MODE = parseNativeStoreMode(
	process.env.RYU_GENERAL_SETTINGS_STORE_MODE ?? "native"
);
function parseNativeStoreMode(mode: string): "native" | "browser-fallback" {
	if (mode === "native" || mode === "browser-fallback") {
		return mode;
	}
	throw new Error(
		"RYU_GENERAL_SETTINGS_STORE_MODE must be native or browser-fallback"
	);
}
const ACCOUNT_STORE_KEY = "general-proof:native-store:auth.bin";
const COVERAGE_ACCOUNT = {
	email: "coverage@example.test",
	image: null,
	name: "Coverage Account",
	token: "fixture-token",
	userId: "coverage-user",
};
const SAVED_ACCOUNT_VAULT = {
	accounts: [COVERAGE_ACCOUNT],
	activeUserId: COVERAGE_ACCOUNT.userId,
};
const VAULT_SLOT_KEY = "general-proof:sealed-slot:auth-vault";
const ROOT_PROOF_SCREENSHOT = "desktop-general-settings-root-proof.png";
const TERMINAL_PROOF_SCREENSHOT = "desktop-general-settings-terminal-proof.png";
const PROOF_SCREENSHOT = "desktop-general-settings-proof.png";

const DEFAULT_PROJECTLESS_FOLDER = String.raw`C:\Users\Proof\Documents\Ryu\Projects`;

function evidencePath(name: string): string {
	return test.info().outputPath(`${name}.png`);
}

interface GeneralProofCall {
	args?: InvokeArgs;
	command: string;
}

interface GeneralGatewayCall {
	body: PluginDocument | null;
	method: string;
	path: string;
}

declare global {
	interface Window {
		__GENERAL_NATIVE_STORE_MODE__?: "native" | "browser-fallback";
		__generalGatewayCalls: GeneralGatewayCall[];
		__generalNativeStoreCalls: Array<{
			args?: Record<string, unknown>;
			command: string;
			acknowledged: boolean;
			value?: unknown;
		}>;
		__generalProofCalls: GeneralProofCall[];
		__generalProofFixture: {
			failNextCommand: (command: string, message?: string) => void;
			failNextGatewayRequest: (path: string, message?: string) => void;
			failNextFolderDialog: (message?: string) => void;
			setFolderSelection: (path: string | null) => void;
		};
		__generalUnknownCommands: string[];
	}
}

async function proofCalls(
	page: import("@playwright/test").Page
): Promise<GeneralProofCall[]> {
	return page.evaluate(() => window.__generalProofCalls);
}

async function gatewayCalls(
	page: import("@playwright/test").Page
): Promise<GeneralGatewayCall[]> {
	return page.evaluate(() => window.__generalGatewayCalls);
}

const LEGACY_VAULT_KEYS = [
	"ryu_accounts",
	"ryu_active_user_id",
	"ryu_session_token",
] as const;
const AUTH_STORE_VAULT_KEYS = ["accounts", "activeUserId", "token"];

async function legacyVaultCopies(page: import("@playwright/test").Page) {
	return page.evaluate(
		({ keys, storeKey }) => ({
			webStorage: keys.map((key) => localStorage.getItem(key)),
			authStore: JSON.parse(localStorage.getItem(storeKey) ?? "{}"),
		}),
		{ keys: [...LEGACY_VAULT_KEYS], storeKey: ACCOUNT_STORE_KEY }
	);
}

// The account vault lives only in the sealed `auth-vault` slot: never in web
// storage and never in the plaintext `auth.bin` plugin store.
async function assertAccountStoreBoundary(
	page: import("@playwright/test").Page,
	reloaded = false
) {
	if (NATIVE_STORE_MODE === "browser-fallback") {
		expect(
			await page.evaluate((key) => localStorage.getItem(key), VAULT_SLOT_KEY)
		).toBeNull();
		expect(
			await page.evaluate((key) => localStorage.getItem(key), ACCOUNT_STORE_KEY)
		).toBeNull();
		return;
	}
	await expect
		.poll(async () => {
			const saved = await page.evaluate(
				(key) => localStorage.getItem(key),
				VAULT_SLOT_KEY
			);
			return saved === null ? null : JSON.parse(saved);
		})
		.toEqual(SAVED_ACCOUNT_VAULT);
	const copies = await legacyVaultCopies(page);
	expect(copies.webStorage).toEqual([null, null, null]);
	for (const key of AUTH_STORE_VAULT_KEYS) {
		expect(copies.authStore).not.toHaveProperty(key);
	}
	const calls = await page.evaluate(() => window.__generalNativeStoreCalls);
	expect(
		calls.filter(
			(call) =>
				call.command === "plugin:store|set" &&
				AUTH_STORE_VAULT_KEYS.includes(String(call.args?.key))
		)
	).toEqual([]);
	const slotWrites = calls
		.filter((call) => call.command === "desktop_secret_set")
		.map((call) => ({
			acknowledged: call.acknowledged,
			name: call.args?.name,
			value: JSON.parse(String(call.args?.value)),
		}));
	if (reloaded) {
		expect(slotWrites).toEqual([]);
		const slotReads = calls
			.filter(
				(call) =>
					call.command === "desktop_secret_get" &&
					call.args?.name === "auth-vault" &&
					call.acknowledged
			)
			.map((call) => JSON.parse(String(call.value)));
		expect(slotReads).toContainEqual(SAVED_ACCOUNT_VAULT);
		return;
	}
	expect(slotWrites).toEqual([
		{ acknowledged: true, name: "auth-vault", value: SAVED_ACCOUNT_VAULT },
	]);
}

async function failNativeCommand(
	page: import("@playwright/test").Page,
	command: string,
	message?: string
): Promise<void> {
	await page.evaluate(
		({ failureMessage, failureCommand }) =>
			window.__generalProofFixture.failNextCommand(
				failureCommand,
				failureMessage
			),
		{ failureCommand: command, failureMessage: message }
	);
}

async function failGatewayRequest(
	page: import("@playwright/test").Page,
	path: string,
	message?: string
): Promise<void> {
	await page.evaluate(
		({ failureMessage, failurePath }) =>
			window.__generalProofFixture.failNextGatewayRequest(
				failurePath,
				failureMessage
			),
		{ failurePath: path, failureMessage: message }
	);
}

async function setFolderSelection(
	page: import("@playwright/test").Page,
	path: string | null
): Promise<void> {
	await page.evaluate(
		(folderPath) => window.__generalProofFixture.setFolderSelection(folderPath),
		path
	);
}

async function failFolderDialog(
	page: import("@playwright/test").Page,
	message?: string
): Promise<void> {
	await page.evaluate(
		(failureMessage) =>
			window.__generalProofFixture.failNextFolderDialog(failureMessage),
		message
	);
}

async function chooseOption(
	page: import("@playwright/test").Page,
	triggerId: string,
	optionName: string
) {
	const trigger = page.locator(`#${triggerId}`);
	await expect(trigger).toBeVisible();
	await trigger.click();
	const listboxId = await trigger.getAttribute("aria-controls");
	const listbox = listboxId
		? page.locator(`[id="${listboxId}"]`)
		: page.getByRole("listbox").last();
	await listbox.getByRole("option", { exact: true, name: optionName }).click();
}

function settingSwitch(
	page: import("@playwright/test").Page,
	id: string
): import("@playwright/test").Locator {
	// Base UI assigns id to the hidden input; click and assert its visible switch.
	return page.locator(`#${id}`).locator("..").getByRole("switch");
}

async function togglePreference(
	page: import("@playwright/test").Page,
	control: import("@playwright/test").Locator,
	storageKey: string,
	serializedValue: (checked: boolean) => string = String
): Promise<boolean> {
	const before = await control.isChecked();
	await control.click();
	await expect(control).toBeChecked({ checked: !before });
	await expect(
		page.evaluate(({ key }) => localStorage.getItem(key), { key: storageKey })
	).resolves.toBe(serializedValue(!before));
	return !before;
}

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page }) => {
	const errors: string[] = [];
	runtimeErrors.set(page, errors);
	page.on("pageerror", (error) => errors.push(error.message));
	await page.addInitScript((mode) => {
		window.__GENERAL_NATIVE_STORE_MODE__ = mode;
	}, NATIVE_STORE_MODE);
	await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
});

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
	await expect(page.getByRole("switch")).toHaveCount(5);
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

declare global {
	interface Window {
		__generalGatewayCalls: GeneralGatewayCall[];
		__generalProofCalls: GeneralProofCall[];
		__generalProofFixture: {
			failNextCommand: (command: string, message?: string) => void;
			failNextGatewayRequest: (path: string, message?: string) => void;
			failNextFolderDialog: (message?: string) => void;
			setFolderSelection: (path: string | null) => void;
		};
	}
}

function shippingLicenseReceipt() {
	const text = readFileSync(
		new URL("../src/lib/desktop-licenses.generated.txt", import.meta.url),
		"utf8"
	);
	return {
		length: text.length,
		digest: createHash("sha256").update(text).digest("hex"),
	};
}

async function expectShippingLicenseText(
	dialog: import("@playwright/test").Locator
) {
	const notices = dialog.locator("pre");
	await expect(notices).toContainText(
		"THE FOLLOWING SETS FORTH ATTRIBUTION NOTICES"
	);
	const actual = await notices.textContent();
	if (actual === null) {
		throw new Error("Missing rendered license notices");
	}
	const expected = shippingLicenseReceipt();
	expect(actual.length).toBe(expected.length);
	expect(createHash("sha256").update(actual).digest("hex")).toBe(
		expected.digest
	);
}

test("open source licenses load the shipping legal artifact on demand and restore keyboard focus on dismissal", async ({
	page,
}) => {
	const noticeRequests: string[] = [];
	page.on("request", (request) => {
		if (
			request.resourceType() === "fetch" &&
			request.url().includes("desktop-licenses.generated")
		) {
			noticeRequests.push(request.url());
		}
	});
	await page.goto(STORY_URL);
	const view = page.getByRole("button", { name: "View open source licenses" });
	await expect(view).toBeVisible();
	expect(noticeRequests).toEqual([]);
	await view.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Open source licenses" });
	await expect(dialog).toBeVisible();
	await expectShippingLicenseText(dialog);
	expect(noticeRequests).toHaveLength(1);
	expect(
		await dialog.evaluate((element) => element.contains(document.activeElement))
	).toBe(true);
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
	await expect(view).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(dialog).toBeVisible();
	await expectShippingLicenseText(dialog);
	expect(noticeRequests).toHaveLength(1);
});

test("failed delivery of the real license chunk surfaces an error and explicit retry recovers the complete notices", async ({
	page,
}) => {
	let attempts = 0;
	await page.route("**/desktop-licenses.generated*.txt*", async (route) => {
		if (route.request().resourceType() !== "fetch") {
			await route.continue();
			return;
		}
		attempts += 1;
		if (attempts === 1) {
			await route.abort("failed");
		} else {
			await route.continue();
		}
	});
	await page.goto(STORY_URL);
	await page.getByRole("button", { name: "View open source licenses" }).click();
	const dialog = page.getByRole("dialog", { name: "Open source licenses" });
	await expect(
		dialog.getByText("The license notices could not be loaded.")
	).toBeVisible();
	expect(attempts).toBe(1);
	await expect(dialog.locator("pre")).toHaveCount(0);
	await dialog.getByRole("button", { name: "Try again" }).click();
	await expectShippingLicenseText(dialog);
	expect(attempts).toBe(2);
	await expect(
		dialog.getByText("The license notices could not be loaded.")
	).toHaveCount(0);
});
