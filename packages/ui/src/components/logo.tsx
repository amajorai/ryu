"use client";

import type React from "react";
import { lazy, Suspense, useState } from "react";
import { cn } from "../lib/utils.ts";
import type { ExpressiveExpressionSelection } from "./expressive.ts";
import type { ExpressiveAnimationSelection } from "./expressive-animation.ts";
import styles from "./logo.module.css";
import type { LogoColors } from "./logo-colors.ts";
import { useActiveExpression } from "./logo-expression.ts";
import { ExpressiveVariant } from "./logo-expressive-variant.tsx";
import { EyesVariant } from "./logo-eyes-variant.tsx";
import { useLogoGaze } from "./logo-gaze.ts";
import { ghostEyeGeometry } from "./logo-ghost-eyes.tsx";
import {
	DefaultVariant,
	FilledVariant,
	type GhostVariantProps,
	OutlineVariant,
	ShimmerVariant,
	SkeletonVariant,
} from "./logo-material-variants.tsx";
import { OutlineStatic } from "./logo-outline-static.tsx";
import {
	ghostPathD as buildGhostPathD,
	isExpressiveVariant,
	type LogoDimensionsStyle,
	parseLogoSize,
} from "./logo-shared.ts";
import { LogoTrace, type LogoTraceOptions } from "./logo-trace.tsx";

export interface LogoProps extends LogoTraceOptions {
	/** Disable gaze, blinking, and random expression changes. */
	animated?: boolean;
	/** Expressive ghost animation, or random for the full reference-style cycle. */
	animation?: ExpressiveAnimationSelection;
	animationDuration?: number;
	/** Material treatment for the 3D body. */
	bodyStyle?: "solid" | "orb";
	className?: string;
	colors?: LogoColors;
	corners?: "default" | "circle" | "compact";
	/** Named expressive face, or random for a changing face. */
	expression?: ExpressiveExpressionSelection;
	/** Scale the expressive ghost's eyes without changing its body size. */
	eyeScale?: number;
	presentation?: "default" | "sidebar-tab";
	/** Hide the default variant's eyes when another face is layered over its fill. */
	showEyes?: boolean;
	size?: string;
	tone?: "default" | "inherit" | "foreground";
	variant?:
		| "3d"
		| "default"
		| "filled"
		| "outline"
		| "skeleton"
		| "shimmer"
		| "trace"
		| "eyes"
		| "expressive"
		| "outline-static"
		| "outline-muted";
}

const Logo3D = lazy(() => import("./logo-3d.tsx"));

const AnimatedLogo: React.FC<LogoProps> = ({
	variant = "default",
	size = "192px",
	className,
	colors,
	eyeScale = 1,
	animationDuration = 20,
	animation,
	animated = true,
	expression,
	showEyes = true,
}) => {
	// A state-backed callback ref, so the gaze hook re-observes the element when
	// a variant change swaps the root node.
	const [orb, setOrb] = useState<HTMLDivElement | null>(null);
	const activeExpression = useActiveExpression(variant, animated, expression);
	const sizeValue = parseLogoSize(size);

	// Non-expressive variants keep blinking and tracking regardless of
	// `animated`; only the expressive timeline honours it. Variants that never
	// draw a moving eye skip the work entirely: the shimmer's eyes stay put, and
	// the default body can hide its eyes.
	const blinks = !(
		(isExpressiveVariant(variant) && !animated) ||
		(variant === "default" && !showEyes)
	);
	const { eyePosition, isBlinking } = useLogoGaze({
		blinks,
		element: orb,
		sizeValue,
		tracks: blinks && variant !== "shimmer",
	});

	// ── Eyes variant ─────────────────────────────────────────────────────────────
	// Just the two eyes, centered and enlarged in the viewBox (no ghost body).
	// Used for tiny resting surfaces like the Island's collapsed circle. Extracted
	// into its own component so the main Logo function stays under the complexity
	// budget; it still receives the live blink/gaze state.
	if (variant === "eyes") {
		return (
			<EyesVariant
				className={className}
				eyePosition={eyePosition}
				isBlinking={isBlinking}
				orbRef={setOrb}
				size={size}
				sizeValue={sizeValue}
			/>
		);
	}

	const scaleFactor = sizeValue / 24;
	const ghostPathD = buildGhostPathD(scaleFactor);

	// ── Expressive variants ─────────────────────────────────────────────────────
	// Ryu keeps its recognizable ghost body while the two eye shapes morph
	// independently through named moods. A random selection advances on its own;
	// a named selection stays on that expression while still blinking and tracking.
	// `outline-muted` uses the same timeline, but keeps every mark muted and
	// unfilled so it remains suitable for secondary chrome.
	if (isExpressiveVariant(variant)) {
		const outlineOnly = variant === "outline-muted";
		return (
			<ExpressiveVariant
				animated={animated}
				animation={animation ?? "random"}
				bodyStrokeWidth={outlineOnly ? 1 : 1.5}
				className={className}
				expression={activeExpression}
				eyePosition={eyePosition}
				eyeScale={outlineOnly ? eyeScale * 1.5 : eyeScale}
				ghostPathD={ghostPathD}
				isBlinking={isBlinking}
				orbRef={setOrb}
				outlineOnly={outlineOnly}
				size={size}
				sizeValue={sizeValue}
			/>
		);
	}

	const ghostProps: GhostVariantProps = {
		className,
		eyePosition,
		eyes: ghostEyeGeometry(scaleFactor),
		ghostPathD,
		isBlinking,
		orbRef: setOrb,
		size,
		sizeValue,
	};
	switch (variant) {
		case "filled":
			return <FilledVariant {...ghostProps} />;
		case "outline":
			return <OutlineVariant {...ghostProps} />;
		case "skeleton":
			return <SkeletonVariant {...ghostProps} />;
		case "shimmer":
			return <ShimmerVariant {...ghostProps} />;
		default:
			return (
				<DefaultVariant
					{...ghostProps}
					animationDuration={animationDuration}
					colors={colors}
					showEyes={showEyes}
				/>
			);
	}
};

// Thin dispatcher: the static outline is a hookless component so it installs no
// blink interval and no global mousemove listener; animated and expressive
// variants stay inside the hook-owning `AnimatedLogo`.
const Logo: React.FC<LogoProps> = ({
	tone,
	corners,
	presentation,
	...baseProps
}) => {
	const presentationClasses = cn(
		tone === "inherit" && "text-current",
		tone === "foreground" && "text-foreground",
		corners === "circle" && "rounded-full object-cover",
		corners === "compact" && "rounded-glyph-compact object-contain",
		presentation === "sidebar-tab" &&
			"transition-[scale,opacity] duration-150 group-hover/row:scale-50 group-hover/row:opacity-0 group-focus-visible/row:scale-50 group-focus-visible/row:opacity-0 group-has-[button:focus-visible]/row:scale-50 group-has-[button:focus-visible]/row:opacity-0"
	);
	const props = presentationClasses
		? { ...baseProps, className: cn(presentationClasses, baseProps.className) }
		: baseProps;
	if (props.variant === "3d") {
		const fallbackStyle: LogoDimensionsStyle = {
			"--logo-size": props.size ?? "192px",
		};
		const fallback = (
			<div
				className={cn(styles.dimensions, props.className)}
				style={fallbackStyle}
			>
				<OutlineStatic size="100%" />
			</div>
		);
		return (
			<Suspense fallback={fallback}>
				<Logo3D {...props} fallback={fallback} />
			</Suspense>
		);
	}
	if (props.variant === "outline-static") {
		return <OutlineStatic className={props.className} size={props.size} />;
	}
	if (props.variant === "trace") {
		return <LogoTrace {...props} />;
	}
	return <AnimatedLogo {...props} />;
};

export { Logo };
