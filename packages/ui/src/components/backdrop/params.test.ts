import { describe, expect, test } from "bun:test";
import { BACKDROPS, backdropById, backdropPosterCss } from "./definitions.ts";
import {
	type BackdropParamSpec,
	isSafeColor,
	resolveBackdropParams,
	specsFromDefaults,
} from "./params.ts";

const SPECS: BackdropParamSpec[] = [
	{ default: "#000000", key: "background", kind: "color", label: "Background" },
	{
		default: ["#ff0000"],
		key: "colors",
		kind: "colors",
		label: "Colours",
		max: 3,
		min: 1,
	},
	{
		default: 1,
		key: "speed",
		kind: "number",
		label: "Speed",
		max: 3,
		min: 0,
		step: 0.1,
	},
	{ default: true, key: "fade", kind: "boolean", label: "Fade" },
	{
		default: "top",
		key: "position",
		kind: "select",
		label: "Position",
		options: ["top", "bottom"],
	},
];

describe("isSafeColor", () => {
	test("accepts colour literals only", () => {
		expect(isSafeColor("#fff")).toBe(true);
		expect(isSafeColor("#a600ff6e")).toBe(true);
		expect(isSafeColor("rgb(1, 2, 3)")).toBe(true);
		expect(isSafeColor("hsla(10, 50%, 50%, 0.5)")).toBe(true);
		expect(isSafeColor("red; background:url(x)")).toBe(false);
		expect(isSafeColor("url(https://x)")).toBe(false);
		expect(isSafeColor(42)).toBe(false);
	});
});

describe("resolveBackdropParams", () => {
	test("fills defaults and drops unknown keys", () => {
		const resolved = resolveBackdropParams(SPECS, { evil: "x" });
		expect(resolved).toEqual({
			background: "#000000",
			colors: ["#ff0000"],
			fade: true,
			position: "top",
			speed: 1,
		});
	});

	test("clamps numbers and rejects bad values", () => {
		const resolved = resolveBackdropParams(SPECS, {
			background: "javascript:alert(1)",
			colors: ["#00ff00", "nope", "#0000ff", "#111", "#222"],
			fade: "yes",
			position: "left",
			speed: 99,
		});
		expect(resolved.background).toBe("#000000");
		expect(resolved.colors).toEqual(["#00ff00", "#0000ff", "#111"]);
		expect(resolved.fade).toBe(true);
		expect(resolved.position).toBe("top");
		expect(resolved.speed).toBe(3);
	});

	test("treats NaN and non-objects as defaults", () => {
		expect(resolveBackdropParams(SPECS, { speed: Number.NaN }).speed).toBe(1);
		expect(resolveBackdropParams(SPECS, "junk").speed).toBe(1);
	});
});

test("legacy array and inherited property sources retain their declared-control semantics", () => {
	const specs = [
		{
			default: 1.1,
			key: "length",
			kind: "number",
			label: "Length",
			max: 10,
			min: 0,
			step: 0.1,
		},
	] satisfies BackdropParamSpec[];
	expect(resolveBackdropParams(specs, [])).toEqual({ length: 0 });
	expect(resolveBackdropParams(specs, ["a", "b"])).toEqual({ length: 2 });
	expect(resolveBackdropParams(SPECS, Object.create({ speed: 2 })).speed).toBe(
		2
	);
});

describe("specsFromDefaults", () => {
	test("derives controls from shader defaults", () => {
		const specs = specsFromDefaults("warp", {
			colors: ["#121212", "#9470ff"],
			edges: false,
			shape: "checks",
			speed: 1,
			unknownText: "abc",
		});
		const byKey = Object.fromEntries(specs.map((spec) => [spec.key, spec]));
		expect(byKey.colors?.kind).toBe("colors");
		expect(byKey.edges?.kind).toBe("boolean");
		expect(byKey.shape?.kind).toBe("select");
		expect(byKey.speed?.kind).toBe("number");
		expect(byKey.unknownText).toBeUndefined();
	});
});

describe("registry", () => {
	test("ids are unique and every entry has a poster", () => {
		const ids = BACKDROPS.map((item) => item.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const item of BACKDROPS) {
			const css = backdropPosterCss(resolveBackdropParams(item.params, {}));
			expect(css.length).toBeGreaterThan(10);
		}
	});

	test("includes the requested looks", () => {
		for (const id of [
			"light-rays",
			"animated-gradient",
			"liquid-chrome",
			"warp-starfield",
			"shooting-stars",
			"topo-field",
			"dotted-globe",
			"grid",
			"shader-mesh-gradient",
		]) {
			expect(backdropById(id)).toBeDefined();
		}
	});
});

test("rejects stored oversized functional colors before regex evaluation", () => {
	const started = performance.now();
	expect(isSafeColor(`rgb(${"1".repeat(4000)}!`)).toBe(false);
	expect(isSafeColor(`hsl(${"1".repeat(4000)}!`)).toBe(false);
	expect(performance.now() - started).toBeLessThan(100);
	expect(isSafeColor("rgb(12, 34, 56)")).toBe(true);
});
