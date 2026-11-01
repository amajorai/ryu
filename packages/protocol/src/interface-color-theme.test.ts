import { describe, expect, test } from "bun:test";
import {
	interfaceColorThemeId,
	MAX_INTERFACE_COLOR_THEME_ID_BYTES,
	parseInterfaceColorTheme,
} from "./interface-color-theme.ts";
import {
	parseInterfaceContribution,
	parseInterfaceContributions,
} from "./interfaces.ts";

const PLUGIN = "@acme/pixel-town";

describe("parseInterfaceColorTheme", () => {
	test("keeps own-namespace theme ids for both modes", () => {
		expect(
			parseInterfaceColorTheme(
				{ dark: `${PLUGIN}:night`, light: `${PLUGIN}:day` },
				PLUGIN
			)
		).toEqual({ dark: `${PLUGIN}:night`, light: `${PLUGIN}:day` });
	});

	test("keeps built-in preset ids", () => {
		expect(
			parseInterfaceColorTheme({ dark: "ryu-dark", light: "ryu" }, PLUGIN)
		).toEqual({ dark: "ryu-dark", light: "ryu" });
	});

	test("a single slot is enough", () => {
		expect(parseInterfaceColorTheme({ dark: "ryu-dark" }, PLUGIN)).toEqual({
			dark: "ryu-dark",
		});
	});

	test("drops another plugin's namespace", () => {
		expect(
			parseInterfaceColorTheme({ dark: "@other/plugin:night" }, PLUGIN)
		).toBeUndefined();
		expect(
			parseInterfaceColorTheme(
				{ dark: "@other/plugin:night", light: `${PLUGIN}:day` },
				PLUGIN
			)
		).toEqual({ light: `${PLUGIN}:day` });
		// A prefix match without the `:` separator is still foreign.
		expect(
			parseInterfaceColorTheme({ dark: `${PLUGIN}-evil:night` }, PLUGIN)
		).toBeUndefined();
	});

	test("drops one bad slot while keeping the other", () => {
		expect(
			parseInterfaceColorTheme({ dark: 42, light: `${PLUGIN}:day` }, PLUGIN)
		).toEqual({ light: `${PLUGIN}:day` });
		expect(
			parseInterfaceColorTheme(
				{ dark: `${PLUGIN}:night`, light: "Not A Preset" },
				PLUGIN
			)
		).toEqual({ dark: `${PLUGIN}:night` });
	});

	test("rejects malformed ids", () => {
		const bad = [
			"",
			`${PLUGIN}:`,
			`${PLUGIN}:tab\there`,
			`${PLUGIN}:next\u0085line`,
			`${PLUGIN}:nul\u0000`,
			`${PLUGIN}:new\nline`,
			"-leading-dash",
			"UPPER",
			"a".repeat(65),
			`${PLUGIN}:${"x".repeat(MAX_INTERFACE_COLOR_THEME_ID_BYTES)}`,
		];
		for (const id of bad) {
			expect(parseInterfaceColorTheme({ dark: id }, PLUGIN)).toBeUndefined();
		}
	});

	test("accepts any non-control character in a same-plugin id, as Rust does", () => {
		const id = `${PLUGIN}:Night Mode é`;
		expect(parseInterfaceColorTheme({ dark: id }, PLUGIN)).toEqual({
			dark: id,
		});
	});

	test("accepts an id at exactly the byte limit", () => {
		const prefix = `${PLUGIN}:`;
		const id = `${prefix}${"x".repeat(MAX_INTERFACE_COLOR_THEME_ID_BYTES - prefix.length)}`;
		expect(parseInterfaceColorTheme({ light: id }, PLUGIN)).toEqual({
			light: id,
		});
	});

	test("non-object input and empty objects give undefined", () => {
		for (const raw of [
			undefined,
			null,
			"ryu-dark",
			42,
			["ryu-dark"],
			{},
			{ theme: "ryu-dark" },
		]) {
			expect(parseInterfaceColorTheme(raw, PLUGIN)).toBeUndefined();
		}
	});

	test("never throws on a hostile getter", () => {
		const hostile = {
			get dark(): string {
				throw new Error("boom");
			},
			light: "ryu",
		};
		expect(parseInterfaceColorTheme(hostile, PLUGIN)).toEqual({ light: "ryu" });
	});

	test("an empty plugin id only admits built-in presets", () => {
		expect(
			parseInterfaceColorTheme({ dark: ":night", light: "ryu" }, "")
		).toEqual({ light: "ryu" });
	});
});

describe("interfaceColorThemeId", () => {
	test("reads the slot for a mode", () => {
		const theme = { dark: `${PLUGIN}:night` };
		expect(interfaceColorThemeId(theme, "dark")).toBe(`${PLUGIN}:night`);
		expect(interfaceColorThemeId(theme, "light")).toBeUndefined();
		expect(interfaceColorThemeId(undefined, "dark")).toBeUndefined();
	});
});

describe("parseInterfaceContribution colorTheme", () => {
	const row = {
		id: `${PLUGIN}:town`,
		label: "Pixel Town",
		params: { theme: "night" },
		plugin: PLUGIN,
		renderer: "world-2d",
	};

	test("carries a valid colorTheme onto the descriptor", () => {
		expect(
			parseInterfaceContribution({
				...row,
				colorTheme: { dark: `${PLUGIN}:night`, light: `${PLUGIN}:day` },
			})
		).toEqual({
			colorTheme: { dark: `${PLUGIN}:night`, light: `${PLUGIN}:day` },
			description: "",
			id: `${PLUGIN}:town`,
			label: "Pixel Town",
			origin: "marketplace",
			params: { theme: "night" },
			plugin: PLUGIN,
			renderer: "world-2d",
		});
	});

	test("drops foreign slots and keeps the interface", () => {
		const descriptor = parseInterfaceContribution({
			...row,
			colorTheme: { dark: "@other/plugin:night", light: "ryu" },
		});
		expect(descriptor?.colorTheme).toEqual({ light: "ryu" });
	});

	test("omits the field when absent or fully invalid", () => {
		const absent = parseInterfaceContribution(row);
		expect(absent).not.toBeNull();
		expect(absent && "colorTheme" in absent).toBe(false);
		const invalid = parseInterfaceContribution({
			...row,
			colorTheme: { dark: "@other/plugin:night" },
		});
		expect(invalid).not.toBeNull();
		expect(invalid && "colorTheme" in invalid).toBe(false);
		const wrongType = parseInterfaceContribution({
			...row,
			colorTheme: "ryu-dark",
		});
		expect(wrongType).not.toBeNull();
		expect(wrongType && "colorTheme" in wrongType).toBe(false);
	});

	test("survives list parsing", () => {
		const [descriptor] = parseInterfaceContributions([
			{ ...row, colorTheme: { dark: "ryu-dark" } },
		]);
		expect(descriptor?.colorTheme).toEqual({ dark: "ryu-dark" });
	});
});
