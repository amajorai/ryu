import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties } from "react";
import visualStyles from "../../marketplace-visual.module.css";
// packages/marketplace/src/catalog/chrome/dither-banner.tsx
//
// The listing hero's background wash. Extracted out of `apps-catalog-section.tsx`
// so every realm's detail hero paints the same thing — the Apps/Plugins hero was
// the only one that had it, which is why an app opened with real art and an MCP
// server or an engine opened with a flat grey slab.
//
// Three tiers, in order:
//
//  1. **The listing's own `icon_dither`** — the generative wash its CARD already
//     shows. Using it here is why hero and card never disagree.
//  2. **An explicit `banner`** — a flat `background`, a raster `imageUrl`,
//     author-declared `colors`, `style: "animated-gradient"` with its shader
//     field, or `style: "dither"` with a grain overlay. Outranks tier 1: it is
//     the author saying "the hero is not just my icon, bigger".
//  3. **A flat fallback** — `icon_background`/`accent_color`, else the muted
//     surface.
//
// Tier 1 is the reason the store stopped looking generic: with no `banner` (which
// no first-party manifest has ever declared) every hero painted the SAME hardcoded
// indigo `linear-gradient`, so all 62 detail pages opened with an identical purple
// slab that had nothing to do with the app.
//
// WITHIN tier 2 the order is animated-gradient → background → imageUrl → colors,
// and the picture is painted OVER whatever paints beneath it rather than instead
// of it, so a transparent PNG letterboxes onto the author's colour instead of onto
// grey. `style` does not select between the CSS keys: it is a label ("flat",
// "image") that describes what the author declared, and honouring it as a switch
// would mean an item with `style: "flat"` and only an `imageUrl` paints nothing at
// all. `animated-gradient` is the ONE exception and is documented as such on the
// type — a WebGL renderer is not something a surface should acquire because a key
// happened to be present.
//
// ---------------------------------------------------------------------------
// WHERE THE ANIMATED GRADIENT IS ALLOWED TO BE LIVE
// ---------------------------------------------------------------------------
//
// It renders through WebGL, and browsers cap simultaneous contexts (~16), evicting
// the OLDEST to satisfy a new request. So instances do not merely cost — past a
// point they KILL each other, and this app already has that crash on file (Sentry
// RUST-2A, "WebGL context is lost" via `transferToImageBitmap`). A 60-card grid
// each running a field would exhaust the cap on first paint.
//
// The rule, enforced by the `live` prop rather than by documentation:
//
//  * **LIVE — the detail hero, and nothing else.** `ListingHero` is the one caller
//    that passes `live`, and it passes it unconditionally from the inside, so no
//    call site can forget or over-claim it. A dozen desktop sections mount that
//    hero, but every one of them mounts it inside a `*Detail*` pane — one band at
//    the top of one pane — so the real ceiling is one context per SIMULTANEOUSLY
//    OPEN detail pane, which split view can multiply but only up to the number of
//    panes (≤4 in a 4-way split). Sections with two or three `ListingHero` calls
//    (`EnginesCatalogSection`, `ToolsLibrary`, `InstalledSection`) are alternate
//    BRANCHES of one detail component, not a list, so they mount one at a time.
//    Every live context is therefore the thing the viewer is looking at. Putting a
//    hero inside a repeated row would break that arithmetic — the invariant to
//    preserve is "one per pane", not "one per component".
//  * **STATIC — everywhere else, by construction.** `live` defaults to false, so
//    cards, grids, list rows and any future caller get a painted div with no
//    canvas, no context and no rAF, without having to know any of this. Today the
//    card path does not read `banner` at all — `entry.banner` is handed only to
//    `ListingHero` — so the grid is safe by absence as well as by default; the
//    default is what keeps it safe the day a card does start painting one. The
//    static paint is a CSS approximation derived from the SAME preset table the
//    shader reads (`animatedGradientCss`), so a card and its hero are recognisably
//    the same listing.
//
// The static paint is also the FLOOR, not just the alternative: it is painted on
// the wrapper underneath the canvas, so an evicted context, a refused one, or a
// shader chunk that fails to load leaves it standing instead of a black hole.
// `prefers-reduced-motion` drops to it too — subscribed, not sampled, so flipping
// the OS setting unmounts the canvas mid-session. Upstream offers no reduced-motion
// guidance and the obvious reading (`speed: 0`) still holds a context and still
// composites; stopped means stopped.
//
// EVERY key here is publisher-supplied and reaches a DOM sink, so all of them are
// guarded here and not upstream: Core keeps `banner` as opaque JSON precisely so a
// new key needs no Core release, which also means Core never validates one. The
// colours reach a CSS background AND a shader uniform, so they go through the same
// `safeCssBackground` the other keys use; the numbers reach GPU uniforms, where an
// unbounded `swirlIterations` is a frozen tab rather than an ugly banner, so
// `resolveAnimatedGradient` clamps every one of them.

import {
	DitherGradient,
	type GradientDirection,
} from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	AnimatedGradient,
	type AnimatedGradientInputConfig,
	type AnimatedGradientPreset,
	DEFAULT_ANIMATED_GRADIENT_PRESET,
	isAnimatedGradientPreset,
} from "@ryu/ui/components/motion/animated-gradient.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useId } from "react";
import { safeCssBackground, safeHttpUrl } from "../safe-url.ts";
import type {
	CardDither,
	CatalogBanner,
	CatalogBannerGradient,
} from "../types.ts";
import { normalizeDither } from "./dither.ts";

/** The icon tile inside the hero washes in the OPPOSITE direction to the banner
 *  behind it, so the two do not blend into one flat field — the tile has to read
 *  as a tile sitting on the hero, not as a hole in it. */
export const OPPOSITE_DIRECTION = {
	up: "down",
	down: "up",
	left: "right",
	right: "left",
} satisfies Record<GradientDirection, GradientDirection>;

/** The grain overlay's defaults, which are what `style: "dither"` has always
 *  painted. `noise` only moves them. */
const DEFAULT_NOISE_OPACITY = 30;
const DEFAULT_NOISE_FREQUENCY = 0.9;
const MAX_NOISE_SCALE = 10;
const MIN_NOISE_SCALE = 0.1;

interface ResolvedNoise {
	baseFrequency: number;
	opacity: number;
}

/** The grain overlay for a banner, or null when it declares none.
 *
 *  ONE overlay serves both `style: "dither"` (which turns it on with the defaults
 *  above) and an `animated-gradient` that wants grain over the shader — adding a
 *  second noise implementation for the new style would give the same manifest key
 *  two different textures depending on which branch painted it. */
function resolveNoise(banner?: CatalogBanner | null): ResolvedNoise | null {
	const declared = banner?.noise;
	const isDither = banner?.style === "dither";
	if (!(declared || isDither)) {
		return null;
	}
	const rawOpacity =
		isNativeNumber(declared?.opacity) && Number.isFinite(declared.opacity)
			? Math.min(100, Math.max(0, declared.opacity))
			: DEFAULT_NOISE_OPACITY;
	if (rawOpacity === 0) {
		return null;
	}
	const scale =
		isNativeNumber(declared?.scale) && Number.isFinite(declared.scale)
			? Math.min(MAX_NOISE_SCALE, Math.max(MIN_NOISE_SCALE, declared.scale))
			: 1;
	return {
		// A bigger `scale` means bigger grain, which is a LOWER spatial frequency.
		baseFrequency: DEFAULT_NOISE_FREQUENCY / scale,
		opacity: rawOpacity / 100,
	};
}

interface ResolvedGradient {
	config: AnimatedGradientInputConfig;
	preset: AnimatedGradientPreset;
}

/** The animated-gradient spec a listing declared, scrubbed — or null, which sends
 *  the hero back down the tier list to the derived wash.
 *
 *  ALL-OR-NOTHING on the colours, matching what `colors` already does one branch
 *  down and for the same reason: the three stops are one ramp, so keeping the
 *  survivors of a rejected palette paints something the author never declared.
 *  The numbers are deliberately NOT filtered here — they are forwarded raw and
 *  clamped by `resolveAnimatedGradient`, so the shader and the static CSS can
 *  never disagree about what a hostile value became. */
function resolveGradient(
	gradient?: CatalogBannerGradient | null
): ResolvedGradient | null {
	const declared = gradient ?? {};
	const stops = [declared.color1, declared.color2, declared.color3];
	if (stops.some((c) => c !== undefined && !safeCssBackground(c))) {
		return null;
	}
	const preset = isAnimatedGradientPreset(declared.preset)
		? declared.preset
		: DEFAULT_ANIMATED_GRADIENT_PRESET;
	const { preset: _dropped, ...config } = declared;
	return { config, preset };
}

export default function DitherBanner({
	banner,
	dither,
	fallback,
	live = false,
}: {
	banner?: CatalogBanner | null;
	/** The listing's `icon_dither`, untrusted; validated before paint. */
	dither?: CardDither | null;
	fallback?: string | null;
	/** Allow an `animated-gradient` banner to hold a WebGL context. DEFAULT FALSE
	 *  — see the header: only the detail hero opts in, so every other surface is
	 *  static by construction. Has no effect on any other banner style. */
	live?: boolean;
}) {
	const filterId = useId();
	const safeDither = normalizeDither(dither);
	const background = safeCssBackground(banner?.background);
	const imageUrl = safeHttpUrl(banner?.imageUrl);
	// One bad stop drops the whole ramp: the stops are joined into a single
	// `linear-gradient(…)` string, so keeping the survivors would paint a gradient
	// the author never declared — and dropping to the derived wash is the documented
	// degradation.
	const declaredColors = banner?.colors?.length ? banner.colors : null;
	const colors = declaredColors?.every((c) => safeCssBackground(c))
		? declaredColors
		: null;
	const gradient =
		banner?.style === "animated-gradient"
			? resolveGradient(banner.gradient)
			: null;
	const noise = resolveNoise(banner);
	// `gradient` and not `banner.style === "animated-gradient"`: a spec whose
	// palette was rejected has to fall THROUGH to the derived wash, and a request
	// that survived has to outrank it. Leaving the new style out of this test is
	// how a listing that declares only `{ style, gradient }` — no `background`, no
	// `colors` — would paint its icon dither instead of what it asked for.
	const explicitBanner =
		background || imageUrl || colors || gradient || banner?.style === "dither";

	if (safeDither && !explicitBanner) {
		return (
			<div
				aria-hidden="true"
				className="absolute inset-0 bg-muted"
				// `relative`-free: DitherGradient absolutely fills its nearest
				// positioned ancestor, which is the hero's own `relative` wrapper.
			>
				<DitherGradient
					cell={4}
					direction={safeDither.direction}
					from={safeDither.from}
					to={safeDither.to}
				/>
			</div>
		);
	}

	let cssBackground: string | undefined;
	if (background) {
		cssBackground = background;
	} else if (colors) {
		cssBackground = `linear-gradient(135deg, ${colors.join(", ")})`;
	} else if (!gradient) {
		cssBackground = fallback ?? undefined;
	}

	const backgroundStyle: BannerPaintStyle | undefined = cssBackground
		? { "--marketplace-background": cssBackground }
		: undefined;
	const noiseStyle: BannerNoiseStyle | undefined = noise
		? { "--marketplace-opacity": noise.opacity }
		: undefined;
	return (
		<div
			aria-hidden="true"
			className={cn(
				"absolute inset-0",
				cssBackground ? visualStyles.background : undefined,
				cssBackground || imageUrl || gradient ? undefined : "bg-muted"
			)}
			style={backgroundStyle}
		>
			{gradient ? (
				<AnimatedGradient
					className="absolute inset-0 size-full"
					config={gradient.config}
					live={live}
					preset={gradient.preset}
				/>
			) : null}
			{imageUrl ? (
				// `alt=""`, not a description: the whole band is `aria-hidden`, and the
				// listing's name is already the heading sitting on top of it.
				<img
					alt=""
					className="absolute inset-0 size-full object-cover"
					src={imageUrl}
				/>
			) : null}
			{noise ? (
				<svg
					className={cn(
						"absolute inset-0 size-full mix-blend-overlay",
						visualStyles.opacity
					)}
					preserveAspectRatio="none"
					style={noiseStyle}
				>
					<title>Dither texture</title>
					<filter id={filterId}>
						<feTurbulence
							baseFrequency={noise.baseFrequency}
							numOctaves={2}
							seed={banner?.seed ?? 0}
							type="fractalNoise"
						/>
						<feColorMatrix type="saturate" values="0" />
					</filter>
					<rect filter={`url(#${filterId})`} height="100%" width="100%" />
				</svg>
			) : null}
		</div>
	);
}

interface BannerPaintStyle extends CSSProperties {
	"--marketplace-background": string;
}
interface BannerNoiseStyle extends CSSProperties {
	"--marketplace-opacity": number;
}
