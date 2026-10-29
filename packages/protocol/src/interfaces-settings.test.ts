import { describe, expect, test } from "bun:test";
import {
	INTERFACE_RENDERERS,
	interfaceParamsWith,
	interfaceParamsWithOverrides,
	interfaceSettingsFor,
	KIT_GAME_RENDERERS,
	parseInterfaceContribution,
	parseInterfaceSettings,
	rendererSettings,
	resolveInterfaceParams,
	settingValueFits,
} from "./interfaces.ts";

describe("renderer settings", () => {
	test("stay in lockstep with the params each renderer resolves", () => {
		for (const renderer of INTERFACE_RENDERERS) {
			const defaults = resolveInterfaceParams(renderer, {}) as Record<
				string,
				unknown
			>;
			const fields = rendererSettings(renderer);
			// One field per param, no more, no fewer.
			expect(fields.map((field) => field.key).sort()).toEqual(
				Object.keys(defaults).sort()
			);
			for (const field of fields) {
				expect(field.default).toBe(defaults[field.key] as never);
				if (field.type === "select") {
					for (const option of field.options ?? []) {
						const resolved = resolveInterfaceParams(renderer, {
							[field.key]: option.value,
						}) as Record<string, unknown>;
						expect(resolved[field.key]).toBe(option.value);
					}
					const junk = resolveInterfaceParams(renderer, {
						[field.key]: "not-an-option",
					}) as Record<string, unknown>;
					expect(junk[field.key]).toBe(field.default);
				}
			}
		}
	});

	test("every kit game shares overlay density and work bubbles", () => {
		for (const renderer of KIT_GAME_RENDERERS) {
			const keys = rendererSettings(renderer).map((field) => field.key);
			expect(keys).toContain("overlayDensity");
			expect(keys).toContain("workBubbles");
			expect(resolveInterfaceParams(renderer, {})).toMatchObject({
				overlayDensity: "full",
				workBubbles: true,
			});
		}
		expect(
			rendererSettings("channels").map((field) => field.key)
		).not.toContain("workBubbles");
	});
});

describe("live params", () => {
	const board = { params: {}, renderer: "board" as const };

	test("the user's overrides win over the descriptor's params", () => {
		expect(
			interfaceParamsWith(
				{ ...board, params: { view: "list" } },
				{ groupBy: "agent" }
			)
		).toEqual({ groupBy: "agent", view: "list" });
		expect(
			interfaceParamsWith(
				{ ...board, params: { view: "list" } },
				{
					view: "board",
				}
			).view
		).toBe("board");
	});

	test("unknown keys and values outside a setting are ignored", () => {
		expect(
			interfaceParamsWith(board, {
				groupBy: "nonsense",
				secret: "x",
				view: true,
			})
		).toEqual({ groupBy: "status", view: "board" });
	});

	test("a value fits its field's type and options", () => {
		const [view] = rendererSettings("board");
		if (!view) {
			throw new Error("no board setting");
		}
		expect(settingValueFits(view, "list")).toBe(true);
		expect(settingValueFits(view, "grid")).toBe(false);
		expect(
			settingValueFits(
				{ default: 3, key: "n", label: "N", max: 5, min: 1, type: "number" },
				9
			)
		).toBe(false);
	});
});

describe("Marketplace settings", () => {
	test("a contribution may relabel and narrow its renderer's settings", () => {
		const fields = parseInterfaceSettings("board", [
			{
				default: "list",
				key: "view",
				label: "Look",
				options: [
					{ label: "Lanes", value: "board" },
					{ label: "Rows", value: "list" },
				],
			},
		]);
		expect(fields).toEqual([
			{
				default: "list",
				key: "view",
				label: "Look",
				options: [
					{ label: "Lanes", value: "board" },
					{ label: "Rows", value: "list" },
				],
				type: "select",
			},
		]);
		// A relabelled field narrowed to one option keeps that option only.
		const one = parseInterfaceSettings("board", [
			{
				key: "groupBy",
				label: "Lanes by",
				options: [{ label: "Agent", value: "agent" }],
				default: "agent",
			},
		]);
		expect(one?.[0]?.options).toEqual([{ label: "Agent", value: "agent" }]);
	});

	test("it may not invent keys, types, options or defaults", () => {
		expect(
			parseInterfaceSettings("board", [{ key: "colour", label: "Colour" }])
		).toBeNull();
		expect(
			parseInterfaceSettings("board", [
				{
					key: "view",
					label: "View",
					options: [{ label: "Grid", value: "grid" }],
				},
			])
		).toBeNull();
		expect(
			parseInterfaceSettings("board", [
				{ default: "grid", key: "view", label: "View" },
			])
		).toBeNull();
		expect(
			parseInterfaceSettings("board", [
				{ key: "view", label: "A" },
				{ key: "view", label: "B" },
			])
		).toBeNull();
		expect(parseInterfaceSettings("board", "view")).toBeNull();
	});

	test("narrowing without a default starts from params, then the first option", () => {
		const night = {
			key: "theme",
			label: "Floor",
			options: [
				{ label: "N", value: "night" },
				{ label: "O", value: "office" },
			],
		};
		const fromParams = parseInterfaceContribution({
			id: "@example/world:main",
			label: "World",
			params: { theme: "night" },
			plugin: "@example/world",
			renderer: "world-2d",
			settings: [night],
		});
		expect(fromParams?.settings).toHaveLength(1);
		expect(fromParams?.settings?.[0]?.default).toBe("night");
		const noParams = parseInterfaceContribution({
			id: "@example/world:main",
			label: "World",
			params: {},
			plugin: "@example/world",
			renderer: "world-2d",
			settings: [night],
		});
		expect(noParams?.settings?.[0]?.default).toBe("night");
		// An explicit default still has to be valid.
		expect(
			parseInterfaceSettings("world-2d", [{ ...night, default: "meadow" }])
		).toBeNull();
	});

	test("a param outside its narrowed setting falls back to the setting's default", () => {
		const descriptor = parseInterfaceContribution({
			id: "@example/lanes:narrow",
			label: "Lanes",
			params: { view: "board" },
			plugin: "@example/lanes",
			renderer: "board",
			settings: [
				{
					default: "list",
					key: "view",
					label: "Look",
					options: [{ label: "Rows", value: "list" }],
				},
			],
		});
		if (!descriptor) {
			throw new Error("no descriptor");
		}
		expect(interfaceParamsWith(descriptor, {})).toMatchObject({
			view: "list",
		});
	});

	test("a contribution's settings reach its descriptor, and its defaults its params", () => {
		const descriptor = parseInterfaceContribution({
			id: "@example/lanes:main",
			label: "Lanes",
			params: {},
			plugin: "@example/lanes",
			renderer: "board",
			settings: [{ default: "list", key: "view", label: "Look" }],
		});
		expect(descriptor?.settings?.map((field) => field.key)).toEqual(["view"]);
		if (!descriptor) {
			throw new Error("no descriptor");
		}
		expect(interfaceSettingsFor(descriptor)).toHaveLength(1);
		expect(interfaceParamsWith(descriptor, {})).toEqual({
			groupBy: "status",
			view: "list",
		});
		// The user may change only the settings the interface shows.
		expect(
			interfaceParamsWithOverrides(descriptor, { groupBy: "agent" }).groupBy
		).toBeUndefined();
		// Invalid settings fall back to the renderer's own.
		const bad = parseInterfaceContribution({
			id: "@example/lanes:bad",
			label: "Lanes",
			plugin: "@example/lanes",
			renderer: "board",
			settings: [{ key: "colour", label: "Colour" }],
		});
		expect(bad?.settings).toBeUndefined();
		if (bad) {
			expect(interfaceSettingsFor(bad)).toHaveLength(2);
		}
	});
});

describe("in-view controls as settings", () => {
	test("calendar's rail and canvas's minimap are settings", () => {
		expect(rendererSettings("calendar").map((field) => field.key)).toEqual([
			"scale",
			"rail",
		]);
		expect(
			interfaceParamsWith(
				{ params: {}, renderer: "canvas" },
				{ minimap: "hidden" }
			).minimap
		).toBe("hidden");
	});

	test("Knowledge's graph settings fit the cap and clamp their ranges", () => {
		const fields = rendererSettings("knowledge");
		expect(fields.length).toBeLessThanOrEqual(16);
		const nodeSize = fields.find((field) => field.key === "nodeSize");
		expect(nodeSize && settingValueFits(nodeSize, 1.5)).toBe(true);
		expect(nodeSize && settingValueFits(nodeSize, 9)).toBe(false);
		expect(
			resolveInterfaceParams("knowledge", { linkDistance: 500 }).linkDistance
		).toBe(30);
		expect(
			interfaceParamsWith(
				{ params: {}, renderer: "knowledge" },
				{ mode: "local", repelForce: 0.9 }
			)
		).toMatchObject({ mode: "local", repelForce: 0.9 });
	});
});
