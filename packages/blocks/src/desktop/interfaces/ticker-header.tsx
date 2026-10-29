import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import {
	describeChange,
	formatPrice,
	shownPercent,
	type TickerIndex,
} from "./ticker-model.ts";
import { ChangeText } from "./ticker-parts.tsx";

const clockFormat = new Intl.DateTimeFormat("en-US", {
	hour: "2-digit",
	hour12: false,
	minute: "2-digit",
});
const dateFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	weekday: "short",
});

function Divider() {
	return (
		<span
			aria-hidden="true"
			className="h-5 w-px shrink-0 bg-border max-sm:hidden"
		/>
	);
}

/** A rule before each later group in the stats list (dividers cannot sit in a dl). */
const GROUP_RULE = "flex h-5 items-center border-border border-s ps-4";

/**
 * The market bar: the interface name, the whole workspace as one index (every
 * thread's messages, with the messages in threads active today as its move),
 * breadth (how many tickers had threads active today and how many stayed
 * quiet), how many agents are working, and the clock.
 */
export function TickerHeader({
	agentCount,
	index,
	loading,
	now,
	onNewThread,
}: {
	agentCount: number;
	index: TickerIndex;
	loading: boolean;
	now: number;
	onNewThread: () => void;
}) {
	const date = new Date(now);
	return (
		<header className="flex h-12 shrink-0 items-center gap-4 border-border border-b px-4">
			<h1 className="shrink-0 font-heading font-semibold text-base text-foreground leading-none">
				Ticker
			</h1>
			<Divider />
			{loading ? (
				<div aria-hidden="true" className="flex items-center gap-4">
					<Skeleton className="h-3.5 w-40" radius="dense" />
					<Skeleton className="h-3.5 w-24" radius="dense" />
				</div>
			) : (
				<dl className="flex min-w-0 items-center gap-4 text-xs">
					<div className="flex items-baseline gap-2">
						<dt className="text-muted-foreground">Workspace</dt>
						<dd className="flex items-baseline gap-2">
							<span className="font-medium text-foreground text-sm tabular-nums">
								{formatPrice(index.price)}
							</span>
							<span className="sr-only">messages, </span>
							<ChangeText
								change={index.change}
								changePercent={shownPercent(
									index.changePercent,
									index.previousClose,
									index.price
								)}
								className="max-sm:hidden"
								direction={index.direction}
							/>
							<span className="text-muted-foreground max-sm:hidden">
								active today
							</span>
							<span className="sr-only">
								{describeChange(index.change, index.changePercent)}
							</span>
						</dd>
					</div>
					<div className={cn(GROUP_RULE, "max-lg:hidden")}>
						<dt className="sr-only">Breadth</dt>
						<dd className="flex items-center gap-1.5 text-muted-foreground">
							<span title="Tickers with threads active today">
								<span
									className={cn(
										"tabular-nums",
										index.active > 0
											? "text-status-success"
											: "text-muted-foreground"
									)}
								>
									{index.active}
								</span>{" "}
								active
							</span>
							<span aria-hidden="true">·</span>
							<span title="Tickers with no thread active today">
								<span className="text-muted-foreground tabular-nums">
									{index.quiet}
								</span>{" "}
								quiet
							</span>
						</dd>
					</div>
					<div className={cn(GROUP_RULE, "gap-1.5 max-md:hidden")}>
						<dt className="sr-only">Agents working</dt>
						<dd className="flex items-center gap-1.5 text-muted-foreground">
							<span
								aria-hidden="true"
								className={cn(
									"size-1.5 rounded-full",
									index.working > 0 ? "bg-success" : "bg-muted-foreground/50"
								)}
							/>
							<span>
								<span className="text-foreground tabular-nums">
									{index.working}
								</span>{" "}
								of {agentCount} working
							</span>
						</dd>
					</div>
				</dl>
			)}
			<div className="ms-auto flex shrink-0 items-center gap-4">
				<time
					className="flex items-baseline gap-2 text-muted-foreground text-xs max-lg:hidden"
					dateTime={date.toISOString()}
				>
					<span>{dateFormat.format(date)}</span>
					<span className="text-foreground tabular-nums">
						{clockFormat.format(date)}
					</span>
				</time>
				<Button onClick={onNewThread} size="sm" type="button" variant="outline">
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className="max-sm:sr-only">New thread</span>
				</Button>
			</div>
		</header>
	);
}
