import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
	type KeyboardEvent,
	memo,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	CINEMA_GAP,
	type CinemaCollectionId,
	type CinemaRow as CinemaRowData,
	type CinemaTitle,
	cinemaCardWidth,
	cinemaPages,
	cinemaRowFeatured,
	cinemaRowFit,
} from "./cinema-model.ts";
import {
	CINEMA_POSTER_ATTRIBUTE,
	CinemaFeature,
	CinemaPoster,
} from "./cinema-poster.tsx";

/** Moves focus between posters in one row with the arrow keys. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
	if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
		return;
	}
	const posters = [
		...event.currentTarget.querySelectorAll<HTMLElement>(
			`[${CINEMA_POSTER_ATTRIBUTE}]`
		),
	];
	const active = document.activeElement;
	const index = active instanceof HTMLElement ? posters.indexOf(active) : -1;
	if (index === -1) {
		return;
	}
	const next = posters[index + (event.key === "ArrowRight" ? 1 : -1)];
	if (next) {
		event.preventDefault();
		next.focus();
	}
}

function RowArrow({
	direction,
	gutter,
	label,
	onClick,
	visible,
}: {
	direction: "next" | "previous";
	gutter: number;
	label: string;
	onClick: () => void;
	visible: boolean;
}) {
	const Icon = direction === "next" ? ChevronRight : ChevronLeft;
	return (
		<button
			aria-label={label}
			className={cn(
				"group/arrow absolute inset-y-2 z-10 flex items-center justify-center bg-background/50 text-foreground outline-none transition-opacity duration-200",
				"hover:bg-background/70 focus-visible:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				direction === "next" ? "right-0 rounded-l-sm" : "left-0 rounded-r-sm",
				visible
					? "opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100"
					: "pointer-events-none opacity-0"
			)}
			onClick={onClick}
			style={{ width: gutter }}
			tabIndex={-1}
			type="button"
		>
			<Icon
				aria-hidden="true"
				className="size-7 transition-transform duration-150 group-hover/arrow:scale-125 motion-reduce:transition-none"
				strokeWidth={2.5}
			/>
		</button>
	);
}

export interface CinemaRowProps {
	activeThreadId: string | null;
	cardWidth: number;
	gutter: number;
	onExplore: (id: CinemaCollectionId) => void;
	onHoverEnd: () => void;
	onHoverStart: (element: HTMLElement, title: CinemaTitle) => void;
	onSelect: (threadId: string, opener: HTMLElement) => void;
	perRow: number;
	reduceMotion: boolean;
	row: CinemaRowData;
	total: number;
}

/**
 * One shelf: a row title that reveals "Explore all" on hover, a page indicator,
 * and a horizontal run of posters paged by the arrows in the side gutters.
 * Native scrolling stays on, so trackpads, touch and focus all move it too.
 */
export const CinemaRow = memo(function CinemaRow({
	activeThreadId,
	cardWidth,
	gutter,
	onExplore,
	onHoverEnd,
	onHoverStart,
	onSelect,
	perRow,
	reduceMotion,
	row,
	total,
}: CinemaRowProps) {
	const tl = useLiteralMessages();
	const headingId = useId();
	const listRef = useRef<HTMLUListElement>(null);
	const [scroll, setScroll] = useState({ left: 0, max: 0 });
	const pageWidth = (cardWidth + CINEMA_GAP) * perRow;
	// Short rows fill the frame: one or two titles as feature cards, a few
	// more stretched across; ranked rows keep their rhythm.
	const featured =
		row.layout === "boxart" && cinemaRowFeatured(row.titles.length, perRow);
	const fit =
		row.layout === "boxart" ? cinemaRowFit(row.titles.length, perRow) : perRow;
	const itemWidth =
		fit === perRow
			? cardWidth
			: cinemaCardWidth(cardWidth * perRow + CINEMA_GAP * (perRow - 1), fit);

	const measure = useCallback(() => {
		const list = listRef.current;
		if (!list) {
			return;
		}
		setScroll({
			left: list.scrollLeft,
			max: Math.max(0, list.scrollWidth - list.clientWidth),
		});
	}, []);

	// Re-measure when the layout or the titles change.
	useEffect(() => {
		measure();
	}, [measure, cardWidth, perRow, row.titles.length]);

	const page = (direction: 1 | -1) => {
		onHoverEnd();
		listRef.current?.scrollBy({
			behavior: reduceMotion ? "auto" : "smooth",
			left: direction * pageWidth,
		});
	};

	const pages = cinemaPages(row.titles.length, perRow, scroll.left, pageWidth);
	const canPrevious = scroll.left > 1;
	const canNext = scroll.left < scroll.max - 1;
	const showArrows = gutter >= 32;
	const more = total > row.titles.length || row.titles.length > perRow;

	return (
		<section aria-labelledby={headingId} className="group/row relative">
			<div
				className="flex h-8 items-end justify-between gap-4"
				style={{ paddingInline: gutter }}
			>
				<h2 className="min-w-0" id={headingId}>
					<button
						className="group/title flex min-w-0 items-baseline gap-2 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
						onClick={() => onExplore(row.id)}
						type="button"
					>
						<span className="truncate font-semibold text-foreground text-xl leading-7 tracking-tight">
							{row.title}
						</span>
						{more ? (
							<span className="flex shrink-0 items-center gap-0.5 font-semibold text-foreground/80 text-sm leading-5 opacity-0 transition-[opacity,translate] duration-300 group-hover/title:translate-x-0 group-hover/title:opacity-100 group-focus-visible/title:translate-x-0 group-focus-visible/title:opacity-100 motion-safe:-translate-x-2">
								Explore all
								<ChevronRight aria-hidden="true" className="size-3.5" />
							</span>
						) : null}
					</button>
				</h2>
				{pages.count > 1 ? (
					<ol
						aria-hidden="true"
						className="flex shrink-0 gap-0.5 pb-1.5 opacity-0 transition-opacity duration-200 group-hover/row:opacity-100"
					>
						{Array.from({ length: pages.count }, (_, index) => (
							<li
								className={cn(
									"h-0.5 w-3",
									index === pages.current
										? "bg-foreground/80"
										: "bg-foreground/25"
								)}
								key={`${row.id}-page-${index.toString()}`}
							/>
						))}
					</ol>
				) : null}
			</div>
			<div className="relative">
				{showArrows ? (
					<RowArrow
						direction="previous"
						gutter={gutter}
						label={tl("Previous titles in {title}", { title: row.title })}
						onClick={() => page(-1)}
						visible={canPrevious}
					/>
				) : null}
				<ul
					aria-labelledby={headingId}
					className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
					onKeyDown={moveFocus}
					onScroll={measure}
					ref={listRef}
					style={{
						columnGap: CINEMA_GAP,
						paddingInline: gutter,
						scrollPaddingInline: gutter,
					}}
				>
					{row.titles.map((title, index) => (
						<li
							className="shrink-0 snap-start"
							key={`${row.id}:${title.thread.id}`}
							style={{ width: itemWidth }}
						>
							{featured ? (
								<CinemaFeature
									current={title.thread.id === activeThreadId}
									onSelect={onSelect}
									title={title}
								/>
							) : (
								<CinemaPoster
									current={title.thread.id === activeThreadId}
									layout={row.layout}
									onHoverEnd={onHoverEnd}
									onHoverStart={onHoverStart}
									onSelect={onSelect}
									rank={row.layout === "top" ? index + 1 : undefined}
									title={title}
								/>
							)}
						</li>
					))}
				</ul>
				{showArrows ? (
					<RowArrow
						direction="next"
						gutter={gutter}
						label={tl("Next titles in {title}", { title: row.title })}
						onClick={() => page(1)}
						visible={canNext}
					/>
				) : null}
			</div>
		</section>
	);
});
