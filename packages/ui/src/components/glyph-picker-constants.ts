import type { GradientDirection } from "@ryu/ui/components/dither-kit/gradient.tsx";
import type { DitherColor } from "@ryu/ui/components/dither-kit/palette.ts";
import type { GlyphDitherValue, GlyphKind } from "@ryu/ui/components/glyph.ts";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import type { CSSProperties } from "react";

export interface GlyphPickerDrawingStyle extends CSSProperties {
	"--glyph-picker-square-size"?: string;
	"--glyph-picker-swatch-color"?: string;
}

export interface Dimensions {
	height: number;
	width: number;
}

export const OUTPUT_SIZE = 256;
export const MAX_ZOOM = 3;

export const DITHER_COLORS: DitherColor[] = [
	"green",
	"blue",
	"purple",
	"pink",
	"orange",
	"red",
	"grey",
];

export const DIRECTION_OPTIONS: {
	value: GradientDirection;
	label: string;
	Icon: typeof ArrowUp;
}[] = [
	{ value: "up", label: "Up", Icon: ArrowUp },
	{ value: "down", label: "Down", Icon: ArrowDown },
	{ value: "left", label: "Left", Icon: ArrowLeft },
	{ value: "right", label: "Right", Icon: ArrowRight },
];

export const DEFAULT_DITHER: GlyphDitherValue = {
	from: "green",
	to: null,
	direction: "up",
};

export const TAB_LABEL = {
	avatar: "Upload",
	icon: "Icon",
	emoji: "Emoji",
	dicebear: "DiceBear",
	expressive: "Expressive",
	avatar_style: "Styles",
	dither: "Dither",
} satisfies Record<GlyphKind, string>;

export interface EmojiSelectPayload {
	native?: string;
}
