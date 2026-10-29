"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import {
	blendExpressiveFrames,
	type ExpressiveExpressionSelection,
	expressiveFrame,
} from "./expressive.ts";
import {
	type ExpressiveAnimationSelection,
	expressiveAnimationPreviewTime,
	sampleExpressiveAnimation,
} from "./expressive-animation.ts";
import styles from "./logo.module.css";
import { ExpressiveDecorationLayer } from "./logo-expressive-decorations.tsx";
import type {
	EyePosition,
	LogoDimensionsStyle,
	OrbRef,
} from "./logo-shared.ts";
import { usePrefersReducedMotion } from "./reduced-motion.ts";

interface ExpressiveVariantProps {
	animated: boolean;
	animation: ExpressiveAnimationSelection;
	bodyStrokeWidth: number;
	className?: string;
	expression: ExpressiveExpressionSelection;
	eyePosition: EyePosition;
	eyeScale: number;
	ghostPathD: string;
	isBlinking: boolean;
	orbRef: OrbRef;
	outlineOnly: boolean;
	size: string;
	sizeValue: number;
}

/**
 * Renders Ryu's own ghost body with the reference-style expressive timeline.
 * Named states and the random cycle both pass through the same pure sampler, so
 * state changes cross-fade instead of teleporting between unrelated drawings.
 */
export const ExpressiveVariant: React.FC<ExpressiveVariantProps> = ({
	animated,
	animation,
	className,
	eyeScale,
	expression,
	eyePosition,
	isBlinking,
	orbRef,
	ghostPathD,
	outlineOnly,
	size,
	sizeValue,
	bodyStrokeWidth,
}) => {
	const dimensionsStyle: LogoDimensionsStyle = { "--logo-size": size };
	const initialFrame = expressiveFrame(expression);
	const transitionRef = useRef({
		from: initialFrame,
		progress: 1,
		to: initialFrame,
	});
	const [transition, setTransition] = useState(transitionRef.current);
	const [animationTime, setAnimationTime] = useState(0);
	const prefersReducedMotion = usePrefersReducedMotion();
	const motionEnabled = animated && !prefersReducedMotion;

	useEffect(() => {
		const next = expressiveFrame(expression);
		const current = transitionRef.current;
		if (current.to.id === next.id && current.progress === 1) {
			return;
		}
		if (!motionEnabled) {
			const settled = { from: next, progress: 1, to: next };
			transitionRef.current = settled;
			setTransition(settled);
			return;
		}

		const started = performance.now();
		const nextTransition = { from: current.to, progress: 0, to: next };
		transitionRef.current = nextTransition;
		setTransition(nextTransition);
		let frameId = 0;
		const tick = (now: number) => {
			const progress = Math.min((now - started) / 450, 1);
			const running = { from: current.to, progress, to: next };
			transitionRef.current = running;
			setTransition(running);
			if (progress < 1) {
				frameId = requestAnimationFrame(tick);
			}
		};
		frameId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frameId);
	}, [expression, motionEnabled]);

	useEffect(() => {
		if (!motionEnabled) {
			setAnimationTime(0);
			return;
		}
		const started = performance.now();
		let frameId = 0;
		const tick = (now: number) => {
			setAnimationTime((now - started) / 1000);
			frameId = requestAnimationFrame(tick);
		};
		frameId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frameId);
	}, [motionEnabled]);

	const expressionFrame = blendExpressiveFrames(
		transition.from,
		transition.to,
		transition.progress
	);
	const sampleTime = motionEnabled
		? animationTime
		: animation === "random"
			? 0
			: expressiveAnimationPreviewTime(animation);
	const sampled = sampleExpressiveAnimation(
		sampleTime,
		animation,
		expressionFrame
	);
	const frame = sampled.eyes;
	const scaleFactor = sizeValue / 24;
	const expressiveEyeScale = Math.max(0.1, eyeScale);
	const centerX = 17 * scaleFactor + frame.gaze.x * scaleFactor;
	const eyeGap = frame.gap * scaleFactor;
	const gazePosition = sampled.followGaze ? eyePosition : { x: 0, y: 0 };
	const eyeY = 10 * scaleFactor + frame.gaze.y * scaleFactor + gazePosition.y;
	const eyeCenters = [centerX - eyeGap / 2, centerX + eyeGap / 2];
	const openMultiplier = sampled.animation === "idle" && isBlinking ? 0.06 : 1;
	const center = sizeValue / 2;
	const bodyTransform = `translate(${sampled.body.x * scaleFactor} ${sampled.body.y * scaleFactor}) rotate(${sampled.body.rotate} ${center} ${center}) translate(${center} ${center}) scale(${sampled.body.scaleX} ${sampled.body.scaleY}) translate(${-center} ${-center})`;

	return (
		<div
			className={cn(
				"duration-300 ease-in-out",
				styles.dimensions,
				styles.sizeTransition,
				outlineOnly && "text-muted-foreground",
				className
			)}
			data-expressive-animation={sampled.animation}
			data-expressive-animation-progress={sampled.progress.toFixed(3)}
			data-expressive-expression={frame.id}
			data-expressive-eye-scale={expressiveEyeScale}
			ref={orbRef}
			style={dimensionsStyle}
		>
			<svg
				aria-hidden="true"
				height={size}
				overflow="visible"
				viewBox={`0 0 ${sizeValue} ${sizeValue}`}
				width={size}
			>
				<ExpressiveDecorationLayer
					decorations={sampled.decorations}
					outlineOnly={outlineOnly}
					scaleFactor={scaleFactor}
				/>
				<g transform={bodyTransform}>
					<path
						d={ghostPathD}
						fill="none"
						opacity={0.96}
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={bodyStrokeWidth}
						vectorEffect="non-scaling-stroke"
					/>
					<g opacity={sampled.eyeAlpha}>
						{frame.eyes.map((eye, index) => {
							const width = Math.max(
								eye.width * scaleFactor * expressiveEyeScale,
								0.1
							);
							const height = Math.max(
								eye.height *
									scaleFactor *
									expressiveEyeScale *
									eye.open *
									openMultiplier,
								0.1
							);
							const cx = eyeCenters[index] ?? centerX;
							const key = index === 0 ? "left" : "right";
							const transform = `translate(${cx + gazePosition.x} ${eyeY}) rotate(${frame.gaze.roll + eye.tilt})`;
							if (eye.shape === "x") {
								const crossSize = Math.max(height, 1.4);
								const crossStrokeWidth = Math.max(
									Math.min(width * 0.2, 2.2),
									1.25
								);
								return (
									<g
										data-expressive-eye-shape={eye.shape}
										key={key}
										transform={transform}
									>
										<line
											stroke="currentColor"
											strokeLinecap="round"
											strokeWidth={crossStrokeWidth}
											vectorEffect="non-scaling-stroke"
											x1={-crossSize / 2}
											x2={crossSize / 2}
											y1={-crossSize / 2}
											y2={crossSize / 2}
										/>
										<line
											stroke="currentColor"
											strokeLinecap="round"
											strokeWidth={crossStrokeWidth}
											vectorEffect="non-scaling-stroke"
											x1={crossSize / 2}
											x2={-crossSize / 2}
											y1={-crossSize / 2}
											y2={crossSize / 2}
										/>
									</g>
								);
							}
							return (
								<rect
									data-expressive-eye-shape={eye.shape}
									fill={outlineOnly ? "none" : "currentColor"}
									height={height}
									key={key}
									opacity={sampled.eyeAlpha}
									rx={Math.min(width, height) / 2}
									stroke={outlineOnly ? "currentColor" : undefined}
									strokeLinecap={outlineOnly ? "round" : undefined}
									strokeLinejoin={outlineOnly ? "round" : undefined}
									strokeWidth={outlineOnly ? 1 : undefined}
									transform={`rotate(${frame.gaze.roll + eye.tilt} ${cx} ${eyeY})`}
									vectorEffect={outlineOnly ? "non-scaling-stroke" : undefined}
									width={width}
									x={cx - width / 2 + gazePosition.x}
									y={eyeY - height / 2}
								/>
							);
						})}
					</g>
				</g>
			</svg>
		</div>
	);
};
