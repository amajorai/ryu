import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowDown, ArrowUp, CornerDownLeft } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	describeChange,
	formatPrice,
	TICKER_RANGE_LABELS,
	TICKER_RANGE_NAMES,
	type TickerQuote,
	type TickerRange,
	type TickerSort,
	type TickerSortKey,
} from "./ticker-model.ts";
import { ChangePill, Sparkline, SYMBOL_TEXT } from "./ticker-parts.tsx";

const SORT_LABELS: Record<TickerSortKey, string> = {
	change: "Change",
	price: "Price",
	symbol: "Symbol",
};

/** What the market metaphor counts, explained where the numbers are read. */
const SORT_HINTS: Partial<Record<TickerSortKey, string>> = {
	change: "Messages in threads active today",
	price: "Messages across the agent's threads",
};

/** Footer key hints: square-cornered keycaps with legible glyphs in every theme. */
const KBD_HINT =
	"h-5 min-w-5 rounded-sm border border-border bg-muted px-1 text-foreground/80";

const SKELETON_KEYS = ["s1", "s2", "s3", "s4", "s5", "s6"] as const;

/** Keys that move the selection, as an index step (Home/End go to the ends). */
const STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
	j: 1,
	k: -1,
};

function SortHeader({
	align,
	className,
	onSort,
	sort,
	sortKey,
}: {
	align: "end" | "start";
	className?: string;
	onSort: (key: TickerSortKey) => void;
	sort: TickerSort;
	sortKey: TickerSortKey;
}) {
	const active = sort.key === sortKey;
	let ariaSort: "ascending" | "descending" | "none" = "none";
	if (active) {
		ariaSort = sort.direction === "asc" ? "ascending" : "descending";
	}
	const Icon = sort.direction === "asc" ? ArrowUp : ArrowDown;
	const hint = SORT_HINTS[sortKey];
	const button = (
		<button
			className={cn(
				"group/sort inline-flex h-7 w-full items-center gap-1 rounded-md px-1.5 font-normal text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
				align === "end" ? "flex-row-reverse justify-start" : "justify-start",
				active ? "text-foreground" : "text-muted-foreground"
			)}
			onClick={() => onSort(sortKey)}
			type="button"
		>
			{SORT_LABELS[sortKey]}
			<Icon
				aria-hidden="true"
				className={cn(
					"size-3 shrink-0",
					active
						? "opacity-100"
						: "opacity-0 transition-opacity group-hover/sort:opacity-50 group-focus-visible/sort:opacity-50"
				)}
			/>
		</button>
	);
	return (
		<th
			aria-sort={ariaSort}
			className={cn("h-8 p-0 font-normal", className)}
			scope="col"
		>
			{hint ? (
				<Tooltip>
					<TooltipTrigger render={button} />
					<TooltipContent side="bottom">{hint}</TooltipContent>
				</Tooltip>
			) : (
				button
			)}
		</th>
	);
}

interface PriceTick {
	id: number;
	up: boolean;
}

/**
 * A brief tint behind the price when it moves while on screen, the way a
 * terminal flashes a changed quote. Opacity only, so it is calm under reduced
 * motion too.
 */
function usePriceTick(price: number): PriceTick | null {
	const previous = useRef(price);
	const [tick, setTick] = useState<PriceTick | null>(null);
	useEffect(() => {
		if (price === previous.current) {
			return;
		}
		const up = price > previous.current;
		previous.current = price;
		setTick({ id: Date.now(), up });
	}, [price]);
	return tick;
}

function WatchRow({
	onKeyDown,
	onSelect,
	quote,
	selected,
	selectedRef,
}: {
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, agentId: string) => void;
	onSelect: (agentId: string, reveal: boolean) => void;
	quote: TickerQuote;
	selected: boolean;
	selectedRef: Ref<HTMLButtonElement> | undefined;
}) {
	const tl = useLiteralMessages();
	const working = quote.agent.status === "working";
	const tick = usePriceTick(quote.price);
	const rowValues = {
		change: describeChange(quote.change, quote.changePercent),
		name: quote.agent.name,
		price: formatPrice(quote.price),
		symbol: quote.symbol,
	};
	return (
		<tr
			className={cn(
				"group relative border-border/60 border-b transition-colors last:border-b-0",
				selected ? "bg-accent" : "hover:bg-muted/60"
			)}
			data-agent-id={quote.agent.id}
			data-selected={selected ? "true" : undefined}
		>
			<td className="py-2 ps-4 pe-2">
				<span
					aria-hidden="true"
					className={cn(
						"absolute inset-y-0 start-0 w-0.5 bg-primary transition-opacity",
						selected ? "opacity-100" : "opacity-0"
					)}
				/>
				<button
					aria-current={selected ? "true" : undefined}
					aria-keyshortcuts="Enter T"
					aria-label={
						working
							? tl(
									"{symbol}, {name}, working: {price} messages, {change}",
									rowValues
								)
							: tl("{symbol}, {name}: {price} messages, {change}", rowValues)
					}
					className="flex min-w-0 flex-col items-start text-start outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
					onClick={() => onSelect(quote.agent.id, true)}
					onKeyDown={(event) => onKeyDown(event, quote.agent.id)}
					ref={selectedRef}
					tabIndex={selected ? 0 : -1}
					type="button"
				>
					<span className="flex items-center gap-1.5">
						<span className={cn(SYMBOL_TEXT, "text-sm")}>{quote.symbol}</span>
						{working ? (
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-success"
								title="Working"
							/>
						) : null}
					</span>
					<span className="w-full truncate text-muted-foreground text-xs">
						{quote.agent.name}
					</span>
				</button>
			</td>
			<td className="px-1 py-2">
				<Sparkline
					className="ms-auto"
					direction={quote.direction}
					values={quote.spark}
				/>
			</td>
			<td className="px-1.5 py-2 text-end">
				<span className="relative ms-auto -me-1 block w-fit rounded-sm px-1 text-foreground text-sm tabular-nums">
					<AnimatePresence>
						{tick ? (
							<motion.span
								animate={{ opacity: 0 }}
								aria-hidden="true"
								className={cn(
									"absolute inset-0 rounded-sm",
									tick.up ? "bg-success/30" : "bg-destructive/30"
								)}
								data-price-tick={tick.up ? "up" : "down"}
								initial={{ opacity: 1 }}
								key={tick.id}
								transition={{ duration: 1.4, ease: "easeOut" }}
							/>
						) : null}
					</AnimatePresence>
					<span className="relative">{formatPrice(quote.price)}</span>
				</span>
			</td>
			<td className="py-2 ps-1 pe-4 text-end">
				<ChangePill change={quote.change} direction={quote.direction} />
			</td>
		</tr>
	);
}

/** The sparkline column's heading, e.g. "Recent activity within the past 2 weeks". */
function sparkHeaderText(range: TickerRange, tl: LiteralMessage): string {
	return tl("Recent activity within the past {range}", {
		range: TICKER_RANGE_NAMES[range],
	});
}

/**
 * The watchlist: every agent as a ticker row (symbol and name, a sparkline
 * over the chart's range, price, and a change pill). Columns sort;
 * arrow keys move the selection, Enter opens the agent's most urgent thread,
 * and T starts a new thread with it.
 */
export function TickerWatchlist({
	children,
	loading,
	onOpenLead,
	onSelect,
	onSort,
	onNewThread,
	onTrade,
	quotes,
	range,
	selectedId,
	selectedRef,
	sort,
}: {
	/** Offered on the empty row when there are no agents yet. */
	onNewThread?: () => void;
	/** Extra sections under the table, inside the same scroller. */
	children?: ReactNode;
	loading: boolean;
	onOpenLead: (agentId: string) => void;
	/** `reveal` is true for a pointer pick, which may scroll the detail into view. */
	onSelect: (agentId: string, reveal: boolean) => void;
	onSort: (key: TickerSortKey) => void;
	onTrade: (agentId: string) => void;
	quotes: TickerQuote[];
	/** The chart range, which the sparklines follow. */
	range: TickerRange;
	selectedId: string | null;
	selectedRef: Ref<HTMLButtonElement>;
	sort: TickerSort;
}) {
	const tl = useLiteralMessages();
	const onRowKeyDown = (
		event: KeyboardEvent<HTMLButtonElement>,
		agentId: string
	) => {
		if (event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			onOpenLead(agentId);
			return;
		}
		if (event.key === "t" || event.key === "T") {
			event.preventDefault();
			onTrade(agentId);
			return;
		}
		const index = quotes.findIndex((quote) => quote.agent.id === agentId);
		let next = index + (STEP[event.key] ?? 0);
		if (event.key === "Home") {
			next = 0;
		} else if (event.key === "End") {
			next = quotes.length - 1;
		} else if (STEP[event.key] === undefined) {
			return;
		}
		event.preventDefault();
		const target = quotes[Math.min(quotes.length - 1, Math.max(0, next))];
		if (!target) {
			return;
		}
		onSelect(target.agent.id, false);
		const table = event.currentTarget.closest("table");
		requestAnimationFrame(() => {
			const button = table?.querySelector<HTMLButtonElement>(
				`tr[data-agent-id="${CSS.escape(target.agent.id)}"] button`
			);
			button?.focus();
			button?.closest("tr")?.scrollIntoView({ block: "nearest" });
		});
	};

	return (
		<section
			aria-labelledby="ticker-watchlist-heading"
			className="flex min-h-0 flex-col border-border bg-background md:w-[22rem] md:shrink-0 md:border-r xl:w-[25rem]"
			data-testid="ticker-watchlist"
		>
			<header className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-4">
				<h2
					className="font-semibold text-foreground text-sm"
					id="ticker-watchlist-heading"
				>
					Watchlist
				</h2>
				<span className="text-muted-foreground text-sm tabular-nums">
					{loading ? "–" : quotes.length}
				</span>
			</header>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<table className="w-full shrink-0 table-fixed border-collapse text-sm">
					<caption className="sr-only">Agents as tickers</caption>
					<colgroup>
						<col />
						<col className="w-[5.25rem]" />
						<col className="w-[4.5rem]" />
						<col className="w-[5rem]" />
					</colgroup>
					<thead className="sticky top-0 z-10 bg-background shadow-[0_1px_0_var(--border)]">
						<tr>
							<SortHeader
								align="start"
								className="ps-2.5"
								onSort={onSort}
								sort={sort}
								sortKey="symbol"
							/>
							{/* Each sparkline narrows to its own activity inside the range,
							    so the header names the range as a bound, not a shared axis. */}
							<th
								className="h-8 px-1 text-end font-normal text-muted-foreground text-xs"
								data-testid="ticker-spark-header"
								scope="col"
								title={sparkHeaderText(range, tl)}
							>
								<span aria-hidden="true">{TICKER_RANGE_LABELS[range]}</span>
								<span className="sr-only">{sparkHeaderText(range, tl)}</span>
							</th>
							<SortHeader
								align="end"
								onSort={onSort}
								sort={sort}
								sortKey="price"
							/>
							<SortHeader
								align="end"
								className="pe-2.5"
								onSort={onSort}
								sort={sort}
								sortKey="change"
							/>
						</tr>
					</thead>
					<tbody>
						{loading || quotes.length > 0 ? null : (
							<tr>
								<td className="px-4 py-3 text-sm" colSpan={4}>
									<span className="flex items-center justify-between gap-3">
										<span className="text-muted-foreground">No agents yet</span>
										{onNewThread ? (
											<Button
												onClick={onNewThread}
												size="sm"
												type="button"
												variant="ghost"
											>
												New thread
											</Button>
										) : null}
									</span>
								</td>
							</tr>
						)}
						{loading
							? SKELETON_KEYS.map((key) => (
									<tr className="border-border/60 border-b" key={key}>
										<td className="py-2.5 ps-4 pe-2">
											<Skeleton className="h-3.5 w-12" radius="dense" />
											<Skeleton className="mt-1.5 h-3 w-20" radius="dense" />
										</td>
										<td className="px-1">
											<Skeleton className="ms-auto h-5 w-16" radius="dense" />
										</td>
										<td className="px-1.5">
											<Skeleton className="ms-auto h-3.5 w-8" radius="dense" />
										</td>
										<td className="ps-1 pe-4">
											<Skeleton className="ms-auto h-6 w-14" radius="dense" />
										</td>
									</tr>
								))
							: quotes.map((quote) => {
									const selected = quote.agent.id === selectedId;
									return (
										<WatchRow
											key={quote.agent.id}
											onKeyDown={onRowKeyDown}
											onSelect={onSelect}
											quote={quote}
											selected={selected}
											selectedRef={selected ? selectedRef : undefined}
										/>
									);
								})}
					</tbody>
				</table>
				{children}
			</div>
			<footer className="flex h-9 shrink-0 items-center gap-4 border-border border-t px-4 text-muted-foreground text-xs max-md:hidden">
				<span className="inline-flex items-center gap-1.5">
					<span className="inline-flex items-center gap-0.5">
						<Kbd className={KBD_HINT}>
							<ArrowUp aria-hidden="true" className="size-3" />
							<span className="sr-only">Up</span>
						</Kbd>
						<Kbd className={KBD_HINT}>
							<ArrowDown aria-hidden="true" className="size-3" />
							<span className="sr-only">Down</span>
						</Kbd>
					</span>
					Select
				</span>
				<span className="inline-flex items-center gap-1.5">
					<Kbd className={KBD_HINT}>
						<CornerDownLeft aria-hidden="true" className="size-3" />
						<span className="sr-only">Enter</span>
					</Kbd>
					Open
				</span>
				<span className="inline-flex items-center gap-1.5">
					<Kbd className={KBD_HINT}>T</Kbd>
					Message
				</span>
			</footer>
		</section>
	);
}
