import type { EyePosition } from "./logo-shared.ts";

/** Eye placement on the ghost body, in the scaled viewBox's units. */
export interface GhostEyeGeometry {
	blinkStrokeWidth: number;
	eyeHeight: number;
	eyeWidth: number;
	eyeY: number;
	leftBlinkEnd: number;
	leftBlinkStart: number;
	leftEyeX: number;
	rightBlinkEnd: number;
	rightBlinkStart: number;
	rightEyeX: number;
}

export function ghostEyeGeometry(scaleFactor: number): GhostEyeGeometry {
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

	return {
		blinkStrokeWidth: Math.min(Math.max(2.0 * scaleFactor, 1.0), 4.0),
		eyeHeight,
		eyeWidth,
		eyeY,
		leftBlinkEnd: leftEyeX + eyeWidth,
		leftBlinkStart: leftEyeX - eyeWidth,
		leftEyeX,
		rightBlinkEnd: rightEyeX + eyeWidth,
		rightBlinkStart: rightEyeX - eyeWidth,
		rightEyeX,
	};
}

interface GhostEyesProps {
	/** Paint the open eyes' rim too (the default variant's soft edge). */
	edgeStrokeWidth?: string;
	eyePosition: EyePosition;
	geometry: GhostEyeGeometry;
	isBlinking: boolean;
	/** Fill of the open eyes and stroke of the closed ones. */
	paint: string;
	/** Keep the blink line's width independent of the viewBox scale. */
	vectorEffect?: "non-scaling-stroke";
}

/**
 * The ghost's two eyes: ellipses offset by the gaze while open, horizontal
 * lines while blinking. Shared by every variant that draws eyes on the body.
 */
export function GhostEyes({
	edgeStrokeWidth,
	eyePosition,
	geometry,
	isBlinking,
	paint,
	vectorEffect,
}: GhostEyesProps) {
	const {
		blinkStrokeWidth,
		eyeHeight,
		eyeWidth,
		eyeY,
		leftBlinkEnd,
		leftBlinkStart,
		leftEyeX,
		rightBlinkEnd,
		rightBlinkStart,
		rightEyeX,
	} = geometry;
	if (isBlinking) {
		return (
			<>
				<line
					stroke={paint}
					strokeLinecap="round"
					strokeWidth={blinkStrokeWidth}
					vectorEffect={vectorEffect}
					x1={leftBlinkStart}
					x2={leftBlinkEnd}
					y1={eyeY}
					y2={eyeY}
				/>
				<line
					stroke={paint}
					strokeLinecap="round"
					strokeWidth={blinkStrokeWidth}
					vectorEffect={vectorEffect}
					x1={rightBlinkStart}
					x2={rightBlinkEnd}
					y1={eyeY}
					y2={eyeY}
				/>
			</>
		);
	}
	const edgeStroke = edgeStrokeWidth ? paint : undefined;
	return (
		<>
			<ellipse
				cx={leftEyeX + eyePosition.x}
				cy={eyeY + eyePosition.y}
				fill={paint}
				rx={eyeWidth}
				ry={eyeHeight}
				stroke={edgeStroke}
				strokeWidth={edgeStrokeWidth}
			/>
			<ellipse
				cx={rightEyeX + eyePosition.x}
				cy={eyeY + eyePosition.y}
				fill={paint}
				rx={eyeWidth}
				ry={eyeHeight}
				stroke={edgeStroke}
				strokeWidth={edgeStrokeWidth}
			/>
		</>
	);
}
