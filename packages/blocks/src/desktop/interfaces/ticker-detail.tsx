import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceEvent,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { BoardAvatar } from "./board-avatar.tsx";
import { compactAge } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";
import { TickerPriceHistory } from "./ticker-chart.tsx";
import {
	countdown,
	describeChange,
	formatChange,
	formatPrice,
	plural,
	type TickerQuote,
	type TickerRange,
	type TickerSeries,
} from "./ticker-model.ts";
import { DIRECTION_TEXT, STATUS_TEXT, SYMBOL_TEXT } from "./ticker-parts.tsx";

interface Stat {
	label: string;
	/** A muted second line under the value. */
	note?: string;
	/** Spoken value, when the printed one is terse ("+31"). */
	spoken?: string;
	tone?: string;
	value: string;
}

/** The headline counts: one row of four above the thread list. */
function keyStats(quote: TickerQuote): Stat[] {
	const { stats } = quote;
	return [
		{
			label: "Active today",
			spoken: describeChange(quote.change, quote.changePercent),
			tone: quote.change === 0 ? undefined : DIRECTION_TEXT[quote.direction],
			value: formatChange(quote.change),
		},
		{ label: "Threads", value: formatPrice(stats.threads) },
		{
			label: "Working",
			tone: stats.working > 0 ? "text-status-success" : undefined,
			value: formatPrice(stats.working),
		},
		{
			label: "Needs attention",
			tone: stats.attention > 0 ? "text-status-destructive" : undefined,
			value: formatPrice(stats.attention),
		},
	];
}

/** The secondary figures, shown under the thread list. */
function moreStats(
	quote: TickerQuote,
	nextRun: InterfaceEvent | undefined,
	now: number
): Stat[] {
	const { stats } = quote;
	const age = quote.lastActive ? compactAge(quote.lastActive, now) : "";
	let lastActive = "—";
	if (age) {
		lastActive = age === "now" ? "Just now" : `${age} ago`;
	}
	return [
		{ label: "Your turn", value: formatPrice(stats.yourTurn) },
		{ label: "Waiting on agent", value: formatPrice(stats.waiting) },
		{ label: "Last active", value: lastActive },
		{
			label: "Next run",
			note: nextRun?.title,
			value: nextRun ? countdown(nextRun.start, now) : "—",
		},
	];
}

/** Robinhood-style section heading: one hairline under it, none elsewhere. */
const SECTION_HEADING =
	"border-border border-b pb-3 font-semibold text-base text-foreground";

function StatGrid({ stats }: { stats: Stat[] }) {
	return (
		<dl className="mt-2 grid @lg:grid-cols-4 grid-cols-2 gap-x-8">
			{stats.map((stat) => (
				<div
					className="flex min-w-0 @lg:flex-col @lg:items-start items-baseline @lg:justify-start justify-between @lg:gap-1 gap-3 py-2"
					key={stat.label}
				>
					<dt className="shrink-0 text-[13px] text-muted-foreground">
						{stat.label}
					</dt>
					<dd className="flex @lg:w-full min-w-0 flex-col @lg:items-start items-end gap-0.5">
						<span
							className={cn(
								"whitespace-nowrap font-medium text-foreground text-lg tabular-nums",
								stat.tone
							)}
						>
							<span aria-hidden={stat.spoken ? "true" : undefined}>
								{stat.value}
							</span>
							{stat.spoken ? (
								<span className="sr-only">{stat.spoken}</span>
							) : null}
						</span>
						{stat.note ? (
							<span className="max-w-full truncate text-muted-foreground text-xs">
								{stat.note}
							</span>
						) : null}
					</dd>
				</div>
			))}
		</dl>
	);
}

function ThreadRow({
	active,
	now,
	onOpen,
	thread,
}: {
	active: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	thread: TickerQuote["threads"][number];
}) {
	const tl = useLiteralMessages();
	const status = threadStatus(thread);
	const title = thread.title.trim() || "Untitled thread";
	const age = compactAge(thread.updatedAt, now);
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				aria-label={tl(
					"Open {title}: {status}, {messageCount, plural, one {# message} other {# messages}}",
					{
						messageCount: thread.messageCount,
						status: THREAD_STATUS_LABELS[status],
						title,
					}
				)}
				className={cn(
					"group grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 rounded-md px-3 py-2 text-start outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
					active && "bg-accent hover:bg-accent"
				)}
				data-thread-id={thread.id}
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate font-medium text-foreground text-sm">
						{title}
					</span>
					{thread.lastMessage ? (
						<span className="truncate text-muted-foreground text-xs">
							{thread.lastMessageRole === "user" ? "You: " : ""}
							{thread.lastMessage}
						</span>
					) : null}
				</span>
				<span className="flex flex-col items-end gap-0.5 whitespace-nowrap text-xs">
					<span className={cn("text-sm", STATUS_TEXT[status])}>
						{THREAD_STATUS_LABELS[status]}
					</span>
					<span className="text-muted-foreground tabular-nums">
						{plural(thread.messageCount, "message")} · {age}
					</span>
				</span>
			</button>
		</li>
	);
}

/**
 * The selected ticker, Robinhood-style: who it is, its "price" and day move in
 * large tabular numerals, a scrubbable activity chart, key statistics, and its
 * threads. "Message" starts a new thread with the agent through the port.
 */
export function TickerDetail({
	activeThreadId,
	nextRun,
	now,
	onOpen,
	onRangeChange,
	onTrade,
	quote,
	range,
	series,
}: {
	activeThreadId: string | null;
	/** The agent's next scheduled run, when it has one. */
	nextRun: InterfaceEvent | undefined;
	now: number;
	onOpen: (threadId: string) => void;
	onRangeChange: (range: TickerRange) => void;
	onTrade: (agentId: string) => void;
	quote: TickerQuote;
	range: TickerRange;
	/** The selected agent's price series over `range`. */
	series: TickerSeries;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const { agent } = quote;
	const working = agent.status === "working";
	const subtitle = [agent.description.trim(), ...quote.groups]
		.filter(Boolean)
		.join(" · ");
	return (
		<motion.article
			animate={{ opacity: 1, y: 0 }}
			aria-labelledby="ticker-detail-symbol"
			className="@container flex w-full max-w-[72rem] flex-col px-8 py-6 max-sm:px-4"
			data-agent-id={agent.id}
			data-testid="ticker-detail"
			initial={reduceMotion ? false : { opacity: 0, y: 6 }}
			transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
		>
			<header className="flex flex-wrap items-center gap-x-4 gap-y-3">
				<BoardAvatar
					agent={agent}
					className="size-10"
					name={agent.name}
					size={28}
				/>
				<div className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
					<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 leading-6">
						<h2
							className={cn(SYMBOL_TEXT, "text-xl")}
							id="ticker-detail-symbol"
						>
							{quote.symbol}
							<span className="sr-only">, {agent.name}</span>
						</h2>
						<span aria-hidden="true" className="text-foreground text-sm">
							{agent.name}
						</span>
						{working ? (
							<span className="text-sm text-status-success">
								<span aria-hidden="true">· </span>Working
							</span>
						) : null}
					</div>
					{subtitle ? (
						<p
							className="truncate text-muted-foreground text-xs"
							title={subtitle}
						>
							{subtitle}
						</p>
					) : null}
				</div>
				<Button
					aria-keyshortcuts="T"
					aria-label={tl("Message {name}", { name: agent.name })}
					className="max-sm:w-full"
					onClick={() => onTrade(agent.id)}
					title={tl("Start a new thread with {name} (T)", { name: agent.name })}
					type="button"
				>
					{tl("Message {name}", { name: agent.name })}
				</Button>
			</header>

			<div className="mt-6">
				<TickerPriceHistory
					key={`${agent.id}-${range}`}
					now={now}
					onRangeChange={onRangeChange}
					price={quote.price}
					range={range}
					series={series}
					symbol={quote.symbol}
				/>
			</div>

			<section aria-labelledby="ticker-stats-heading" className="mt-8">
				<h3 className={SECTION_HEADING} id="ticker-stats-heading">
					Key statistics
				</h3>
				<StatGrid stats={keyStats(quote)} />
			</section>

			<section aria-labelledby="ticker-threads-heading" className="mt-10">
				<div className={cn(SECTION_HEADING, "flex items-baseline gap-2")}>
					<h3 id="ticker-threads-heading">Threads</h3>
					<span className="font-normal text-muted-foreground text-sm tabular-nums">
						{quote.threads.length}
					</span>
				</div>
				{quote.threads.length > 0 ? (
					<ul className="-mx-3 mt-2 flex flex-col">
						{quote.threads.map((thread) => (
							<ThreadRow
								active={thread.id === activeThreadId}
								key={thread.id}
								now={now}
								onOpen={onOpen}
								thread={thread}
							/>
						))}
					</ul>
				) : (
					<p className="py-4 text-muted-foreground text-sm">
						{tl("No threads with {name} yet", { name: agent.name })}
					</p>
				)}
			</section>

			<section aria-labelledby="ticker-more-stats-heading" className="mt-10">
				<h3 className={SECTION_HEADING} id="ticker-more-stats-heading">
					Activity
				</h3>
				<StatGrid stats={moreStats(quote, nextRun, now)} />
			</section>
		</motion.article>
	);
}
