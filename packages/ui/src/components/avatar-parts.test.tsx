import { describe, expect, test } from "bun:test";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { AvatarContributionsProvider } from "./avatar-contributions.tsx";
import {
	type AvatarContributions,
	isAvatarPaint,
	isAvatarTransform,
	parseAvatarContributions,
	resolveAvatarStyle,
} from "./avatar-parts.ts";
import { GhostAvatarControls } from "./ghost-avatar-controls.tsx";
import { PLAIN_COSTUME, parseGhostCostume } from "./ghost-costume.ts";
import { asGlyphValue } from "./glyph.ts";
import { GlyphDisplay } from "./glyph-display.tsx";

const beanie = {
	id: "@acme/hats:beanie" as const,
	label: "Beanie",
	target: "ghost",
	region: "headwear",
	plugin: "@acme/hats",
	shapes: [
		{ type: "path", d: "M12 2 Q18 -3 24 2 Z", fill: "palette.deep" },
		{ type: "circle", cx: 18, cy: -2, r: 1.2, fill: "#ffffff" },
	],
};

const robot = {
	id: "@acme/robots:robot",
	label: "Robot",
	plugin: "@acme/robots",
	viewBox: [0, 0, 64, 64],
	palettes: [
		{
			id: "steel",
			label: "Steel",
			base: "#9aa5b1",
			light: "#e4e7eb",
			deep: "#3e4c59",
		},
		{
			id: "rust",
			label: "Rust",
			base: "#c26a3d",
			light: "#f2c4a5",
			deep: "#6b2e12",
		},
	],
	base: [
		{
			type: "rect",
			x: 12,
			y: 14,
			width: 40,
			height: 38,
			rx: 8,
			fill: "palette.base",
		},
	],
	regions: [
		{
			id: "eyes",
			label: "Eyes",
			options: [
				{
					id: "dots",
					label: "Dots",
					shapes: [{ type: "circle", cx: 24, cy: 30, r: 3, fill: "ink" }],
				},
				{
					id: "visor",
					label: "Visor",
					shapes: [
						{ type: "rect", x: 18, y: 26, width: 28, height: 6, fill: "ink" },
					],
				},
			],
		},
		{
			id: "antenna",
			label: "Antenna",
			layer: "behind",
			optional: true,
			options: [
				{
					id: "single",
					label: "Single",
					shapes: [
						{
							type: "line",
							x1: 32,
							y1: 14,
							x2: 32,
							y2: 4,
							stroke: "palette.deep",
						},
					],
				},
			],
		},
	],
};

const spring = {
	id: "@acme/hats:spring",
	label: "Spring antenna",
	target: "@acme/robots:robot",
	region: "antenna",
	shapes: [
		{ type: "polyline", points: "32,14 30,10 34,8 30,4", stroke: "ink" },
	],
};

const contributions: AvatarContributions = parseAvatarContributions(
	[beanie, spring],
	[robot]
);

describe("parseAvatarContributions", () => {
	test("keeps valid rows and applies defaults", () => {
		expect(contributions.accessories.map((row): string => row.id)).toEqual([
			beanie.id,
			spring.id,
		]);
		expect(contributions.accessories[0]?.layer).toBe("front");
		expect(contributions.styles[0]?.regions[0]?.optional).toBe(false);
	});

	test("drops markup-shaped, unbounded, foreign, and duplicate rows", () => {
		const parsed = parseAvatarContributions(
			[
				beanie,
				beanie,
				{ ...beanie, id: "@acme/hats:x", plugin: "@other/hats" },
				{ ...beanie, id: "@acme/hats:y", region: "tail" },
				{
					...beanie,
					id: "@acme/hats:z",
					shapes: [{ type: "path", d: "M0 0 <script>" }],
				},
				{
					...beanie,
					id: "@acme/hats:u",
					shapes: [{ type: "circle", r: 1, fill: "url(#steal)" }],
				},
				{ ...beanie, id: "@acme/hats:f", shapes: [{ type: "foreignObject" }] },
			],
			[{ ...robot, viewBox: [0, 0, 0, 64] }, "nope"]
		);
		expect(parsed.accessories.map((row): string => row.id)).toEqual([
			beanie.id,
		]);
		expect(parsed.styles).toEqual([]);
	});

	test("paint and transform grammars stay inert", () => {
		expect(isAvatarPaint("palette.deep")).toBe(true);
		expect(isAvatarPaint("#abcdef80")).toBe(true);
		for (const bad of ["url(#x)", "red", "var(--x)", "#12345"]) {
			expect(isAvatarPaint(bad)).toBe(false);
		}
		expect(isAvatarTransform("translate(18 1.3) rotate(15)")).toBe(true);
		expect(isAvatarTransform("expression(alert(1))")).toBe(false);
		expect(isAvatarTransform("rotate(")).toBe(false);
	});
});

describe("resolveAvatarStyle", () => {
	const style = contributions.styles[0];
	if (!style) {
		throw new Error("robot style must parse");
	}

	test("a seed always resolves to the same look", () => {
		const first = resolveAvatarStyle(style, { seed: "aria" });
		expect(resolveAvatarStyle(style, { seed: "aria" })).toEqual(first);
		expect(["steel", "rust"]).toContain(first.paletteId);
	});

	test("explicit picks win, including another plugin's accessory", () => {
		const resolved = resolveAvatarStyle(
			style,
			{
				seed: "aria",
				palette: "rust",
				parts: { eyes: "visor", antenna: spring.id },
			},
			contributions.accessories
		);
		expect(resolved.paletteId).toBe("rust");
		expect(resolved.picks).toEqual({ eyes: "visor", antenna: spring.id });
		expect(resolved.behind.map((part) => part.id)).toEqual([spring.id]);
		expect(resolved.front.map((part) => part.id)).toEqual(["visor"]);
	});

	test("optional regions accept none and unknown picks fall back to the seed", () => {
		const resolved = resolveAvatarStyle(style, {
			seed: "aria",
			parts: { antenna: "none", eyes: "@gone/pack:eyes" },
		});
		expect(resolved.picks.antenna).toBe("none");
		expect(["dots", "visor"]).toContain(resolved.picks.eyes ?? "");
	});
});

describe("persisted selections", () => {
	test("costume region slots keep contributed ids; colour and finish do not", () => {
		expect(
			parseGhostCostume({
				headwear: beanie.id,
				palette: "@acme/hats:pink",
				finish: "@acme/hats:chrome",
			})
		).toEqual({ ...PLAIN_COSTUME, headwear: beanie.id });
	});

	test("avatar_style glyphs round-trip and reject unsafe picks", () => {
		const stored = {
			kind: "avatar_style",
			style: robot.id,
			seed: "aria",
			palette: "rust",
			parts: { eyes: "visor", antenna: spring.id, "bad key": "x", hat: "<b>" },
		};
		expect(asGlyphValue(stored)).toEqual({
			kind: "avatar_style",
			style: robot.id,
			seed: "aria",
			palette: "rust",
			parts: { eyes: "visor", antenna: spring.id },
		});
		expect(
			asGlyphValue({ kind: "avatar_style", style: "robot", seed: "a" })
		).toBeUndefined();
	});
});

async function renderAll(node: React.ReactNode): Promise<string> {
	const stream = await renderToReadableStream(node);
	await stream.allReady;
	return new Response(stream).text();
}

describe("rendering", () => {
	test("a contributed ghost accessory replaces the built-in region", async () => {
		const html = await renderAll(
			<AvatarContributionsProvider value={contributions}>
				<GlyphDisplay
					size={40}
					value={{
						kind: "expressive",
						expression: "happy",
						variant: "costume",
						costume: { ...PLAIN_COSTUME, headwear: beanie.id },
					}}
				/>
			</AvatarContributionsProvider>
		);
		expect(html).toContain(`data-avatar-part="${beanie.id}"`);
		expect(html).not.toContain("<script");
	});

	test("a contributed style renders, and falls back when its plugin is off", async () => {
		const value = {
			kind: "avatar_style" as const,
			style: robot.id,
			seed: "aria",
			parts: { antenna: spring.id },
		};
		const html = await renderAll(
			<AvatarContributionsProvider value={contributions}>
				<GlyphDisplay size={40} value={value} />
			</AvatarContributionsProvider>
		);
		expect(html).toContain(`data-avatar-style="${robot.id}"`);
		expect(html).toContain(`data-avatar-part="${spring.id}"`);
		const fallback = await renderAll(
			<GlyphDisplay fallback={<i>fallback</i>} size={40} value={value} />
		);
		expect(fallback).toContain("fallback");
		expect(fallback).not.toContain("data-avatar-style");
	});

	test("costume controls offer marketplace accessories for their region", () => {
		const controls = renderToStaticMarkup(
			<AvatarContributionsProvider value={contributions}>
				<GhostAvatarControls
					onChange={() => undefined}
					value={{ variant: "costume" }}
				/>
			</AvatarContributionsProvider>
		);
		expect(controls).toContain('label="From Marketplace"');
		expect(controls).toContain(`value="${beanie.id}"`);
		expect(controls).not.toContain(`value="${spring.id}"`);
	});
});
