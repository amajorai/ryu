"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { motion, useInView } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

interface SignatureProps {
	className?: string;
	color?: string;
	delay?: number;
	duration?: number;
	fontSize?: number;
	fontUrl?: string;
	inView?: boolean;
	once?: boolean;
	text?: string;
}

const DEFAULT_FONT_URLS = [
	"https://componentry.dev/LastoriaBoldRegular.otf",
] as const;

export function Signature({
	text = "Signature",
	color = "currentColor",
	fontSize = 32,
	duration = 1.5,
	delay = 0,
	className,
	inView = true,
	once = true,
	fontUrl,
}: SignatureProps) {
	const [paths, setPaths] = useState<string[]>([]);
	const [width, setWidth] = useState(300);
	const [hasAnimated, setHasAnimated] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const hasEnteredView = useInView(containerRef, { once, amount: 0.2 });
	const height = fontSize * 3;
	const horizontalPadding = fontSize * 0.1;
	const topMargin = fontSize * 1.5;
	const baseline = topMargin;
	const maskId = `signature-reveal-${useId().replace(/:/g, "")}`;
	const isReady = paths.length > 0;
	const shouldAnimate =
		isReady && !hasAnimated && (inView ? hasEnteredView : true);

	useEffect(() => {
		let cancelled = false;

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
		async function loadSignature() {
			try {
				const { parse } = await import("opentype.js");
				const fontPaths = fontUrl ? [fontUrl] : [...DEFAULT_FONT_URLS];
				let font: ReturnType<typeof parse> | null = null;

				for (const path of fontPaths) {
					try {
						const response = await fetch(path);
						if (!response.ok) {
							continue;
						}

						const buffer = await response.arrayBuffer();
						font = parse(buffer);
						break;
					} catch {
						// try next path
					}
				}

				if (!font) {
					throw new Error("Signature font could not be loaded");
				}

				let x = horizontalPadding;
				const newPaths: string[] = [];

				for (const char of text) {
					const glyph = font.charToGlyph(char);
					const path = glyph.getPath(x, baseline, fontSize);
					newPaths.push(path.toPathData(3));

					const advanceWidth = glyph.advanceWidth ?? font.unitsPerEm;
					x += advanceWidth * (fontSize / font.unitsPerEm);
				}

				if (!cancelled) {
					setPaths(newPaths);
					setWidth(x + horizontalPadding);
				}
			} catch {
				if (!cancelled) {
					setPaths([]);
					setWidth(text.length * fontSize * 0.6);
				}
			}
		}

		loadSignature().catch(() => undefined);

		return () => {
			cancelled = true;
		};
	}, [text, fontSize, baseline, horizontalPadding, fontUrl]);

	const variants = {
		hidden: { pathLength: 0, opacity: 0 },
		visible: { pathLength: 1, opacity: 1 },
	};

	const motionState = hasAnimated
		? "visible"
		: shouldAnimate
			? "visible"
			: "hidden";

	return (
		<div
			className={cn("relative min-h-[4.5rem]", className)}
			ref={containerRef}
		>
			{isReady ? null : (
				<span
					aria-hidden="true"
					className="pointer-events-none select-none font-serif text-4xl text-foreground/20 italic md:text-5xl"
				>
					{text}
				</span>
			)}

			<motion.svg
				animate={motionState}
				className={cn(
					"overflow-visible text-foreground",
					isReady ? "absolute inset-0" : "opacity-0"
				)}
				fill="none"
				height={height}
				initial="hidden"
				onAnimationComplete={() => {
					if (shouldAnimate) {
						setHasAnimated(true);
					}
				}}
				viewBox={`0 0 ${width} ${height}`}
				width={width}
			>
				<defs>
					<mask id={maskId} maskUnits="userSpaceOnUse">
						{paths.map((d, i) => (
							<motion.path
								d={d}
								fill="none"
								key={`mask-${i}`}
								stroke="white"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={fontSize * 0.22}
								transition={{
									pathLength: {
										delay: delay + i * 0.2,
										duration,
										ease: "easeInOut",
									},
									opacity: {
										delay: delay + i * 0.2 + 0.01,
										duration: 0.01,
									},
								}}
								variants={variants}
								vectorEffect="non-scaling-stroke"
							/>
						))}
					</mask>
				</defs>

				{paths.map((d, i) => (
					<motion.path
						d={d}
						fill="none"
						key={`stroke-${i}`}
						stroke={color}
						strokeLinecap="butt"
						strokeLinejoin="round"
						strokeWidth={2}
						transition={{
							pathLength: {
								delay: delay + i * 0.2,
								duration,
								ease: "easeInOut",
							},
							opacity: {
								delay: delay + i * 0.2 + 0.01,
								duration: 0.01,
							},
						}}
						variants={variants}
						vectorEffect="non-scaling-stroke"
					/>
				))}

				<g mask={`url(#${maskId})`}>
					{paths.map((d, i) => (
						<path d={d} fill={color} key={`fill-${i}`} />
					))}
				</g>
			</motion.svg>
		</div>
	);
}
