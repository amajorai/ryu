import type { CSSProperties } from "react";
import { z } from "zod";
import type { BackdropCssStyle } from "./definitions.ts";
import "./marketplace-css-backdrop.css";

const CSS_STYLE_KEYS = [
	"animation",
	"background",
	"backgroundBlendMode",
	"backgroundColor",
	"backgroundImage",
	"backgroundPosition",
	"backgroundRepeat",
	"backgroundSize",
	"boxShadow",
	"filter",
	"imageRendering",
	"maskComposite",
	"maskImage",
	"mixBlendMode",
	"opacity",
	"WebkitMaskComposite",
	"WebkitMaskImage",
] as const satisfies readonly (keyof BackdropCssStyle)[];

const SAFE_CSS_CHARACTERS =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#.,%()+/_:- ";
const COLOR_FUNCTIONS = new Set(["hsl", "hsla", "rgb", "rgba"]);
const PAINT_FUNCTIONS = new Set([
	...COLOR_FUNCTIONS,
	"conic-gradient",
	"linear-gradient",
	"radial-gradient",
	"repeating-conic-gradient",
	"repeating-linear-gradient",
	"repeating-radial-gradient",
]);
const FILTER_FUNCTIONS = new Set([
	"blur",
	"brightness",
	"contrast",
	"drop-shadow",
	"grayscale",
	"hue-rotate",
	"invert",
	"opacity",
	"saturate",
	"sepia",
]);
const BLEND_MODES = new Set([
	"color",
	"color-burn",
	"color-dodge",
	"darken",
	"difference",
	"exclusion",
	"hard-light",
	"hue",
	"lighten",
	"luminosity",
	"multiply",
	"normal",
	"overlay",
	"saturation",
	"screen",
	"soft-light",
]);
const MASK_COMPOSITES = new Set(["add", "exclude", "intersect", "subtract"]);
const WEBKIT_MASK_COMPOSITES = new Set([
	"clear",
	"copy",
	"source-atop",
	"source-in",
	"source-out",
	"source-over",
	"xor",
]);
const BACKGROUND_REPEATS = new Set([
	"no-repeat",
	"repeat",
	"repeat-x",
	"repeat-y",
	"round",
	"space",
]);
const ANIMATION_NAMES = new Map([
	["aurora 8s linear infinite", "ryu-patterncraft-aurora 8s linear infinite"],
	[
		"crystal-shimmer 15s ease-in-out infinite",
		"ryu-patterncraft-crystal-shimmer 15s ease-in-out infinite",
	],
]);

function isCssWhitespace(character: string): boolean {
	const code = character.charCodeAt(0);
	return code === 9 || code === 10 || code === 13 || code === 32;
}

function allowedFunctions(key: keyof BackdropCssStyle): ReadonlySet<string> {
	if (key === "filter") {
		return FILTER_FUNCTIONS;
	}
	if (key === "boxShadow") {
		return new Set([...COLOR_FUNCTIONS, "drop-shadow"]);
	}
	if (
		key === "background" ||
		key === "backgroundColor" ||
		key === "backgroundImage" ||
		key === "maskImage" ||
		key === "WebkitMaskImage"
	) {
		return PAINT_FUNCTIONS;
	}
	return new Set();
}

function hasOnlySafeCharacters(value: string): boolean {
	for (const character of value) {
		if (isCssWhitespace(character)) {
			continue;
		}
		if (!SAFE_CSS_CHARACTERS.includes(character)) {
			return false;
		}
	}
	return true;
}

function cssFunctionNames(value: string): string[] | null {
	const names: string[] = [];
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "(") {
			let end = index;
			while (end > 0 && isCssWhitespace(value.charAt(end - 1))) {
				end -= 1;
			}
			let start = end;
			while (start > 0) {
				const previous = value.charAt(start - 1).toLowerCase();
				if ((previous >= "a" && previous <= "z") || previous === "-") {
					start -= 1;
				} else {
					break;
				}
			}
			if (start === end) {
				return null;
			}
			names.push(value.slice(start, end).toLowerCase());
			depth += 1;
		} else if (value[index] === ")") {
			depth -= 1;
			if (depth < 0) {
				return null;
			}
		}
	}
	return depth === 0 ? names : null;
}

function isSafeCssValue(key: keyof BackdropCssStyle, value: string): boolean {
	if (
		value.length === 0 ||
		value.length > 4096 ||
		!hasOnlySafeCharacters(value)
	) {
		return false;
	}
	if (key === "animation") {
		return ANIMATION_NAMES.has(value.trim());
	}
	if (key === "backgroundBlendMode" || key === "mixBlendMode") {
		return value.split(",").every((mode) => BLEND_MODES.has(mode.trim()));
	}
	if (key === "maskComposite") {
		return MASK_COMPOSITES.has(value.trim());
	}
	if (key === "WebkitMaskComposite") {
		return WEBKIT_MASK_COMPOSITES.has(value.trim());
	}
	if (key === "imageRendering") {
		return ["auto", "crisp-edges", "pixelated"].includes(value.trim());
	}
	if (key === "backgroundRepeat") {
		const repeats = value
			.split(",")
			.flatMap((layer) => layer.trim().split(" "))
			.filter(Boolean);
		return (
			repeats.length > 0 &&
			repeats.every((repeat) => BACKGROUND_REPEATS.has(repeat))
		);
	}
	const functions = cssFunctionNames(value);
	return functions?.every((name) => allowedFunctions(key).has(name)) ?? false;
}

const PAINT_VARIABLES = {
	animation: "--ryu-marketplace-animation",
	background: "--ryu-marketplace-background",
	backgroundBlendMode: "--ryu-marketplace-backgroundBlendMode",
	backgroundColor: "--ryu-marketplace-backgroundColor",
	backgroundImage: "--ryu-marketplace-backgroundImage",
	backgroundPosition: "--ryu-marketplace-backgroundPosition",
	backgroundRepeat: "--ryu-marketplace-backgroundRepeat",
	backgroundSize: "--ryu-marketplace-backgroundSize",
	boxShadow: "--ryu-marketplace-boxShadow",
	filter: "--ryu-marketplace-filter",
	imageRendering: "--ryu-marketplace-imageRendering",
	maskComposite: "--ryu-marketplace-maskComposite",
	maskImage: "--ryu-marketplace-maskImage",
	mixBlendMode: "--ryu-marketplace-mixBlendMode",
	opacity: "--ryu-marketplace-opacity",
	WebkitMaskComposite: "--ryu-marketplace-WebkitMaskComposite",
	WebkitMaskImage: "--ryu-marketplace-WebkitMaskImage",
} as const satisfies Record<
	keyof BackdropCssStyle,
	`--ryu-marketplace-${string}`
>;
type MarketplacePaintInputs = CSSProperties &
	Partial<
		Record<
			(typeof PAINT_VARIABLES)[keyof typeof PAINT_VARIABLES],
			string | number
		>
	>;

function resolvePaint(paint: BackdropCssStyle, animate: boolean) {
	const variables: MarketplacePaintInputs = {};
	const roles: string[] = [];
	for (const key of CSS_STYLE_KEYS) {
		const value = paint[key];
		if (key === "animation") {
			const parsed = z.string().safeParse(value);
			const animation =
				animate && parsed.success
					? ANIMATION_NAMES.get(parsed.data)
					: undefined;
			if (animation !== undefined) {
				variables[PAINT_VARIABLES.animation] = animation;
				roles.push("ryu-marketplace-animation");
			}
			continue;
		}
		if (key === "opacity") {
			const parsed = z.number().min(0).max(1).safeParse(value);
			if (parsed.success) {
				variables[PAINT_VARIABLES.opacity] = parsed.data;
				roles.push("ryu-marketplace-opacity");
			}
			continue;
		}
		const parsed = z.string().safeParse(value);
		if (parsed.success && isSafeCssValue(key, parsed.data)) {
			if (key === "WebkitMaskComposite") {
				roles.push(`ryu-marketplace-WebkitMaskComposite-${parsed.data.trim()}`);
			} else {
				variables[PAINT_VARIABLES[key]] = parsed.data;
				roles.push(`ryu-marketplace-${key}`);
			}
		}
	}
	return { variables, roles };
}
export function MarketplaceCssBackdrop({
	animate,
	paint,
}: {
	animate: boolean;
	paint: BackdropCssStyle;
}) {
	const { variables, roles } = resolvePaint(paint, animate);
	const style: MarketplacePaintInputs = {
		"--ryu-marketplace-animation": variables[PAINT_VARIABLES.animation],
		"--ryu-marketplace-background": variables[PAINT_VARIABLES.background],
		"--ryu-marketplace-backgroundBlendMode":
			variables[PAINT_VARIABLES.backgroundBlendMode],
		"--ryu-marketplace-backgroundColor":
			variables[PAINT_VARIABLES.backgroundColor],
		"--ryu-marketplace-backgroundImage":
			variables[PAINT_VARIABLES.backgroundImage],
		"--ryu-marketplace-backgroundPosition":
			variables[PAINT_VARIABLES.backgroundPosition],
		"--ryu-marketplace-backgroundRepeat":
			variables[PAINT_VARIABLES.backgroundRepeat],
		"--ryu-marketplace-backgroundSize":
			variables[PAINT_VARIABLES.backgroundSize],
		"--ryu-marketplace-boxShadow": variables[PAINT_VARIABLES.boxShadow],
		"--ryu-marketplace-filter": variables[PAINT_VARIABLES.filter],
		"--ryu-marketplace-imageRendering":
			variables[PAINT_VARIABLES.imageRendering],
		"--ryu-marketplace-maskComposite": variables[PAINT_VARIABLES.maskComposite],
		"--ryu-marketplace-maskImage": variables[PAINT_VARIABLES.maskImage],
		"--ryu-marketplace-mixBlendMode": variables[PAINT_VARIABLES.mixBlendMode],
		"--ryu-marketplace-opacity": variables[PAINT_VARIABLES.opacity],
		"--ryu-marketplace-WebkitMaskComposite":
			variables[PAINT_VARIABLES.WebkitMaskComposite],
		"--ryu-marketplace-WebkitMaskImage":
			variables[PAINT_VARIABLES.WebkitMaskImage],
	};
	return (
		<div
			aria-hidden="true"
			className={["absolute inset-0 size-full", ...roles].join(" ")}
			data-backdrop-renderer="marketplace-css"
			style={style}
		/>
	);
}
