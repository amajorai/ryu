import { isNativeText } from "../lib/native-primitive-observation.ts";
import {
	blendExpressiveFrames,
	type ExpressiveExpressionSelection,
	type ExpressiveEye,
	expressiveFrame,
	type ResolvedExpressiveFrame,
} from "./expressive.ts";

/**
 * Ryu's expressive animation catalogue follows Bloub's state names and
 * measured cadence. The renderer keeps Ryu's ghost silhouette, but borrows the
 * useful part of the reference: a pure timeline sampler and cross-faded state
 * poses. See https://github.com/jeremy-prt/bloub (MIT).
 */
export const EXPRESSIVE_ANIMATION_IDS = [
	"idle",
	"thinking",
	"wink",
	"wide",
	"alert",
	"notify",
	"exclaim",
	"sleep",
	"egg",
	"hexagon",
	"play",
	"orbit",
	"burst",
	"comet",
] as const;

export type ExpressiveAnimation = (typeof EXPRESSIVE_ANIMATION_IDS)[number];
export type ExpressiveAnimationSelection = ExpressiveAnimation | "random";

export interface ExpressiveAnimationDefinition {
	description: string;
	duration: number;
	label: string;
	morph: number;
}

export const EXPRESSIVE_ANIMATIONS = {
	idle: {
		description: "The calm resting pose with the selected Ryu expression.",
		duration: 2.4,
		label: "Idle",
		morph: 0.45,
	},
	thinking: {
		description: "Three pulsing dots hover above the ghost while it thinks.",
		duration: 2.6,
		label: "Thinking",
		morph: 0.4,
	},
	wink: {
		description: "One eye closes into a quick, friendly wink.",
		duration: 1.6,
		label: "Wink",
		morph: 0.3,
	},
	wide: {
		description: "Wide eyes make the ghost look suddenly surprised.",
		duration: 1.8,
		label: "Wide eyes",
		morph: 0.55,
	},
	alert: {
		description: "A tilted exclamation bounces with an alert pulse.",
		duration: 2.4,
		label: "Alert",
		morph: 0.45,
	},
	notify: {
		description: "A notification badge pops in at the edge of the ghost.",
		duration: 2.2,
		label: "Notification",
		morph: 0.5,
	},
	exclaim: {
		description: "A clean exclamation mark rises above the ghost.",
		duration: 2,
		label: "Exclamation",
		morph: 0.45,
	},
	sleep: {
		description: "Sleepy eyes drift with a soft, buoyant bob.",
		duration: 2.4,
		label: "Sleep",
		morph: 0.5,
	},
	egg: {
		description: "The ghost squeezes into a gentle egg-like squash.",
		duration: 1.8,
		label: "Egg",
		morph: 0.4,
	},
	hexagon: {
		description: "A firmer, faceted lean gives the ghost a hexagonal beat.",
		duration: 1.6,
		label: "Hexagon",
		morph: 0.4,
	},
	play: {
		description: "A playful triangle sweeps across the ghost.",
		duration: 2,
		label: "Play",
		morph: 0.5,
	},
	orbit: {
		description: "Colourful orbit rings wrap around the moving ghost.",
		duration: 3.4,
		label: "Orbit",
		morph: 0.6,
	},
	burst: {
		description: "The ghost collapses into a burst of particles and reforms.",
		duration: 2.6,
		label: "Burst",
		morph: 0.4,
	},
	comet: {
		description:
			"A tight comet ribbon whips around the ghost before it returns.",
		duration: 2.4,
		label: "Comet",
		morph: 0.45,
	},
} as const satisfies Record<ExpressiveAnimation, ExpressiveAnimationDefinition>;

/** The measured Bloub default cycle, kept as a reusable Ryu cycle. */
export const EXPRESSIVE_ANIMATION_SEQUENCE = EXPRESSIVE_ANIMATION_IDS;

export const EXPRESSIVE_ANIMATION_OPTIONS = [
	{
		description: "Let Ryu move through every supported animation in one cycle.",
		label: "Random",
		value: "random" as const,
	},
	...EXPRESSIVE_ANIMATION_SEQUENCE.map((value) => ({
		description: EXPRESSIVE_ANIMATIONS[value].description,
		label: EXPRESSIVE_ANIMATIONS[value].label,
		value,
	})),
] satisfies readonly {
	description: string;
	label: string;
	value: ExpressiveAnimationSelection;
}[];

const EXPRESSIVE_ANIMATION_SET = new Set<string>(EXPRESSIVE_ANIMATION_IDS);

export interface ExpressiveAnimationBody {
	rotate: number;
	scaleX: number;
	scaleY: number;
	x: number;
	y: number;
}

export type ExpressiveAnimationDecoration =
	| {
			color?: string;
			kind: "dot";
			opacity: number;
			r: number;
			x: number;
			y: number;
	  }
	| {
			color?: string;
			cx: number;
			cy: number;
			dash: string;
			kind: "ring";
			opacity: number;
			radiusX: number;
			radiusY: number;
			rotate: number;
	  }
	| {
			color?: string;
			kind: "ray";
			opacity: number;
			x1: number;
			x2: number;
			y1: number;
			y2: number;
	  }
	| {
			color?: string;
			kind: "badge";
			opacity: number;
			r: number;
			x: number;
			y: number;
	  }
	| {
			kind: "exclamation";
			opacity: number;
			rotate: number;
			scale: number;
			x: number;
			y: number;
	  }
	| {
			color?: string;
			kind: "comet";
			opacity: number;
			rotate: number;
			scale: number;
			x: number;
			y: number;
	  }
	| {
			kind: "play";
			opacity: number;
			rotate: number;
			scale: number;
			x: number;
			y: number;
	  };

export interface ExpressiveAnimationFrame {
	animation: ExpressiveAnimation;
	body: ExpressiveAnimationBody;
	decorations: readonly ExpressiveAnimationDecoration[];
	eyeAlpha: number;
	eyes: ResolvedExpressiveFrame;
	followGaze: boolean;
	progress: number;
}

export interface SampledExpressiveAnimation extends ExpressiveAnimationFrame {
	elapsed: number;
	totalDuration: number;
}

const clamp = (value: number, min = 0, max = 1): number =>
	Math.min(max, Math.max(min, value));

const lerp = (from: number, to: number, progress: number): number =>
	from + (to - from) * progress;

const easeOutCubic = (value: number): number => 1 - (1 - value) ** 3;
const easeOutQuint = (value: number): number => 1 - (1 - value) ** 5;

function safeTime(time: number): number {
	return Number.isFinite(time) ? Math.max(time, 0) : 0;
}

function dotPulse(time: number, index: number): number {
	const phase = ((((time - index * 0.5) / 1.5) % 1) + 1) % 1;
	return phase < 0.5 ? Math.sin(phase * Math.PI) : 0;
}

function eyePatch(
	frame: ResolvedExpressiveFrame,
	index: 0 | 1,
	patch: Partial<ExpressiveEye>
): ResolvedExpressiveFrame {
	const eyes: [ExpressiveEye, ExpressiveEye] = [...frame.eyes];
	eyes[index] = { ...eyes[index], ...patch };
	return { ...frame, eyes };
}

function eyesForAnimation(
	animation: ExpressiveAnimation,
	selected: ResolvedExpressiveFrame
): ResolvedExpressiveFrame {
	switch (animation) {
		case "idle":
			return selected;
		case "thinking":
		case "orbit":
			return expressiveFrame("curious");
		case "wink":
			return eyePatch(eyePatch(selected, 0, { height: 2.55, tilt: -8 }), 1, {
				height: 0.62,
				open: 1,
				tilt: -18,
				width: 2.25,
			});
		case "wide":
			return expressiveFrame("surprised");
		case "alert":
			return expressiveFrame("scared");
		case "notify":
			return expressiveFrame("attentive");
		case "exclaim":
			return expressiveFrame("excited");
		case "sleep":
			return expressiveFrame("sleepy");
		case "egg":
			return expressiveFrame("shy");
		case "hexagon":
			return expressiveFrame("skeptical");
		case "play":
			return expressiveFrame("excited");
		case "burst":
		case "comet":
			return expressiveFrame("surprised");
	}
}

function hsl(hue: number): string {
	return `hsl(${Math.round(hue % 360)} 78% 64%)`;
}

function ringsForAnimation(time: number): ExpressiveAnimationDecoration[] {
	return Array.from({ length: 6 }, (_, index) => ({
		color: hsl(index * 60 + 18),
		cx: 12,
		cy: 11.8,
		dash: `${5.2 + index * 0.25} ${8.8 - index * 0.25}`,
		kind: "ring" as const,
		opacity: 0.48 + (index % 2) * 0.12,
		radiusX: 7.1 + index * 0.18,
		radiusY: 1.25 + (index % 3) * 0.22,
		rotate: index * 31 - time * (82 + index * 11),
	}));
}

function burstForAnimation(time: number): ExpressiveAnimationDecoration[] {
	const burstProgress = easeOutQuint(clamp(time / 0.7));
	const fade = clamp((2.45 - time) / 0.65);
	return Array.from({ length: 8 }, (_, index) => {
		const angle = (index / 8) * Math.PI * 2;
		const inner = 3.2 + burstProgress * 1.2;
		const outer = 4.8 + burstProgress * 2.8;
		return {
			color: hsl(index * 45 + 12),
			kind: "ray" as const,
			opacity: fade * (0.45 + (index % 2) * 0.2),
			x1: 12 + Math.cos(angle) * inner,
			x2: 12 + Math.cos(angle) * outer,
			y1: 11.8 + Math.sin(angle) * inner,
			y2: 11.8 + Math.sin(angle) * outer,
		};
	});
}

function poseForState(
	animation: ExpressiveAnimation,
	localTime: number,
	selected: ResolvedExpressiveFrame
): ExpressiveAnimationFrame {
	const definition = EXPRESSIVE_ANIMATIONS[animation];
	const time = safeTime(localTime);
	const progress = clamp(time / definition.duration);
	const body: ExpressiveAnimationBody = {
		rotate: 0,
		scaleX: 1,
		scaleY: 1,
		x: 0,
		y: 0,
	};
	let eyeAlpha = 1;
	let decorations: ExpressiveAnimationDecoration[] = [];

	switch (animation) {
		case "thinking":
			body.scaleY = 1 + Math.sin(time * Math.PI * 2.4) * 0.018;
			decorations = Array.from({ length: 3 }, (_, index) => {
				const pulse = dotPulse(time, index);
				return {
					kind: "dot" as const,
					opacity: 0.42 + pulse * 0.58,
					r: 0.38 + pulse * 0.17,
					x: 8.4 + index * 3.6,
					y: 2.25,
				};
			});
			break;
		case "wink":
			body.rotate = Math.sin(time * Math.PI * 2) * 1.5;
			break;
		case "wide":
			body.scaleX = 1 + Math.sin(time * Math.PI * 2) * 0.012;
			break;
		case "alert":
			body.rotate = Math.sin(time * Math.PI * 5) * 1.4;
			body.y = Math.sin(time * Math.PI * 5) * 0.16;
			decorations = [
				{
					kind: "exclamation",
					opacity: 0.95,
					rotate: 17.7 + Math.sin(time * Math.PI * 5) * 2,
					scale: 0.78,
					x: 17.2 + Math.sin(time * Math.PI * 2.5) * 0.6,
					y: 2.45,
				},
			];
			break;
		case "notify": {
			const pop = 1 + 0.14 * Math.sin(clamp(time / 0.45) * Math.PI);
			decorations = [
				{
					color: "#2496e8",
					kind: "badge",
					opacity: 1,
					r: 0.85 * pop,
					x: 20.9,
					y: 3.45,
				},
			];
			break;
		}
		case "exclaim":
			body.y = Math.sin(time * Math.PI * 2) * 0.08;
			decorations = [
				{
					kind: "exclamation",
					opacity: 1,
					rotate: 0,
					scale: 0.92,
					x: 17.2,
					y: 2.25,
				},
			];
			break;
		case "sleep":
			body.y = 0.2 + Math.sin(time * ((Math.PI * 2) / 0.6)) * 0.18;
			body.scaleY = 0.98 + Math.sin(time * ((Math.PI * 2) / 0.6)) * 0.012;
			decorations = [
				{
					kind: "dot",
					opacity: 0.45,
					r: 0.28,
					x: 19.5,
					y: 2.4 + Math.sin(time * 2.4) * 0.25,
				},
				{
					kind: "dot",
					opacity: 0.7,
					r: 0.2,
					x: 20.8,
					y: 1.45 + Math.sin(time * 2.4 + 1) * 0.25,
				},
			];
			break;
		case "egg":
			body.rotate = -7;
			body.scaleX = 0.84;
			body.scaleY = 1.06;
			body.x = 0.35;
			break;
		case "hexagon":
			body.rotate = -5;
			body.scaleX = 0.93;
			body.scaleY = 1.02;
			body.x = 0.2;
			break;
		case "play":
			body.rotate = -6;
			body.scaleX = 0.96;
			body.scaleY = 1.03;
			decorations = [
				{
					kind: "play",
					opacity:
						clamp(time / 0.35) * clamp((definition.duration - time) / 0.5),
					rotate: -8 + time * 40,
					scale: 0.74,
					x: 12.5 - time * 2.2,
					y: 14.2,
				},
			];
			break;
		case "orbit":
			body.rotate = -time * 38;
			body.scaleX = 1 + Math.sin(time * Math.PI * 1.4) * 0.015;
			decorations = ringsForAnimation(time);
			break;
		case "burst": {
			const collapse = 1 - 0.834 * easeOutQuint(clamp(time / 0.7));
			const regrow = easeOutQuint(clamp((time - 1.7) / 0.7));
			const size = collapse + (1 - collapse) * regrow;
			body.scaleX = size;
			body.scaleY = size;
			eyeAlpha = clamp((time - 1.85) / 0.4);
			decorations = burstForAnimation(time);
			break;
		}
		case "comet": {
			const collapse = 1 - 0.76 * easeOutQuint(clamp(time / 0.55));
			const regrow = easeOutQuint(clamp((time - 1.85) / 0.6));
			const size = collapse + (1 - collapse) * regrow;
			body.scaleX = size;
			body.scaleY = size;
			eyeAlpha = clamp((time - 2) / 0.35);
			const fade = clamp((time - 0.15) / 0.25) * clamp((1.95 - time) / 0.3);
			decorations = Array.from({ length: 4 }, (_, index) => ({
				color: hsl(index * 85 + 20),
				kind: "comet" as const,
				opacity: fade * (0.55 + index * 0.08),
				rotate: 34 + index * 2 - time * 210,
				scale: 0.82 + index * 0.03,
				x: 12,
				y: 11.8,
			}));
			break;
		}
		case "idle":
			break;
	}

	return {
		animation,
		body,
		decorations,
		eyeAlpha,
		eyes: eyesForAnimation(animation, selected),
		followGaze: animation === "idle",
		progress,
	};
}

export function isExpressiveAnimation<T>(
	value: T
): value is T & ExpressiveAnimation {
	return isNativeText(value) && EXPRESSIVE_ANIMATION_SET.has(value);
}

export function isExpressiveAnimationSelection<T>(
	value: T
): value is T & ExpressiveAnimationSelection {
	return value === "random" || isExpressiveAnimation(value);
}

export function randomExpressiveAnimation(): ExpressiveAnimation {
	const index = Math.floor(Math.random() * EXPRESSIVE_ANIMATION_IDS.length);
	return EXPRESSIVE_ANIMATION_IDS[index] ?? "idle";
}

export function expressiveAnimationLabel(
	value: ExpressiveAnimationSelection
): string {
	return value === "random" ? "Random" : EXPRESSIVE_ANIMATIONS[value].label;
}

export function expressiveAnimationPreviewTime(
	value: ExpressiveAnimation
): number {
	return {
		alert: 0.75,
		burst: 0.45,
		comet: 1.15,
		egg: 0.8,
		exclaim: 0.8,
		hexagon: 0.8,
		idle: 1,
		notify: 0.9,
		orbit: 1.2,
		play: 0.9,
		sleep: 0.45,
		thinking: 1.1,
		wide: 0.8,
		wink: 0.8,
	}[value];
}

function totalDurationFor(selection: ExpressiveAnimationSelection): number {
	const states: readonly ExpressiveAnimation[] =
		selection === "random" ? EXPRESSIVE_ANIMATION_SEQUENCE : [selection];
	return states.reduce(
		(total, state) => total + EXPRESSIVE_ANIMATIONS[state].duration,
		0
	);
}

function blendAnimationFrames(
	from: ExpressiveAnimationFrame,
	to: ExpressiveAnimationFrame,
	progress: number
): ExpressiveAnimationFrame {
	const t = clamp(progress);
	return {
		animation: to.animation,
		body: {
			rotate: lerp(from.body.rotate, to.body.rotate, t),
			scaleX: lerp(from.body.scaleX, to.body.scaleX, t),
			scaleY: lerp(from.body.scaleY, to.body.scaleY, t),
			x: lerp(from.body.x, to.body.x, t),
			y: lerp(from.body.y, to.body.y, t),
		},
		decorations: [
			...from.decorations.map((decoration) => ({
				...decoration,
				opacity: decoration.opacity * (1 - t),
			})),
			...to.decorations.map((decoration) => ({
				...decoration,
				opacity: decoration.opacity * t,
			})),
		],
		eyeAlpha: lerp(from.eyeAlpha, to.eyeAlpha, t),
		eyes: blendExpressiveFrames(from.eyes, to.eyes, t),
		followGaze: to.followGaze,
		progress: to.progress,
	};
}

/**
 * Pure timeline sampling. Every frame is reproducible from `time`, which keeps
 * pause/resume, reduced-motion previews, and browser tests deterministic while
 * still allowing a real requestAnimationFrame driver in the component.
 */
export function sampleExpressiveAnimation(
	time: number,
	selection: ExpressiveAnimationSelection = "random",
	expression:
		| ExpressiveExpressionSelection
		| ResolvedExpressiveFrame = "neutral"
): SampledExpressiveAnimation {
	const states =
		selection === "random" ? EXPRESSIVE_ANIMATION_SEQUENCE : [selection];
	const totalDuration = totalDurationFor(selection);
	const wrapped =
		totalDuration > 0
			? ((safeTime(time) % totalDuration) + totalDuration) % totalDuration
			: 0;
	const selected = isNativeText(expression)
		? expressiveFrame(expression === "random" ? "neutral" : expression)
		: expression;

	let offset = 0;
	let index = states.length - 1;
	for (let candidate = 0; candidate < states.length; candidate += 1) {
		const duration = EXPRESSIVE_ANIMATIONS[states[candidate]!].duration;
		if (wrapped < offset + duration) {
			index = candidate;
			break;
		}
		offset += duration;
	}

	const animation = states[index] ?? "idle";
	const definition = EXPRESSIVE_ANIMATIONS[animation];
	const localTime = wrapped - offset;
	const current = poseForState(animation, localTime, selected);
	const previousAnimation =
		states[(index - 1 + states.length) % states.length] ?? animation;
	const previous = poseForState(
		previousAnimation,
		EXPRESSIVE_ANIMATIONS[previousAnimation].duration,
		selected
	);
	const morphProgress = easeOutCubic(clamp(localTime / definition.morph));
	const frame = blendAnimationFrames(previous, current, morphProgress);

	return {
		...frame,
		elapsed: wrapped,
		totalDuration,
	};
}
