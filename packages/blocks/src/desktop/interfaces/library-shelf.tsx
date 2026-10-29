import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import {
	Children,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { BoardStatusLabel } from "./board-status.tsx";
import { BookCover } from "./library-cover.tsx";
import {
	type ContinueItem,
	chapterCountLabel,
	LIBRARY_SORT_LABELS,
	LIBRARY_SORTS,
	type LibraryBook,
	type LibrarySort,
	progressLabel,
	progressPercent,
	readableAge,
} from "./library-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/** Marks the control that opens a book, so focus can return to it. */
export const LIBRARY_BOOK_ATTRIBUTE = "data-book-id";

/** The lift every cover shares: a resting shadow that deepens on hover. */
export const COVER_FRAME =
	"rounded-[3px] shadow-[2px_4px_10px_-2px] shadow-foreground/30 transition-[translate,box-shadow] duration-200 ease-out group-hover:-translate-y-1.5 group-hover:shadow-[4px_10px_18px_-4px] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0";

const FOCUS_RING =
	"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** A hairline progress track: finished chapters over all chapters. */
export function ProgressTrack({
	className,
	value,
}: {
	className?: string;
	value: number;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative block h-[3px] overflow-hidden rounded-full bg-foreground/10",
				className
			)}
		>
			<span
				className="absolute inset-y-0 left-0 rounded-full bg-primary"
				style={{ width: `${Math.min(100, Math.max(0, value)).toString()}%` }}
			/>
		</span>
	);
}

/** One book on a shelf: its cover, a progress track, and its length. */
export function BookTile({
	book,
	onOpen,
}: {
	book: LibraryBook;
	onOpen: (bookId: string) => void;
}) {
	const percent = progressPercent(book);
	const empty = book.chapters.length === 0;
	return (
		<li className="min-w-0">
			<button
				{...{ [LIBRARY_BOOK_ATTRIBUTE]: book.id }}
				aria-label={`${book.title}. ${progressLabel(book)}`}
				className={cn("group block w-full rounded-[3px] text-left", FOCUS_RING)}
				onClick={() => onOpen(book.id)}
				type="button"
			>
				<div className={COVER_FRAME}>
					<BookCover
						authors={book.authors}
						bookId={book.id}
						kind={book.kind}
						subtitle={book.description}
						title={book.title}
					/>
				</div>
				<ProgressTrack className="mt-6" value={percent} />
				<span className="mt-2 flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
					<span className="truncate">
						{chapterCountLabel(book.chapters.length)}
					</span>
					<span className="shrink-0 tabular-nums">
						{empty ? "New" : `${percent.toString()}%`}
					</span>
				</span>
			</button>
		</li>
	);
}

/** Narrowest a book stands, and the gap between books, by frame width. */
const SHELF_METRICS = {
	compact: { gap: 16, min: 100 },
	wide: { gap: 24, min: 128 },
} as const;
/** Frames at least this wide use the wide metrics (the 3xl container). */
const SHELF_WIDE_MIN = 768;
/** How far books sink into the shelf's top face, so they stand on it. */
const PLANK_SINK = 4;

function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		setWidth(element.clientWidth);
		if (typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() => setWidth(element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}

/** The plank a row of books stands on: a lit top face, a front edge, a shadow. */
function ShelfPlank({ top }: { top: number }) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute -inset-x-4"
			style={{ top: top - PLANK_SINK }}
		>
			<div className="h-2 rounded-t-[2px] bg-linear-to-b from-foreground/[0.05] to-foreground/[0.12]" />
			<div className="h-2.5 border-foreground/10 border-t bg-foreground/[0.16] shadow-[0_12px_16px_-8px] shadow-foreground/45" />
		</div>
	);
}

/**
 * Books stood on shelves: the grid is split into rows that fit the frame,
 * and each row stands on its own plank, so the library has depth instead of
 * floating covers. Before the first measurement it renders one plain row.
 */
export function BookGrid({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null);
	const width = useWidth(ref);
	const metrics =
		width >= SHELF_WIDE_MIN ? SHELF_METRICS.wide : SHELF_METRICS.compact;
	const columns = width
		? Math.max(
				1,
				Math.floor((width + metrics.gap) / (metrics.min + metrics.gap))
			)
		: 6;
	const coverHeight = width
		? ((width - metrics.gap * (columns - 1)) / columns) * 1.5
		: 0;
	const items = Children.toArray(children);
	const rows: ReactNode[][] = [];
	for (let index = 0; index < items.length; index += columns) {
		rows.push(items.slice(index, index + columns));
	}
	return (
		<div className="flex flex-col gap-y-10" ref={ref}>
			{rows.map((row, index) => (
				<div className="relative" key={`shelf-${index.toString()}`}>
					{coverHeight > 0 ? <ShelfPlank top={coverHeight} /> : null}
					<ul
						className="relative grid"
						data-book-grid=""
						style={{
							columnGap: metrics.gap,
							gridTemplateColumns: `repeat(${columns.toString()}, minmax(0, 1fr))`,
						}}
					>
						{row}
					</ul>
				</div>
			))}
		</div>
	);
}

/** A shelf heading with optional controls on the right. */
export function Shelf({
	actions,
	children,
	className,
	title,
}: {
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	title: string;
}) {
	const headingId = useId();
	return (
		<section aria-labelledby={headingId} className={className}>
			<div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<h2
					className="font-semibold text-2xl text-foreground tracking-tight"
					id={headingId}
				>
					{title}
				</h2>
				{actions}
			</div>
			<div className="mt-5">{children}</div>
		</section>
	);
}

/** Resume a book at the chapter that waits on the user. */
function ContinueCard({
	item,
	now,
	onOpen,
}: {
	item: ContinueItem;
	now: number;
	onOpen: (item: ContinueItem) => void;
}) {
	const tl = useLiteralMessages();
	const { book, chapter, more } = item;
	const age = readableAge(chapter.thread.updatedAt, now);
	return (
		<li className="min-w-0 snap-start">
			<button
				{...{ [LIBRARY_BOOK_ATTRIBUTE]: book.id }}
				aria-label={tl(
					"Continue {bookTitle}, chapter {chapterNumber}: {chapterTitle}",
					{
						bookTitle: book.title,
						chapterNumber: chapter.number.toString(),
						chapterTitle: chapter.thread.title,
					}
				)}
				className={cn(
					"group flex h-full w-full gap-5 rounded-xl bg-muted/60 p-4 text-left transition-colors duration-150 hover:bg-muted motion-reduce:transition-none",
					// Inset, because the sideways scroller clips anything outside it.
					"outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
				)}
				data-thread-id={chapter.thread.id}
				onClick={() => onOpen(item)}
				type="button"
			>
				<div className={cn("w-24 shrink-0 self-start", COVER_FRAME)}>
					<BookCover
						authors={book.authors}
						bookId={book.id}
						kind={book.kind}
						subtitle={book.description}
						title={book.title}
					/>
				</div>
				<span className="flex min-w-0 flex-1 flex-col py-0.5">
					<BoardStatusLabel status={chapter.status} />
					<span className="mt-2 line-clamp-2 font-semibold text-base text-foreground leading-snug tracking-tight">
						{chapter.thread.title}
					</span>
					<span className="mt-1 truncate text-[13px] text-muted-foreground">
						{tl("{bookTitle} · Chapter {chapterNumber}", {
							bookTitle: book.title,
							chapterNumber: chapter.number.toString(),
						})}
					</span>
					<span className="mt-auto flex flex-col gap-2 pt-3">
						<ProgressTrack value={progressPercent(book)} />
						<span className="flex items-baseline justify-between gap-2 text-[13px] text-muted-foreground">
							<span className="truncate">
								{more > 0
									? tl("{age} · {moreCount} more waiting", {
											age,
											moreCount: more.toString(),
										})
									: age}
							</span>
							<span className="flex shrink-0 items-center gap-0.5 font-medium text-foreground transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none">
								Resume
								<ChevronRight aria-hidden="true" className="size-3.5" />
							</span>
						</span>
					</span>
				</span>
			</button>
		</li>
	);
}

/** Scroll state for a horizontal shelf, so the arrows know when to rest. */
function useScrollEdges(ref: RefObject<HTMLElement | null>, itemCount: number) {
	const [edges, setEdges] = useState({ end: true, start: true });
	const measure = useCallback(() => {
		const element = ref.current;
		if (!element) {
			return;
		}
		const max = element.scrollWidth - element.clientWidth;
		setEdges({
			end: element.scrollLeft >= max - 1,
			start: element.scrollLeft <= 1,
		});
	}, [ref]);
	useEffect(() => {
		const element = ref.current;
		if (!element || itemCount === 0) {
			return;
		}
		measure();
		element.addEventListener("scroll", measure, { passive: true });
		const observer =
			typeof ResizeObserver === "undefined"
				? null
				: new ResizeObserver(measure);
		observer?.observe(element);
		return () => {
			element.removeEventListener("scroll", measure);
			observer?.disconnect();
		};
	}, [ref, measure, itemCount]);
	return edges;
}

/**
 * Continue Reading: one card per book with chapters waiting on the user,
 * on a shelf that scrolls sideways with arrow controls, like Books.
 */
export function ContinueShelf({
	items,
	now,
	onOpen,
}: {
	items: ContinueItem[];
	now: number;
	onOpen: (item: ContinueItem) => void;
}) {
	const listRef = useRef<HTMLUListElement>(null);
	const edges = useScrollEdges(listRef, items.length);
	const reduceMotion = useReducedMotion();
	// Cards are sized so a page holds whole cards; one press turns one page.
	const page = (direction: 1 | -1) => {
		const element = listRef.current;
		element?.scrollBy({
			behavior: reduceMotion ? "auto" : "smooth",
			left: direction * element.clientWidth,
		});
	};
	const scrollable = !(edges.start && edges.end);
	return (
		<Shelf
			actions={
				scrollable ? (
					<div className="flex items-center gap-1">
						<Button
							aria-label="Scroll Continue Reading back"
							disabled={edges.start}
							onClick={() => page(-1)}
							size="icon-sm"
							variant="ghost"
						>
							<ChevronLeft aria-hidden="true" />
						</Button>
						<Button
							aria-label="Scroll Continue Reading forward"
							disabled={edges.end}
							onClick={() => page(1)}
							size="icon-sm"
							variant="ghost"
						>
							<ChevronRight aria-hidden="true" />
						</Button>
					</div>
				) : null
			}
			title="Continue Reading"
		>
			<ul
				className="grid snap-x snap-mandatory @3xl/library:auto-cols-[calc((100%-1rem)/2)] @min-[68rem]/library:auto-cols-[calc((100%-2rem)/3)] auto-cols-[88%] grid-flow-col gap-4 overflow-x-auto overscroll-x-contain pb-1 [scrollbar-width:none]"
				ref={listRef}
			>
				{items.map((item) => (
					<ContinueCard
						item={item}
						key={item.book.id}
						now={now}
						onOpen={onOpen}
					/>
				))}
			</ul>
		</Shelf>
	);
}

/** Search and sort for a grid of books. */
export function LibraryToolbar({
	inputRef,
	onQuery,
	onSort,
	query,
	sort,
}: {
	inputRef: RefObject<HTMLInputElement | null>;
	onQuery: (query: string) => void;
	onSort: (sort: LibrarySort) => void;
	query: string;
	sort: LibrarySort;
}) {
	return (
		<div className="flex @2xl/library:w-auto w-full items-center gap-2">
			<div
				className="@2xl/library:w-60 min-w-0 @2xl/library:flex-none flex-1"
				role="search"
			>
				<InputGroup className="h-8">
					<InputGroupAddon>
						<Search aria-hidden="true" />
					</InputGroupAddon>
					<InputGroupInput
						aria-label="Search books"
						autoComplete="off"
						className="[&::-webkit-search-cancel-button]:appearance-none"
						onChange={(event) => onQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query) {
								event.stopPropagation();
								onQuery("");
							}
						}}
						placeholder="Search"
						ref={inputRef}
						spellCheck={false}
						type="search"
						value={query}
					/>
					<InputGroupAddon align="inline-end">
						{query ? (
							<InputGroupButton
								aria-label="Clear search"
								onClick={() => {
									onQuery("");
									inputRef.current?.focus();
								}}
								size="icon-xs"
							>
								<X aria-hidden="true" />
							</InputGroupButton>
						) : (
							<Kbd>/</Kbd>
						)}
					</InputGroupAddon>
				</InputGroup>
			</div>
			<fieldset className="flex h-8 shrink-0 items-center rounded-md bg-muted p-0.5">
				<legend className="sr-only">Sort by</legend>
				{LIBRARY_SORTS.map((option) => (
					<button
						aria-pressed={sort === option}
						className={cn(
							"h-7 rounded-[5px] px-2.5 font-medium text-xs transition-colors duration-150 motion-reduce:transition-none",
							"outline-none focus-visible:ring-2 focus-visible:ring-ring",
							sort === option
								? "bg-background text-foreground shadow-foreground/10 shadow-sm"
								: "text-muted-foreground hover:text-foreground"
						)}
						key={option}
						onClick={() => onSort(option)}
						type="button"
					>
						{LIBRARY_SORT_LABELS[option]}
					</button>
				))}
			</fieldset>
		</div>
	);
}
