"use client";

import type React from "react";
import { cn } from "../lib/utils.ts";
import styles from "./logo.module.css";
import type {
	EyePosition,
	LogoDimensionsStyle,
	OrbRef,
} from "./logo-shared.ts";

interface EyesVariantProps {
	className?: string;
	eyePosition: EyePosition;
	isBlinking: boolean;
	orbRef: OrbRef;
	size: string;
	sizeValue: number;
}

// Renders just the two eyes, centered and enlarged in the viewBox. Kept as a
// standalone component so the eyes can blink/track (state lives in `useLogoGaze`) while
// keeping `Logo`'s own cognitive complexity within budget.
export const EyesVariant: React.FC<EyesVariantProps> = ({
	size,
	sizeValue,
	className,
	isBlinking,
	eyePosition,
	orbRef,
}) => {
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
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
			className={cn(styles.dimensions, styles.sizeTransition, className)}
			ref={orbRef}
			style={dimensionsStyle}
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
