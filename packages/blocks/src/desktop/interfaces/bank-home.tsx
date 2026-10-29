import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type {
	InterfaceAccount,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ArrowUpRight } from "lucide-react";
import { useId, useMemo } from "react";
import { BankSpendChart } from "./bank-chart.tsx";
import { BankFeed, type BankMonthFilter } from "./bank-feed.tsx";
import {
	dailySpend,
	formatCompact,
	formatMoney,
	moneyParts,
	monthToDate,
	sortTransactions,
	tokensThisMonth,
} from "./bank-model.ts";

export type BankTab = "home" | "insights" | "statements";

const TOP_UP_HINT = "Add credit from Settings, under Billing.";

function BalanceFigure({ account }: { account: InterfaceAccount }) {
	if (account.balance === null) {
		return (
			<p className="flex h-15 items-center font-semibold text-2xl text-muted-foreground tracking-tight">
				Unavailable
			</p>
		);
	}
	const { fraction, lead } = moneyParts(account.balance, account.currency);
	return (
		<p
			className="font-semibold text-foreground tabular-nums tracking-tight"
			data-testid="bank-balance"
		>
			<span className="text-6xl max-sm:text-5xl">{lead}</span>
			<span className="text-3xl max-sm:text-2xl">{fraction}</span>
		</p>
	);
}

function Breakdown({ account }: { account: InterfaceAccount }) {
	const breakdown = account.breakdown;
	if (!breakdown) {
		return null;
	}
	const known: [string, number][] = [];
	for (const [label, value] of [
		["Plan", breakdown.plan],
		["Top-up", breakdown.topup],
		["Gift", breakdown.gift],
	] as const) {
		if (value !== null) {
			known.push([label, value]);
		}
	}
	if (known.length === 0) {
		return null;
	}
	return (
		<dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
			{known.map(([label, value]) => (
				<div className="flex items-baseline gap-1.5" key={label}>
					<dt className="text-muted-foreground">{label}</dt>
					<dd className="font-medium text-foreground tabular-nums">
						{formatMoney(value, account.currency)}
					</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * Home: the balance as the one big number with where it comes from, quick
 * actions, this month's spend and tokens over a 30-day chart, then the feed.
 */
export function BankHome({
	account,
	month,
	now,
	onClearMonth,
	onQuery,
	onSelect,
	onTab,
	query,
	selectedId,
	snapshot,
}: {
	account: InterfaceAccount;
	month: BankMonthFilter | null;
	now: number;
	onClearMonth: () => void;
	onQuery: (query: string) => void;
	onSelect: (id: string) => void;
	onTab: (tab: BankTab) => void;
	query: string;
	selectedId: string | null;
	snapshot: InterfaceSnapshot;
}) {
	const transactions = useMemo(
		() => sortTransactions(account.transactions),
		[account.transactions]
	);
	const days = useMemo(
		() => dailySpend(transactions, now),
		[transactions, now]
	);
	const monthSoFar = useMemo(
		() => monthToDate(transactions, now),
		[transactions, now]
	);
	const tokens = useMemo(
		() => tokensThisMonth(transactions, now),
		[transactions, now]
	);
	const topUpHintId = useId();

	return (
		<div className="@container flex flex-col gap-10">
			<div className="grid @[56rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-x-16 gap-y-10">
				<section
					aria-labelledby="bank-balance-heading"
					className="flex flex-col"
				>
					<h2
						className="font-medium text-muted-foreground text-sm"
						id="bank-balance-heading"
					>
						Balance
						<span className="sr-only">
							{" "}
							in {account.currency.toUpperCase()}
						</span>
					</h2>
					<div className="mt-2">
						<BalanceFigure account={account} />
					</div>
					<div className="mt-3">
						<Breakdown account={account} />
					</div>
					<dl className="mt-8 flex flex-wrap gap-x-10 gap-y-4">
						<div className="flex flex-col gap-0.5">
							<dt className="font-medium text-muted-foreground text-sm">
								Spent this month
							</dt>
							<dd className="font-semibold text-foreground text-xl tabular-nums tracking-tight">
								{formatMoney(monthSoFar.current, account.currency)}
							</dd>
						</div>
						<div className="flex flex-col gap-0.5">
							<dt className="font-medium text-muted-foreground text-sm">
								Tokens this month
							</dt>
							<dd className="font-semibold text-foreground text-xl tabular-nums tracking-tight">
								{formatCompact(tokens)}
							</dd>
						</div>
					</dl>
					<nav
						aria-label="Account actions"
						className="mt-8 flex flex-wrap items-center gap-2"
					>
						<Tooltip>
							<TooltipTrigger
								render={
									<Button
										aria-describedby={topUpHintId}
										aria-disabled="true"
										className="cursor-default active:translate-y-0"
										radius="pill"
										size="sm"
										type="button"
										variant="secondary"
									/>
								}
							>
								Top up in Settings
								<ArrowUpRight aria-hidden="true" data-icon="inline-end" />
							</TooltipTrigger>
							<TooltipContent>{TOP_UP_HINT}</TooltipContent>
						</Tooltip>
						<span className="sr-only" id={topUpHintId}>
							{TOP_UP_HINT}
						</span>
						<Button
							onClick={() => onTab("statements")}
							radius="pill"
							size="sm"
							type="button"
							variant="secondary"
						>
							Statements
						</Button>
						<Button
							onClick={() => onTab("insights")}
							radius="pill"
							size="sm"
							type="button"
							variant="secondary"
						>
							Insights
						</Button>
					</nav>
				</section>
				<section aria-labelledby="bank-spend-heading" className="flex flex-col">
					<BankSpendChart
						currency={account.currency}
						days={days}
						headingId="bank-spend-heading"
						title="Daily spend, last 30 days"
					/>
				</section>
			</div>
			<div className="-mx-3">
				<BankFeed
					currency={account.currency}
					month={month}
					now={now}
					onClearMonth={onClearMonth}
					onQuery={onQuery}
					onSelect={onSelect}
					query={query}
					selectedId={selectedId}
					snapshot={snapshot}
					transactions={transactions}
				/>
			</div>
		</div>
	);
}
