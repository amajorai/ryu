import type React from "react";
import type { ExpressiveAnimationDecoration } from "./expressive-animation.ts";

interface ExpressiveDecorationLayerProps {
	decorations: readonly ExpressiveAnimationDecoration[];
	outlineOnly: boolean;
	scaleFactor: number;
}

export const ExpressiveDecorationLayer: React.FC<
	ExpressiveDecorationLayerProps
> = ({ decorations, outlineOnly, scaleFactor }) => (
	<g>
		{decorations.map((decoration, index) => {
			const color = outlineOnly
				? "currentColor"
				: "color" in decoration
					? (decoration.color ?? "currentColor")
					: "currentColor";
			const key = `${decoration.kind}-${index}`;
			switch (decoration.kind) {
				case "dot":
					return (
						<circle
							cx={decoration.x * scaleFactor}
							cy={decoration.y * scaleFactor}
							fill={outlineOnly ? "none" : color}
							key={key}
							opacity={decoration.opacity}
							r={decoration.r * scaleFactor}
							stroke={outlineOnly ? "currentColor" : undefined}
							strokeWidth={outlineOnly ? 1 : undefined}
							vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
						/>
					);
				case "ring":
					return (
						<ellipse
							cx={decoration.cx * scaleFactor}
							cy={decoration.cy * scaleFactor}
							fill="none"
							key={key}
							opacity={decoration.opacity}
							rx={decoration.radiusX * scaleFactor}
							ry={decoration.radiusY * scaleFactor}
							stroke={color}
							strokeDasharray={decoration.dash}
							strokeLinecap="round"
							strokeWidth={outlineOnly ? 1 : Math.max(0.7, 0.08 * scaleFactor)}
							transform={`rotate(${decoration.rotate} ${decoration.cx * scaleFactor} ${decoration.cy * scaleFactor})`}
							vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
						/>
					);
				case "ray":
					return (
						<line
							key={key}
							opacity={decoration.opacity}
							stroke={color}
							strokeLinecap="round"
							strokeWidth={outlineOnly ? 1 : Math.max(0.8, 0.11 * scaleFactor)}
							vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
							x1={decoration.x1 * scaleFactor}
							x2={decoration.x2 * scaleFactor}
							y1={decoration.y1 * scaleFactor}
							y2={decoration.y2 * scaleFactor}
						/>
					);
				case "badge":
					return (
						<circle
							cx={decoration.x * scaleFactor}
							cy={decoration.y * scaleFactor}
							fill={outlineOnly ? "none" : color}
							key={key}
							opacity={decoration.opacity}
							r={decoration.r * scaleFactor}
							stroke="currentColor"
							strokeWidth={outlineOnly ? 1 : Math.max(0.6, 0.08 * scaleFactor)}
							vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
						/>
					);
				case "exclamation":
					return (
						<g
							key={key}
							opacity={decoration.opacity}
							transform={`translate(${decoration.x * scaleFactor} ${decoration.y * scaleFactor}) rotate(${decoration.rotate}) scale(${decoration.scale * scaleFactor})`}
						>
							<rect
								fill={outlineOnly ? "none" : "currentColor"}
								height="3.7"
								rx="0.42"
								stroke={outlineOnly ? "currentColor" : undefined}
								strokeWidth={outlineOnly ? 1 : undefined}
								vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
								width="0.84"
								x="-0.42"
								y="-2.6"
							/>
							<circle
								cy="2.2"
								fill={outlineOnly ? "none" : "currentColor"}
								r="0.52"
								stroke={outlineOnly ? "currentColor" : undefined}
								strokeWidth={outlineOnly ? 1 : undefined}
								vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
							/>
						</g>
					);
				case "comet":
					return (
						<g
							key={key}
							opacity={decoration.opacity}
							transform={`translate(${decoration.x * scaleFactor} ${decoration.y * scaleFactor}) rotate(${decoration.rotate}) scale(${decoration.scale * scaleFactor})`}
						>
							<path
								d="M-5 0C-3.4-1.4-1.7-1.5 0 0C-1.7 1.5-3.4 1.4-5 0Z"
								fill="none"
								stroke={color}
								strokeLinecap="round"
								strokeWidth={outlineOnly ? 1 : 0.42}
								vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
							/>
							<circle
								cx="0"
								cy="0"
								fill={outlineOnly ? "none" : color}
								r="0.62"
								stroke={outlineOnly ? "currentColor" : undefined}
								strokeWidth={outlineOnly ? 1 : undefined}
								vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
							/>
						</g>
					);
				case "play":
					return (
						<polygon
							fill={outlineOnly ? "none" : "currentColor"}
							key={key}
							opacity={decoration.opacity}
							points="-1.6,-2.1 2.1,0 -1.6,2.1"
							stroke={outlineOnly ? "currentColor" : undefined}
							strokeWidth={outlineOnly ? 1 : undefined}
							transform={`translate(${decoration.x * scaleFactor} ${decoration.y * scaleFactor}) rotate(${decoration.rotate}) scale(${decoration.scale * scaleFactor})`}
							vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
						/>
					);
			}
		})}
	</g>
);
