import { useLiteralMessages } from "@ryu/i18n/react";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAccount,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";
import {
	BANK_PERIOD_LABELS,
	type BankPeriod,
	type BankShare,
	formatMoney,
	monthToDate,
	rollupShares,
	shortDay,
	spendByAgent,
	spendByConversation,
	spendByModel,
	transactionCountLabel,
} from "./bank-model.ts";

/** Rows each side-by-side ranking shows before rolling the rest into Other. */
const RANKED_ROWS = 4;

const PERIODS: BankPeriod[] = ["this-month", "last-month"];
const MONTH_NAME = new Intl.DateTimeFormat(undefined, { month: "long" });
const PERCENT = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 0,
	style: "percent",
});

function isPeriod(value: unknown): value is BankPeriod {
	return value === "this-month" || value === "last-month";
}

function ShareRow({
	currency,
	onOpen,
	share,
}: {
	currency: string;
	onOpen?: (threadId: string) => void;
	share: BankShare;
}) {
	const tl = useLiteralMessages();
	// The bar is the row's share of the period, the same figure as its label.
	const width = share.spent > 0 ? Math.max(1, share.share * 100) : 0;
	const detail = [share.detail, transactionCountLabel(share.count)]
		.filter(Boolean)
		.join(" · ");
	const content = (
		<>
			<span className="flex items-baseline justify-between gap-4">
				<span className="flex min-w-0 flex-col gap-0.5">
					<span
						className={cn(
							"flex min-w-0 items-center gap-1 font-medium text-sm",
							share.pinned || share.rollup
								? "text-muted-foreground"
								: "text-foreground"
						)}
					>
						<span className="truncate">{share.label}</span>
						{onOpen ? (
							<ArrowUpRight
								aria-hidden="true"
								className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/share:opacity-100 group-focus-visible/share:opacity-100 motion-reduce:transition-none"
							/>
						) : null}
					</span>
					<span className="truncate text-muted-foreground text-xs">
						{detail}
					</span>
				</span>
				<span className="flex shrink-0 items-baseline gap-3">
					<span className="font-medium text-foreground text-sm tabular-nums">
						{formatMoney(share.spent, currency)}
					</span>
					<span className="w-9 text-right text-muted-foreground text-xs tabular-nums">
						{PERCENT.format(share.share)}
					</span>
				</span>
			</span>
			<span
				aria-hidden="true"
				className="block h-1.5 overflow-hidden rounded-full bg-muted"
			>
				<span
					className={cn(
						"block h-full rounded-full",
						share.pinned || share.rollup
							? "bg-muted-foreground/50"
							: "bg-primary"
					)}
					style={{ width: `${width}%` }}
				/>
			</span>
		</>
	);
	if (onOpen && share.threadId) {
		const threadId = share.threadId;
		return (
			<li>
				<button
					aria-label={tl("{label}: {amount}. Open conversation", {
						amount: formatMoney(share.spent, currency),
						label: share.label,
					})}
					className="group/share -mx-3 flex w-[calc(100%+1.5rem)] flex-col gap-2 rounded-lg px-3 py-2.5 text-left outline-none transition-colors duration-100 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
					data-thread-id={threadId}
					onClick={() => onOpen(threadId)}
					type="button"
				>
					{content}
				</button>
			</li>
		);
	}
	return <li className="flex flex-col gap-2 py-2.5">{content}</li>;
}

function ShareList({
	className,
	currency,
	empty,
	onOpen,
	shares,
	title,
}: {
	className?: string;
	currency: string;
	empty: string;
	onOpen?: (threadId: string) => void;
	shares: BankShare[];
	title: string;
}) {
	const ranked = shares.filter((share) => !share.pinned);
	const pinned = shares.filter((share) => share.pinned);
	const headingId = `bank-insights-${title.toLowerCase().replaceAll(" ", "-")}`;
	return (
		<section
			aria-labelledby={headingId}
			className={cn("flex flex-col", className)}
		>
			<h3
				className="border-border border-b pb-3 font-semibold text-foreground text-sm"
				id={headingId}
			>
				{title}
			</h3>
			{shares.length === 0 ? (
				<p className="py-4 text-muted-foreground text-sm">{empty}</p>
			) : (
				<>
					{ranked.length > 0 ? (
						<ol className="flex flex-col pt-1.5">
							{ranked.map((share) => (
								<ShareRow
									currency={currency}
									key={share.id}
									onOpen={onOpen}
									share={share}
								/>
							))}
						</ol>
					) : null}
					{pinned.length > 0 ? (
						<ul
							aria-label="Not attributed to an agent"
							className={cn(
								"flex flex-col",
								ranked.length > 0
									? "mt-1.5 border-border border-t pt-1.5"
									: "pt-1.5"
							)}
						>
							{pinned.map((share) => (
								<ShareRow currency={currency} key={share.id} share={share} />
							))}
						</ul>
					) : null}
				</>
			)}
		</section>
	);
}

function Comparison({
	account,
	now,
}: {
	account: InterfaceAccount;
	now: number;
}) {
	const tl = useLiteralMessages();
	const month = monthToDate(account.transactions, now);
	const currency = account.currency;
	const lastMonth = new Date(now);
	lastMonth.setDate(1);
	lastMonth.setMonth(lastMonth.getMonth() - 1);
	const lastMonthName = MONTH_NAME.format(lastMonth);
	const comparable = month.hasFullPrevious;
	// History that only starts this month leaves nothing of last month.
	const startsThisMonth =
		month.historyStart !== null &&
		month.historyStart >=
			new Date(lastMonth.getFullYear(), lastMonth.getMonth() + 1, 1).getTime();
	let previousLabel = `${lastMonthName} 1–${month.dayOfMonth}`;
	if (!comparable) {
		if (month.historyStart === null) {
			previousLabel = lastMonthName;
		} else if (startsThisMonth) {
			previousLabel = tl("No history in {lastMonthName}", { lastMonthName });
		} else {
			previousLabel = tl("{lastMonthName}, from {startDay}", {
				lastMonthName,
				startDay: shortDay(new Date(month.historyStart)),
			});
		}
	}
	let note: string;
	if (comparable) {
		const difference = month.current - month.previousToDate;
		if (difference === 0) {
			note = "Level with this time last month";
		} else if (month.previousToDate === 0) {
			note = tl("{amount} more than this time last month", {
				amount: formatMoney(difference, currency),
			});
		} else {
			const change = PERCENT.format(
				Math.abs(difference) / month.previousToDate
			);
			note = tl(
				"{change} {direction, select, more {more} other {less}} than this time last month",
				{ change, direction: difference > 0 ? "more" : "less" }
			);
		}
		note = tl("{note} · {total} in all of {lastMonthName}", {
			lastMonthName,
			note,
			total: formatMoney(month.previous, currency),
		});
	} else if (month.historyStart === null) {
		note = "No spend history yet";
	} else if (startsThisMonth) {
		note = tl("Your history starts {startDay}", {
			startDay: shortDay(new Date(month.historyStart)),
		});
	} else {
		note = tl(
			"Your history starts partway through {lastMonthName}, so the two are not like for like",
			{ lastMonthName }
		);
	}
	return (
		<div className="flex flex-col gap-3">
			<dl className="grid grid-flow-col grid-rows-[auto_auto] items-baseline justify-start gap-x-12 gap-y-1">
				<div className="contents">
					<dt className="font-medium text-muted-foreground text-sm">
						This month so far
					</dt>
					<dd className="font-semibold text-4xl text-foreground tabular-nums tracking-tight">
						{formatMoney(month.current, currency)}
					</dd>
				</div>
				<div className="contents">
					<dt className="font-medium text-muted-foreground text-sm">
						{previousLabel}
					</dt>
					<dd
						className={cn(
							"font-semibold text-2xl tabular-nums tracking-tight",
							comparable ? "text-foreground" : "text-muted-foreground"
						)}
					>
						{formatMoney(
							comparable ? month.previousToDate : month.previous,
							currency
						)}
					</dd>
				</div>
			</dl>
			<p className="text-muted-foreground text-sm">{note}</p>
		</div>
	);
}

/**
 * Insights: month-to-date against last month, then where the money went,
 * ranked by model, by agent (through each spend's conversation), and by
 * conversation, which opens the thread.
 */
export function BankInsights({
	account,
	now,
	onOpenThread,
	onPeriod,
	period,
	snapshot,
}: {
	account: InterfaceAccount;
	now: number;
	onOpenThread: (threadId: string) => void;
	onPeriod: (period: BankPeriod) => void;
	period: BankPeriod;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const transactions = account.transactions;
	const byModel = useMemo(
		() => rollupShares(spendByModel(transactions, period, now), RANKED_ROWS),
		[transactions, period, now]
	);
	const byAgent = useMemo(
		() =>
			rollupShares(
				spendByAgent(snapshot, transactions, period, now),
				RANKED_ROWS
			),
		[snapshot, transactions, period, now]
	);
	const byConversation = useMemo(
		() => spendByConversation(snapshot, transactions, period, now),
		[snapshot, transactions, period, now]
	);
	const periodName = BANK_PERIOD_LABELS[period].toLowerCase();

	return (
		<div className="flex flex-col gap-12" data-testid="bank-insights">
			<Comparison account={account} now={now} />
			<div className="flex flex-col gap-8">
				<div className="flex flex-wrap items-center justify-between gap-4">
					<h2 className="font-semibold text-base text-foreground">Breakdown</h2>
					<ToggleGroup
						aria-label="Period"
						multiple={false}
						onValueChange={(values: string[]) => {
							const value = values[0];
							if (isPeriod(value)) {
								onPeriod(value);
							}
						}}
						spacing={1}
						value={[period]}
					>
						{PERIODS.map((option) => (
							<ToggleGroupItem
								className="h-8 rounded-full px-3 font-medium text-muted-foreground text-sm aria-pressed:text-foreground"
								key={option}
								size="sm"
								value={option}
							>
								{BANK_PERIOD_LABELS[option]}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</div>
				<div className="grid gap-x-16 gap-y-10 md:grid-cols-2">
					<ShareList
						currency={account.currency}
						empty={tl("No spend {periodName}.", { periodName })}
						shares={byAgent}
						title="By agent"
					/>
					<ShareList
						currency={account.currency}
						empty={tl("No spend {periodName}.", { periodName })}
						shares={byModel}
						title="By model"
					/>
				</div>
				<ShareList
					currency={account.currency}
					empty={tl("No conversation spend {periodName}.", { periodName })}
					onOpen={onOpenThread}
					shares={byConversation}
					title="By conversation"
				/>
			</div>
		</div>
	);
}
