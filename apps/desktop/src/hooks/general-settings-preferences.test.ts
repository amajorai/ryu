import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { beforeEach, describe, expect, test } from "bun:test";
import { listSettingsByCategory } from "../lib/settings-registry.ts";
import {
	LANGUAGE_MODE_KEY,
	parseLanguageMode,
	readLanguageMode,
	setLanguageMode,
} from "./useLanguageMode.ts";
import { setPersistedToggle } from "./usePersistedToggle.ts";
import {
	PROJECTLESS_TASK_FOLDER_KEY,
	setProjectlessTaskFolder,
} from "./useProjectlessTaskFolder.ts";
import {
	DEFAULT_SHOW_BOTTOM_PANEL_TOGGLE,
	SHOW_BOTTOM_PANEL_TOGGLE_KEY,
} from "./useShowBottomPanelToggle.ts";
import {
	DEFAULT_TERMINAL_PANEL_LOCATION,
	parseTerminalPanelLocation,
	setTerminalPanelLocation,
	TERMINAL_PANEL_LOCATION_KEY,
} from "./useTerminalPanelLocation.ts";

beforeEach(() => {
	localStorage.clear();
	setProjectlessTaskFolder(null);
	setPersistedToggle(
		SHOW_BOTTOM_PANEL_TOGGLE_KEY,
		DEFAULT_SHOW_BOTTOM_PANEL_TOGGLE
	);
	setTerminalPanelLocation(DEFAULT_TERMINAL_PANEL_LOCATION);
	setLanguageMode("auto");
});

describe("Desktop General preference persistence", () => {
	test("stores a trimmed projectless task folder and supports clearing it", () => {
		setProjectlessTaskFolder("  /tmp/projectless  ");
		expect(localStorage.getItem(PROJECTLESS_TASK_FOLDER_KEY)).toBe(
			"/tmp/projectless"
		);

		setProjectlessTaskFolder(null);
		expect(localStorage.getItem(PROJECTLESS_TASK_FOLDER_KEY)).toBeNull();
	});

	test("normalizes terminal location to the supported bottom/right values", () => {
		expect(parseTerminalPanelLocation(null)).toBe("bottom");
		expect(parseTerminalPanelLocation("left")).toBe("bottom");
		setTerminalPanelLocation("right");
		expect(localStorage.getItem(TERMINAL_PANEL_LOCATION_KEY)).toBe("right");
	});

	test("persists the bottom-panel header visibility preference", () => {
		setPersistedToggle(SHOW_BOTTOM_PANEL_TOGGLE_KEY, false);
		expect(localStorage.getItem(SHOW_BOTTOM_PANEL_TOGGLE_KEY)).toBe("false");
	});

	test("persists auto-detect versus a fixed language selection", () => {
		expect(readLanguageMode()).toBe("auto");
		setLanguageMode("fixed");
		expect(localStorage.getItem(LANGUAGE_MODE_KEY)).toBe("fixed");
		expect(readLanguageMode()).toBe("fixed");
	});

	test("keeps a pre-mode language-pack selection fixed during migration", () => {
		expect(parseLanguageMode(null, "community/es")).toBe("fixed");
		expect(parseLanguageMode(null, null)).toBe("auto");
		expect(parseLanguageMode("auto", "community/es")).toBe("auto");
	});

	test("registers the new controls for General reset", () => {
		const ids = listSettingsByCategory("general").map((setting) => setting.id);
		expect(ids).toEqual(
			expect.arrayContaining([
				"general.projectless-task-folder",
				"general.bottom-panel-toggle",
				"general.terminal.panel-location",
			])
		);
	});
});
