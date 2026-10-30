import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";
import { GUTTER_LEFT, GUTTER_RIGHT } from "./passport-palette.ts";
import { usePassportArtId } from "./passport-stamp.tsx";

/** Page size in booklet pixels; the booklet scales as a whole to fit. */
export const PAGE_WIDTH = 400;
export const PAGE_HEIGHT = 564;

export type PageSide = "left" | "right" | "single";

/** Shared label style: small official capitals. */
export const CAPTION =
	"font-mono text-[9px] text-(--pp-ink-muted) uppercase leading-3 tracking-[0.18em]";

/** A sheet of visa paper: cream, a guilloche ground, and the fold shading. */
export function Paper({
	children,
	header,
	number,
	side,
	watermark = false,
}: {
	children: ReactNode;
	header: string;
	number: number;
	side: PageSide;
	/** Visa pages carry the emblem as a faint watermark, like the real thing. */
	watermark?: boolean;
}) {
	const prefix = usePassportArtId();
	const outer = side === "left" ? "text-start" : "text-end";
	return (
		<div
			className="relative flex size-full flex-col overflow-hidden bg-(--pp-paper) px-7 pt-6 pb-5 text-(--pp-ink)"
			style={{
				backgroundImage:
					side === "left"
						? GUTTER_LEFT
						: side === "right"
							? GUTTER_RIGHT
							: undefined,
			}}
		>
			<svg
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 size-full"
				focusable="false"
			>
				<rect fill={`url(#${prefix}-guilloche)`} height="100%" width="100%" />
			</svg>
			{watermark ? (
				<GlobeMark className="pointer-events-none absolute top-[58%] left-1/2 size-56 -translate-x-1/2 -translate-y-1/2 text-(--pp-watermark)" />
			) : null}
			<div
				className={cn(
					"relative flex h-4 items-center justify-between",
					side === "right" && "flex-row-reverse"
				)}
			>
				<span className={CAPTION}>{header}</span>
				<span className={cn(CAPTION, "tracking-[0.3em]")}>RYU</span>
			</div>
			<div className="relative mt-4 flex min-h-0 flex-1 flex-col">
				{children}
			</div>
			<p
				className={cn(
					"relative mt-3 font-mono text-(--pp-ink-muted) text-[11px] tabular-nums leading-4",
					outer
				)}
			>
				{number}
			</p>
		</div>
	);
}

/** The issuing emblem: a globe in a dotted ring with compass points. */
export function GlobeMark({
	className,
	style,
}: {
	className: string;
	style?: CSSProperties;
}) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			fill="none"
			focusable="false"
			stroke="currentColor"
			style={style}
			viewBox="0 0 120 120"
		>
			<circle cx="60" cy="60" r="56" strokeWidth="1.6" />
			<circle cx="60" cy="60" r="51" strokeDasharray="1 3.2" strokeWidth="2" />
			<circle cx="60" cy="60" r="36" strokeWidth="1.4" />
			<ellipse cx="60" cy="60" rx="15" ry="36" strokeWidth="1.1" />
			<path
				d="M24 60 H96 M27.5 45 H92.5 M27.5 75 H92.5 M60 24 V96"
				strokeWidth="1.1"
			/>
			<path
				d="M60 4 L63 13 L60 11 L57 13 Z M60 116 L63 107 L60 109 L57 107 Z M4 60 L13 57 L11 60 L13 63 Z M116 60 L107 57 L109 60 L107 63 Z"
				fill="currentColor"
				stroke="none"
			/>
		</svg>
	);
}
