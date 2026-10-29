"use client";

import type { MotionStyle } from "motion/react";
import {
	animate,
	motion,
	useAnimationFrame,
	useMotionTemplate,
	useMotionValue,
	useReducedMotion,
	useSpring,
	useTransform,
} from "motion/react";
import type { CSSProperties } from "react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { isNativeNumber } from "../lib/native-primitive-observation.ts";
import { cn } from "../lib/utils.ts";
import { DitherAvatar, ditherAvatarHue } from "./dither-kit/avatar.tsx";
import { hueFill } from "./dither-kit/pixel.ts";
import { Logo } from "./logo.tsx";
import { METAL_EDGE_RING_PX, MetalEdge } from "./metal-edge.tsx";
import { ShaderBackground } from "./motion/shader-background.tsx";
import drawingStyles from "./pass-card-shell.drawing.module.css";
import styles from "./pass-card-shell.module.css";
import {
	CARD_HALF_THICKNESS_PX,
	CARD_THICKNESS_PX,
	edgeSliceFill,
	sliceDepths,
} from "./pass-edge.ts";

interface CardInteractionStyle extends MotionStyle {
	"--pass-card-shell-1-perspective"?: string | undefined;
	"--pass-card-shell-1-touch-action"?: MotionStyle["touchAction"];
}
interface CardSpinStyle extends MotionStyle {
	"--pass-card-shell-2-rotate-x"?: MotionStyle["rotateX"];
	"--pass-card-shell-2-rotate-y"?: MotionStyle["rotateY"];
}
interface CardTiltStyle extends MotionStyle {
	"--pass-card-shell-3-rotate-x"?: MotionStyle["rotateX"];
	"--pass-card-shell-3-rotate-y"?: MotionStyle["rotateY"];
}
interface CardGlareStyle extends MotionStyle {
	"--pass-card-shell-4-background"?: MotionStyle["background"];
}
function drawingLength(value: CSSProperties["width"]): string | undefined {
	return isNativeNumber(value) ? `${value}px` : value;
}

// Re-exported rather than re-declared: `pass-studio/scene.ts` and the tier card
// import the thickness from HERE, and the edge module is where it now lives
// alongside the slice geometry and the material that fills it.
interface PassShellDrawingStyle extends React.CSSProperties {
	"--pass-face-depth"?: string;
	"--pass-face-radius"?: string;
	"--pass-ring-padding"?: string;
	"--pass-slice-depth"?: string;
	"--pass-slice-fill"?: string;
	"--pass-slice-radius"?: string;
	"--pass-warp-opacity"?: number;
}

export { CARD_THICKNESS_PX };

/**
 * The card object itself — the laminated, two-sided, metal-ringed thing that
 * turns, tilts, floats and can be dragged by hand. It carries NO content of its
 * own: callers pass the front face as `children` and (optionally) the back as
 * `back`.
 *
 * It exists as its own component because more than one surface wants this
 * object. The waitlist pass was the first; the agent employee badge is the
 * second. Copying ~400 lines of transform layering, extrusion geometry and
 * pointer plumbing into a second file would guarantee the two drift, which is
 * exactly what happened to the waitlist SCREEN before it was unified.
 *
 * All colour comes from design tokens so it reads in light and dark. Motion is
 * suppressed under `prefers-reduced-motion` — the card is decoration, and
 * decoration is the first thing that should stop moving when a user asks for
 * less of it.
 */

/**
 * Tilt/glare/shadow tuning, kept at the reference interactive-tilt-card values:
 * a 15° tilt at the far edge, a 1000px perspective, a 5% lift on hover, and a
 * glare that reaches 80% of the card before it falls off. The drop shadow is
 * animated rather than a static `shadow-xl` — the card is meant to look like it
 * lifts off the page when you point at it, and a fixed shadow reads as flat.
 */
const TILT_DEGREES = 15;
export const PERSPECTIVE_PX = 1000;
const HOVER_SCALE = 1.05;
const GLARE_INTENSITY = 0.5;
const GLARE_SIZE_PERCENT = 80;
const SHADOW_RESTING = "0 10px 30px -10px rgba(0, 0, 0, 0.2)";
const SHADOW_HOVER = "0 25px 50px -12px rgba(0, 0, 0, 0.5)";
const TRANSITION_SECONDS = 0.2;
/**
 * The idle revolution: one slow, unbroken turn, repeating forever, so the back
 * of the pass comes into view every cycle. Linear — a constant-rate turn is the
 * only easing that does not visibly stutter at the seam where the loop repeats.
 * The axis is CSS `rotateY`, which swings the card left-to-right like a
 * revolving door; `rotateX` would tumble it top-over-bottom instead.
 */
/** How long the card stays perfectly still after mount, so its rings paint. */
const SETTLE_MS = 900;
/** One unbroken turn per cycle, in degrees and seconds. */
const FULL_TURN_DEGREES = 360;
export const FLIP_CYCLE_SECONDS = 24;
/**
 * Drag-to-rotate. A degree per pixel means a swipe across a 320px card turns it
 * most of the way round, which is about right for "throw it and look at the
 * back". Pitch is clamped well short of edge-on so the card can never be dragged
 * into a hairline.
 */
/** Tuned to settle in about the 0.2s the reference tween took. */
const TILT_SPRING = { stiffness: 320, damping: 32, mass: 0.6 } as const;
/** Half of the coordinate space; a pointer at the centre must read as zero tilt. */
const CENTER = 0.5;
/** Tilt is derived from a -50..50 offset, so halve the span to normalize it. */
const TILT_SPAN = 50;
/**
 * The idle float — the card rises and settles a few pixels, forever. Slow and
 * shallow on purpose: it should read as the card being held rather than as an
 * animation playing, so the period is long and the travel is small enough that
 * you notice it only when you are not looking straight at it.
 */
export const FLOAT_TRAVEL_PX = 10;
export const FLOAT_CYCLE_SECONDS = 6;
const DRAG_DEGREES_PER_PX = 1;
const MAX_DRAG_PITCH = 60;
/**
 * Below this queue size the position is hidden. A low number is the truth but
 * it is the wrong truth to lead with: "#42" against a 60-person list reads as an
 * empty room, so the pass shows who you are and holds the ranking until there is
 * a crowd to be ranked against. The waitlist screen gates its own counters on
 * the same value.
 */
/** The card's corner radius, in the CSS px `metal-fx` wants it in. */
export const CARD_RADIUS_PX = 28;
/**
 * The FACE's radius — the card's, less the ring gutter it sits inside. Keeping
 * the two in step is what makes the ring read as one even band rather than as a
 * band that thins at the corners.
 */
export const FACE_RADIUS_PX = CARD_RADIUS_PX - METAL_EDGE_RING_PX;

/**
 * The card's thickness, the depths its slices sit at, and the metal they are
 * filled with all live in `pass-edge.ts` — see the header there for why they are
 * not in this file. In short: the pass studio paints the same edge to a canvas
 * and used to carry its own copy of the ramp, and none of the arithmetic that
 * decides how the edge LOOKS was reachable from a test while it sat next to
 * `motion` and a WebGL shader.
 *
 * The fill is a stack of copies of the card's own rounded silhouette, one every
 * half pixel of depth, rather than four rotated slabs along the straight edges.
 * Four slabs cannot follow a 28px corner radius, so the corners came out hollow
 * — you could see through the card where it was rounded. A stack has no such
 * problem: every slice is the exact outline, so the extrusion is solid the whole
 * way round, corners included.
 */

/**
 * How the card's thickness is finished. `"brushed"` is the static ramp above —
 * cheap, and what a grid of cards should use. `"live"` gives every plane of the
 * milled edge its own metal-fx ring, so the thickness is the same animated
 * shader as the faces instead of a painted lookalike.
 *
 * `"live"` costs one metal-fx instance per slice. They share a single WebGL
 * canvas, so the cost is per-frame 2D copies rather than contexts — fine for the
 * one card on a pass screen, wrong for twenty badges in a list.
 *
 * The rings must all sit on the SAME box as the faces. The first attempt used a
 * single wider ring at mid-depth, which is exactly the failure the thickness
 * comment above warns about: against the two face rings it read as two cards
 * stacked with a gap between them rather than as one solid edge.
 */
export type PassEdge = "brushed" | "live";

/**
 * A slice's own radius, and the reason it is not `FACE_RADIUS_PX`.
 *
 * A slice spans the WHOLE card box (`inset-0`), not the box inside the ring's
 * gutter, so its silhouette is the card's own outline and its radius has to be
 * the card's own. Rounded at the face's radius instead, every slice cut its
 * corners two pixels tighter than the card is rounded — which pushes the corner
 * of the slice OUTSIDE the arc the ring traces, and the brushed ramp showed as
 * four bright angular nubs sitting proud of the chrome at exactly the four
 * corners. The straight edges never showed it, which is what made it read as
 * "the metal has sharp corners" rather than as a radius that was simply wrong.
 *
 * The live mid-plane ring is the one case where the slice IS inside a gutter —
 * `MetalEdge`'s own, one pixel of it — so there it rounds by one less.
 */
const SLICE_RADIUS_PX = CARD_RADIUS_PX;
/** The `ringPx` of the live mid-plane ring the depth-0 slice sits inside. */
const LIVE_EDGE_RING_PX = 1;
const LIVE_SLICE_RADIUS_PX = CARD_RADIUS_PX - LIVE_EDGE_RING_PX;

/**
 * The card's thickness, as a stack of its own silhouette. Each slice sits half a
 * pixel further back than the last, spanning front face to back face, so any
 * edge-on view shows a continuous band of material instead of a hairline — and
 * because each slice is tinted for its own depth (see `edgeSliceFill`), that
 * band is a specular ramp across the thickness rather than one flat colour
 * repeated.
 */
function CardExtrusion({ edge, ringed }: { edge: PassEdge; ringed: boolean }) {
	// The edge FINISH, which is not the same question as "does this plane carry
	// the mid-plane ring" below. Keeping the two under one name is how the
	// iridescence ends up on a single slice instead of across the whole core.
	const iridescent = edge === "live" && ringed;
	return (
		<>
			{sliceDepths().map((depth) => {
				// The material of the slice: the lengthwise brushed ramp, shaded for
				// this slice's own depth so the stack reads as a rolled edge lit from
				// one side rather than one flat colour repeated. That per-slice tint is
				// the half of this component that has now been dropped twice — most
				// recently by a merge that took the ramp and the geometry from the fix
				// and left the shading behind — and it is the difference between one
				// thick card and two thin ones stacked. `pass-edge.test.ts` guards it.
				//
				// Under `"live"` the middle plane additionally carries a metal-fx ring,
				// so the thickness catches the same animated shader as the faces rather
				// than only a painted lookalike.
				//
				// The brushed ramp stays on an UNRINGED card too. The thing an
				// unclaimed pass withholds is the animated chrome BORDER, not the
				// material it is milled from — a card whose edge went flat read as
				// cardboard rather than as metal waiting to be finished.
				const live = iridescent && depth === 0;
				const sliceStyle: PassShellDrawingStyle = {
					"--pass-slice-fill": edgeSliceFill(depth, iridescent),
					// See `SLICE_RADIUS_PX`: the card's own radius, less the live
					// ring's gutter on the one plane that has one.
					"--pass-slice-radius": `${live ? LIVE_SLICE_RADIUS_PX : SLICE_RADIUS_PX}px`,
				};
				const slice = (
					<div
						aria-hidden="true"
						className={cn("absolute inset-0", styles.slice)}
						style={sliceStyle}
					/>
				);
				const slicePlaneStyle: PassShellDrawingStyle = {
					"--pass-slice-depth": `${depth}px`,
				};
				return (
					<div
						aria-hidden="true"
						className={cn(
							"pointer-events-none absolute inset-0",
							styles.slicePlane
						)}
						key={depth}
						style={slicePlaneStyle}
					>
						{live ? (
							// ONE hairline ring, on the middle plane only. Ringing every
							// plane stacked five arcs that each project from a slightly
							// different depth, and at the corners they piled into a band far
							// thicker than the arc it was tracing — the card read as having a
							// smaller radius than it has. A single ring at mid-depth is
							// hidden behind the faces head-on, catches the light edge-on
							// where the milled edge actually shows, and leaves the
							// silhouette to the face rings.
							<MetalEdge
								borderRadius={CARD_RADIUS_PX}
								className="h-full"
								ringPx={LIVE_EDGE_RING_PX}
							>
								<div className="relative h-full w-full">{slice}</div>
							</MetalEdge>
						) : (
							slice
						)}
					</div>
				);
			})}
		</>
	);
}

/**
 * Warp backdrop tuning. The shader is a flowing four-stop gradient, and it is
 * read here as a texture UNDER the card's content rather than as a background
 * in its own right: the name sits on it at `text-5xl`, so the opacity is what
 * keeps it legible. Higher in dark (the stops are dark and the type is light,
 * so the texture only ever adds contrast) than in light, where a saturated
 * wash would eat a black headline.
 */
export const WARP_OPACITY_DARK = 0.55;
export const WARP_OPACITY_LIGHT = 0.3;
/** Degrees between the seed's own hue and its companion stop. */
export const WARP_HUE_SPREAD = 42;
/** The near-black / near-white the seeded hues are laid against. */
export const WARP_BASE_DARK = "#121212";
export const WARP_BASE_LIGHT = "#f2f2f4";
export const WARP_SPEED = 0.32;
export const WARP_SWIRL = 0.75;
export const WARP_DISTORTION = 0.22;
export const WARP_SOFTNESS = 1;
export const WARP_SCALE = 1.1;

export const hueHex = (hue: number): string => {
	const [r, g, b] = hueFill(hue);
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
};

const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";
const subscribeToScheme = (onChange: () => void) => {
	if (globalThis.window === undefined || !window.matchMedia) {
		return () => {
			/* nothing to unsubscribe from on the server */
		};
	}
	const media = window.matchMedia(DARK_SCHEME_QUERY);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
};

/**
 * Resolve `metalTheme` down to a boolean the shader can be coloured from.
 * `"auto"` is the only case that has to ask the OS — and it must ask through a
 * subscription rather than a render-time `matchMedia` read, because a card that
 * sampled the scheme once would keep its old palette when the user flips the OS
 * toggle. Callers that own a manual theme pass `"dark"`/`"light"` and never
 * reach the media query at all.
 *
 * Exported because a card's CONTENT can need the same answer the face resolves
 * — `tier-pass.tsx` picks the base tone its warp stops are laid against — and a
 * second `matchMedia` read at the call site would strand that palette on the
 * old scheme when the OS toggle flips, which is the exact bug this hook exists
 * to avoid.
 */
export function useIsDarkFace(metalTheme: "auto" | "dark" | "light"): boolean {
	const prefersDark = useSyncExternalStore(
		subscribeToScheme,
		() => window.matchMedia(DARK_SCHEME_QUERY).matches,
		// Server render: assume light, which is what an unstyled page is.
		() => false
	);
	if (metalTheme === "auto") {
		return prefersDark;
	}
	return metalTheme === "dark";
}

/**
 * The member's own generative dither glyph, blown up to fill the card and
 * dropped to a texture. Held at a low opacity because it has to sit under the
 * content without competing with it; `animate={false}` because the entrance
 * would replay on every re-render and this is a backdrop, not a subject.
 */
function DitherBackdrop({ seed }: { seed: string }) {
	return <DitherAvatar animate={false} className="h-full w-full" name={seed} />;
}

/**
 * The same seed, painted as a flowing warp shader instead of a pixel glyph. The
 * hue comes from `ditherAvatarHue` — the avatar's OWN draw, not a second hash —
 * so the card's backdrop is the colour of the glyph in the circle above the
 * name, and two members never get the same card.
 */
function WarpBackdrop({
	colors,
	isDark,
	reduceMotion,
	seed,
}: {
	/** {@link PassCardShellProps.warpColors}. Falsy → the seeded stops. */
	colors?: readonly string[];
	isDark: boolean;
	reduceMotion: boolean;
	seed: string;
}) {
	const hue = ditherAvatarHue(seed);
	const base = isDark ? WARP_BASE_DARK : WARP_BASE_LIGHT;
	return (
		<ShaderBackground
			className="h-full w-full"
			// Spread rather than passed through: the shader's `colors` is a mutable
			// `string[]`, and the override arrives readonly so a caller's palette
			// constant cannot be written into by anything downstream.
			colors={[
				...(colors ?? [base, hueHex(hue), base, hueHex(hue + WARP_HUE_SPREAD)]),
			]}
			distortion={WARP_DISTORTION}
			scale={WARP_SCALE}
			softness={WARP_SOFTNESS}
			// Frozen explicitly rather than through the shader's own reduced-motion
			// read, for the same reason `metalTheme` is a prop: the card resolves
			// these questions once, at the top, and hands down the answer.
			speed={reduceMotion ? 0 : WARP_SPEED}
			swirl={WARP_SWIRL}
			variant="warp"
		/>
	);
}

/**
 * The card's outer frame. With `ringed` it is the metal edge; without it, the
 * same box and the same gutter, minus the shader — so turning the ring off
 * changes nothing about the card's geometry, only whether the band is chrome or
 * the page showing through.
 */
function CardRingFrame({
	children,
	metalTheme,
	ringed,
}: {
	children: ReactNode;
	metalTheme: "auto" | "dark" | "light";
	ringed: boolean;
}) {
	if (ringed) {
		return (
			<MetalEdge
				borderRadius={CARD_RADIUS_PX}
				className="h-full"
				theme={metalTheme}
			>
				{children}
			</MetalEdge>
		);
	}
	const ringPaddingStyle: PassShellDrawingStyle = {
		"--pass-ring-padding": `${METAL_EDGE_RING_PX}px`,
	};
	return (
		<div
			className={cn("flex h-full w-full flex-col", styles.ringPadding)}
			style={ringPaddingStyle}
		>
			{children}
		</div>
	);
}

/**
 * One side of the pass: the metal ring plus the laminated card surface. Both
 * faces render this so the back is unmistakably the same object as the front
 * rather than a plain panel behind it.
 */
function PassFace({
	backdrop,
	children,
	metalTheme,
	mirrored = false,
	reduceMotion,
	ringed,
	seed,
	warpColors,
	warpOpacity,
}: {
	/** Which generative texture the card face is printed on. */
	backdrop: PassBackdrop;
	children: React.ReactNode;
	metalTheme: "auto" | "dark" | "light";
	/**
	 * Flip the backdrop horizontally. The back face is the same sheet of card
	 * seen from behind, so its pattern has to read as the front's pattern viewed
	 * through the material — an unmirrored copy looks like a second, different
	 * card glued on.
	 */
	mirrored?: boolean;
	reduceMotion: boolean;
	/** Paint the metal ring. See `PassCardShellProps.ringed`. */
	ringed: boolean;
	/** Name or handle the generative backdrop is derived from. */
	seed: string;
	/** {@link PassCardShellProps.warpColors}. */
	warpColors?: readonly string[];
	/** {@link PassCardShellProps.warpOpacity}. */
	warpOpacity?: { dark: number; light: number };
}) {
	const isDark = useIsDarkFace(metalTheme);
	const isWarp = backdrop === "warp";
	const faceRadiusStyle: PassShellDrawingStyle = {
		"--pass-face-radius": `${FACE_RADIUS_PX}px`,
	};
	const fillRadiusStyle: PassShellDrawingStyle = {
		"--pass-face-radius": `${FACE_RADIUS_PX}px`,
	};
	const backdropStyle: PassShellDrawingStyle = {
		"--pass-face-radius": `${FACE_RADIUS_PX}px`,
		"--pass-warp-opacity": isWarp
			? isDark
				? (warpOpacity?.dark ?? WARP_OPACITY_DARK)
				: (warpOpacity?.light ?? WARP_OPACITY_LIGHT)
			: undefined,
	};
	return (
		// `h-full` on top of the shared edge's own `w-full`: the back face is
		// absolutely positioned to the card's box, so the ring wrapper has to be as
		// tall as the card or its surface covers only the content and leaves a bare
		// band above and below.
		// NOT paused under reduced motion. `metal-fx` shares one GL loop across
		// every ring on the page, so a paused card froze the invite row and the
		// stat tiles with it — and a frozen ring reads as a dead border rather than
		// as a considerate one. The ring is a slow shimmer inside a 2px band, not
		// travel across the screen; the card's spin, tilt and float are what
		// `reduceMotion` still suppresses.
		<CardRingFrame metalTheme={metalTheme} ringed={ringed}>
			{/* `isolate` scopes the foil overlay's `mix-blend-soft-light` to the
			    card, so it can never blend against whatever the card happens to be
			    sitting on. `preserve-3d` lives on the flip wrapper above, never
			    here: Chromium forces it back to `flat` on any element that also
			    clips, and the clip is what keeps the content inside the rounded
			    corners while the card is turning. The radius is the card's own less
			    the gutter, so the face stays concentric with the ring around it. */}
			<div
				className={cn(
					"relative isolate flex h-full w-full flex-col overflow-hidden text-card-foreground",
					styles.face
				)}
				style={faceRadiusStyle}
			>
				{/* The card face — fill and edge both — as its own layer rather than a
				    `border bg-card` on the element above. MetalFx normalizes its DIRECT
				    child's outer chrome with
				    `background: transparent !important; border: 0 !important` so
				    consumer button styles can't fight the ring, which silently ate both
				    of those when they were written up there. A grandchild is outside
				    that selector. Both matter: an opaque face is load-bearing now that
				    the pass has two sides (a see-through face shows the other side's
				    content mirrored through it mid-turn), and in light mode the metal
				    ring is near-invisible along the straight edges, so without the
				    border a white card on a white page has no edge at all. The radius
				    is repeated here because a square border would have its corners
				    lopped off by the parent's clip. */}
				{/* No border when the card is unringed. The border existed because in
				    light mode the metal ring is near-invisible along the straight
				    edges and a white card on a white page would have had no edge at
				    all — but an unringed card is deliberately plain, and a hairline
				    there just reads as a weaker version of the chrome it is meant to
				    be waiting for. */}
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute inset-0 bg-card",
						styles.face,
						ringed && "border"
					)}
					style={fillRadiusStyle}
				/>
				{/* The generative backdrop, drawn from the member's own seed so the
			    face IS them — two people never get the same card. Which texture
			    is the caller's call: the employee badge keeps the pixel glyph,
			    the waitlist pass is printed on the warp shader. Mirrored on the
			    back face either way, so the pattern reads as the front's seen
			    through the material rather than as a second card glued on. */}
				{/* `clip-path` rather than the parent's `overflow-hidden` + radius.
			    The warp is a WebGL canvas, so it gets its own compositing layer,
			    and Chromium does not apply an ancestor's rounded overflow clip to
			    a composited descendant inside a 3D rendering context — the shader
			    painted square over the front face's corners while the back face
			    (which carries its own transform, hence its own clip) came out
			    right. A `clip-path` on the layer itself is honoured by the
			    compositor, so both faces round identically. */}
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden",
						styles.backdrop,
						isWarp ? "opacity-(--pass-warp-opacity)" : "opacity-[0.14]",
						mirrored && "-scale-x-100"
					)}
					style={backdropStyle}
				>
					{isWarp ? (
						<WarpBackdrop
							colors={warpColors}
							isDark={isDark}
							reduceMotion={reduceMotion}
							seed={seed}
						/>
					) : (
						<DitherBackdrop seed={seed} />
					)}
				</div>
				{/* Iridescent foil: a fixed diagonal sheen so the card reads as
				    laminated even when nothing is pointing at it. Deliberately faint.
				    Measured over a white card face, the original weighting pulled the
				    centre to rgb(200,233,255) — a blue wash rather than a graze, which
				    desaturated the content sitting on it. The metal ring now carries
				    most of the laminated signal, so this only has to hint at it. */}
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute inset-0 opacity-[0.16] mix-blend-soft-light",
						styles.laminate
					)}
				/>
				{children}
			</div>
		</CardRingFrame>
	);
}

/**
 * Which generative texture the card is printed on. `"dither"` is the pixel
 * glyph the card shipped with and stays the default, so the agent employee
 * badge — the shell's other consumer — is untouched by the waitlist pass
 * moving to the shader.
 */
export type PassBackdrop = "dither" | "warp";

export interface PassCardShellProps {
	/** The back face. Defaults to the Ryu mark alone. */
	back?: ReactNode;
	/** {@link PassBackdrop}. Defaults to the pixel glyph. */
	backdrop?: PassBackdrop;
	/** The front face. */
	children: ReactNode;
	className?: string;
	/**
	 * Seed for the generative dither backdrop — a name or handle. The same seed
	 * always draws the same pattern, so the backdrop identifies its owner.
	 */
	ditherSeed: string;
	/** {@link PassEdge}. Defaults to the static brushed ramp. */
	edge?: PassEdge;
	/**
	 * Track a specular highlight across the card face under the pointer. Defaults
	 * to on.
	 *
	 * The invite pass turns it off. On a hero card the glare is the last proof the
	 * thing is laminated; on a card sitting inside a panel it is a white wash that
	 * fades in over the content the moment the pointer crosses it, and the code —
	 * the one string on the card anyone has to read — is what it washes out. The
	 * hover LIFT stays either way: the shadow says the card responded, without
	 * painting over what it says.
	 */
	glare?: boolean;
	/**
	 * Which tuning of the metal ring to paint. `"auto"` follows
	 * `prefers-color-scheme`, which is wrong wherever the app has a manual theme
	 * toggle that can disagree with the OS — callers pass their resolved theme.
	 */
	metalTheme?: "auto" | "dark" | "light";
	/**
	 * Paint the metal ring around the card. Defaults to on.
	 *
	 * The waitlist pass turns it off until a handle is claimed: the chrome edge
	 * is the card's reward for finishing the one thing the screen asks of you,
	 * and an unclaimed pass that already looks finished takes that away.
	 */
	ringed?: boolean;
	/**
	 * Kill the card's SELF-motion: the idle revolution, the float, and the
	 * drag-to-turn that writes into the same angle. Hover is untouched — the
	 * tilt, the lift, the shadow and the glare ({@link PassCardShellProps.glare},
	 * where it is left on) all still answer the pointer, so
	 * the card is still a card you can handle, it just does nothing on its own.
	 *
	 * For grids. One pass on a settings page turning forever reads as an object;
	 * a screen of twenty doing it reads as a fault, and a drag that nudges the
	 * yaw a few degrees is permanent once there is no idle turn to carry the card
	 * back round — a list would quietly skew itself card by card as you clicked
	 * through it.
	 */
	still?: boolean;
	/**
	 * Override the warp backdrop's colour stops. Ignored unless
	 * `backdrop === "warp"`; up to ten stops, which is the shader's own ceiling.
	 *
	 * The seeded default answers "whose card is this"; an override answers "what
	 * KIND of card is this" — the tier pass feeds it the plan badge's own
	 * gradient stops so the field is the badge, in motion. Deliberately an
	 * additive prop rather than a third `PassBackdrop` member: a `"tier"` variant
	 * would leave `ditherSeed` semantically dangling while still being required,
	 * and would fork three ternaries inside `PassFace`. It is also why the warp
	 * stays the shader and does not become a CSS gradient — `pass-studio` drives
	 * a paper-shaders mount by hand to close the loop seam on an export, and
	 * silently exports without a clock if it does not find one.
	 */
	warpColors?: readonly string[];
	/**
	 * Override how strongly the warp backdrop is laid over the card face, per
	 * scheme. Ignored unless `backdrop === "warp"`; defaults to
	 * {@link WARP_OPACITY_DARK} / {@link WARP_OPACITY_LIGHT}.
	 *
	 * A prop rather than a retune of those constants, because the two warp cards
	 * are not the same kind of surface. The waitlist pass's field is a texture
	 * derived from a seed — it says "this card is yours", and nobody can tell it
	 * is wrong, so it is tuned purely for the type sitting on it. A TIER card's
	 * field has to be RECOGNISED: it is the plan badge the reader already knows
	 * from the sidebar, and at the waitlist card's weighting every tier washed
	 * out to the same pale iridescence, which is a different claim about the
	 * product than the badge makes. Moving the shared constant would have
	 * restyled the waitlist pass to fix a problem it does not have.
	 */
	warpOpacity?: { dark: number; light: number };
}

/** The Ryu mark, the default back face. */
export function PassGhost() {
	return (
		<div className="relative flex h-full w-full items-center justify-center p-7">
			<Logo size="48px" variant="outline" />
		</div>
	);
}

export function PassCardShell({
	back,
	backdrop = "dither",
	children,
	edge = "brushed",
	glare = true,
	ringed = true,
	className,
	ditherSeed,
	metalTheme = "auto",
	still = false,
	warpColors,
	warpOpacity,
}: PassCardShellProps) {
	// Motion can resolve the browser preference before hydration, while the server
	// has no media query result. Hold the preference until after hydration so the
	// shell's initial transform markup is identical on both sides.
	const reducedMotionPreference = useReducedMotion();
	const [reduceMotion, setReduceMotion] = useState(false);
	useEffect(() => {
		setReduceMotion(reducedMotionPreference ?? false);
	}, [reducedMotionPreference]);
	// The card is held STILL for its first moment on screen, and that is a
	// correctness requirement, not a polish detail.
	//
	// `metal-fx` asks an IntersectionObserver once whether an instance may paint
	// and only revises that answer when the intersection state changes. An
	// instance created while its host is already moving can be told "not visible"
	// on that single callback and never asked again — its ring stays blank for
	// the life of the page, which is exactly what the waitlist screen showed
	// while /pass, mounting a beat differently, happened to come up visible.
	// Starting from rest means every ring is created in the state the library
	// defaults to, and the sway that follows never turns a face far enough to be
	// culled.
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(true), SETTLE_MS);
		return () => clearTimeout(timer);
	}, []);
	const cardRef = useRef<HTMLDivElement>(null);
	const [hovered, setHovered] = useState(false);
	const [dragging, setDragging] = useState(false);
	/** Last pointer position, so a drag reads as a delta rather than a position. */
	const lastPointer = useRef({ x: 0, y: 0 });

	// Tilt and glare are motion values, NOT React state, and that is a performance
	// decision rather than a stylistic one. Held in state, every pointermove
	// re-rendered this component — and with it BOTH `PassFace`s, each of which
	// mounts a WebGL metal ring. That is what made the rotation stutter. Motion
	// values write straight to the DOM node, so a move now costs no render at all.
	const tiltX = useMotionValue(0);
	const tiltY = useMotionValue(0);
	const glareX = useMotionValue(50);
	const glareY = useMotionValue(50);
	// Springs stand in for the reference's 0.2s ease-out: same settle, without
	// spawning a fresh tween on every one of the ~120 moves a second a trackpad
	// can produce.
	const smoothTiltX = useSpring(tiltX, TILT_SPRING);
	const smoothTiltY = useSpring(tiltY, TILT_SPRING);
	const glareXPercent = useTransform(glareX, (value) => `${value}%`);
	const glareYPercent = useTransform(glareY, (value) => `${value}%`);
	const glareBackground = useMotionTemplate`radial-gradient(circle at ${glareXPercent} ${glareYPercent}, rgba(255, 255, 255, ${GLARE_INTENSITY}) 0%, rgba(255, 255, 255, 0) ${GLARE_SIZE_PERCENT}%)`;

	// The idle turn is driven by a motion value ticked per frame, NOT by a
	// keyframed `animate` that swaps out on hover. That swap is what made the card
	// snap: handing Framer a keyframe array restarts the loop at its first frame,
	// so releasing the pointer teleported the card back to 0° instead of settling.
	// A motion value has no such seam — the angle simply stops accumulating while
	// the pointer is on the card, and resumes from exactly where it stopped, which
	// is also what lets a drag write into the same value.
	const spin = useMotionValue(0);
	const previousStill = useRef(still);
	useEffect(() => {
		const becameStill = still && !previousStill.current;
		previousStill.current = still;
		if (!becameStill) {
			return;
		}
		const frontAngle =
			Math.round(spin.get() / FULL_TURN_DEGREES) * FULL_TURN_DEGREES;
		const alignment = animate(spin, frontAngle, {
			duration: reduceMotion ? 0 : TRANSITION_SECONDS,
			ease: "easeOut",
		});
		return () => alignment.stop();
	}, [reduceMotion, spin, still]);
	/** Pitch contributed by dragging up/down; eases back to level on release. */
	const dragPitch = useMotionValue(0);
	// One slow, unbroken revolution, so the back of the pass comes into view once
	// a cycle. Linear — a constant-rate turn is the only easing that does not
	// visibly stutter at the seam where the loop repeats.
	//
	// This briefly became a bounded sway while the blank-ring bug was open, on
	// the theory that a face turning past 90° is backface-culled and loses its
	// metal-fx instance for good. The real cause was the MOUNT race that
	// `settled` now closes: an instance created while the card was already moving
	// could be told "not visible" once and never asked again. With the card
	// starting from rest the instances come up visible, and a cull mid-cycle is
	// recoverable — the observer fires again when the face swings back.
	useAnimationFrame((_, delta) => {
		if (hovered || dragging || reduceMotion || still || !settled) {
			return;
		}
		const degreesPerMs = FULL_TURN_DEGREES / (FLIP_CYCLE_SECONDS * 1000);
		spin.set((spin.get() + delta * degreesPerMs) % FULL_TURN_DEGREES);
	});

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			// A still card is not draggable at all. Capturing the pointer here would
			// also swallow the click a grid card is wrapped in, and any yaw a drag
			// left behind would be permanent — there is no idle turn to carry it
			// back round. `dragging` therefore never becomes true, which is what
			// keeps the move and release handlers inert too.
			if (still) {
				return;
			}
			// Capture so a drag that leaves the card keeps steering it, and so the
			// release still arrives here. Touch and mouse both come through pointer
			// events, so this is the whole mobile story.
			event.currentTarget.setPointerCapture(event.pointerId);
			lastPointer.current = { x: event.clientX, y: event.clientY };
			setDragging(true);
			tiltX.set(0);
			tiltY.set(0);
		},
		[still, tiltX, tiltY]
	);

	const endDrag = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (!dragging) {
				return;
			}
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			setDragging(false);
			// Yaw keeps whatever angle the drag left it at — that IS the new resting
			// position, and the idle turn carries on from there. Pitch is a held
			// gesture rather than a position, so it levels out.
			animate(dragPitch, 0, { duration: 0.4, ease: "easeOut" });
		},
		[dragPitch, dragging]
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const node = cardRef.current;
			if (!node) {
				return;
			}
			if (dragging) {
				const deltaX = event.clientX - lastPointer.current.x;
				const deltaY = event.clientY - lastPointer.current.y;
				lastPointer.current = { x: event.clientX, y: event.clientY };
				spin.set(spin.get() + deltaX * DRAG_DEGREES_PER_PX);
				// Dragging up should pitch the top away, hence the negated delta, and
				// the clamp stops a long vertical drag rolling the card past edge-on.
				const nextPitch = dragPitch.get() - deltaY * DRAG_DEGREES_PER_PX;
				dragPitch.set(
					Math.min(Math.max(nextPitch, -MAX_DRAG_PITCH), MAX_DRAG_PITCH)
				);
				return;
			}
			const rect = node.getBoundingClientRect();
			const offsetX = ((event.clientX - rect.left) / rect.width - CENTER) * 100;
			const offsetY = ((event.clientY - rect.top) / rect.height - CENTER) * 100;
			glareX.set(offsetX / 2 + 50);
			glareY.set(offsetY / 2 + 50);
			tiltX.set(-(offsetY / TILT_SPAN) * TILT_DEGREES);
			tiltY.set((offsetX / TILT_SPAN) * TILT_DEGREES);
		},
		[dragPitch, dragging, glareX, glareY, spin, tiltX, tiltY]
	);

	const handlePointerLeave = useCallback(() => {
		setHovered(false);
		tiltX.set(0);
		tiltY.set(0);
		glareX.set(50);
		glareY.set(50);
	}, [glareX, glareY, tiltX, tiltY]);

	// Tilt, scale and shadow are the reference interactive-tilt-card's, which
	// separates them across two elements: the perspective host scales, and a child
	// carries the rotation and the drop shadow. Fusing them onto one element (as
	// this used to) makes Framer compose scale and rotation in one matrix, and the
	// foreshortening comes out wrong.
	const settleTransition = {
		duration: TRANSITION_SECONDS,
		ease: "easeOut" as const,
	};

	const frontDepthStyle: PassShellDrawingStyle = {
		"--pass-face-depth": `${CARD_HALF_THICKNESS_PX}px`,
	};
	const backDepthStyle: PassShellDrawingStyle = {
		"--pass-face-depth": `${CARD_HALF_THICKNESS_PX}px`,
	};
	const cardInteractionStyle: CardInteractionStyle = {
		"--pass-card-shell-1-perspective": drawingLength(`${PERSPECTIVE_PX}px`),
		"--pass-card-shell-1-touch-action": still ? "auto" : "none",
	};
	const cardSpinStyle: CardSpinStyle = {
		"--pass-card-shell-2-rotate-x": dragPitch,
		"--pass-card-shell-2-rotate-y": spin,
	};
	const cardTiltStyle: CardTiltStyle | undefined = reduceMotion
		? undefined
		: {
				"--pass-card-shell-3-rotate-x": smoothTiltX,
				"--pass-card-shell-3-rotate-y": smoothTiltY,
			};
	const cardGlareStyle: CardGlareStyle = {
		"--pass-card-shell-4-background": glareBackground,
	};
	return (
		// Three layers, each owning exactly one transform, because they change on
		// different clocks: this one scales on hover, the next turns forever, the
		// last follows the pointer. Collapsing any two of them onto one element is
		// what produced both the wrong-looking tilt and the snap-back on leave.
		<motion.div
			animate={{
				scale: hovered && !reduceMotion ? HOVER_SCALE : 1,
				y: reduceMotion || still || !settled ? 0 : [0, -FLOAT_TRAVEL_PX, 0],
			}}
			className={cn(
				cn(
					"w-full select-none [transform-style:preserve-3d]",
					// The grab cursors are a promise the card can only keep while it turns;
					// a still card advertises nothing and lets its caller say what a click
					// does.
					!still && "cursor-grab active:cursor-grabbing",
					className
				),
				drawingStyles.cardInteraction
			)}
			// Native text/image dragging would otherwise hijack the gesture: the
			// browser starts its own drag on mousedown-and-move over text, which
			// swallows the pointermove events the rotation reads.
			draggable={false}
			onDragStart={(event) => event.preventDefault()}
			onPointerCancel={endDrag}
			onPointerDown={handlePointerDown}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={handlePointerLeave}
			onPointerMove={handlePointerMove}
			onPointerUp={endDrag}
			ref={cardRef}
			// `touchAction: none` is what makes the drag work on a phone: without it
			// the browser claims a vertical swipe for page scrolling before the
			// pointermove handler ever sees it. A still card has no drag to protect,
			// and claiming the gesture there would stop a grid from scrolling under
			// the finger.
			style={cardInteractionStyle}
			transition={{
				scale: settleTransition,
				y: {
					duration: FLOAT_CYCLE_SECONDS,
					ease: "easeInOut",
					repeat: Number.POSITIVE_INFINITY,
				},
			}}
		>
			{/* The idle turn, and the same value a horizontal drag writes into — so
			    letting go leaves the card turning on from wherever it was thrown.
			    Reading straight off the motion value means hover or a drag interrupts
			    it mid-angle and resuming picks up from there. */}
			<motion.div
				className={cn("[transform-style:preserve-3d]", drawingStyles.cardSpin)}
				style={cardSpinStyle}
			>
				{/* Pointer tilt and the drop shadow, exactly as the reference pairs
				    them. `preserve-3d` is what makes the two faces occupy real depth —
				    it can live here because this element does not clip; each face
				    carries its own rounded overflow clip, which Chromium would
				    otherwise flatten. */}
				<motion.div
					animate={{
						boxShadow: hovered && !reduceMotion ? SHADOW_HOVER : SHADOW_RESTING,
					}}
					className={cn(
						"relative rounded-[1.75rem] [transform-style:preserve-3d]",
						drawingStyles.cardTilt
					)}
					style={cardTiltStyle}
					transition={settleTransition}
				>
					{/* The thickness, drawn before the faces so a face always wins
					    where they meet. */}
					<CardExtrusion edge={edge} ringed={ringed} />

					{/* Front. It is the only face in normal flow, so it sets the height
				    the absolutely-positioned back is measured against, and the only one
				    that is not absolutely positioned — hence the transform goes on a
				    wrapper rather than onto the extrusion's own transform. */}
					<div
						className={cn("[backface-visibility:hidden]", styles.front)}
						style={frontDepthStyle}
					>
						<PassFace
							backdrop={backdrop}
							metalTheme={metalTheme}
							reduceMotion={Boolean(reduceMotion)}
							ringed={ringed}
							seed={ditherSeed}
							warpColors={warpColors}
							warpOpacity={warpOpacity}
						>
							{children}
							{/* Specular glare, tracked to the pointer. Fades out on leave rather
					    than snapping, so the highlight follows the hand off the card.
					    Opt-out per card — see `PassCardShellProps.glare`. */}
							{glare ? (
								<motion.div
									animate={{ opacity: hovered && !reduceMotion ? 1 : 0 }}
									aria-hidden="true"
									className={cn(
										"pointer-events-none absolute inset-0",
										drawingStyles.cardGlare
									)}
									style={cardGlareStyle}
									transition={{ duration: 0.25 }}
								/>
							) : null}
						</PassFace>
					</div>

					{/* Back. Pre-rotated a half turn about the same axis the card spins on,
				    so it reads upright exactly when the front has turned away. Hidden
				    from assistive tech: it carries no information the front does not. */}
					<div
						aria-hidden="true"
						className={cn(
							"absolute inset-0 [backface-visibility:hidden]",
							styles.back
						)}
						style={backDepthStyle}
					>
						<PassFace
							backdrop={backdrop}
							metalTheme={metalTheme}
							mirrored
							reduceMotion={Boolean(reduceMotion)}
							ringed={ringed}
							seed={ditherSeed}
							warpColors={warpColors}
							warpOpacity={warpOpacity}
						>
							{back ?? <PassGhost />}
						</PassFace>
					</div>
				</motion.div>
			</motion.div>
		</motion.div>
	);
}
