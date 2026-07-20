"use client";

import type React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "../lib/utils.ts";

interface LogoProps {
	animationDuration?: number;
	className?: string;
	colors?: {
		bg?: string;
		c1?: string;
		c2?: string;
		c3?: string;
	};
	size?: string;
	variant?:
		| "default"
		| "outline"
		| "skeleton"
		| "shimmer"
		| "eyes"
		| "outline-static";
}

// Corner-mask radius for the default variant's dotted overlay, widening with the
// rendered size. Extracted from `Logo` to keep its cognitive complexity in budget.
const computeMaskRadius = (sizeValue: number): string => {
	if (sizeValue < 30) {
		return "0%";
	}
	if (sizeValue < 50) {
		return "5%";
	}
	if (sizeValue < 100) {
		return "15%";
	}
	return "25%";
};

const computeFinalContrast = (
	sizeValue: number,
	contrastAmount: number
): number => {
	if (sizeValue < 30) {
		return 1.1;
	}
	if (sizeValue < 50) {
		return Math.max(contrastAmount * 1.2, 1.3);
	}
	return contrastAmount;
};

interface EyesVariantProps {
	className?: string;
	eyePosition: { x: number; y: number };
	isBlinking: boolean;
	orbRef: React.RefObject<HTMLDivElement | null>;
	size: string;
	sizeValue: number;
}

// Renders just the two eyes, centered and enlarged in the viewBox. Kept as a
// standalone component so the eyes can blink/track (state lives in `Logo`) while
// keeping `Logo`'s own cognitive complexity within budget.
const EyesVariant: React.FC<EyesVariantProps> = ({
	size,
	sizeValue,
	className,
	isBlinking,
	eyePosition,
	orbRef,
}) => {
	// Match the desktop outline variant's eyes in *absolute* size and spacing,
	// not relative to this (small) circle: the desktop renders the ghost at 64px,
	// where the eyes resolve to rx=3, ry=5, ~10.7 apart. We reuse that fixed
	// geometry and simply center the pair in this variant's viewBox (no ghost
	// body), so the eyes read at the same size users see on the desktop.
	const referenceScale = 64 / 24;
	const eyesRx = Math.min(1.5 * referenceScale, 3.0);
	const eyesRy = Math.min(3.0 * referenceScale, 5.0);
	const referenceLeftEyeX = 15 * referenceScale;
	const referenceRightEyeX = Math.max(
		19 * referenceScale,
		referenceLeftEyeX + 4
	);
	// Pull the pair slightly closer than the desktop reference spacing.
	const eyesGap = (referenceRightEyeX - referenceLeftEyeX) * 0.9;
	const eyesCenter = sizeValue / 2;
	const eyesLeftX = eyesCenter - eyesGap / 2;
	const eyesRightX = eyesCenter + eyesGap / 2;
	const eyesBlinkStroke = Math.min(Math.max(2.0 * referenceScale, 1.0), 4.0);

	return (
		<div
			className={cn("transition-all duration-300 ease-in-out", className)}
			ref={orbRef}
			style={{
				width: size,
				height: size,
				transition: "width 0.3s ease-in-out, height 0.3s ease-in-out",
			}}
		>
			<svg
				aria-hidden="true"
				height={size}
				viewBox={`0 0 ${sizeValue} ${sizeValue}`}
				width={size}
			>
				{isBlinking ? (
					<>
						<line
							stroke="currentColor"
							strokeLinecap="round"
							strokeWidth={eyesBlinkStroke}
							vectorEffect="non-scaling-stroke"
							x1={eyesLeftX - eyesRx}
							x2={eyesLeftX + eyesRx}
							y1={eyesCenter}
							y2={eyesCenter}
						/>
						<line
							stroke="currentColor"
							strokeLinecap="round"
							strokeWidth={eyesBlinkStroke}
							vectorEffect="non-scaling-stroke"
							x1={eyesRightX - eyesRx}
							x2={eyesRightX + eyesRx}
							y1={eyesCenter}
							y2={eyesCenter}
						/>
					</>
				) : (
					<>
						<ellipse
							cx={eyesLeftX + eyePosition.x}
							cy={eyesCenter + eyePosition.y}
							fill="currentColor"
							rx={eyesRx}
							ry={eyesRy}
						/>
						<ellipse
							cx={eyesRightX + eyePosition.x}
							cy={eyesCenter + eyePosition.y}
							fill="currentColor"
							rx={eyesRx}
							ry={eyesRy}
						/>
					</>
				)}
			</svg>
		</div>
	);
};

// ── Outline-static variant ────────────────────────────────────────────────────
// The ghost outline + eyes drawn once, at rest: no blink interval, no mouse
// tracking, no hooks at all. This is the plain "original" SVG, suitable for tiny
// chrome surfaces (e.g. a tab logo) where motion would be noise and a global
// mousemove listener per instance would be wasteful. Kept hookless and separate
// from the animated `Logo` so it is genuinely static, not merely motion-ignoring.
const OutlineStatic: React.FC<Pick<LogoProps, "size" | "className">> = ({
	size = "192px",
	className,
}) => {
	const sizeValue = Number.parseInt(size.replace("px", ""), 10);
	const scaleFactor = sizeValue / 24;

	const ghostPathD = `M${12 * scaleFactor},${24 * scaleFactor}c${9.2 * scaleFactor},0,${12.9 * scaleFactor}-${4.8 * scaleFactor},${12.4 * scaleFactor}-${14.6 * scaleFactor}C${24.1 * scaleFactor},${0.3 * scaleFactor},${12.8 * scaleFactor}-${3.7 * scaleFactor},${8.8 * scaleFactor},${5.4 * scaleFactor}c-${2.2 * scaleFactor},${5.7 * scaleFactor},${1.1 * scaleFactor},${7.9 * scaleFactor}-${2.9 * scaleFactor},${12.6 * scaleFactor}c-${0.9 * scaleFactor},${1.1 * scaleFactor}-${1.8 * scaleFactor},${2 * scaleFactor}-${2.7 * scaleFactor},${3.1 * scaleFactor}c-${1.2 * scaleFactor},${1.3 * scaleFactor},${0.7 * scaleFactor},${2.2 * scaleFactor},${1.9 * scaleFactor},${2.2 * scaleFactor}C${7.4 * scaleFactor},${23.3 * scaleFactor},${9.7 * scaleFactor},${24 * scaleFactor},${12 * scaleFactor},${24 * scaleFactor}z`;

	const eyeWidth = Math.min(1.5 * scaleFactor, 3.0);
	const eyeHeight = Math.min(3.0 * scaleFactor, 5.0);
	const leftEyeX = 15 * scaleFactor;
	const rightEyeX = Math.max(19 * scaleFactor, leftEyeX + 4);
	const eyeY = 10 * scaleFactor;

	return (
		<div className={className} style={{ width: size, height: size }}>
			<svg
				aria-hidden="true"
				height={size}
				overflow="visible"
				viewBox={`0 0 ${sizeValue} ${sizeValue}`}
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
				<ellipse
					cx={leftEyeX}
					cy={eyeY}
					fill="currentColor"
					rx={eyeWidth}
					ry={eyeHeight}
				/>
				<ellipse
					cx={rightEyeX}
					cy={eyeY}
					fill="currentColor"
					rx={eyeWidth}
					ry={eyeHeight}
				/>
			</svg>
		</div>
	);
};

const AnimatedLogo: React.FC<LogoProps> = ({
	variant = "default",
	size = "192px",
	className,
	colors,
	animationDuration = 20,
}) => {
	const [isBlinking, setIsBlinking] = useState(false);
	const [eyePosition, setEyePosition] = useState({ x: 0, y: 0 });
	const [isMouseIdle, setIsMouseIdle] = useState(false);
	const orbRef = useRef<HTMLDivElement>(null);
	const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const randomMoveTimerRef = useRef<ReturnType<typeof setInterval> | null>(
		null
	);
	const shimmerGradientId = useId();

	const defaultColors = {
		bg: "oklch(95% 0.02 264)",
		c1: "oklch(75% 0.18 300)", // violet-pink
		c2: "oklch(70% 0.20 264)", // brand purple
		c3: "oklch(78% 0.15 230)", // blue-purple
	};

	const finalColors = { ...defaultColors, ...colors };

	const sizeValue = Number.parseInt(size.replace("px", ""), 10);

	const blurAmount =
		sizeValue < 50
			? Math.max(sizeValue * 0.008, 1)
			: Math.max(sizeValue * 0.015, 4);

	const contrastAmount =
		sizeValue < 50
			? Math.max(sizeValue * 0.004, 1.2)
			: Math.max(sizeValue * 0.008, 1.5);

	const dotSize =
		sizeValue < 50
			? Math.max(sizeValue * 0.004, 0.05)
			: Math.max(sizeValue * 0.008, 0.1);

	const shadowSpread =
		sizeValue < 50
			? Math.max(sizeValue * 0.004, 0.5)
			: Math.max(sizeValue * 0.008, 2);

	const maskRadius = computeMaskRadius(sizeValue);

	const finalContrast = computeFinalContrast(sizeValue, contrastAmount);

	const scaleFactor = sizeValue / 24;

	// Shared ghost path d-string (no path() wrapper) — used for SVG path and clip-path
	const ghostPathD = `M${12 * scaleFactor},${24 * scaleFactor}c${9.2 * scaleFactor},0,${12.9 * scaleFactor}-${4.8 * scaleFactor},${12.4 * scaleFactor}-${14.6 * scaleFactor}C${24.1 * scaleFactor},${0.3 * scaleFactor},${12.8 * scaleFactor}-${3.7 * scaleFactor},${8.8 * scaleFactor},${5.4 * scaleFactor}c-${2.2 * scaleFactor},${5.7 * scaleFactor},${1.1 * scaleFactor},${7.9 * scaleFactor}-${2.9 * scaleFactor},${12.6 * scaleFactor}c-${0.9 * scaleFactor},${1.1 * scaleFactor}-${1.8 * scaleFactor},${2 * scaleFactor}-${2.7 * scaleFactor},${3.1 * scaleFactor}c-${1.2 * scaleFactor},${1.3 * scaleFactor},${0.7 * scaleFactor},${2.2 * scaleFactor},${1.9 * scaleFactor},${2.2 * scaleFactor}C${7.4 * scaleFactor},${23.3 * scaleFactor},${9.7 * scaleFactor},${24 * scaleFactor},${12 * scaleFactor},${24 * scaleFactor}z`;

	const scaledClipPath = `path("${ghostPathD}")`;

	const baseEyeWidth = 1.5;
	const baseEyeHeight = 3.0;
	const maxEyeWidth = 3.0;
	const maxEyeHeight = 5.0;

	const eyeWidth = Math.min(baseEyeWidth * scaleFactor, maxEyeWidth);
	const eyeHeight = Math.min(baseEyeHeight * scaleFactor, maxEyeHeight);

	const baseLeftEyeX = 15;
	const baseRightEyeX = 19;
	const baseEyeY = 10;
	const eyeSpacing = 4;

	const leftEyeX = baseLeftEyeX * scaleFactor;
	const rightEyeX = Math.max(
		baseRightEyeX * scaleFactor,
		leftEyeX + eyeSpacing
	);
	const eyeY = baseEyeY * scaleFactor;

	const blinkStrokeWidth = Math.min(Math.max(2.0 * scaleFactor, 1.0), 4.0);
	const leftBlinkStart = leftEyeX - eyeWidth;
	const leftBlinkEnd = leftEyeX + eyeWidth;
	const rightBlinkStart = rightEyeX - eyeWidth;
	const rightBlinkEnd = rightEyeX + eyeWidth;

	// Memoized so it keeps a stable identity across renders. The idle-gaze effect
	// below lists it as a dependency; an inline function would be recreated every
	// render, re-running that effect, which calls setEyePosition — an infinite
	// "Maximum update depth exceeded" loop while the mouse is idle.
	const generateRandomEyePosition = useCallback(() => {
		const maxDistance = Math.min(sizeValue * 0.08, 8.0);
		const angle = Math.random() * Math.PI * 2;
		const distance = Math.random() * maxDistance;
		return {
			x: Math.cos(angle) * distance,
			y: Math.sin(angle) * distance,
		};
	}, [sizeValue]);

	useEffect(() => {
		const blinkInterval = setInterval(
			() => {
				setIsBlinking(true);
				setTimeout(() => setIsBlinking(false), 150);
			},
			3000 + Math.random() * 2000
		);
		return () => clearInterval(blinkInterval);
	}, []);

	useEffect(() => {
		const resetIdleTimer = () => {
			setIsMouseIdle(false);
			if (idleTimerRef.current) {
				clearTimeout(idleTimerRef.current);
			}
			if (randomMoveTimerRef.current) {
				clearInterval(randomMoveTimerRef.current);
			}
			idleTimerRef.current = setTimeout(() => {
				setIsMouseIdle(true);
			}, 3000);
		};

		const handleMouseMove = (e: MouseEvent) => {
			resetIdleTimer();
			if (!orbRef.current) {
				return;
			}
			const rect = orbRef.current.getBoundingClientRect();
			const orbCenterX = rect.left + rect.width / 2;
			const orbCenterY = rect.top + rect.height / 2;
			const angle = Math.atan2(e.clientY - orbCenterY, e.clientX - orbCenterX);
			const maxDistance = Math.min(sizeValue * 0.1, 15.0);
			setEyePosition({
				x: Math.cos(angle) * maxDistance,
				y: Math.sin(angle) * maxDistance,
			});
		};

		resetIdleTimer();
		window.addEventListener("mousemove", handleMouseMove);
		return () => {
			window.removeEventListener("mousemove", handleMouseMove);
			if (idleTimerRef.current) {
				clearTimeout(idleTimerRef.current);
			}
			if (randomMoveTimerRef.current) {
				clearInterval(randomMoveTimerRef.current);
			}
		};
	}, [sizeValue]);

	useEffect(() => {
		if (!isMouseIdle) {
			return;
		}

		const moveRandomly = () => {
			setEyePosition(generateRandomEyePosition());
		};

		moveRandomly();
		randomMoveTimerRef.current = setInterval(
			moveRandomly,
			2000 + Math.random() * 2000
		);

		return () => {
			if (randomMoveTimerRef.current) {
				clearInterval(randomMoveTimerRef.current);
			}
		};
	}, [isMouseIdle, generateRandomEyePosition]);

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
				orbRef={orbRef}
				size={size}
				sizeValue={sizeValue}
			/>
		);
	}

	// ── Outline variant ──────────────────────────────────────────────────────────
	// Ghost shape as a crisp SVG stroke with currentColor eyes. Fully interactive.
	if (variant === "outline") {
		// The ghost path is drawn edge-to-edge, so its 1.5px non-scaling stroke
		// straddles the viewBox boundary by half its width. Relying on
		// `overflow: visible` to show that overhang fails inside a compositing
		// layer — StaggerReveal clones `will-change: transform` onto this
		// container on the desktop start page, and macOS WKWebView rasterizes the
		// layer to its bounds, shaving the ghost's right edge. Insetting the
		// geometry inside the viewBox keeps the whole stroke within the box.
		const strokeMargin = 1.5;
		const outlineViewBox = `${-strokeMargin} ${-strokeMargin} ${sizeValue + strokeMargin * 2} ${sizeValue + strokeMargin * 2}`;
		return (
			<div
				className={cn("transition-all duration-300 ease-in-out", className)}
				ref={orbRef}
				style={{
					width: size,
					height: size,
					transition: "width 0.3s ease-in-out, height 0.3s ease-in-out",
				}}
			>
				<svg
					aria-hidden="true"
					height={size}
					overflow="visible"
					viewBox={outlineViewBox}
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
					{isBlinking ? (
						<>
							<line
								stroke="currentColor"
								strokeLinecap="round"
								strokeWidth={blinkStrokeWidth}
								vectorEffect="non-scaling-stroke"
								x1={leftBlinkStart}
								x2={leftBlinkEnd}
								y1={eyeY}
								y2={eyeY}
							/>
							<line
								stroke="currentColor"
								strokeLinecap="round"
								strokeWidth={blinkStrokeWidth}
								vectorEffect="non-scaling-stroke"
								x1={rightBlinkStart}
								x2={rightBlinkEnd}
								y1={eyeY}
								y2={eyeY}
							/>
						</>
					) : (
						<>
							<ellipse
								cx={leftEyeX + eyePosition.x}
								cy={eyeY + eyePosition.y}
								fill="currentColor"
								rx={eyeWidth}
								ry={eyeHeight}
							/>
							<ellipse
								cx={rightEyeX + eyePosition.x}
								cy={eyeY + eyePosition.y}
								fill="currentColor"
								rx={eyeWidth}
								ry={eyeHeight}
							/>
						</>
					)}
				</svg>
			</div>
		);
	}

	// ── Skeleton variant ─────────────────────────────────────────────────────────
	// Shimmer fill clipped to the ghost shape. Eyes in currentColor, no motion.
	if (variant === "skeleton") {
		return (
			<div
				className={cn(
					"relative transition-all duration-300 ease-in-out",
					className
				)}
				ref={orbRef}
				style={{
					width: size,
					height: size,
					transition: "width 0.3s ease-in-out, height 0.3s ease-in-out",
				}}
			>
				<style>{`
          @keyframes ryu-skeleton-shimmer {
            0%   { background-position: -200% center; }
            100% { background-position:  200% center; }
          }
          .ryu-logo-skeleton {
            animation: ryu-skeleton-shimmer 1.8s ease-in-out infinite;
            background: linear-gradient(
              90deg,
              oklch(83% 0.01 264) 0%,
              oklch(91% 0.03 264) 45%,
              oklch(95% 0.04 264) 50%,
              oklch(91% 0.03 264) 55%,
              oklch(83% 0.01 264) 100%
            );
            background-size: 200% 100%;
          }
          @media (prefers-color-scheme: dark) {
            .ryu-logo-skeleton {
              background: linear-gradient(
                90deg,
                oklch(28% 0.02 264) 0%,
                oklch(36% 0.03 264) 45%,
                oklch(40% 0.04 264) 50%,
                oklch(36% 0.03 264) 55%,
                oklch(28% 0.02 264) 100%
              );
              background-size: 200% 100%;
            }
          }
        `}</style>
				<div
					className="ryu-logo-skeleton absolute inset-0"
					style={{ clipPath: scaledClipPath }}
				/>
				<svg
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 h-full w-full"
					style={{ zIndex: 10 }}
					viewBox={`0 0 ${sizeValue} ${sizeValue}`}
				>
					{isBlinking ? (
						<>
							<line
								stroke="currentColor"
								strokeLinecap="round"
								strokeWidth={blinkStrokeWidth}
								x1={leftBlinkStart}
								x2={leftBlinkEnd}
								y1={eyeY}
								y2={eyeY}
							/>
							<line
								stroke="currentColor"
								strokeLinecap="round"
								strokeWidth={blinkStrokeWidth}
								x1={rightBlinkStart}
								x2={rightBlinkEnd}
								y1={eyeY}
								y2={eyeY}
							/>
						</>
					) : (
						<>
							<ellipse
								cx={leftEyeX + eyePosition.x}
								cy={eyeY + eyePosition.y}
								fill="currentColor"
								rx={eyeWidth}
								ry={eyeHeight}
							/>
							<ellipse
								cx={rightEyeX + eyePosition.x}
								cy={eyeY + eyePosition.y}
								fill="currentColor"
								rx={eyeWidth}
								ry={eyeHeight}
							/>
						</>
					)}
				</svg>
			</div>
		);
	}

	// ── Shimmer variant ──────────────────────────────────────────────────────────
	// Branded loading state: the ghost OUTLINE and eyes are painted with an animated
	// linear gradient so a silver highlight sweeps *along* the stroke and eyes. The
	// shimmer lives in the SVG paint itself (not a translated overlay), so it can
	// never leak outside the mark. currentColor is the resting tint (theme-adaptive),
	// white is the moving highlight. No mouse tracking.
	if (variant === "shimmer") {
		const reduceMotion =
			typeof window !== "undefined" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const shimmerStroke = `url(#${shimmerGradientId})`;
		return (
			<div
				className={cn("transition-all duration-300 ease-in-out", className)}
				ref={orbRef}
				style={{
					width: size,
					height: size,
					transition: "width 0.3s ease-in-out, height 0.3s ease-in-out",
				}}
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
							<stop offset="50%" stopColor="#ffffff" stopOpacity="1" />
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
					{isBlinking ? (
						<>
							<line
								stroke={shimmerStroke}
								strokeLinecap="round"
								strokeWidth={blinkStrokeWidth}
								x1={leftBlinkStart}
								x2={leftBlinkEnd}
								y1={eyeY}
								y2={eyeY}
							/>
							<line
								stroke={shimmerStroke}
								strokeLinecap="round"
								strokeWidth={blinkStrokeWidth}
								x1={rightBlinkStart}
								x2={rightBlinkEnd}
								y1={eyeY}
								y2={eyeY}
							/>
						</>
					) : (
						<>
							<ellipse
								cx={leftEyeX}
								cy={eyeY}
								fill={shimmerStroke}
								rx={eyeWidth}
								ry={eyeHeight}
							/>
							<ellipse
								cx={rightEyeX}
								cy={eyeY}
								fill={shimmerStroke}
								rx={eyeWidth}
								ry={eyeHeight}
							/>
						</>
					)}
				</svg>
			</div>
		);
	}

	// ── Default variant ──────────────────────────────────────────────────────────
	return (
		<div
			className={cn(
				"ryu-logo transition-all duration-300 ease-in-out",
				className
			)}
			ref={orbRef}
			style={
				{
					width: size,
					height: size,
					"--bg": finalColors.bg,
					"--c1": finalColors.c1,
					"--c2": finalColors.c2,
					"--c3": finalColors.c3,
					"--animation-duration": `${animationDuration}s`,
					"--blur-amount": `${blurAmount}px`,
					"--contrast-amount": finalContrast,
					"--dot-size": `${dotSize}px`,
					"--shadow-spread": `${shadowSpread}px`,
					"--mask-radius": maskRadius,
					clipPath: scaledClipPath,
					transition:
						"width 0.3s ease-in-out, height 0.3s ease-in-out, clip-path 0.3s ease-in-out",
				} as React.CSSProperties
			}
		>
			<style>{`
        @property --angle {
          syntax: "<angle>";
          inherits: false;
          initial-value: 0deg;
        }

        .ryu-logo {
          display: grid;
          grid-template-areas: "stack";
          overflow: hidden;
          position: relative;
          transform: scale(1.1);
        }

        .ryu-logo::before,
        .ryu-logo::after {
          content: "";
          display: block;
          grid-area: stack;
          width: 100%;
          height: 100%;
          transform: translateZ(0);
        }

        .ryu-logo::before {
          background: conic-gradient(
              from calc(var(--angle) * 2) at 25% 70%,
              var(--c3),
              transparent 20% 80%,
              var(--c3)
            ),
            conic-gradient(
              from calc(var(--angle) * 2) at 45% 75%,
              var(--c2),
              transparent 30% 60%,
              var(--c2)
            ),
            conic-gradient(
              from calc(var(--angle) * -3) at 80% 20%,
              var(--c1),
              transparent 40% 60%,
              var(--c1)
            ),
            conic-gradient(
              from calc(var(--angle) * 2) at 15% 5%,
              var(--c2),
              transparent 10% 90%,
              var(--c2)
            ),
            conic-gradient(
              from calc(var(--angle) * 1) at 20% 80%,
              var(--c1),
              transparent 10% 90%,
              var(--c1)
            ),
            conic-gradient(
              from calc(var(--angle) * -2) at 85% 10%,
              var(--c3),
              transparent 20% 80%,
              var(--c3)
            );
          box-shadow: inset var(--bg) 0 0 var(--shadow-spread)
            calc(var(--shadow-spread) * 0.2);
          filter: blur(var(--blur-amount)) contrast(var(--contrast-amount));
          animation: ryu-logo-rotate var(--animation-duration) linear infinite;
        }

        .ryu-logo::after {
          background-image: radial-gradient(
            circle at center,
            var(--bg) var(--dot-size),
            transparent var(--dot-size)
          );
          background-size: calc(var(--dot-size) * 2) calc(var(--dot-size) * 2);
          backdrop-filter: blur(calc(var(--blur-amount) * 2))
            contrast(calc(var(--contrast-amount) * 2));
          mix-blend-mode: overlay;
        }

        .ryu-logo[style*="--mask-radius: 0%"]::after {
          mask-image: none;
        }

        .ryu-logo:not([style*="--mask-radius: 0%"])::after {
          mask-image: radial-gradient(
            black var(--mask-radius),
            transparent 75%
          );
        }

        @keyframes ryu-logo-rotate {
          to {
            --angle: 360deg;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .ryu-logo::before {
            animation: none;
          }
        }
      `}</style>

			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 h-full w-full"
				style={{ zIndex: 10 }}
				viewBox={`0 0 ${sizeValue} ${sizeValue}`}
			>
				{isBlinking ? (
					<>
						<line
							stroke="white"
							strokeLinecap="round"
							strokeWidth={blinkStrokeWidth}
							x1={leftBlinkStart}
							x2={leftBlinkEnd}
							y1={eyeY}
							y2={eyeY}
						/>
						<line
							stroke="white"
							strokeLinecap="round"
							strokeWidth={blinkStrokeWidth}
							x1={rightBlinkStart}
							x2={rightBlinkEnd}
							y1={eyeY}
							y2={eyeY}
						/>
					</>
				) : (
					<>
						<ellipse
							cx={leftEyeX + eyePosition.x}
							cy={eyeY + eyePosition.y}
							fill="white"
							rx={eyeWidth}
							ry={eyeHeight}
							stroke="white"
							strokeWidth="0.3"
						/>
						<ellipse
							cx={rightEyeX + eyePosition.x}
							cy={eyeY + eyePosition.y}
							fill="white"
							rx={eyeWidth}
							ry={eyeHeight}
							stroke="white"
							strokeWidth="0.3"
						/>
					</>
				)}
			</svg>
		</div>
	);
};

// Thin dispatcher: the static outline is a hookless component so it installs no
// blink interval and no global mousemove listener; every other variant is the
// fully-interactive `AnimatedLogo`.
const Logo: React.FC<LogoProps> = (props) => {
	if (props.variant === "outline-static") {
		return <OutlineStatic className={props.className} size={props.size} />;
	}
	return <AnimatedLogo {...props} />;
};

export type { LogoProps };
export { Logo };
