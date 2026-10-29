"use client";
import type { CSSProperties } from "react";
import css from "./animated-gradient.module.css";

interface Inline1Style extends CSSProperties {
	"--animated-gradient-1-background"?: CSSProperties["background"];
	"--animated-gradient-1-border-radius"?: CSSProperties["borderRadius"];
}

import { isNativeText } from "../../lib/native-primitive-observation.ts";

// spell.sh/components/animated-gradient
//
// The Animated Gradient, as this repo ships it: paper's `Warp` shader under six
// named presets, with a STATIC paint of the same preset always underneath it.
//
// WHY THE STATIC LAYER IS NOT OPTIONAL. This renders through WebGL, not CSS.
// Browsers cap simultaneous WebGL contexts (~16) and evict the OLDEST one to
// honour a new request, so a surface that mounts many of these does not degrade
// gracefully — it kills its own earlier instances. Sentry RUST-2A on this app is
// already that failure ("InvalidStateError: Failed to execute
// transferToImageBitmap … WebGL context is lost"). Three consequences, all
// enforced here rather than documented:
//
//  1. `live` is OPT-IN and defaults to false. A caller that does not ask for the
//     shader gets a plain painted div — no canvas, no context, no rAF. Grids and
//     lists are therefore static by construction, not by discipline.
//  2. The static paint is the element's own `background`, painted whether or not
//     the canvas mounts. An evicted or failed context leaves that paint standing
//     instead of a hole, which is the difference between "the animation stopped"
//     and "the hero went black".
//  3. `prefers-reduced-motion` UNMOUNTS the canvas rather than freezing time.
//     Upstream gives no reduced-motion guidance and the obvious reading —
//     `speed: 0` — still holds a GL context and still runs the compositor. Stopped
//     means stopped.
//
// The static paint is derived from the SAME preset table the shader reads, so a
// preset edit cannot desync the two. It is a CSS approximation (a three-stop ramp
// plus two radial pools), not a captured frame: a frame would be a raster asset
// per preset per palette, and authors supply their own colours.
//
// PROVENANCE OF THE NUMBERS. `prism` is exact — its uniforms are the ones
// `apps/web/src/lib/og-prism.ts` already froze to re-derive this same look on the
// CPU for social cards, which are upstream's documented defaults. The other five
// are house interpretations of the named looks, not upstream-exact values; they
// live in one table so correcting one is a one-place edit.

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Component,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useState,
} from "react";
import { isNativeNumber } from "../../lib/native-primitive-observation.ts";

/** The six named looks. `prism` is the default, as upstream. */
export type AnimatedGradientPreset =
	| "lava"
	| "prism"
	| "plasma"
	| "pulse"
	| "vortex"
	| "mist";

/** The base pattern the colour field is warped over. */
export type GradientPattern = "checks" | "stripes" | "edge";

export const DEFAULT_ANIMATED_GRADIENT_PRESET: AnimatedGradientPreset = "prism";

/**
 * A gradient as an AUTHOR writes it — the 0-100 slider form the component's own
 * docs use, not the shader's uniforms.
 *
 * One wire convention, deliberately: a manifest author copying upstream's config
 * block writes `swirl: 80` / `shapeSize: 10`, and the uniforms those mean are
 * `0.8` / `0.1`. Everything marked "0-100" below is divided by 100 exactly once,
 * in {@link resolveAnimatedGradient}. Accepting both forms would make `swirl: 80`
 * render flat for half of all authors.
 *
 * Every field is optional and every field may arrive from an untrusted manifest,
 * so every number is clamped and every non-finite value is dropped on resolve.
 * The COLOURS are not validated here — they reach a CSS sink as well as the
 * shader, and the caller owns that guard (in the catalog that is
 * `safeCssBackground`).
 */
export interface AnimatedGradientConfig {
	/** First ramp stop. */
	color1?: string;
	/** Middle ramp stop. */
	color2?: string;
	/** Last ramp stop. */
	color3?: string;
	/** Noise-driven warp strength, 0-100. */
	distortion?: number;
	/** Horizontal recentring, -100 to 100. */
	offset?: number;
	/** Where the ramp's midpoint sits, 0-100. */
	proportion?: number;
	/** Whole-field rotation in DEGREES (not a 0-100 slider), 0-360. */
	rotation?: number;
	/** Whole-field zoom, 0.01-4 (not a 0-100 slider). */
	scale?: number;
	/** Base pattern. Matched case-insensitively, so upstream's `Checks` works. */
	shape?: GradientPattern;
	/** Base-pattern zoom, 0-100. */
	shapeSize?: number;
	/** Edge hardness between stops, 0-100 (100 = fully smooth). */
	softness?: number;
	/** Animation rate, 0-100. `0` is a still field. */
	speed?: number;
	/** Swirl strength, 0-100. */
	swirl?: number;
	/** Layered swirl passes, 0-20 (a count, not a slider). */
	swirlIterations?: number;
}

/** Complete manifest input before the resolver normalizes its pattern name.
 * Presets retain their closed authored pattern owner above. */
export interface AnimatedGradientInputConfig
	extends Omit<AnimatedGradientConfig, "shape"> {
	shape?: string;
}

/** The uniforms the shader and the static paint both read. */
export interface ResolvedAnimatedGradient {
	colors: string[];
	distortion: number;
	offsetX: number;
	proportion: number;
	rotation: number;
	scale: number;
	shape: GradientPattern;
	shapeScale: number;
	softness: number;
	speed: number;
	swirl: number;
	swirlIterations: number;
}

const PATTERN_KINDS: GradientPattern[] = ["checks", "stripes", "edge"];

/**
 * The preset table. Colours are the three stops; the rest are the authored
 * 0-100 form, so a preset and an author's config are the same shape and merge
 * by plain spread.
 */
export const ANIMATED_GRADIENT_PRESETS = {
	/** Upstream's default, and the one set of numbers here that is exact — see the
	 *  file header. Violet through the brand blue into aqua. */
	prism: {
		color1: "#5b2fd1",
		color2: "#0099ff",
		color3: "#3ce0d0",
		distortion: 12,
		offset: 0,
		proportion: 35,
		rotation: 0,
		scale: 1,
		shape: "checks",
		shapeSize: 10,
		softness: 100,
		speed: 25,
		swirl: 80,
		swirlIterations: 10,
	},
	/** Slow, heavy, molten: a split edge rather than a lattice, so the two halves
	 *  crawl past each other instead of shimmering. */
	lava: {
		color1: "#2a0a05",
		color2: "#ff4d1c",
		color3: "#ffb347",
		distortion: 20,
		offset: 0,
		proportion: 45,
		rotation: 0,
		scale: 1.2,
		shape: "edge",
		shapeSize: 6,
		softness: 100,
		speed: 12,
		swirl: 60,
		swirlIterations: 8,
	},
	/** Banded and electric — stripes read as sheets of colour folding over. */
	plasma: {
		color1: "#0b0b2e",
		color2: "#7b2ff7",
		color3: "#f107a3",
		distortion: 30,
		offset: 0,
		proportion: 50,
		rotation: 20,
		scale: 1,
		shape: "stripes",
		shapeSize: 14,
		softness: 90,
		speed: 35,
		swirl: 70,
		swirlIterations: 12,
	},
	/** Fast and shallow: little distortion, so the field breathes rather than
	 *  churns. */
	pulse: {
		color1: "#04121f",
		color2: "#0099ff",
		color3: "#8ef6e4",
		distortion: 6,
		offset: 0,
		proportion: 30,
		rotation: 0,
		scale: 0.9,
		shape: "checks",
		shapeSize: 18,
		softness: 100,
		speed: 55,
		swirl: 40,
		swirlIterations: 6,
	},
	/** Maximum swirl passes — the most obviously in-motion of the six. */
	vortex: {
		color1: "#120024",
		color2: "#ff2e88",
		color3: "#00d4ff",
		distortion: 24,
		offset: 0,
		proportion: 40,
		rotation: 0,
		scale: 1.1,
		shape: "checks",
		shapeSize: 8,
		softness: 100,
		speed: 30,
		swirl: 95,
		swirlIterations: 20,
	},
	/** Pale and nearly still. The one preset that reads on a light surface. */
	mist: {
		color1: "#eef2f7",
		color2: "#c9d6e8",
		color3: "#a8b6d6",
		distortion: 8,
		offset: 0,
		proportion: 55,
		rotation: 0,
		scale: 1.6,
		shape: "edge",
		shapeSize: 4,
		softness: 100,
		speed: 8,
		swirl: 35,
		swirlIterations: 6,
	},
} satisfies Record<AnimatedGradientPreset, Required<AnimatedGradientConfig>>;

export const ANIMATED_GRADIENT_PRESET_NAMES =
	// SAFETY: This immediate module-initialization snapshot reads the six own enumerable string keys of the just-created complete preset literal. Its keys are exactly AnimatedGradientPreset; no external mutation can occur between the initializer and this statement.
	Object.keys(ANIMATED_GRADIENT_PRESETS) as AnimatedGradientPreset[];

/** Is this string one of the six? The authority for any untrusted input. */
export function isAnimatedGradientPreset<T>(
	value: T
): value is T & AnimatedGradientPreset {
	return isNativeText(value) && Object.hasOwn(ANIMATED_GRADIENT_PRESETS, value);
}

/** Is this string one of the three base patterns? Case-insensitive, because
 *  upstream's docs capitalise them (`Checks`). */
export function toGradientPattern<PatternInput>(
	value: PatternInput
): GradientPattern | null {
	if (!isNativeText(value)) {
		return null;
	}
	const lower = value.trim().toLowerCase();
	return PATTERN_KINDS.find((s) => s === lower) ?? null;
}

/**
 * Clamp a number into a range, dropping anything non-finite.
 *
 * This is the DoS guard, not a tidiness pass: these values become shader
 * uniforms, and `swirlIterations: 1e6` or `scale: 1e9` from a third-party
 * manifest is a loop the GPU runs — a frozen tab, not a bad-looking banner.
 */
const clampNumber = <NumericInput,>(
	value: NumericInput,
	min: number,
	max: number,
	fallback: number
): number => {
	if (!(isNativeNumber(value) && Number.isFinite(value))) {
		return fallback;
	}
	return Math.min(max, Math.max(min, value));
};

/** A 0-100 authored slider as its 0-1 uniform. */
const slider = <SliderInput,>(value: SliderInput, fallback: number): number =>
	clampNumber(value, 0, 100, fallback) / 100;

/**
 * A preset plus an author's overrides, as bounded uniforms.
 *
 * ONE resolver for both the shader and the static paint. Deriving the CSS
 * approximation from anything else is how a preset edit ends up changing the
 * live hero and not the 60 cards behind it.
 */
export function resolveAnimatedGradient(
	input?: {
		config?: AnimatedGradientInputConfig | null;
		preset?: AnimatedGradientPreset | null;
	} | null
): ResolvedAnimatedGradient {
	const base =
		ANIMATED_GRADIENT_PRESETS[
			input?.preset && isAnimatedGradientPreset(input.preset)
				? input.preset
				: DEFAULT_ANIMATED_GRADIENT_PRESET
		];
	const cfg = { ...base, ...input?.config };
	const colors = [cfg.color1, cfg.color2, cfg.color3].filter(
		(c): c is string => isNativeText(c) && c.trim().length > 0
	);
	return {
		colors:
			colors.length > 0 ? colors : [base.color1, base.color2, base.color3],
		distortion: slider(cfg.distortion, base.distortion),
		offsetX: clampNumber(cfg.offset, -100, 100, base.offset) / 100,
		proportion: slider(cfg.proportion, base.proportion),
		rotation: clampNumber(cfg.rotation, 0, 360, base.rotation),
		scale: clampNumber(cfg.scale, 0.01, 4, base.scale),
		shape: toGradientPattern(cfg.shape) ?? base.shape,
		shapeScale: slider(cfg.shapeSize, base.shapeSize),
		softness: slider(cfg.softness, base.softness),
		speed: slider(cfg.speed, base.speed),
		swirl: slider(cfg.swirl, base.swirl),
		// A count, not a slider: upstream's own loop breaks at 20.
		swirlIterations: Math.round(
			clampNumber(cfg.swirlIterations, 0, 20, base.swirlIterations)
		),
	};
}

/** How far the ramp midpoint is allowed from either end, so a `proportion` at
 *  the extremes still reads as three colours rather than two. */
const MIN_MID_STOP = 15;
const MAX_MID_STOP = 85;
/** The linear ramp's base angle. The shader's `rotation: 0` is a field with no
 *  particular direction; 135° is what the rest of the catalog paints a two-stop
 *  ramp at, so an un-rotated gradient matches its neighbours. */
const BASE_ANGLE = 135;

/**
 * The static paint for a resolved gradient: what a card, a list row, a
 * reduced-motion viewer and a lost WebGL context all get.
 *
 * A CSS approximation rather than a captured frame — a frame would be a raster
 * per preset per palette, and the palette is author-supplied. It keeps the three
 * colours, their ordering, the ramp's midpoint and the rotation, which is what
 * makes a card recognisably the same listing as its animated hero. It does not
 * try to reproduce the warp; the two radial pools stand in for the depth the
 * swirl gives the live version.
 */
export function animatedGradientCss(r: ResolvedAnimatedGradient): string {
	const [first, second, third] = r.colors;
	const start = first ?? "transparent";
	const mid = second ?? start;
	const end = third ?? mid;
	const stop = Math.min(
		MAX_MID_STOP,
		Math.max(MIN_MID_STOP, Math.round(r.proportion * 100))
	);
	const angle = (BASE_ANGLE + r.rotation) % 360;
	return [
		`radial-gradient(120% 120% at 12% 18%, ${start} 0%, transparent 58%)`,
		`radial-gradient(110% 110% at 88% 24%, ${end} 0%, transparent 52%)`,
		`linear-gradient(${angle}deg, ${start} 0%, ${mid} ${stop}%, ${end} 100%)`,
	].join(", ");
}

/** The whole shader package is loaded on demand and ONLY for a live instance:
 *  it is a WebGL runtime plus every shader in the library, and the static path —
 *  which is what SSR, every card and every reduced-motion viewer renders — has
 *  no use for a byte of it. */
const LazyWarp = lazy(async () => {
	const mod = await import("@paper-design/shaders-react");
	return { default: mod.Warp };
});

/** Cap the GL surface: a hero at 3x DPR on a wide monitor is millions of pixels
 *  of fragment shader per frame for a decoration. */
const MAX_SHADER_PIXELS = 1280 * 720;

/**
 * Anything the shader throws — a refused context, a lost one, a chunk that fails
 * to load — must leave the static paint standing rather than take the page down
 * with it. That is the whole point of painting the background on the wrapper.
 */
// biome-ignore lint/style/useReactFunctionComponents: error boundaries must be class components
class ShaderBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		return this.state.failed ? null : this.props.children;
	}
}

/**
 * True when this instance may hold a WebGL context.
 *
 * Three gates, in order: the caller asked (`live`), we are in a browser (the
 * effect never runs on the server, so SSR is always static and hydration cannot
 * mismatch), and the viewer has not asked for reduced motion. The media query is
 * SUBSCRIBED, not sampled once — flipping the OS setting mid-session unmounts
 * the canvas, which is what "stop the animation" has to mean.
 */
function useLiveShader(live: boolean): boolean {
	const [allowed, setAllowed] = useState(false);
	useEffect(() => {
		if (!live || globalThis.window === undefined || !window.matchMedia) {
			setAllowed(false);
			return;
		}
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const sync = () => setAllowed(!query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => {
			query.removeEventListener("change", sync);
		};
	}, [live]);
	return allowed;
}

export interface AnimatedGradientProps {
	className?: string;
	/** Author overrides on top of the preset. */
	config?: AnimatedGradientInputConfig | null;
	/**
	 * Mount the WebGL shader. DEFAULT FALSE, and that default is the feature: a
	 * caller has to name itself as a place where one or two contexts are
	 * affordable (a detail hero), so cards, grids and list rows are static without
	 * having to know any of this.
	 */
	live?: boolean;
	preset?: AnimatedGradientPreset | null;
	/** CSS border-radius for the painted box. */
	radius?: number | string;
	style?: React.CSSProperties;
}

export function AnimatedGradient({
	className,
	config,
	live = false,
	preset,
	radius,
	style,
}: AnimatedGradientProps) {
	const resolved = resolveAnimatedGradient({ config, preset });
	const animate = useLiveShader(live);
	const inline1Style: Inline1Style = {
		"--animated-gradient-1-background": animatedGradientCss(resolved),
		"--animated-gradient-1-border-radius":
			radius === undefined
				? undefined
				: isNativeText(radius)
					? radius
					: `${radius}px`,
		...style,
	};
	return (
		<div
			aria-hidden="true"
			className={[
				css.inline1,
				cn("relative isolate overflow-hidden", className),
			].join(" ")}
			style={inline1Style}
		>
			{animate ? (
				<ShaderBoundary>
					<Suspense fallback={null}>
						<LazyWarp
							className="absolute inset-0 size-full"
							colors={resolved.colors}
							distortion={resolved.distortion}
							maxPixelCount={MAX_SHADER_PIXELS}
							offsetX={resolved.offsetX}
							proportion={resolved.proportion}
							rotation={resolved.rotation}
							scale={resolved.scale}
							shape={resolved.shape}
							shapeScale={resolved.shapeScale}
							softness={resolved.softness}
							speed={resolved.speed}
							swirl={resolved.swirl}
							swirlIterations={resolved.swirlIterations}
						/>
					</Suspense>
				</ShaderBoundary>
			) : null}
		</div>
	);
}

export default AnimatedGradient;
