"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type IconInput,
	MorphIcon as MorphIconPrimitive,
	type MorphIconProps,
} from "morphicons/react";

export type { IconInput, MorphIconProps };

/**
 * Shared Morphicons entry point for stateful stroke icons.
 *
 * The wrapper keeps reduced-motion behavior consistent across every surface:
 * Morphicons honors the user's OS preference, while callers can still opt
 * into an explicit policy for a special-purpose animation.
 */
export function MorphIcon({
	className,
	reducedMotion = "user",
	...props
}: MorphIconProps) {
	return (
		<MorphIconPrimitive
			{...props}
			className={cn("shrink-0", className)}
			reducedMotion={reducedMotion}
		/>
	);
}

export interface MorphIconSwapProps
	extends Omit<MorphIconProps, "from" | "to" | "progress" | "icon"> {
	a: IconInput;
	b: IconInput;
	state: "a" | "b";
}

/** Morph between two icon data values when a state changes. */
export function MorphIconSwap({
	a,
	b,
	state,
	spring = "snappy",
	reducedMotion = "user",
	...props
}: MorphIconSwapProps) {
	return (
		<MorphIcon
			{...props}
			icon={state === "a" ? a : b}
			reducedMotion={reducedMotion}
			spring={spring}
		/>
	);
}
