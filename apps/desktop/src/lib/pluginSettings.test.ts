// Guards the Store → settings-dialog jump: the section value it computes must be
// one the settings nav would also have built, because both dialogs look the value
// up in their entity map and silently fall back to their default section when it
// misses. A wrong prefix or scope here is a menu item that opens the dialog on
// "General" with no error to explain it, which is why the mapping is asserted
// against the SAME grouping the nav uses rather than against a hardcoded string.

import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import {
	APP_SECTION_PREFIX,
	isEntitySection,
	PLUGIN_SECTION_PREFIX,
	type PluginSettingsTab,
	parseSettingsTabs,
	resolveSettingsDestination,
	splitScopedTabs,
} from "./pluginSettings.ts";

function tab(
	plugin: string,
	scope: "node" | "user",
	id = `${plugin}.settings`
): PluginSettingsTab {
	return {
		enabled: true,
		fields: [{ type: "secret", prefKey: "KEY", label: "API key", options: [] }],
		id,
		plugin,
		scope,
		title: "Settings",
	};
}

// Exa is the motivating case: a plain plugin (no companion) whose only tab is
// node-scoped, so its API key lives in the Gateway dialog.
const EXA = "@ryu/exa";
const COMPANION_APP = "com.ryu.learning";
const isApp = (id: string) => id === COMPANION_APP;

describe("parseSettingsTabs — the app-enabled bit", () => {
	const raw = (extra: Record<string, z.infer<ReturnType<typeof z.json>>>) => ({
		plugin: EXA,
		title: "Exa Search",
		fields: [{ type: "secret", pref_key: "RYU_EXA_API_KEY", label: "Key" }],
		...extra,
	});

	test("a tab from a disabled plugin is kept, marked not enabled", () => {
		// Core serves settings tabs for every INSTALLED plugin now, so the tab must
		// survive parsing — dropping it would put the API-key field out of reach
		// exactly when the user is trying to set the plugin up.
		const [tab] = parseSettingsTabs([raw({ app_enabled: false })]);
		expect(tab?.enabled).toBe(false);
		expect(tab?.fields[0]?.prefKey).toBe("RYU_EXA_API_KEY");
	});

	test("an absent bit means enabled (an older Core serves enabled only)", () => {
		expect(parseSettingsTabs([raw({})])[0]?.enabled).toBe(true);
		expect(parseSettingsTabs([raw({ app_enabled: true })])[0]?.enabled).toBe(
			true
		);
	});
});

describe("resolveSettingsDestination", () => {
	test("a node-scoped plain plugin resolves to the Gateway dialog", () => {
		const destination = resolveSettingsDestination(
			[tab(EXA, "node")],
			isApp,
			EXA
		);
		expect(destination).toEqual({
			dialog: "gateway",
			section: `${PLUGIN_SECTION_PREFIX}${EXA}`,
		});
	});

	test("a user-scoped companion app resolves to App Settings under app:", () => {
		const destination = resolveSettingsDestination(
			[tab(COMPANION_APP, "user")],
			isApp,
			COMPANION_APP
		);
		expect(destination).toEqual({
			dialog: "app",
			section: `${APP_SECTION_PREFIX}${COMPANION_APP}`,
		});
	});

	test("tabs at both scopes resolve to the node one (where the fields land)", () => {
		const destination = resolveSettingsDestination(
			[tab(EXA, "user", "a"), tab(EXA, "node", "b")],
			isApp,
			EXA
		);
		expect(destination?.dialog).toBe("gateway");
	});

	test("a plugin with no tabs resolves to null, so no affordance renders", () => {
		expect(resolveSettingsDestination([tab(EXA, "node")], isApp, "other")).toBe(
			null
		);
		expect(resolveSettingsDestination([], isApp, EXA)).toBe(null);
	});

	test("the section it returns is one the settings nav also builds", () => {
		// The whole point: same tabs, same isApp — the nav's grouping must contain
		// the id under the same header the prefix names, or the dialog lookup misses.
		const tabs = [tab(EXA, "node"), tab(COMPANION_APP, "node")];
		const grouped = splitScopedTabs(tabs, "node", isApp);
		for (const pluginId of [EXA, COMPANION_APP]) {
			const destination = resolveSettingsDestination(tabs, isApp, pluginId);
			expect(destination).not.toBe(null);
			expect(isEntitySection(destination?.section ?? "")).toBe(true);
			const bucket = destination?.section.startsWith(APP_SECTION_PREFIX)
				? grouped.apps
				: grouped.plugins;
			expect(bucket.has(pluginId)).toBe(true);
		}
	});
});

test("plugin manifest fields keep unknown controls and tolerant sibling fallbacks", () => {
	const [result] = parseSettingsTabs([
		{
			plugin: EXA,
			scope: "future",
			app_enabled: "false",
			fields: [
				null,
				{ pref_key: "", prefKey: "SHOULD_NOT_FALL_BACK" },
				{
					prefKey: "UNITS",
					type: "future_control",
					label: 1,
					min: "2",
					max: 8,
					options: [
						"mm",
						{ value: "in", label: 2 },
						null,
						{ label: "missing value" },
					],
					default: false,
				},
			],
		},
	]);
	expect(result?.scope).toBe("node");
	expect(result?.enabled).toBe(true);
	expect(result?.fields).toEqual([
		{
			prefKey: "UNITS",
			type: "future_control",
			label: "UNITS",
			options: [
				{ value: "mm", label: "mm" },
				{ value: "in", label: "in" },
			],
			default: false,
			description: undefined,
			placeholder: undefined,
			min: undefined,
			max: 8,
			step: undefined,
		},
	]);
});

test("plugin settings keep named surfaces and ignore malformed MCP descriptors", () => {
	const results = parseSettingsTabs([
		{
			plugin: EXA,
			view: "advanced",
			fields: "bad",
			mcpSettings: { readTool: "other.read", updateTool: "other.update" },
		},
		{ plugin: "companion", companion: "preferences", title: 2 },
		{ plugin: EXA, fields: [] },
	]);
	expect(results.map((result) => result.plugin)).toEqual([EXA, "companion"]);
	expect(results[0]?.mcpSettings).toBeUndefined();
	expect(results[1]?.title).toBe("Settings");
});
