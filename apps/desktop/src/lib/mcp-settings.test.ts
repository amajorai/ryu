import { expect, test } from "bun:test";
import {
	changedMcpSettings,
	confirmedMcpSettingsChanges,
	mcpSettingsActionText,
	mcpSettingsResultStatus,
	parseMcpSettings,
} from "./mcp-settings.ts";
import { parseSettingsTabs } from "./pluginSettings.ts";

test("settings preserves primitive schema values and writes changed fields only", () => {
	const data = parseMcpSettings({
		structuredContent: {
			schema: {
				type: "object",
				properties: {
					units: { type: "string", title: "Units", enum: ["mm", "in"] },
					grid: { type: "boolean", title: "Grid" },
				},
			},
			values: { units: "mm", grid: false },
		},
	});
	expect(data.fields[0].enum).toEqual(["mm", "in"]);
	expect(changedMcpSettings(data, { units: "in", grid: false })).toEqual({
		units: "in",
	});
});

test("settings updates distinguish provider failure and pending authorization from completion", () => {
	expect(mcpSettingsResultStatus({ isError: true, content: [] })).toBe(
		"failed"
	);
	expect(
		mcpSettingsResultStatus({ __ryu_elicitation__: { id: "approval" } })
	).toBe("pending");
	expect(mcpSettingsResultStatus(undefined)).toBe("failed");
	expect(mcpSettingsResultStatus({ content: [] })).toBe("completed");
});

test("save confirmation requires the requested values in readback", () => {
	const data = parseMcpSettings({
		schema: { properties: { units: { type: "string" } } },
		values: { units: "mm" },
	});
	expect(confirmedMcpSettingsChanges(data, { units: "in" })).toBe(false);
	expect(confirmedMcpSettingsChanges(data, { units: "mm" })).toBe(true);
	expect(confirmedMcpSettingsChanges(data, { missing: "mm" })).toBe(false);
});

test("invalid provider settings stay errors", () => {
	expect(() =>
		parseMcpSettings({
			schema: { properties: { units: { type: "string" } } },
			values: {},
		})
	).toThrow("did not supply");
	expect(() =>
		parseMcpSettings({
			schema: { properties: { units: { type: "object" } } },
			values: { units: "x" },
		})
	).toThrow("Unsupported");
});

test("settings tools remain bound to the advertised server even when its plugin has another id", () => {
	const settings = {
		serverId: "backend",
		readTool: "backend.settings.read",
		updateTool: "backend.settings.update",
	};
	const tabs = parseSettingsTabs([
		{
			plugin: "@example/editor",
			id: "settings",
			title: "Settings",
			mcpSettings: settings,
		},
	]);
	expect(tabs[0]?.mcpSettings).toEqual(settings);
	expect(
		parseSettingsTabs([
			{
				plugin: "@example/editor",
				id: "settings",
				title: "Settings",
				mcpSettings: { ...settings, updateTool: "unrelated.settings.update" },
			},
		])
	).toEqual([]);
});

test("settings layout retains actions, ignores unsupported items, and groups remaining fields", () => {
	const data = parseMcpSettings({
		schema: {
			properties: {
				units: { type: "string", title: 12, enum: ["mm", 2], minimum: "0" },
				grid: { type: "boolean" },
				ignored: null,
			},
		},
		values: { units: "mm", grid: true },
		layout: [
			{
				kind: "group",
				title: "Drawing",
				items: [
					{ kind: "property", property: "units" },
					{ kind: "property", property: "units" },
					{ kind: "property", property: "missing" },
					{ kind: "future" },
					{
						kind: "tool",
						tool: "drawing.reset",
						title: "Reset",
						description: false,
					},
				],
			},
		],
	});
	expect(data.fields[0]).toMatchObject({ key: "units", title: "units" });
	expect(data.fields[0]?.enum).toBeUndefined();
	expect(data.fields[0]?.minimum).toBeUndefined();
	expect(data.groups).toEqual([
		{
			title: "Drawing",
			items: [
				{ kind: "property", property: "units" },
				{
					kind: "tool",
					tool: "drawing.reset",
					title: "Reset",
					description: undefined,
				},
			],
		},
		{
			title: "Other settings",
			generated: "other",
			items: [{ kind: "property", property: "grid" }],
		},
	]);
});

test("settings reports malformed layout groups and items with their existing messages", () => {
	const base = { schema: { properties: {} }, values: {} };
	expect(() => parseMcpSettings({ ...base, layout: [null] })).toThrow(
		"Invalid settings layout"
	);
	expect(() =>
		parseMcpSettings({
			...base,
			layout: [{ kind: "group", title: "Settings", items: [null] }],
		})
	).toThrow("Invalid settings layout item");
	expect(() =>
		parseMcpSettings({
			schema: { properties: { count: { type: "integer" } } },
			values: { count: 1.5 },
		})
	).toThrow("does not match its schema");
});

test("settings text selects only text content and authorization remains pending on an error result", () => {
	expect(mcpSettingsActionText("Done")).toBe("Done");
	expect(
		mcpSettingsActionText({
			content: [
				null,
				{ type: "image", text: "ignore" },
				{ type: "text", text: "First" },
				{ type: "text", text: 2 },
				{ type: "text", text: "Second" },
			],
		})
	).toBe("First\nSecond");
	expect(
		mcpSettingsResultStatus({ __ryu_elicitation__: null, isError: true })
	).toBe("pending");
});
