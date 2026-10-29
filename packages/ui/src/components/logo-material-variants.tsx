"use client";

import { useId } from "react";
import { cn } from "../lib/utils.ts";
import styles from "./logo.module.css";
import { LOGO_DEFAULT_COLORS, type LogoColors } from "./logo-colors.ts";
import { type GhostEyeGeometry, GhostEyes } from "./logo-ghost-eyes.tsx";
import {
	computeFinalContrast,
	computeMaskRadius,
	type EyePosition,
	type LogoClipStyle,
	type LogoDimensionsStyle,
	type LogoMaterialStyle,
	type OrbRef,
} from "./logo-shared.ts";
import { usePrefersReducedMotion } from "./reduced-motion.ts";

/** What every eyed ghost variant needs from `AnimatedLogo`. */
export interface GhostVariantProps {
	className?: string;
	eyePosition: EyePosition;
	eyes: GhostEyeGeometry;
	ghostPathD: string;
	isBlinking: boolean;
	orbRef: OrbRef;
	size: string;
	sizeValue: number;
}

// The ghost path is drawn edge-to-edge, so a 1.5px stroke straddles the viewBox
// boundary by half its width; these variants inset their geometry by it.
const STROKE_MARGIN = 1.5;
const insetViewBox = (sizeValue: number): string =>
	`${-STROKE_MARGIN} ${-STROKE_MARGIN} ${sizeValue + STROKE_MARGIN * 2} ${sizeValue + STROKE_MARGIN * 2}`;

// ── Filled variant ──────────────────────────────────────────────────────────
// The inverse of `outline`: the ghost body is solid, while the eyes are cut
// out of it so the surface behind the mark shows through. A luminance mask is
// used instead of painting the eyes with a background colour, which keeps the
// variant correct on every surface and lets the eyes continue to track.
export function FilledVariant({
	className,
	eyePosition,
	eyes,
	ghostPathD,
	isBlinking,
	orbRef,
	size,
	sizeValue,
}: GhostVariantProps) {
	const filledMaskId = useId();
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
	return (
		<div
			className={cn(styles.dimensions, styles.sizeTransition, className)}
			ref={orbRef}
			style={dimensionsStyle}
		>
			<svg
				aria-hidden="true"
				height={size}
				overflow="visible"
				viewBox={insetViewBox(sizeValue)}
				width={size}
			>
				<defs>
					<mask
						height={sizeValue}
						id={filledMaskId}
						mask-type="luminance"
						maskContentUnits="userSpaceOnUse"
						maskUnits="userSpaceOnUse"
						width={sizeValue}
						x="0"
						y="0"
					>
						<rect
							fill="var(--color-logo-mask-clear)"
							height={sizeValue}
							width={sizeValue}
							x="0"
							y="0"
						/>
						<path d={ghostPathD} fill="var(--color-logo-mask-solid)" />
						<GhostEyes
							eyePosition={eyePosition}
							geometry={eyes}
							isBlinking={isBlinking}
							paint="var(--color-logo-mask-clear)"
						/>
					</mask>
				</defs>
				<path
					d={ghostPathD}
					fill="currentColor"
					mask={`url(#${filledMaskId})`}
				/>
			</svg>
		</div>
	);
}

// ── Outline variant ──────────────────────────────────────────────────────────
// Ghost shape as a crisp SVG stroke with currentColor eyes. Fully interactive.
// Relying on `overflow: visible` to show the stroke's overhang fails inside a
// compositing layer — entrance transitions can promote this container on the
// desktop start page, and macOS WKWebView rasterizes the layer to its bounds,
// shaving the ghost's right edge. Insetting the geometry inside the viewBox
// keeps the whole stroke within the box.
export function OutlineVariant({
	className,
	eyePosition,
	eyes,
	ghostPathD,
	isBlinking,
	orbRef,
	size,
	sizeValue,
}: GhostVariantProps) {
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
	return (
		<div
			className={cn(styles.dimensions, styles.sizeTransition, className)}
			ref={orbRef}
			style={dimensionsStyle}
		>
			<svg
				aria-hidden="true"
				height={size}
				overflow="visible"
				viewBox={insetViewBox(sizeValue)}
				width={size}
			>
				<path
					d={ghostPathD}
					fill="none"
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="1.5"
					vectorEffect="non-scaling-stroke"
				/>
				<GhostEyes
					eyePosition={eyePosition}
					geometry={eyes}
					isBlinking={isBlinking}
					paint="currentColor"
					vectorEffect="non-scaling-stroke"
				/>
			</svg>
		</div>
	);
}

// ── Skeleton variant ─────────────────────────────────────────────────────────
// Shimmer fill clipped to the ghost shape. Eyes in currentColor, no motion.
export function SkeletonVariant({
	className,
	eyePosition,
	eyes,
	ghostPathD,
	isBlinking,
	orbRef,
	size,
	sizeValue,
}: GhostVariantProps) {
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
	const clipStyle: LogoClipStyle = { "--logo-clip": `path("${ghostPathD}")` };
	return (
		<div
			className={cn(
				"relative",
				styles.dimensions,
				styles.sizeTransition,
				className
			)}
			ref={orbRef}
			style={dimensionsStyle}
		>
			<div
				className={cn("absolute inset-0", styles.skeleton, styles.clipped)}
				style={clipStyle}
			/>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 z-10 h-full w-full"
				viewBox={`0 0 ${sizeValue} ${sizeValue}`}
			>
				<GhostEyes
					eyePosition={eyePosition}
					geometry={eyes}
					isBlinking={isBlinking}
					paint="currentColor"
				/>
			</svg>
		</div>
	);
}

const RESTING_EYES: EyePosition = { x: 0, y: 0 };

// ── Shimmer variant ──────────────────────────────────────────────────────────
// Branded loading state: the ghost OUTLINE and eyes are painted with an animated
// linear gradient so a silver highlight sweeps *along* the stroke and eyes. The
// shimmer lives in the SVG paint itself (not a translated overlay), so it can
// never leak outside the mark. currentColor is the resting tint (theme-adaptive),
// white is the moving highlight. No mouse tracking.
export function ShimmerVariant({
	className,
	eyes,
	ghostPathD,
	isBlinking,
	orbRef,
	size,
	sizeValue,
}: Omit<GhostVariantProps, "eyePosition">) {
	const shimmerGradientId = useId();
	// Read through a hydration-safe store, never `window.matchMedia()` during
	// render: SSR and the first client render must agree on whether
	// `<animateTransform>` exists, or reduced-motion users hit hydration errors.
	const reduceMotion = usePrefersReducedMotion();
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
	const shimmerStroke = `url(#${shimmerGradientId})`;
	return (
		<div
			className={cn(styles.dimensions, styles.sizeTransition, className)}
			ref={orbRef}
			style={dimensionsStyle}
		>
			<svg
				aria-hidden="true"
				className="pointer-events-none h-full w-full"
				height={size}
				overflow="visible"
				viewBox={`0 0 ${sizeValue} ${sizeValue}`}
				width={size}
			>
				<defs>
					<linearGradient
						gradientUnits="userSpaceOnUse"
						id={shimmerGradientId}
						x1="0"
						x2={sizeValue}
						y1="0"
						y2={sizeValue}
					>
						<stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
						<stop offset="38%" stopColor="currentColor" stopOpacity="0.3" />
						<stop
							offset="50%"
							stopColor="var(--color-logo-highlight)"
							stopOpacity="1"
						/>
						<stop offset="62%" stopColor="currentColor" stopOpacity="0.3" />
						<stop offset="100%" stopColor="currentColor" stopOpacity="0.3" />
						{reduceMotion ? null : (
							<animateTransform
								attributeName="gradientTransform"
								dur="1.6s"
								from={`-${sizeValue} -${sizeValue}`}
								repeatCount="indefinite"
								to={`${sizeValue} ${sizeValue}`}
								type="translate"
							/>
						)}
					</linearGradient>
				</defs>
				<path
					d={ghostPathD}
					fill="none"
					stroke={shimmerStroke}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth="1.5"
					vectorEffect="non-scaling-stroke"
				/>
				<GhostEyes
					eyePosition={RESTING_EYES}
					geometry={eyes}
					isBlinking={isBlinking}
					paint={shimmerStroke}
				/>
			</svg>
		</div>
	);
}

interface DefaultVariantProps extends GhostVariantProps {
	animationDuration: number;
	colors?: LogoColors;
	showEyes: boolean;
}

function materialStyleFor(
	size: string,
	sizeValue: number,
	ghostPathD: string,
	colors: LogoColors | undefined,
	animationDuration: number
): LogoMaterialStyle {
	const finalColors = { ...LOGO_DEFAULT_COLORS, ...colors };
	const small = sizeValue < 50;
	const blurAmount = small
		? Math.max(sizeValue * 0.008, 1)
		: Math.max(sizeValue * 0.015, 4);
	const contrastAmount = small
		? Math.max(sizeValue * 0.004, 1.2)
		: Math.max(sizeValue * 0.008, 1.5);
	const dotSize = small
		? Math.max(sizeValue * 0.004, 0.05)
		: Math.max(sizeValue * 0.008, 0.1);
	const shadowSpread = small
		? Math.max(sizeValue * 0.004, 0.5)
		: Math.max(sizeValue * 0.008, 2);
	return {
		"--logo-size": size,
		"--logo-clip": `path("${ghostPathD}")`,
		"--bg": finalColors.bg,
		"--c1": finalColors.c1,
		"--c2": finalColors.c2,
		"--c3": finalColors.c3,
		"--animation-duration": `${animationDuration}s`,
		"--blur-amount": `${blurAmount}px`,
		"--contrast-amount": computeFinalContrast(sizeValue, contrastAmount),
		"--dot-size": `${dotSize}px`,
		"--shadow-spread": `${shadowSpread}px`,
		"--mask-radius": computeMaskRadius(sizeValue),
	};
}

// ── Default variant ──────────────────────────────────────────────────────────
// The animated material body clipped to the ghost, with mask-coloured eyes.
export function DefaultVariant({
	animationDuration,
	className,
	colors,
	eyePosition,
	eyes,
	ghostPathD,
	isBlinking,
	orbRef,
	showEyes,
	size,
	sizeValue,
}: DefaultVariantProps) {
	const materialStyle = materialStyleFor(
		size,
		sizeValue,
		ghostPathD,
		colors,
		animationDuration
	);
	return (
		<div
			className={cn(
				styles.root,
				styles.dimensions,
				styles.clipped,
				styles.shapeTransition,
				className
			)}
			ref={orbRef}
			style={materialStyle}
		>
			{showEyes ? (
				<svg
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 z-10 h-full w-full"
					viewBox={`0 0 ${sizeValue} ${sizeValue}`}
				>
					<GhostEyes
						edgeStrokeWidth="0.3"
						eyePosition={eyePosition}
						geometry={eyes}
						isBlinking={isBlinking}
						paint="var(--color-logo-mask-solid)"
					/>
				</svg>
			) : null}
		</div>
	);
}
