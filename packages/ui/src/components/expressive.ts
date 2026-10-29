/**
 * Ryu's expressive eye language.
 *
 * The compact control geometry is an original adaptation inspired by the
 * open-source Bloub avatar project (MIT): https://github.com/jeremy-prt/bloub
 * The ghost body remains Ryu's own mark; only the independent eye controls are
 * shared between the named expressions and the random animation cycle.
 */

import { isNativeText } from "../lib/native-primitive-observation.ts";
export const EXPRESSIVE_EXPRESSION_IDS = [
	"neutral",
	"attentive",
	"surprised",
	"excited",
	"happy",
	"laughing",
	"angry",
	"sad",
	"scared",
	"skeptical",
	"confused",
	"curious",
	"proud",
	"shy",
	"unimpressed",
	"sleepy",
	"dead",
] as const;

export type ExpressiveExpression = (typeof EXPRESSIVE_EXPRESSION_IDS)[number];
export type ExpressiveExpressionSelection = ExpressiveExpression | "random";

export type EyeContour = "oval" | "x";

export interface ExpressiveEye {
	height: number;
	open: number;
	shape: EyeContour;
	tilt: number;
	width: number;
}

export interface ExpressiveExpressionFrame {
	description: string;
	eyes: readonly [ExpressiveEye, ExpressiveEye];
	gap: number;
	gaze: {
		x: number;
		y: number;
		roll: number;
	};
	label: string;
}

export interface ResolvedExpressiveFrame extends ExpressiveExpressionFrame {
	id: ExpressiveExpression;
}

const eye = (
	width: number,
	height: number,
	tilt = 0,
	open = 1,
	contour: EyeContour = "oval"
): ExpressiveEye => ({ height, open, shape: contour, tilt, width });

const xEye = (size: number): ExpressiveEye => eye(size, size, 0, 1, "x");

/** Measured, base-24 controls for the Ryu ghost's two independent eyes. */
export const EXPRESSIVE_EXPRESSIONS = {
	neutral: {
		description: "The original Ryu gaze, with a calm open face.",
		eyes: [eye(1.5, 3), eye(1.5, 3)],
		gap: 4,
		gaze: { roll: 0, x: 0, y: 0 },
		label: "Neutral",
	},
	attentive: {
		description: "Focused and listening closely.",
		eyes: [eye(1.35, 2.9, -4), eye(1.35, 2.9, -4)],
		gap: 4.1,
		gaze: { roll: -3, x: 0.3, y: -0.2 },
		label: "Attentive",
	},
	surprised: {
		description: "Wide-eyed and caught off guard.",
		eyes: [eye(2.85, 3.1), eye(2.85, 3.1)],
		gap: 5,
		gaze: { roll: 0, x: 0, y: -0.4 },
		label: "Surprised",
	},
	excited: {
		description: "Bright, alert, and ready to move.",
		eyes: [eye(2.55, 3.65, -10), eye(2.55, 3.65, 10)],
		gap: 5.4,
		gaze: { roll: 0, x: 0.4, y: -0.7 },
		label: "Excited",
	},
	happy: {
		description: "A soft, unmistakably happy smile in the eyes.",
		eyes: [eye(1.7, 1.1, 14), eye(1.7, 1.1, -14)],
		gap: 4.5,
		gaze: { roll: 0, x: 0.3, y: 0.2 },
		label: "Happy",
	},
	laughing: {
		description: "Joyful squints for a full laugh.",
		eyes: [eye(2.15, 0.85, 20), eye(2.15, 0.85, -20)],
		gap: 4.8,
		gaze: { roll: 0, x: 0.2, y: 0.3 },
		label: "Laughing",
	},
	angry: {
		description: "Lowered, determined brows without changing the ghost body.",
		eyes: [eye(2.15, 0.98, 30), eye(2.15, 0.98, -30)],
		gap: 4.5,
		gaze: { roll: 0, x: 0.1, y: 0.15 },
		label: "Angry",
	},
	sad: {
		description: "Downturned eyes and a quiet, tender gaze.",
		eyes: [eye(1.4, 2.6, -28), eye(1.4, 2.6, 28)],
		gap: 4,
		gaze: { roll: 0, x: 0.1, y: 0.4 },
		label: "Sad",
	},
	scared: {
		description: "Wide, tense eyes looking for a way out.",
		eyes: [eye(2.55, 3.9), eye(2.55, 3.9)],
		gap: 5.4,
		gaze: { roll: 0, x: 0, y: -0.8 },
		label: "Scared",
	},
	skeptical: {
		description: "One brow up, one eye unconvinced.",
		eyes: [eye(1.35, 2.6, -8), eye(1.4, 0.98, 18)],
		gap: 4.1,
		gaze: { roll: -4, x: 0.6, y: 0.1 },
		label: "Skeptical",
	},
	confused: {
		description: "Two different questions at once.",
		eyes: [eye(1.3, 2.9, -18), eye(1.8, 1.1, 14)],
		gap: 3.8,
		gaze: { roll: 8, x: -0.5, y: -0.1 },
		label: "Confused",
	},
	curious: {
		description: "Leaning into the next interesting detail.",
		eyes: [eye(1.55, 3, -8), eye(1.3, 2.5, -8)],
		gap: 3.8,
		gaze: { roll: -8, x: 0.8, y: -0.3 },
		label: "Curious",
	},
	proud: {
		description: "A lifted chin and a small knowing smile.",
		eyes: [eye(1.9, 0.98, 18), eye(1.9, 0.98, -18)],
		gap: 4.5,
		gaze: { roll: 0, x: 0.3, y: 0.4 },
		label: "Proud",
	},
	shy: {
		description: "Averted, bashful eyes.",
		eyes: [eye(1.1, 1.95, -4), eye(1.1, 1.95, -4)],
		gap: 3.3,
		gaze: { roll: -4, x: -0.7, y: -0.4 },
		label: "Shy",
	},
	unimpressed: {
		description: "Flat eyes for a very measured reaction.",
		eyes: [eye(1.9, 0.78), eye(1.9, 0.78)],
		gap: 4,
		gaze: { roll: 0, x: -0.8, y: 0 },
		label: "Unimpressed",
	},
	sleepy: {
		description: "Half-open eyes drifting toward a nap.",
		eyes: [eye(1.3, 2.75, 0, 0.42), eye(1.3, 2.75, 0, 0.42)],
		gap: 4,
		gaze: { roll: -3, x: 0.2, y: 0.1 },
		label: "Sleepy",
	},
	dead: {
		description: "Crossed-out eyes for a fully crashed-out Ryu.",
		eyes: [xEye(2.4), xEye(2.4)],
		gap: 4.4,
		gaze: { roll: 0, x: 0, y: 0 },
		label: "Dead",
	},
} as const satisfies Record<ExpressiveExpression, ExpressiveExpressionFrame>;

const EXPRESSIVE_EXPRESSION_SET = new Set<string>(EXPRESSIVE_EXPRESSION_IDS);

export const EXPRESSIVE_EXPRESSION_OPTIONS = [
	{
		description: "Let Ryu drift through expressions on its own.",
		label: "Random",
		value: "random" as const,
	},
	...EXPRESSIVE_EXPRESSION_IDS.map((value) => ({
		description: EXPRESSIVE_EXPRESSIONS[value].description,
		label: EXPRESSIVE_EXPRESSIONS[value].label,
		value,
	})),
] satisfies readonly {
	description: string;
	label: string;
	value: ExpressiveExpressionSelection;
}[];

export function isExpressiveExpression<T>(
	value: T
): value is T & ExpressiveExpression {
	return isNativeText(value) && EXPRESSIVE_EXPRESSION_SET.has(value);
}

export function isExpressiveExpressionSelection<T>(
	value: T
): value is T & ExpressiveExpressionSelection {
	return value === "random" || isExpressiveExpression(value);
}

export function randomExpressiveExpression(): ExpressiveExpression {
	const index = Math.floor(Math.random() * EXPRESSIVE_EXPRESSION_IDS.length);
	return EXPRESSIVE_EXPRESSION_IDS[index] ?? "neutral";
}

export function expressiveExpressionLabel(
	value: ExpressiveExpressionSelection
): string {
	if (value === "random") {
		return "Random";
	}
	return EXPRESSIVE_EXPRESSIONS[value].label;
}

export function expressiveFrame(
	value: ExpressiveExpressionSelection
): ResolvedExpressiveFrame {
	const id = value === "random" ? "neutral" : value;
	return { ...EXPRESSIVE_EXPRESSIONS[id], id };
}

const lerp = (from: number, to: number, progress: number): number =>
	from + (to - from) * progress;

/** Interpolate the independent eye controls for a smooth expression change. */
export function blendExpressiveFrames(
	from: ResolvedExpressiveFrame,
	to: ResolvedExpressiveFrame,
	progress: number
): ResolvedExpressiveFrame {
	const t = Math.max(0, Math.min(1, progress));
	return {
		description: to.description,
		eyes: [
			{
				height: lerp(from.eyes[0].height, to.eyes[0].height, t),
				open: lerp(from.eyes[0].open, to.eyes[0].open, t),
				shape: t < 0.5 ? from.eyes[0].shape : to.eyes[0].shape,
				tilt: lerp(from.eyes[0].tilt, to.eyes[0].tilt, t),
				width: lerp(from.eyes[0].width, to.eyes[0].width, t),
			},
			{
				height: lerp(from.eyes[1].height, to.eyes[1].height, t),
				open: lerp(from.eyes[1].open, to.eyes[1].open, t),
				shape: t < 0.5 ? from.eyes[1].shape : to.eyes[1].shape,
				tilt: lerp(from.eyes[1].tilt, to.eyes[1].tilt, t),
				width: lerp(from.eyes[1].width, to.eyes[1].width, t),
			},
		],
		gap: lerp(from.gap, to.gap, t),
		gaze: {
			roll: lerp(from.gaze.roll, to.gaze.roll, t),
			x: lerp(from.gaze.x, to.gaze.x, t),
			y: lerp(from.gaze.y, to.gaze.y, t),
		},
		id: to.id,
		label: to.label,
	};
}
