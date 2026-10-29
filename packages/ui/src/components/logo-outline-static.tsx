import type React from "react";
import { cn } from "../lib/utils.ts";
import styles from "./logo.module.css";
import {
	ghostPathD as buildGhostPathD,
	type LogoDimensionsStyle,
	type LogoProps,
	parseLogoSize,
} from "./logo-shared.ts";

// ── Outline-static variant ────────────────────────────────────────────────────
// The ghost outline + eyes drawn once, at rest: no blink interval, no mouse
// tracking, no hooks at all. This is the plain "original" SVG, suitable for tiny
// chrome surfaces (e.g. a tab logo) where motion would be noise and a global
// mousemove listener per instance would be wasteful. Kept hookless and separate
// from the animated `Logo` so it is genuinely static, not merely motion-ignoring.
export const OutlineStatic: React.FC<Pick<LogoProps, "size" | "className">> = ({
	size = "192px",
	className,
}) => {
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
	const sizeValue = parseLogoSize(size);
	const scaleFactor = sizeValue / 24;

	const ghostPathD = buildGhostPathD(scaleFactor);

	const eyeWidth = Math.min(1.5 * scaleFactor, 3.0);
	const eyeHeight = Math.min(3.0 * scaleFactor, 5.0);
	const leftEyeX = 15 * scaleFactor;
	const rightEyeX = Math.max(19 * scaleFactor, leftEyeX + 4);
	const eyeY = 10 * scaleFactor;

	return (
		<div className={cn(styles.dimensions, className)} style={dimensionsStyle}>
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
