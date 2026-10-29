import { cn } from "@ryu/ui/lib/utils";
import { memo, type PointerEvent } from "react";
import { CinemaArt } from "./cinema-art.tsx";
import {
	type CinemaTitle,
	type CinemaTitleType,
	cinemaNames,
	cinemaStatusText,
} from "./cinema-model.ts";
import { cinemaAgentInk } from "./cinema-palette.ts";

/** The attribute posters carry so focus can return to the one that opened. */
export const CINEMA_POSTER_ATTRIBUTE = "data-cinema-thread";

type TitleSize = "large" | "small" | "tall";

/** How a title is set over its art, per title type and poster size. */
const TITLE_TYPE: Record<CinemaTitleType, Record<TitleSize, string>> = {
	caps: {
		large: "font-bold text-xl uppercase leading-6 tracking-[0.08em]",
		small: "font-bold text-[15px] uppercase leading-5 tracking-[0.08em]",
		tall: "font-bold text-[13px] uppercase leading-4 tracking-[0.06em]",
	},
	display: {
		large: "font-extrabold text-2xl leading-7 tracking-tight",
		small: "font-extrabold text-lg leading-[22px] tracking-tight",
		tall: "font-extrabold text-[15px] leading-[18px] tracking-tight",
	},
	serif: {
		large: "font-serif font-semibold text-2xl italic leading-7",
		small: "font-serif font-semibold text-lg italic leading-[22px]",
		tall: "font-serif font-semibold text-[15px] italic leading-[18px]",
	},
};

/** Who made it, set in the agent's colour over the title like a studio credit. */
export function CinemaKicker({
	className,
	title,
}: {
	className?: string;
	title: CinemaTitle;
}) {
	const lead = title.agents[0]?.name;
	let text = lead ?? title.group?.name ?? "Thread";
	if (lead && title.agents.length > 1) {
		text = `${lead} +${(title.agents.length - 1).toString()}`;
	}
	return (
		<span
			aria-hidden="true"
			className={cn(
				"block truncate font-semibold text-xs uppercase leading-4 tracking-[0.18em]",
				className
			)}
			style={{ color: cinemaAgentInk(title.art) }}
		>
			{text}
		</span>
	);
}

/** The title as it sits on the art, like a show's logo on its key art. */
export function CinemaTitleMark({
	className,
	size = "small",
	title,
}: {
	className?: string;
	size?: TitleSize;
	title: CinemaTitle;
}) {
	return (
		<span className={cn("block text-foreground", className)}>
			<span
				className={cn(
					"hyphens-auto text-balance break-words drop-shadow-sm",
					size === "tall" ? "line-clamp-4" : "line-clamp-2",
					TITLE_TYPE[title.art.type][size]
				)}
			>
				{title.thread.title}
			</span>
		</span>
	);
}

/** A tag on the art for the two states worth interrupting a browse for. */
export function CinemaPosterTag({ title }: { title: CinemaTitle }) {
	const tag =
		"flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 font-bold text-xs uppercase leading-4 tracking-wider";
	if (title.status === "working") {
		return (
			<span className={cn(tag, "bg-background/75 text-foreground")}>
				<span
					aria-hidden="true"
					className="size-1.5 rounded-full bg-success motion-safe:animate-pulse"
				/>
				Live
			</span>
		);
	}
	if (title.status === "attention") {
		return (
			<span className={cn(tag, "bg-destructive text-foreground")}>
				{title.thread.runState === "interrupted" ? "Interrupted" : "Failed"}
			</span>
		);
	}
	return null;
}

/** Key art with the credit up top and the title in its lower third. */
export function CinemaBoxart({
	className,
	size = "small",
	title,
}: {
	className?: string;
	size?: "large" | "small";
	title: CinemaTitle;
}) {
	const inset = size === "large" ? "px-4" : "px-3.5";
	return (
		<span
			className={cn(
				"relative block aspect-video w-full overflow-hidden bg-muted",
				className
			)}
		>
			<CinemaArt className="absolute inset-0" frame="card" spec={title.art} />
			<span
				className={cn(
					"absolute inset-x-0 top-0 flex items-center justify-between gap-2 pt-3",
					inset
				)}
			>
				<CinemaKicker className="min-w-0" title={title} />
				<CinemaPosterTag title={title} />
			</span>
			<CinemaTitleMark
				className={cn(
					"absolute inset-x-0 bottom-0 text-left",
					inset,
					size === "large" ? "pb-4" : "pb-3"
				)}
				size={size}
				title={title}
			/>
		</span>
	);
}

/** A ranked numeral, outlined like the reference's Top 10 row. */
function RankNumeral({ rank }: { rank: number }) {
	return (
		<svg
			aria-hidden="true"
			className="h-full w-1/2 shrink-0 overflow-visible"
			focusable="false"
			preserveAspectRatio="xMaxYMax meet"
			viewBox="0 0 100 150"
		>
			<text
				className="fill-background stroke-foreground/45 font-black"
				fontSize={rank >= 10 ? 118 : 150}
				letterSpacing={rank >= 10 ? -10 : 0}
				paintOrder="stroke"
				strokeLinejoin="round"
				strokeWidth={4}
				textAnchor="end"
				x={rank >= 10 ? 112 : 104}
				y={146}
			>
				{rank}
			</text>
		</svg>
	);
}

export interface CinemaPosterProps {
	current: boolean;
	layout: "boxart" | "top";
	onHoverEnd: () => void;
	onHoverStart: (element: HTMLElement, title: CinemaTitle) => void;
	onSelect: (threadId: string, opener: HTMLElement) => void;
	rank?: number;
	title: CinemaTitle;
}

/**
 * One title in a row or grid. Clicking (or Enter) opens its details, the way
 * the reference opens a title's modal; resting the pointer on it grows the
 * preview card with Open, which the catalogue renders above the rows.
 */
export const CinemaPoster = memo(function CinemaPoster({
	current,
	layout,
	onHoverEnd,
	onHoverStart,
	onSelect,
	rank,
	title,
}: CinemaPosterProps) {
	const names = cinemaNames(title.agents);
	const description = [
		cinemaStatusText(title),
		names || "No agent",
		rank ? `Number ${rank.toString()}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const hoverStart = (event: PointerEvent<HTMLButtonElement>) => {
		if (event.pointerType === "mouse") {
			onHoverStart(event.currentTarget, title);
		}
	};
	return (
		<button
			aria-current={current ? "true" : undefined}
			className={cn(
				"group/poster relative block w-full cursor-pointer rounded-sm text-left outline-none",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				layout === "top" && "flex aspect-[4/3] items-end"
			)}
			onClick={(event) => onSelect(title.thread.id, event.currentTarget)}
			onPointerEnter={hoverStart}
			onPointerLeave={onHoverEnd}
			type="button"
			{...{ [CINEMA_POSTER_ATTRIBUTE]: title.thread.id }}
		>
			{layout === "top" && rank ? <RankNumeral rank={rank} /> : null}
			{layout === "top" ? (
				<span className="relative block aspect-[2/3] h-full overflow-hidden rounded-sm bg-muted">
					<CinemaArt
						className="absolute inset-0"
						frame="poster"
						spec={title.art}
					/>
					<CinemaTitleMark
						className="absolute inset-x-0 top-0 px-3 pt-3"
						size="tall"
						title={title}
					/>
					<span className="absolute inset-x-0 bottom-0 flex flex-col items-start gap-2 px-3 pb-3">
						<CinemaPosterTag title={title} />
						<CinemaKicker className="max-w-full" title={title} />
					</span>
				</span>
			) : (
				<CinemaBoxart className="rounded-sm" title={title} />
			)}
			<span className="sr-only">, {description}</span>
			{current ? (
				<span
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute rounded-sm ring-2 ring-primary ring-inset",
						layout === "top" ? "inset-y-0 right-0 w-1/2" : "inset-0"
					)}
				/>
			) : null}
		</button>
	);
});

/**
 * A feature card for rows with only one or two titles: the key art beside
 * the latest message and where the thread stands, so a short row fills the
 * frame with something worth reading instead of empty space. Clicking it
 * opens details, like any poster.
 */
export const CinemaFeature = memo(function CinemaFeature({
	current,
	onSelect,
	title,
}: {
	current: boolean;
	onSelect: (threadId: string, opener: HTMLElement) => void;
	title: CinemaTitle;
}) {
	const { thread } = title;
	const names = cinemaNames(title.agents);
	return (
		<button
			aria-current={current ? "true" : undefined}
			className={cn(
				"group/poster flex w-full cursor-pointer overflow-hidden rounded-sm bg-card text-left outline-none ring-1 ring-border transition-colors duration-200 hover:bg-muted",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				current && "ring-2 ring-primary"
			)}
			onClick={(event) => onSelect(thread.id, event.currentTarget)}
			type="button"
			{...{ [CINEMA_POSTER_ATTRIBUTE]: thread.id }}
		>
			<CinemaBoxart
				className="w-[min(52%,440px)] shrink-0"
				size="large"
				title={title}
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-2 p-5">
				<span className="font-semibold text-foreground/70 text-sm leading-5">
					{cinemaStatusText(title)}
					{names ? ` · ${names}` : ""}
				</span>
				{thread.lastMessage ? (
					<span className="line-clamp-4 text-base text-foreground/90 leading-6">
						{thread.lastMessage}
					</span>
				) : (
					<span className="text-base text-muted-foreground leading-6">
						No messages yet.
					</span>
				)}
				{title.group ? (
					<span className="mt-auto text-muted-foreground text-sm leading-5">
						{title.group.name}
					</span>
				) : null}
			</span>
		</button>
	);
});
