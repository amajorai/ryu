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
import { formatMessage } from "@ryu/i18n/core";
import type { LiteralMessage } from "@ryu/i18n/react";
import { sentenceLabel } from "@ryu/i18n/sentence-label";
import { z } from "zod";
import { paper } from "./backdrop-builders.ts";
import { NAMED_BACKDROPS } from "./named-backdrops.ts";
import { PAPER_SHADER_DEFAULTS, type PaperShaderId } from "./paper-defaults.ts";
import {
	type BackdropParamSpec,
	type BackdropParams,
	isSafeColor,
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

/** Registry keys identify exactly the installed shader defaults. */
export const paperShaderIdSchema = z.custom<PaperShaderId>(
	(value) =>
		z
			.string()
			.refine((id) => Object.hasOwn(PAPER_SHADER_DEFAULTS, id))
			.safeParse(value).success
);

const englishLiteral: LiteralMessage = (source, values) =>
	formatMessage(source, values);

/** A shader-library entry's description, as one message naming the shader. */
function shaderLibraryDescription(tl: LiteralMessage, label: string): string {
	return tl("The {shader} shader with its default look.", {
		shader: sentenceLabel(tl, label),
	});
}

/** Every paper shader, as-is, so the full beui-style library is selectable. */
const LIBRARY: BackdropDefinition[] = Object.entries(PAPER_SHADER_DEFAULTS).map(
	([shader, definition]) =>
		paper(
			`shader-${shader}`,
			definition.label,
			"Shader library",
			paperShaderIdSchema.parse(shader),
			shaderLibraryDescription(englishLiteral, definition.label)
		)
);

export const BACKDROPS: readonly BackdropDefinition[] = [
	...NAMED_BACKDROPS,
	...LIBRARY,
];

/**
 * The description to show for `definition`. The registry keeps English; a
 * generated shader-library description is translated here as one message,
 * and every other description is returned as written.
 */
export function backdropDescription(
	definition: Pick<BackdropDefinition, "description" | "label">,
	tl: LiteralMessage
): string {
	return definition.description ===
		shaderLibraryDescription(englishLiteral, definition.label)
		? shaderLibraryDescription(tl, definition.label)
		: definition.description;
}

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
