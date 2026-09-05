"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";

/**
 * A Product Hunt award badge — the embeddable one, redrawn as an SVG so it
 * renders at any size without a network hop to producthunt.com (and without
 * handing them a request log of everyone who loads our landing page).
 *
 * The badge tilts toward the pointer on a `matrix3d`, and a stack of blurred
 * colour bands sweeps across it under `mix-blend-mode: overlay` — the holographic
 * sheen the real badge has. Both stop under `prefers-reduced-motion`: the badge
 * is decoration, and decoration is the first thing that should stop moving when
 * a user asks for less of it.
 *
 * It is a link, so it needs `href`. Without one it renders as a static badge —
 * which is what an unclaimed award is.
 */

export type AwardBadgeType =
	| "golden-kitty"
	| "product-of-the-day"
	| "product-of-the-month"
	| "product-of-the-week";

const TITLES: Record<AwardBadgeType, string> = {
	"golden-kitty": "Golden Kitty Awards",
	"product-of-the-day": "Product of the Day",
	"product-of-the-month": "Product of the Month",
	"product-of-the-week": "Product of the Week",
};

/** Gold, silver, bronze — the badge's own placement colours. */
const PLACE_FILLS = ["#f3e3ac", "#dddddd", "#f1cfa6"] as const;
const DEFAULT_PLACE_INDEX = 1;

const IDENTITY_MATRIX = "1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1";
/** How far the badge leans, and how much it shrinks at the far corner. */
const MAX_ROTATE = 0.25;
const MIN_ROTATE = -0.25;
const MAX_SCALE = 1;
const MIN_SCALE = 0.97;
const PERSPECTIVE_PX = 700;
const SETTLE_MS = 200;
/** The sheen: ten bands, each offset ten degrees from the last. */
const SHEEN_BANDS = [
	"hsl(358, 100%, 62%)",
	"hsl(30, 100%, 50%)",
	"hsl(60, 100%, 50%)",
	"hsl(96, 100%, 50%)",
	"hsl(233, 85%, 47%)",
	"hsl(271, 85%, 47%)",
	"hsl(300, 20%, 35%)",
	"#ffffff",
] as const;
const BAND_STEP_DEGREES = 10;
/** How far the pointer's distance from centre swings the sheen, in degrees. */
const SHEEN_TRAVEL_DIVISOR = 1.5;

/** The Product Hunt cat mark, as the badge draws it. */
const PH_MARK =
	"M14.963 9.075c.787-3-.188-5.887-.188-5.887S12.488 5.175 11.7 8.175c-.787 3 .188 5.887.188 5.887s2.25-1.987 3.075-4.987m-4.5 1.987c.787 3-.188 5.888-.188 5.888S7.988 14.962 7.2 11.962c-.787-3 .188-5.887.188-5.887s2.287 1.987 3.075 4.987m.862 10.388s-.6-2.962-2.775-5.175C6.337 14.1 3.375 13.5 3.375 13.5s.6 2.962 2.775 5.175c2.213 2.175 5.175 2.775 5.175 2.775m3.3 3.413s-1.988-2.288-4.988-3.075-5.887.187-5.887.187 1.987 2.287 4.988 3.075c3 .787 5.887-.188 5.887-.188Zm6.75 0s1.988-2.288 4.988-3.075c3-.826 5.887.187 5.887.187s-1.988 2.287-4.988 3.075c-3 .787-5.887-.188-5.887-.188ZM32.625 13.5s-2.963.6-5.175 2.775c-2.213 2.213-2.775 5.175-2.775 5.175s2.962-.6 5.175-2.775c2.175-2.213 2.775-5.175 2.775-5.175M28.65 6.075s.975 2.887.188 5.887c-.826 3-3.076 4.988-3.076 4.988s-.974-2.888-.187-5.888c.788-3 3.075-4.987 3.075-4.987m-4.5 7.987s.975-2.887.188-5.887c-.788-3-3.076-4.988-3.076-4.988s-.974 2.888-.187 5.888c.788 3 3.075 4.988 3.075 4.988ZM18 26.1c.975-.225 3.113-.6 5.325 0 3 .788 5.063 3.038 5.063 3.038s-2.888.975-5.888.187a13 13 0 0 1-1.425-.525c.563.788 1.125 1.425 2.288 1.913l-.863 2.062c-2.063-.862-2.925-2.137-3.675-3.262-.262-.375-.525-.713-.787-1.05-.26.293-.465.586-.686.903l-.102.147-.048.068c-.775 1.108-1.643 2.35-3.627 3.194l-.862-2.062c1.162-.488 1.725-1.125 2.287-1.913-.45.225-.938.375-1.425.525-3 .788-5.887-.187-5.887-.187s1.987-2.288 4.987-3.075c2.212-.563 4.35-.188 5.325.037";

export interface AwardBadgeProps {
	className?: string;
	/** The badge's destination. Omit for a static, unlinked badge. */
	href?: string;
	/** Placement, when the award has one. Also picks the metal colour. */
	place?: number;
	type: AwardBadgeType;
}

/**
 * The pointer-tracked lean, as a `matrix3d` row string. Derived from where the
 * pointer sits inside the badge's own box, so the near corner rises and the far
 * one drops away.
 */
function leanMatrix(rect: DOMRect, clientX: number, clientY: number): string {
	const xCenter = (rect.left + rect.right) / 2;
	const yCenter = (rect.top + rect.bottom) / 2;
	const width = rect.right - rect.left;
	const height = rect.top - rect.bottom;
	const scaleX =
		MAX_SCALE -
		((MAX_SCALE - MIN_SCALE) * Math.abs(xCenter - clientX)) /
			(xCenter - rect.left);
	const scaleY =
		MAX_SCALE -
		((MAX_SCALE - MIN_SCALE) * Math.abs(yCenter - clientY)) /
			(yCenter - rect.top);
	const scaleZ =
		MAX_SCALE -
		((MAX_SCALE - MIN_SCALE) *
			(Math.abs(xCenter - clientX) + Math.abs(yCenter - clientY))) /
			(xCenter - rect.left + yCenter - rect.top);
	const skewX =
		0.25 * ((yCenter - clientY) / yCenter - (xCenter - clientX) / xCenter);
	const tiltX =
		MAX_ROTATE -
		((MAX_ROTATE - MIN_ROTATE) * Math.abs(rect.right - clientX)) / width;
	const tiltY =
		MAX_ROTATE - ((MAX_ROTATE - MIN_ROTATE) * (rect.top - clientY)) / height;
	const rollZ = 0.2 - (0.8 * (rect.top - clientY)) / height;
	return [
		scaleX,
		0,
		-tiltX,
		0,
		skewX,
		scaleY,
		rollZ,
		0,
		tiltX,
		tiltY,
		scaleZ,
		0,
		0,
		0,
		0,
		1,
	].join(", ");
}

export function AwardBadge({ className, href, place, type }: AwardBadgeProps) {
	const ref = useRef<HTMLAnchorElement>(null);
	const [matrix, setMatrix] = useState(IDENTITY_MATRIX);
	const [sheenDegrees, setSheenDegrees] = useState(0);
	const [reduceMotion, setReduceMotion] = useState(false);

	// Read once and subscribe: a badge that sampled the preference at mount would
	// keep animating for a user who turned motion off while the page was open.
	useEffect(() => {
		const media = window.matchMedia("(prefers-reduced-motion: reduce)");
		const sync = () => setReduceMotion(media.matches);
		sync();
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);

	const track = useCallback(
		(event: React.PointerEvent<HTMLAnchorElement>) => {
			const node = ref.current;
			if (!node || reduceMotion) {
				return;
			}
			const rect = node.getBoundingClientRect();
			setMatrix(leanMatrix(rect, event.clientX, event.clientY));
			const xCenter = (rect.left + rect.right) / 2;
			const yCenter = (rect.top + rect.bottom) / 2;
			setSheenDegrees(
				(Math.abs(xCenter - event.clientX) +
					Math.abs(yCenter - event.clientY)) /
					SHEEN_TRAVEL_DIVISOR
			);
		},
		[reduceMotion]
	);

	const release = useCallback(() => {
		setMatrix(IDENTITY_MATRIX);
		setSheenDegrees(0);
	}, []);

	const fill =
		PLACE_FILLS[(place ?? 0) - 1] ?? PLACE_FILLS[DEFAULT_PLACE_INDEX];
	const label = `${TITLES[type]}${place ? ` #${place}` : ""}`;

	return (
		<a
			aria-label={`Product Hunt — ${label}`}
			className={cn("block w-[180px] cursor-pointer sm:w-[260px]", className)}
			href={href}
			onPointerLeave={release}
			onPointerMove={track}
			ref={ref}
			rel="noopener noreferrer"
			target="_blank"
		>
			<div
				style={{
					transform: `perspective(${PERSPECTIVE_PX}px) matrix3d(${matrix})`,
					transformOrigin: "center center",
					transition: `transform ${SETTLE_MS}ms ease-out`,
				}}
			>
				<svg
					className="h-auto w-full"
					role="img"
					viewBox="0 0 260 54"
					xmlns="http://www.w3.org/2000/svg"
				>
					<title>{`Product Hunt — ${label}`}</title>
					<defs>
						<filter id="award-badge-blur">
							<feGaussianBlur in="SourceGraphic" stdDeviation="3" />
						</filter>
						<mask id="award-badge-mask">
							<rect fill="white" height="54" rx="10" width="260" />
						</mask>
					</defs>
					<rect fill={fill} height="54" rx="10" width="260" />
					<rect
						fill="transparent"
						height="46"
						rx="8"
						stroke="#bbbbbb"
						strokeWidth="1"
						width="252"
						x="4"
						y="4"
					/>
					<text fill="#666666" fontSize="9" fontWeight={500} x="53" y="20">
						PRODUCT HUNT
					</text>
					<text fill="#666666" fontSize="16" fontWeight={500} x="52" y="40">
						{label}
					</text>
					<g transform="translate(8, 9)">
						<path d={PH_MARK} fill="#666666" />
					</g>
					{/* The holographic sweep. Masked to the badge's rounded box so the
					    blurred bands cannot bleed past its corners. */}
					<g mask="url(#award-badge-mask)" style={{ mixBlendMode: "overlay" }}>
						{SHEEN_BANDS.map((color, index) => (
							<g
								key={color}
								style={{
									transform: `rotate(${sheenDegrees + index * BAND_STEP_DEGREES}deg)`,
									transformOrigin: "center center",
									transition: `transform ${SETTLE_MS}ms ease-out`,
								}}
							>
								<polygon
									fill={color}
									filter="url(#award-badge-blur)"
									opacity="0.5"
									points="0,0 260,54 260,0 0,54"
								/>
							</g>
						))}
					</g>
				</svg>
			</div>
		</a>
	);
}
