import { z } from "zod";
import {
	isNativeBoolean,
	isNativeNumber,
	isNativeObjectReceiver,
	isNativeText,
} from "../lib/native-primitive-observation.ts";
import {
	type ExpressiveExpressionSelection,
	isExpressiveExpressionSelection,
} from "./expressive.ts";
import {
	type ExpressiveAnimationSelection,
	isExpressiveAnimationSelection,
} from "./expressive-animation.ts";
import { type GhostCostume, parseGhostCostume } from "./ghost-costume.ts";
import type { LogoColors } from "./logo-colors.ts";

export const GHOST_AVATAR_VARIANTS = [
	"3d",
	"outline",
	"outline-muted",
	"default",
	"expressive",
	"costume",
] as const;
export interface GhostAvatarAppearance {
	animated?: boolean;
	animationDuration?: number;
	behavior?: "custom" | "conversation";
	bodyStyle?: "solid" | "orb";
	colors?: LogoColors;
	/** Outfit for the `costume` variant; other variants ignore it. */
	costume?: GhostCostume;
	eyeScale?: number;
	variant?: (typeof GHOST_AVATAR_VARIANTS)[number];
}
export interface GhostAvatarSpec extends GhostAvatarAppearance {
	animation?: ExpressiveAnimationSelection;
	expression: ExpressiveExpressionSelection;
}

/** A plain record of color slots; arrays and primitives fail and are dropped. */
const ghostColorsInputSchema = z.object({
	bg: z.unknown().optional(),
	c1: z.unknown().optional(),
	c2: z.unknown().optional(),
	c3: z.unknown().optional(),
});

/** Normalize persisted settings at the shared UI boundary; legacy faces stay valid. */
const ghostAvatarInputSchema = z
	.unknown()
	.transform((data): GhostAvatarSpec | undefined => {
		if (
			!(
				data &&
				isNativeObjectReceiver(data) &&
				"expression" in data &&
				isExpressiveExpressionSelection(data.expression)
			)
		) {
			return;
		}
		const result: GhostAvatarSpec = { expression: data.expression };
		if ("animation" in data && isExpressiveAnimationSelection(data.animation)) {
			result.animation = data.animation;
		}
		if ("variant" in data) {
			result.variant = GHOST_AVATAR_VARIANTS.find(
				(value) => value === data.variant
			);
		}
		if (
			"bodyStyle" in data &&
			(data.bodyStyle === "solid" || data.bodyStyle === "orb")
		) {
			result.bodyStyle = data.bodyStyle;
		}
		if (
			"behavior" in data &&
			(data.behavior === "custom" || data.behavior === "conversation")
		) {
			result.behavior = data.behavior;
		}
		if ("animated" in data && isNativeBoolean(data.animated)) {
			result.animated = data.animated;
		}
		if (
			"eyeScale" in data &&
			isNativeNumber(data.eyeScale) &&
			Number.isFinite(data.eyeScale)
		) {
			result.eyeScale = Math.min(3, Math.max(0.25, data.eyeScale));
		}
		if (
			"animationDuration" in data &&
			isNativeNumber(data.animationDuration) &&
			Number.isFinite(data.animationDuration)
		) {
			result.animationDuration = Math.min(
				120,
				Math.max(1, data.animationDuration)
			);
		}
		if ("costume" in data) {
			const costume = parseGhostCostume(data.costume);
			if (costume) {
				result.costume = costume;
			}
		}
		// safeParse once: arrays and other non-record values drop the colors
		// instead of throwing out of the whole avatar parse.
		const colorInput =
			"colors" in data ? ghostColorsInputSchema.safeParse(data.colors) : null;
		if (colorInput?.success) {
			const colors: LogoColors = {};
			for (const key of ["bg", "c1", "c2", "c3"] as const) {
				const value = colorInput.data[key];
				if (isNativeText(value) && value.trim() && value.length <= 128) {
					colors[key] = value.trim();
				}
			}
			if (Object.keys(colors).length) {
				result.colors = colors;
			}
		}
		return result;
	});

/** Normalize raw persisted values through the owning input schema. */
export function parseGhostAvatar(
	data: z.input<typeof ghostAvatarInputSchema>
): GhostAvatarSpec | undefined {
	return ghostAvatarInputSchema.parse(data);
}
