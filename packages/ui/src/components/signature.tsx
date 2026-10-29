"use client";

import { motion } from "motion/react";
import { useEffect, useId, useState } from "react";

type SignatureFont = ReturnType<typeof import("opentype.js")["parse"]>;

const SVG_HEIGHT = 100;
const PATH_DELAY_STEP = 0.2;
const OPACITY_DELAY_OFFSET = 0.01;
const MIN_TOP_MARGIN = 5;

/**
 * The font is served from the app's own `public/` directory. The remote copy is
 * a fallback: a 404 here renders an empty `<svg>`, so the signature would just
 * silently vanish.
 */
const DEFAULT_FONT_URLS = [
	"/LastoriaBoldRegular.otf",
	"https://componentry.dev/LastoriaBoldRegular.otf",
] as const;

const fontCache = new Map<string, SignatureFont>();

const PATH_VARIANTS = {
	hidden: { pathLength: 0, opacity: 0 },
	visible: { pathLength: 1, opacity: 1 },
};

function getFontCacheKey(path: string): string {
	try {
		return new URL(path, window.location.origin).href;
	} catch {
		return path;
	}
}

function getPathTransition(index: number, duration: number, delay: number) {
	const pathDelay = delay + index * PATH_DELAY_STEP;

	return {
		pathLength: {
			delay: pathDelay,
			duration,
			ease: "easeInOut" as const,
		},
		opacity: {
			delay: pathDelay + OPACITY_DELAY_OFFSET,
			duration: 0.01,
		},
	};
}

async function loadFontFromPaths(fontPaths: string[]): Promise<SignatureFont> {
	// Imported lazily so opentype.js stays out of the initial client bundle.
	const { parse } = await import("opentype.js");

	for (const path of fontPaths) {
		try {
			const cacheKey = getFontCacheKey(path);
			const cachedFont = fontCache.get(cacheKey);

			if (cachedFont) {
				return cachedFont;
			}

			const response = await fetch(path);

			if (!response.ok) {
				continue;
			}

			const fontBuffer = await response.arrayBuffer();
			const font = parse(fontBuffer);
			fontCache.set(cacheKey, font);

			return font;
		} catch {
			// try next path
		}
	}

	throw new Error(
		`Font could not be loaded from the provided path${fontPaths.length === 1 ? "" : "s"}: ${fontPaths.join(", ")}`
	);
}

async function buildSignaturePaths({
	text,
	fontSize,
	baseline,
	horizontalPadding,
	fontUrl,
}: {
	text: string;
	fontSize: number;
	baseline: number;
	horizontalPadding: number;
	fontUrl?: string;
}): Promise<{ paths: string[]; width: number }> {
	const font = await loadFontFromPaths(
		fontUrl ? [fontUrl] : [...DEFAULT_FONT_URLS]
	);

	let x = horizontalPadding;
	const nextPaths: string[] = [];

	for (const char of text) {
		const glyph = font.charToGlyph(char);
		const path = glyph.getPath(x, baseline, fontSize);
		nextPaths.push(path.toPathData(3));

		const advanceWidth = glyph.advanceWidth ?? font.unitsPerEm;
		x += advanceWidth * (fontSize / font.unitsPerEm);
	}

	return {
		paths: nextPaths,
		width: x + horizontalPadding,
	};
}

function renderMotionPaths({
	paths,
	keyPrefix,
	stroke,
	strokeWidth,
	strokeLinecap,
	duration,
	delay,
}: {
	paths: string[];
	keyPrefix: string;
	stroke: string;
	strokeWidth: number;
	strokeLinecap: "round" | "butt";
	duration: number;
	delay: number;
}) {
	return paths.map((d, index) => (
		<motion.path
			d={d}
			fill="none"
			key={`${keyPrefix}-${index}`}
			stroke={stroke}
			strokeLinecap={strokeLinecap}
			strokeLinejoin="round"
			strokeWidth={strokeWidth}
			transition={getPathTransition(index, duration, delay)}
			variants={PATH_VARIANTS}
			vectorEffect="non-scaling-stroke"
		/>
	));
}

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

export function Signature({
	text = "Signature",
	color = "currentColor",
	fontSize = 14,
	duration = 1.5,
	delay = 0,
	className,
	inView = false,
	once = true,
	fontUrl,
}: SignatureProps) {
	const [paths, setPaths] = useState<string[]>([]);
	const [width, setWidth] = useState(300);
	const horizontalPadding = fontSize * 0.1;
	const topMargin = Math.max(MIN_TOP_MARGIN, (SVG_HEIGHT - fontSize) / 2);
	const baseline = Math.min(SVG_HEIGHT - MIN_TOP_MARGIN, topMargin + fontSize);
	const maskId = `signature-reveal-${useId().replace(/:/g, "")}`;

	useEffect(() => {
		let isCancelled = false;

		async function loadSignaturePaths() {
			try {
				const { paths: nextPaths, width: nextWidth } =
					await buildSignaturePaths({
						text,
						fontSize,
						baseline,
						horizontalPadding,
						fontUrl,
					});

				if (isCancelled) {
					return;
				}

				setPaths(nextPaths);
				setWidth(nextWidth);
			} catch {
				if (isCancelled) {
					return;
				}

				setPaths([]);
				setWidth(text.length * fontSize * 0.6);
			}
		}

		void loadSignaturePaths();

		return () => {
			isCancelled = true;
		};
	}, [text, fontSize, baseline, horizontalPadding, fontUrl]);

	return (
		<motion.svg
			animate={inView ? undefined : "visible"}
			className={className}
			fill="none"
			height={SVG_HEIGHT}
			initial="hidden"
			key={paths.length}
			viewBox={`0 0 ${width} ${SVG_HEIGHT}`}
			viewport={{ once }}
			whileInView={inView ? "visible" : undefined}
			width={width}
		>
			<defs>
				<mask id={maskId} maskUnits="userSpaceOnUse">
					{renderMotionPaths({
						paths,
						keyPrefix: "mask",
						stroke: "white",
						strokeWidth: fontSize * 0.22,
						strokeLinecap: "round",
						duration,
						delay,
					})}
				</mask>
			</defs>

			{renderMotionPaths({
				paths,
				keyPrefix: "stroke",
				stroke: color,
				strokeWidth: 2,
				strokeLinecap: "butt",
				duration,
				delay,
			})}

			<g mask={`url(#${maskId})`}>
				{paths.map((d, index) => (
					<path d={d} fill={color} key={`fill-${index}`} />
				))}
			</g>
		</motion.svg>
	);
}
