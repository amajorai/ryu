"use client";
import { useRender } from "@base-ui/react/use-render";
import {
	type ComponentProps,
	type ComponentRef,
	type CSSProperties,
	isValidElement,
	type ReactElement,
} from "react";
import { z } from "zod";

interface ColorPickerPaintStyle extends CSSProperties {
	"--color-picker-alpha-b"?: number;
	"--color-picker-alpha-g"?: number;
	"--color-picker-alpha-r"?: number;
	"--color-picker-area-b"?: number;
	"--color-picker-area-g"?: number;
	"--color-picker-area-left"?: string;
	"--color-picker-area-r"?: number;
	"--color-picker-area-top"?: string;
	"--color-picker-paint"?: string;
	"--color-picker-trigger-fill"?: string | undefined;
	"--color-picker-trigger-foreground"?: string | undefined;
}

// Base UI has no Radix-style `<Slot>`; `useRender` is its composition primitive.
// This helper preserves the `asChild` API by rendering the single child element
// (merged with the component's own props) when `asChild` is set, otherwise the
// default tag. It is a hook (calls `useRender`), so call it once, unconditionally.
function useSlotRender(
	asChild: boolean | undefined,
	props: useRender.ElementProps<"div"> & { "data-slot"?: string }
): ReactElement {
	const { children, ...rest } = props;
	if (asChild && children && !isValidElement(children)) {
		throw new Error("ColorPicker asChild requires a single React element");
	}
	return useRender({
		defaultTagName: "div",
		// When not composing (`asChild` false), leave `render` undefined so Base UI
		// renders `defaultTag` with the full props (children included). When
		// composing, render the provided child element and drop `children` from
		// props so they don't double up.
		render: asChild && isValidElement(children) ? children : undefined,
		props: asChild ? { ...rest } : { ...props },
	});
}

const ROOT_NAME = "ColorPicker";
const ROOT_IMPL_NAME = "ColorPickerImpl";
const TRIGGER_NAME = "ColorPickerTrigger";
const CONTENT_NAME = "ColorPickerContent";
const AREA_NAME = "ColorPickerArea";
const HUE_SLIDER_NAME = "ColorPickerHueSlider";
const ALPHA_SLIDER_NAME = "ColorPickerAlphaSlider";
const SWATCH_NAME = "ColorPickerSwatch";
const EYE_DROPPER_NAME = "ColorPickerEyeDropper";
const FORMAT_SELECT_NAME = "ColorPickerFormatSelect";
const INPUT_NAME = "ColorPickerInput";

const colorFormats = ["hex", "rgb", "hsl", "oklch"] as const;
const colorFormatSchema = z.enum(colorFormats);
const swatchStringSchema = z.string();
const recentColorStringsSchema = z.array(z.string().catch(""));
const derivedHexSchema = z
	.string()
	.regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);

// Base UI's <SelectValue /> renders the raw value unless the Root is given an
// `items` map of value -> label, so provide one to keep the uppercase labels.
const FORMAT_ITEMS = colorFormats.map((f) => ({
	value: f,
	label: f.toUpperCase(),
}));

interface DivProps extends ComponentProps<"div"> {
	asChild?: boolean;
}

type RootElement = ComponentRef<"div">;
type AreaElement = ComponentRef<"div">;
type InputElement = ComponentRef<"input">;

type ColorFormat = (typeof colorFormats)[number];

/**
 * @see https://gist.github.com/bkrmendy/f4582173f50fab209ddfef1377ab31e3
 */
interface EyeDropper {
	open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }>;
}

declare global {
	interface Window {
		EyeDropper?: {
			new (): EyeDropper;
		};
	}
}

interface ColorValue {
	a: number;
	b: number;
	g: number;
	r: number;
}

interface HSVColorValue {
	a: number;
	h: number;
	s: number;
	v: number;
}

interface OklchColorValue {
	a: number;
	c: number;
	h: number;
	l: number;
}

export interface ParsedColor {
	alpha: number;
	hex: string;
	hsl: { h: number; l: number; s: number };
	oklch: OklchColorValue;
	rgb: ColorValue;
}

export {
	ALPHA_SLIDER_NAME,
	AREA_NAME,
	type AreaElement,
	CONTENT_NAME,
	type ColorFormat,
	type ColorPickerPaintStyle,
	type ColorValue,
	colorFormatSchema,
	colorFormats,
	type DivProps,
	derivedHexSchema,
	EYE_DROPPER_NAME,
	FORMAT_ITEMS,
	FORMAT_SELECT_NAME,
	type HSVColorValue,
	HUE_SLIDER_NAME,
	INPUT_NAME,
	type InputElement,
	type OklchColorValue,
	ROOT_IMPL_NAME,
	ROOT_NAME,
	type RootElement,
	recentColorStringsSchema,
	SWATCH_NAME,
	swatchStringSchema,
	TRIGGER_NAME,
	useSlotRender,
};
