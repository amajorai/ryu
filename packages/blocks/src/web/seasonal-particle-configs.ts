import type { ParticleShape } from "./seasonal-particle-shapes.ts";
import type { Season } from "./seasons.ts";

type Range = readonly [number, number];

export interface ParticleKind {
	/** Palette for the resolved theme; particles pick one color each. */
	colors: (isDark: boolean) => readonly string[];
	/** Seconds a particle lives before it respawns at the edge. */
	life: Range;
	shape: ParticleShape;
	size: Range;
	/** Vertical speed in px/s. */
	speed: Range;
	/** Horizontal drift amplitude in px. */
	sway: Range;
	/** Relative share of the particles. */
	weight: number;
}

export interface ParticleConfig {
	count: number;
	direction: "up" | "down";
	kinds: readonly ParticleKind[];
}

const fixed = (colors: readonly string[]) => () => colors;

const NEW_YEAR_CONFETTI = [
	"#a864fd",
	"#29cdff",
	"#78ff44",
	"#ff718d",
	"#fdff6a",
];
const GOLD_FLECKS = ["#facc15", "#eab308"];

export const SEASON_PARTICLES: Record<Season, ParticleConfig> = {
	// Confetti tumbling down with a few gold sparkles.
	newyear: {
		direction: "down",
		count: 55,
		kinds: [
			{
				shape: "confetti",
				weight: 0.85,
				colors: fixed(NEW_YEAR_CONFETTI),
				size: [6, 10],
				speed: [40, 90],
				sway: [10, 40],
				life: [40, 40],
			},
			{
				shape: "dot",
				weight: 0.15,
				colors: fixed(GOLD_FLECKS),
				size: [1, 2],
				speed: [25, 45],
				sway: [10, 25],
				life: [40, 40],
			},
		],
	},
	// Plum blossom petals and gold flecks, with the odd red packet.
	lunarnewyear: {
		direction: "down",
		count: 45,
		kinds: [
			{
				shape: "petal",
				weight: 0.8,
				colors: fixed(["#f9a8d4", "#fbcfe8", "#f472b6"]),
				size: [4, 7],
				speed: [20, 45],
				sway: [15, 40],
				life: [40, 40],
			},
			{
				shape: "dot",
				weight: 0.14,
				colors: fixed(GOLD_FLECKS),
				size: [1, 2],
				speed: [20, 40],
				sway: [10, 25],
				life: [40, 40],
			},
			{
				shape: "packet",
				weight: 0.06,
				colors: fixed(["#dc2626"]),
				size: [9, 12],
				speed: [25, 40],
				sway: [10, 25],
				life: [40, 40],
			},
		],
	},
	valentines: {
		direction: "up",
		count: 40,
		kinds: [
			{
				shape: "heart",
				weight: 1,
				colors: fixed(["#f43f5e", "#ec4899", "#fb7185", "#e11d48"]),
				size: [4, 9],
				speed: [20, 50],
				sway: [10, 30],
				life: [6, 12],
			},
		],
	},
	// Pastel eggs tumbling down, with a rare golden one.
	easter: {
		direction: "down",
		count: 35,
		kinds: [
			{
				shape: "egg",
				weight: 0.95,
				colors: fixed(["#f9a8d4", "#fde68a", "#a5f3fc", "#c4b5fd", "#bbf7d0"]),
				size: [6, 10],
				speed: [25, 55],
				sway: [10, 30],
				life: [40, 40],
			},
			{
				shape: "egg",
				weight: 0.05,
				colors: fixed(["#eab308"]),
				size: [9, 12],
				speed: [30, 45],
				sway: [10, 25],
				life: [40, 40],
			},
		],
	},
	// Sparks and the odd ghost drifting up: snow in reverse.
	halloween: {
		direction: "up",
		count: 60,
		kinds: [
			{
				shape: "dot",
				weight: 0.92,
				colors: fixed([
					"hsl(15, 95%, 55%)",
					"hsl(28, 95%, 55%)",
					"hsl(40, 95%, 55%)",
				]),
				size: [1, 3],
				speed: [25, 85],
				sway: [10, 35],
				life: [4, 9],
			},
			{
				shape: "ghost",
				weight: 0.08,
				colors: (isDark) =>
					isDark ? ["rgba(255, 255, 255, 0.85)"] : ["rgba(113, 113, 122, 0.7)"],
				size: [10, 16],
				speed: [20, 40],
				sway: [20, 40],
				life: [8, 12],
			},
		],
	},
	// Soft snow. On the light theme it is a pale blue-grey so it still shows.
	christmas: {
		direction: "down",
		count: 70,
		kinds: [
			{
				shape: "flake",
				weight: 1,
				colors: (isDark) =>
					isDark
						? ["rgba(255, 255, 255, 0.9)", "rgba(226, 232, 240, 0.8)"]
						: ["rgba(148, 163, 184, 0.75)", "rgba(125, 211, 252, 0.6)"],
				size: [1, 4],
				speed: [20, 60],
				sway: [10, 40],
				life: [40, 40],
			},
		],
	},
};
