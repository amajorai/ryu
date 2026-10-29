import type * as React from "react";
import { Stage } from "../../kit/react/live.tsx";

/**
 * The drawing itself, hidden from assistive tech: each figure names its interactive root
 * with a short label and points it at one visually hidden description instead. The
 * stage marks itself in view so motion pauses offscreen.
 */
export function QuietSvg({
	width,
	height,
	children,
}: {
	width: number;
	height: number;
	children: React.ReactNode;
}) {
	return (
		<Stage className="iso-stage">
			<svg
				aria-hidden="true"
				className="iso-svg"
				focusable="false"
				viewBox={`0 0 ${width} ${height}`}
			>
				{children}
			</svg>
		</Stage>
	);
}
