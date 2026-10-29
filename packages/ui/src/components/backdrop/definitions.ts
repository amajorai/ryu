// packages/ui/src/components/backdrop/definitions.ts
//
// The universal backdrop registry. One list feeds wallpapers, banners and any
// other surface that wants an animated or patterned background, so adding an
// entry here makes it available everywhere at once.
//
// Every entry is one of four renderer kinds:
// - `paper`     → a @paper-design shader (WebGL), loaded lazily.
// - `component` → a React renderer from this folder (canvas 2D or CSS), or the
//                 existing spell.sh-style AnimatedGradient / dither washes.
// - `css`       → a host-owned CSS renderer for validated, data-only styles.
// - `custom`    → a user-supplied component, rendered in a sandbox by the host
//                 (see `customBackdrop`); the registry only carries its schema.
//
// Looks inspired by public galleries (spell.sh, beui, componentry, Aceternity,
// 21st.dev, React Bits, Pace UI) are original re-implementations or tuned
// paper shaders; no third-party component source is vendored here.

import type { ShaderSizingParams } from "@paper-design/shaders-react";
import { z } from "zod";
import { PALETTE } from "../dither-kit/palette.ts";
import { ANIMATED_GRADIENT_PRESET_NAMES } from "../motion/animated-gradient.tsx";
import { PAPER_SHADER_DEFAULTS, type PaperShaderId } from "./paper-defaults.ts";
import {
	type BackdropParamSpec,
	type BackdropParams,
	isSafeColor,
	specsFromDefaults,
} from "./params.ts";

export const BACKDROP_CATEGORIES = [
	"Gradients",
	"Light",
	"Liquid",
	"Space",
	"Patterns",
	"Geometric",
	"Decorative",
	"Effects",
	"Shader library",
	"Custom",
] as const;

export type BackdropCategory = (typeof BACKDROP_CATEGORIES)[number];

export type BackdropComponentId =
	| "animated-gradient"
	| "dither"
	| "warp-starfield"
	| "twinkling-stars"
	| "shooting-stars"
	| "topo-field"
	| "dotted-globe"
	| "particles"
	| "flowing-lines"
	| "grid"
	| "dots"
	| "radial-glow"
	| "drifting-blobs"
	| "floating-shapes"
	| "flickering-grid"
	| "meteors"
	| "retro-grid"
	| "ripple"
	| "stripes";

/** CSS properties accepted by the marketplace wallpaper adapter. */
export interface BackdropCssStyle {
	animation?: string;
	background?: string;
	backgroundBlendMode?: string;
	backgroundColor?: string;
	backgroundImage?: string;
	backgroundPosition?: string;
	backgroundRepeat?: string;
	backgroundSize?: string;
	boxShadow?: string;
	filter?: string;
	imageRendering?: string;
	maskComposite?: string;
	maskImage?: string;
	mixBlendMode?: string;
	opacity?: number;
	WebkitMaskComposite?: string;
	WebkitMaskImage?: string;
}

export type BackdropRender =
	| {
			/** Sizing props (scale, offsets) that are fixed, not customizable. */
			fixed?: ShaderSizingParams;
			kind: "paper";
			shader: PaperShaderId;
	  }
	| { kind: "component"; component: BackdropComponentId }
	| { kind: "css"; style: BackdropCssStyle }
	| { kind: "custom"; source: string };

export interface BackdropDefinition {
	/** Whether the backdrop moves at all (patterns are fixed). */
	animated: boolean;
	category: BackdropCategory;
	description: string;
	id: string;
	label: string;
	params: readonly BackdropParamSpec[];
	render: BackdropRender;
}

function paper(
	id: string,
	label: string,
	category: BackdropCategory,
	shader: PaperShaderId,
	description: string,
	overrides: BackdropParams = {},
	fixed?: ShaderSizingParams
): BackdropDefinition {
	const defaults = {
		...PAPER_SHADER_DEFAULTS[shader].params,
		...overrides,
	};
	return {
		animated: "speed" in defaults,
		category,
		description,
		id,
		label,
		params: specsFromDefaults(shader, defaults),
		render: { fixed, kind: "paper", shader },
	};
}

function component(
	id: BackdropComponentId,
	label: string,
	category: BackdropCategory,
	description: string,
	params: BackdropParamSpec[],
	animated = true
): BackdropDefinition {
	return {
		animated,
		category,
		description,
		id,
		label,
		params,
		render: { component: id, kind: "component" },
	};
}

const color = (
	key: string,
	label: string,
	value: string
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "color",
	label,
});
const colorList = (
	key: string,
	label: string,
	value: string[]
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "colors",
	label,
	max: 8,
	min: 1,
});
const slider = (
	key: string,
	label: string,
	value: number,
	min: number,
	max: number,
	step = 0.01
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "number",
	label,
	max,
	min,
	step,
});
const toggle = (
	key: string,
	label: string,
	value: boolean
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "boolean",
	label,
});
const select = (
	key: string,
	label: string,
	value: string,
	options: readonly string[]
): BackdropParamSpec => ({
	default: value,
	key,
	kind: "select",
	label,
	options,
});

const DITHER_COLORS = Object.keys(PALETTE);

const NAMED: BackdropDefinition[] = [
	// Gradients
	component(
		"animated-gradient",
		"Animated gradient",
		"Gradients",
		"A warped three-colour gradient with named moods.",
		[
			select("preset", "Mood", "prism", ANIMATED_GRADIENT_PRESET_NAMES),
			color("color1", "First colour", "#5b21b6"),
			color("color2", "Middle colour", "#ec4899"),
			color("color3", "Last colour", "#f59e0b"),
			slider("speed", "Speed", 30, 0, 100, 1),
			slider("swirl", "Swirl", 60, 0, 100, 1),
			slider("distortion", "Distortion", 20, 0, 100, 1),
		]
	),
	paper(
		"mesh-gradient",
		"Mesh gradient",
		"Gradients",
		"mesh-gradient",
		"Soft colour fields that melt into each other.",
		{
			colors: ["#ff6b6b", "#4d96ff", "#ffd93d", "#6bcb77"],
			distortion: 0.9,
			swirl: 0.5,
		}
	),
	paper(
		"aurora-flow",
		"Aurora flow",
		"Gradients",
		"mesh-gradient",
		"Northern-lights greens and violets drifting over night sky.",
		{
			colors: ["#0b1026", "#1de9b6", "#7c4dff", "#00b0ff"],
			distortion: 1,
			grainOverlay: 0.05,
			speed: 0.6,
			swirl: 0.8,
		}
	),
	paper(
		"silk-aurora",
		"Silk aurora",
		"Gradients",
		"warp",
		"Silky ribbons of colour folding slowly.",
		{
			colors: ["#1b1464", "#7b2ff7", "#f107a3", "#ffd6ff"],
			distortion: 0.15,
			shape: "stripes",
			shapeScale: 0.3,
			softness: 1,
			speed: 0.4,
			swirl: 0.4,
		}
	),
	paper(
		"grain-gradient",
		"Grain gradient",
		"Gradients",
		"grain-gradient",
		"A film-grain gradient wave.",
		{
			shape: "wave",
		}
	),
	component(
		"drifting-blobs",
		"Drifting blobs",
		"Gradients",
		"Blurred colour blobs drifting around.",
		[
			color("background", "Background", "#0b0b14"),
			colorList("colors", "Colours", [
				"#6366f1",
				"#ec4899",
				"#22d3ee",
				"#f59e0b",
			]),
			slider("speed", "Speed", 1, 0.1, 4),
			slider("blur", "Blur", 80, 20, 160, 1),
		]
	),
	// Light
	paper(
		"light-rays",
		"Light rays",
		"Light",
		"god-rays",
		"Soft rays of light pouring from above.",
		{
			colorBack: "#05060f",
			colorBloom: "#4f46e5",
			colors: ["#ffffff80", "#a5b4fc", "#f0abfc", "#67e8f9"],
			density: 0.35,
			intensity: 0.8,
		}
	),
	paper(
		"spectral-ribbon",
		"Spectral ribbon",
		"Light",
		"swirl",
		"A spinning ribbon of spectrum colours.",
		{
			bandCount: 6,
			colorBack: "#050505",
			colors: [
				"#ff3b30",
				"#ff9500",
				"#ffcc00",
				"#34c759",
				"#0a84ff",
				"#bf5af2",
			],
			speed: 0.3,
			twist: 0.3,
		}
	),
	paper(
		"closing-plasma",
		"Closing plasma",
		"Light",
		"warp",
		"Hot plasma closing in from the edges.",
		{
			colors: ["#1a0033", "#ff006e", "#fb5607", "#3a0ca3"],
			distortion: 0.5,
			shape: "edge",
			speed: 0.6,
			swirl: 0.9,
		}
	),
	component(
		"flowing-lines",
		"Flowing lines",
		"Light",
		"Fine threads of light waving across.",
		[
			color("background", "Background", "#07070c"),
			color("color", "Start colour", "#f0abfc"),
			color("accent", "End colour", "#60a5fa"),
			slider("lines", "Lines", 24, 4, 60, 1),
			slider("amplitude", "Amplitude", 0.5, 0, 1.5),
			slider("speed", "Speed", 0.5, 0, 3),
		]
	),
	// Liquid
	paper(
		"liquid-chrome",
		"Liquid chrome",
		"Liquid",
		"liquid-metal",
		"Polished chrome rippling like liquid.",
		{
			colorBack: "#0c0c0f",
			colorTint: "#ffffff",
			distortion: 0.2,
			repetition: 4,
			shape: "none",
			speed: 0.6,
		}
	),
	paper(
		"webgl-liquid",
		"Liquid drops",
		"Liquid",
		"metaballs",
		"Glowing liquid drops merging and splitting.",
		{
			colorBack: "#020617",
			colors: ["#38bdf8", "#818cf8", "#22d3ee"],
			count: 8,
			size: 0.9,
		}
	),
	paper(
		"clouds",
		"Clouds",
		"Liquid",
		"perlin-noise",
		"Soft clouds rolling across a blue sky.",
		{
			colorBack: "#4a90d9",
			colorFront: "#ffffff",
			lacunarity: 2,
			octaveCount: 5,
			persistence: 0.55,
			proportion: 0.45,
			softness: 0.6,
			speed: 0.15,
		},
		{ scale: 4 }
	),
	// Space
	component(
		"warp-starfield",
		"Warp starfield",
		"Space",
		"Stars streaking past at warp speed.",
		[
			color("background", "Background", "#02030a"),
			color("starColor", "Star colour", "#ffffff"),
			slider("count", "Stars", 500, 50, 1500, 10),
			slider("speed", "Speed", 1, 0, 4),
			toggle("trails", "Trails", true),
		]
	),
	component(
		"shooting-stars",
		"Shooting stars",
		"Space",
		"A twinkling night sky with shooting stars.",
		[
			color("background", "Background", "#030712"),
			color("starColor", "Star colour", "#ffffff"),
			color("meteorColor", "Shooting star colour", "#9ecbff"),
			slider("density", "Star density", 0.6, 0, 1),
			slider("twinkle", "Twinkle", 1, 0, 3),
			slider("frequency", "Shooting stars", 0.5, 0, 3),
		]
	),
	component(
		"twinkling-stars",
		"Stars",
		"Space",
		"A calm, twinkling starfield.",
		[
			color("background", "Background", "#030712"),
			color("starColor", "Star colour", "#ffffff"),
			slider("density", "Star density", 0.6, 0, 1),
			slider("twinkle", "Twinkle", 1, 0, 3),
		]
	),
	component(
		"dotted-globe",
		"Globe",
		"Space",
		"A slowly turning dotted globe.",
		[
			color("background", "Background", "#050816"),
			color("dotColor", "Dot colour", "#8ab4ff"),
			color("glowColor", "Glow", "#3b82f6"),
			slider("dots", "Dots", 1400, 300, 4000, 50),
			slider("size", "Size", 0.36, 0.15, 0.6),
			slider("speed", "Speed", 0.25, 0, 2),
		]
	),
	// Patterns
	component(
		"topo-field",
		"Topo field",
		"Patterns",
		"Topographic contour lines shifting like terrain.",
		[
			color("background", "Background", "#0b0f14"),
			color("lineColor", "Line colour", "#7dd3fc"),
			slider("levels", "Contours", 14, 4, 30, 1),
			slider("scale", "Scale", 1, 0.3, 3),
			slider("lineWidth", "Line width", 1, 0.5, 3, 0.1),
			slider("speed", "Speed", 0.3, 0, 2),
		]
	),
	component(
		"particles",
		"Particles",
		"Patterns",
		"Drifting particles linked by fine lines.",
		[
			color("background", "Background", "#0a0a12"),
			color("color", "Colour", "#c4b5fd"),
			slider("count", "Particles", 90, 20, 200, 1),
			slider("linkDistance", "Link distance", 120, 40, 240, 1),
			slider("speed", "Speed", 0.4, 0, 3),
		]
	),
	component(
		"grid",
		"Grid",
		"Patterns",
		"A fine grid that fades toward the edges.",
		[
			color("background", "Background", "#0a0a0a"),
			color("lineColor", "Line colour", "#ffffff1a"),
			slider("cellSize", "Cell size", 32, 8, 120, 1),
			toggle("fade", "Fade edges", true),
		],
		false
	),
	component(
		"dots",
		"Dots",
		"Patterns",
		"An evenly spaced dot pattern.",
		[
			color("background", "Background", "#0a0a0a"),
			color("dotColor", "Dot colour", "#ffffff33"),
			slider("spacing", "Spacing", 20, 8, 80, 1),
			slider("dotSize", "Dot size", 1, 0.5, 4, 0.1),
			toggle("fade", "Fade edges", true),
		],
		false
	),
	component(
		"radial-glow",
		"Radial glow",
		"Patterns",
		"A single soft glow on a dark base.",
		[
			color("background", "Background", "#050505"),
			color("glowColor", "Glow", "#7c3aed"),
			select("position", "Position", "top", ["top", "center", "bottom"]),
			slider("spread", "Spread", 60, 20, 120, 1),
		],
		false
	),
	component(
		"dither",
		"Dither wash",
		"Patterns",
		"Ryu's pixel dither glow.",
		[
			select("from", "Colour", DITHER_COLORS[0] ?? "blue", DITHER_COLORS),
			select("to", "Blend into", "transparent", [
				"transparent",
				...DITHER_COLORS,
			]),
			select("direction", "Direction", "up", ["up", "down", "left", "right"]),
			color("background", "Background", "#05060a"),
		],
		false
	),
	component(
		"flickering-grid",
		"Flickering grid",
		"Patterns",
		"A grid of tiny squares flickering on and off.",
		[
			color("background", "Background", "#050505"),
			color("color", "Square colour", "#6b7280"),
			slider("squareSize", "Square size", 4, 1, 16, 1),
			slider("gap", "Gap", 6, 1, 24, 1),
			slider("maxOpacity", "Max opacity", 0.3, 0.05, 1),
			slider("flicker", "Flicker", 0.3, 0, 3),
		]
	),
	component(
		"meteors",
		"Meteors",
		"Space",
		"Meteors streaking diagonally across.",
		[
			color("background", "Background", "#09090b"),
			color("color", "Meteor colour", "#e4e4e7"),
			slider("count", "Meteors", 20, 1, 60, 1),
			slider("angle", "Angle", 215, 180, 270, 1),
			slider("speed", "Speed", 1, 0.1, 4),
		]
	),
	component(
		"retro-grid",
		"Retro grid",
		"Patterns",
		"A synthwave grid rolling toward the horizon.",
		[
			color("background", "Background", "#07030f"),
			color("lineColor", "Line colour", "#a855f7"),
			slider("cellSize", "Cell size", 60, 20, 160, 1),
			slider("angle", "Tilt", 65, 30, 85, 1),
			slider("speed", "Speed", 1, 0.1, 4),
		]
	),
	component(
		"ripple",
		"Ripple",
		"Geometric",
		"Concentric rings pulsing from the centre.",
		[
			color("background", "Background", "#020617"),
			color("color", "Ring colour", "#94a3b8"),
			slider("rings", "Rings", 8, 2, 14, 1),
			slider("size", "Inner size", 210, 60, 400, 1),
			slider("speed", "Speed", 1, 0.1, 4),
		]
	),
	component(
		"stripes",
		"Stripes",
		"Patterns",
		"Diagonal pinstripes.",
		[
			color("background", "Background", "#0a0a0a"),
			color("color", "Stripe colour", "#ffffff14"),
			slider("width", "Width", 10, 2, 60, 1),
			slider("angle", "Angle", 45, 0, 180, 1),
		],
		false
	),
	// Geometric
	component(
		"floating-shapes",
		"Floating shapes",
		"Geometric",
		"Glassy pills floating over a dark field.",
		[
			color("background", "Background", "#030303"),
			colorList("colors", "Colours", [
				"#6366f1",
				"#f43f5e",
				"#8b5cf6",
				"#f59e0b",
				"#06b6d4",
			]),
			slider("speed", "Speed", 1, 0.1, 4),
		]
	),
];

/** Registry keys identify exactly the installed shader defaults. */
export const paperShaderIdSchema = z.custom<PaperShaderId>(
	(value) =>
		z
			.string()
			.refine((id) => Object.hasOwn(PAPER_SHADER_DEFAULTS, id))
			.safeParse(value).success
);

/** Every paper shader, as-is, so the full beui-style library is selectable. */
const LIBRARY: BackdropDefinition[] = Object.entries(PAPER_SHADER_DEFAULTS).map(
	([shader, definition]) =>
		paper(
			`shader-${shader}`,
			definition.label,
			"Shader library",
			paperShaderIdSchema.parse(shader),
			`The ${definition.label.toLowerCase()} shader with its default look.`
		)
);

export const BACKDROPS: readonly BackdropDefinition[] = [...NAMED, ...LIBRARY];

export function backdropById(id: string): BackdropDefinition | undefined {
	return BACKDROPS.find((item) => item.id === id);
}

/** Colours a static poster paints with, pulled from whichever params exist. */
function posterColors(params: BackdropParams): string[] {
	const found: string[] = [];
	for (const value of Object.values(params)) {
		if (Array.isArray(value)) {
			found.push(...value.filter(isSafeColor));
		} else if (isSafeColor(value)) {
			found.push(value);
		}
	}
	return found;
}

/**
 * A CSS background approximating the backdrop, painted underneath the live
 * renderer and used alone for grid thumbnails, reduced motion and failures.
 */
export function backdropPosterCss(params: BackdropParams): string {
	const background =
		(["background", "colorBack"] as const)
			.map((key) => params[key])
			.find(isSafeColor) ?? "#0b0b14";
	const palette = posterColors(params).filter((item) => item !== background);
	const [first = background, second = first, third = second] = palette;
	return [
		`radial-gradient(90% 80% at 20% 25%, ${first} 0%, transparent 60%)`,
		`radial-gradient(80% 80% at 80% 30%, ${second} 0%, transparent 55%)`,
		`radial-gradient(90% 90% at 50% 100%, ${third} 0%, transparent 60%)`,
		background,
	].join(", ");
}
