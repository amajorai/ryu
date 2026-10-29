import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";
import {
	GALLERY_COVER_MAX_LINES,
	GALLERY_TEXT_FRAMES,
	type GalleryCoverSpec,
} from "./gallery-model.ts";
import {
	type GalleryCoverColors,
	galleryCoverColors,
} from "./gallery-palette.ts";

/**
 * Clamps to a set number of lines without a utility per count. Below about
 * 200px the type stops shrinking with the card, so narrow cards hold fewer.
 */
const CLAMP =
	"[-webkit-box-orient:vertical] [-webkit-line-clamp:var(--lines)] [display:-webkit-box] overflow-hidden @max-[200px]:[-webkit-line-clamp:var(--narrow-lines)]";

function clamp(lines: number): CSSProperties {
	return {
		"--lines": lines,
		"--narrow-lines": Math.max(1, Math.floor(lines * 0.8)),
	} as CSSProperties;
}

/** Lines of text a frame of `ratio` holds. */
function linesFor(
	ratio: number,
	kind: keyof typeof GALLERY_TEXT_FRAMES
): number {
	const frame = GALLERY_TEXT_FRAMES[kind];
	const fit = Math.floor((ratio * 100 - frame.chrome) / frame.line + 0.3);
	return Math.min(GALLERY_COVER_MAX_LINES, Math.max(1, fit));
}

function messages(count: number): string {
	return `${count.toString()} ${count === 1 ? "message" : "messages"}`;
}

/** The latest message as a pull quote, attributed to the agent who said it. */
function QuoteCover({
	colors,
	cover,
	ratio,
}: {
	colors: GalleryCoverColors;
	cover: GalleryCoverSpec;
	ratio: number;
}) {
	return (
		<>
			<span
				className="block font-serif leading-none"
				style={{ color: colors.accent, fontSize: "24cqw", height: "12cqw" }}
			>
				&ldquo;
			</span>
			<span
				className={cn("mt-[3cqw] text-pretty font-serif leading-[1.38]", CLAMP)}
				style={{
					...clamp(linesFor(ratio, "quote")),
					fontSize: "clamp(13px, 7.4cqw, 22px)",
				}}
			>
				{cover.excerpt}
			</span>
			<span
				className="mt-auto flex items-center gap-[2.5cqw] pt-[4cqw] font-medium"
				style={{ color: colors.muted, fontSize: "clamp(11px, 5.6cqw, 15px)" }}
			>
				<span
					className="h-px w-[7cqw] shrink-0"
					style={{ background: colors.accent }}
				/>
				<span className="truncate">{cover.speaker}</span>
			</span>
		</>
	);
}

/** A live or failed run: its state as a header, the latest output as a log. */
function StatusCover({
	colors,
	cover,
	ratio,
}: {
	colors: GalleryCoverColors;
	cover: GalleryCoverSpec;
	ratio: number;
}) {
	const working = cover.status === "working";
	return (
		<>
			<span
				className="flex items-center gap-[2.5cqw] font-semibold uppercase tracking-[0.12em]"
				style={{ color: colors.accent, fontSize: "clamp(11px, 5.4cqw, 14px)" }}
			>
				<span
					className={cn(
						"size-[3.2cqw] shrink-0 rounded-full",
						working && "motion-safe:animate-pulse"
					)}
					style={{ background: colors.accent }}
				/>
				{working ? "Working now" : "Run failed"}
			</span>
			<span
				className="mt-[4cqw] mb-[5cqw] h-px w-full shrink-0"
				style={{ background: colors.accent, opacity: 0.35 }}
			/>
			<span
				className={cn("font-mono leading-[1.55]", CLAMP)}
				style={{
					...clamp(linesFor(ratio, "status")),
					fontSize: "clamp(11px, 5.6cqw, 15px)",
				}}
			>
				<span aria-hidden="true" style={{ color: colors.accent }}>
					{"› "}
				</span>
				{cover.excerpt ?? (working ? "Starting…" : "The run stopped.")}
				{working ? (
					<span
						className="ms-[1cqw] inline-block h-[5.6cqw] w-[2.6cqw] translate-y-[0.8cqw] motion-safe:animate-pulse"
						style={{ background: colors.text }}
					/>
				) : null}
			</span>
			<span
				className="mt-auto pt-[4cqw] font-mono"
				style={{ color: colors.muted, fontSize: "clamp(11px, 5.2cqw, 15px)" }}
			>
				{messages(cover.count)}
			</span>
		</>
	);
}

/** The project or team set as a title card in the agent's colour. */
function PosterCover({
	colors,
	cover,
}: {
	colors: GalleryCoverColors;
	cover: GalleryCoverSpec;
}) {
	return (
		<>
			<span
				className="truncate font-semibold uppercase tracking-[0.16em]"
				style={{ color: colors.accent, fontSize: "clamp(11px, 5.2cqw, 15px)" }}
			>
				{cover.groupKind === "team" ? "Team" : "Project"}
			</span>
			<span
				className={cn(
					"mt-auto text-balance font-bold leading-[0.98] tracking-tight",
					CLAMP
				)}
				style={{ ...clamp(4), fontSize: "13.5cqw" }}
			>
				{cover.group}
			</span>
			<span
				className="mt-[5cqw] flex items-center justify-between gap-[3cqw] border-t pt-[3.5cqw]"
				style={{
					borderColor: colors.muted,
					color: colors.muted,
					fontSize: "clamp(11px, 5.2cqw, 15px)",
				}}
			>
				<span className="truncate">{cover.author ?? "No agent"}</span>
				<span className="shrink-0">{messages(cover.count)}</span>
			</span>
		</>
	);
}

/** How long the conversation has run, when there is no message to quote. */
function StatCover({
	colors,
	cover,
}: {
	colors: GalleryCoverColors;
	cover: GalleryCoverSpec;
}) {
	return (
		<>
			<span
				className="truncate font-semibold uppercase tracking-[0.16em]"
				style={{ color: colors.muted, fontSize: "clamp(11px, 5.2cqw, 15px)" }}
			>
				{cover.author ?? "No agent"}
			</span>
			<span
				className="mt-auto font-black tabular-nums leading-[0.82] tracking-tighter"
				style={{ color: colors.accent, fontSize: "36cqw" }}
			>
				{cover.count}
			</span>
			<span
				className="mt-[3cqw] font-medium"
				style={{ color: colors.muted, fontSize: "clamp(12px, 6.4cqw, 18px)" }}
			>
				{cover.count === 1 ? "message" : "messages"}
			</span>
		</>
	);
}

/**
 * A thread's cover, built from what is in it: the latest message, the run's
 * state, its project, or its length, set in the lead agent's colour. Sized in
 * container units so the same cover reads at card and detail widths. `ratio`
 * re-frames it (the detail view's) instead of cropping it. Decorative: the
 * card around it carries the title and status in text.
 */
export function GalleryCover({
	className,
	cover,
	ratio = cover.ratio,
}: {
	className?: string;
	cover: GalleryCoverSpec;
	ratio?: number;
}) {
	const colors = galleryCoverColors(cover);
	let body: ReactNode;
	if (cover.kind === "quote") {
		body = <QuoteCover colors={colors} cover={cover} ratio={ratio} />;
	} else if (cover.kind === "status") {
		body = <StatusCover colors={colors} cover={cover} ratio={ratio} />;
	} else if (cover.kind === "poster") {
		body = <PosterCover colors={colors} cover={cover} />;
	} else {
		body = <StatCover colors={colors} cover={cover} />;
	}
	return (
		<div
			aria-hidden="true"
			className={cn("@container w-full", className)}
			data-cover={cover.kind}
		>
			<div
				className="flex w-full flex-col overflow-hidden p-[8cqw]"
				style={{
					aspectRatio: `1 / ${ratio.toFixed(4)}`,
					background: colors.ground,
					color: colors.text,
				}}
			>
				{body}
			</div>
		</div>
	);
}
