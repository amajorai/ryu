import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// packages/marketplace/src/catalog/chrome/dither.ts
//
// Validation for the untrusted `icon_dither` spec a catalog entry carries, shared
// by every surface that paints one (the list card's icon square, the detail hero,
// the hero's own icon tile).
//
// It lives in its own module rather than on the card because the validator is the
// safety boundary, not a rendering detail: `fillOf` THROWS on an unknown palette
// name, so a typo'd colour in one manifest would take down the whole catalog list
// with a render error. Exactly one implementation means a new painting surface
// cannot accidentally ship without the guard.

import type { GradientDirection } from "@ryu/ui/components/dither-kit/gradient.tsx";
import {
	type DitherColor,
	isDitherColor,
} from "@ryu/ui/components/dither-kit/palette.ts";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CardDither } from "../types.ts";

/** The four gradient directions dither-kit accepts. */
const DIRECTIONS: GradientDirection[] = ["up", "down", "left", "right"];

function isGradientDirection(
	value: CardDither["direction"]
): value is GradientDirection {
	return DIRECTIONS.some((direction) => direction === value);
}

/** Normalize ONE untrusted colour token to a dither-kit `PixelColor`: a finite hue
 *  number, or a known palette-colour name. Anything else (typo'd name, NaN, object)
 *  → null, so a malformed remote card never reaches `fillOf`, which throws on an
 *  unknown name. */
function normalizeColor<T>(value: T): DitherColor | number | null {
	if (isNativeNumber(value) && Number.isFinite(value)) {
		return value;
	}
	if (isDitherColor(value)) {
		return value;
	}
	return null;
}

/** A dither spec that is safe to hand to `DitherGradient`. `from` is guaranteed
 *  valid; `to`/`direction` are already validated (or omitted so the component's own
 *  defaults apply). */
export interface SafeDither {
	direction?: GradientDirection;
	from: DitherColor | number;
	to?: DitherColor | number | "transparent";
}

/** The hue offset an opaque two-tone ramp puts between its two ends. Small enough
 *  that both ends read as the same colour family, large enough that the dither has
 *  something to blend. */
const TWO_TONE_SPREAD = 34;

/** True when this spec dissolves to transparent rather than painting edge to edge.
 *
 *  This is a LEGIBILITY question, not a cosmetic one, which is why it is a shared
 *  predicate instead of an inline `=== "transparent"` at each painting site. A
 *  two-tone ramp covers its whole box, so white-on-dither always reads. One that
 *  dissolves leaves the far end at whatever is behind it — on a light surface that
 *  end is nearly white, and a white glyph on it disappears entirely. Every surface
 *  that hardcodes a light foreground over a dither must branch on this. */
export function ditherDissolves(dither: SafeDither | null): boolean {
	// An ABSENT `to` counts. `normalizeDither` omits a `to` it could not resolve,
	// and `DitherGradient` defaults the prop to "transparent" — so an omitted one
	// paints the same dissolve as an explicit one, and treating it as opaque would
	// put a white glyph on a see-through square.
	return !dither || dither.to === undefined || dither.to === "transparent";
}

/** Force a spec to paint edge to edge, for the surfaces whose foreground is a fixed
 *  light colour and so cannot survive a dissolve (the detail hero and its tile).
 *
 *  A dissolving spec becomes a two-tone ramp in its OWN hue, so the standardized
 *  colour a manifest declares still drives the surface — it just stays opaque. Only
 *  a numeric hue can be offset; a named palette colour has no arithmetic, so it is
 *  returned unchanged and that caller keeps whatever contrast it had before. */
export function opaqueDither(dither: SafeDither | null): SafeDither | null {
	if (!(dither && ditherDissolves(dither))) {
		return dither;
	}
	if (!isNativeNumber(dither.from)) {
		return dither;
	}
	return { ...dither, to: (dither.from + TWO_TONE_SPREAD) % 360 };
}

/** Validate an untrusted {@link CardDither} into a {@link SafeDither}, or null when
 *  it can't paint. `from` MUST resolve (else the whole spec is dropped and the
 *  caller falls back to its flat/`img` path); `to` accepts "transparent" or a valid
 *  colour (else omitted → transparent); an unknown `direction` is dropped (→ "up"). */
export function normalizeDither(dither?: CardDither | null): SafeDither | null {
	if (!dither) {
		return null;
	}
	const from = normalizeColor(dither.from);
	if (from === null) {
		return null;
	}
	const safe: SafeDither = { from };
	if (dither.to === "transparent") {
		safe.to = "transparent";
	} else {
		const to = normalizeColor(dither.to);
		if (to !== null) {
			safe.to = to;
		}
	}
	if (isNativeText(dither.direction) && isGradientDirection(dither.direction)) {
		safe.direction = dither.direction;
	}
	return safe;
}
