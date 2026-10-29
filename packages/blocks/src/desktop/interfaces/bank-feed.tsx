import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAccountTransaction,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { ArrowDownLeft, Search, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import {
	agentNames,
	type BankDayGroup,
	type BankTransactionContext,
	clockTime,
	formatMoney,
	groupByDay,
	matchesQuery,
	merchantInitial,
	transactionContext,
	transactionMonth,
	transactionSubtitle,
} from "./bank-model.ts";

/** A statement month the feed is narrowed to. */
export interface BankMonthFilter {
	key: string;
	label: string;
}

/**
 * The merchant mark: the provider's (or model's) initial in one neutral round
 * tile, the way bank feeds show a merchant logo; credits get an arrow in. The
 * hairline ring keeps the tile distinct on a hovered or selected row.
 */
export function BankMerchantTile({
	className,
	transaction,
}: {
	className?: string;
	transaction: InterfaceAccountTransaction;
}) {
	const credit = transaction.kind === "credit";
	return (
		<span
			aria-hidden="true"
			className={cn(
				"grid size-10 shrink-0 place-items-center rounded-full font-semibold text-sm ring-1 ring-inset",
				credit
					? "bg-success/12 text-status-success ring-success/20"
					: "bg-muted text-foreground ring-border",
				className
			)}
		>
			{credit ? (
				<ArrowDownLeft className="size-[1.15em]" strokeWidth={2} />
			) : (
				merchantInitial(transaction)
			)}
		</span>
	);
}

/** Amount as the feed shows it: spend plain, credit `+` in the success tone. */
export function BankAmount({
	className,
	currency,
	transaction,
}: {
	className?: string;
	currency: string;
	transaction: InterfaceAccountTransaction;
}) {
	const credit = transaction.kind === "credit";
	return (
		<span
			className={cn(
				"tabular-nums",
				credit ? "text-status-success" : "text-foreground",
				className
			)}
		>
			{formatMoney(transaction.amount, currency, { plus: credit })}
		</span>
	);
}

function TransactionRow({
	context,
	currency,
	onSelect,
	selected,
	transaction,
}: {
	context: BankTransactionContext | null;
	currency: string;
	onSelect: (id: string) => void;
	selected: boolean;
	transaction: InterfaceAccountTransaction;
}) {
	const conversation = context
		? context.thread.title.trim() || "Untitled conversation"
		: null;
	return (
		<li>
			<button
				aria-current={selected ? "true" : undefined}
				className={cn(
					"group/row relative flex w-full items-center @2xl:gap-x-4 gap-x-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors duration-100 hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
					// Wide, the row splits on the same two tracks as the balance and
					// chart above, so the conversation column starts under the chart.
					"@[57.5rem]:grid @[57.5rem]:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] @[57.5rem]:gap-x-16",
					selected &&
						"bg-muted before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary hover:bg-muted"
				)}
				data-transaction-id={transaction.id}
				onClick={() => onSelect(transaction.id)}
				type="button"
			>
				<span className="flex min-w-0 flex-1 items-center @2xl:gap-x-4 gap-x-3">
					<BankMerchantTile
						className={cn(
							transaction.kind === "debit" &&
								"transition-colors duration-100 group-hover/row:bg-background motion-reduce:transition-none",
							transaction.kind === "debit" && selected && "bg-background"
						)}
						transaction={transaction}
					/>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate font-medium text-foreground text-sm">
							{transaction.label.trim() || "Transaction"}
						</span>
						<span className="truncate text-muted-foreground text-xs">
							{context ? (
								<span className="@2xl:hidden">
									{agentNames(context.agents)}
									<span aria-hidden="true"> · </span>
								</span>
							) : null}
							{transactionSubtitle(transaction)}
						</span>
					</span>
				</span>
				<span className="flex min-w-0 @2xl:flex-[0.85] shrink-0 items-center gap-x-4">
					<span className="@2xl:flex hidden min-w-0 flex-1 flex-col gap-0.5">
						{conversation && context ? (
							<>
								<span className="truncate text-foreground/80 text-sm">
									{conversation}
								</span>
								<span className="truncate text-muted-foreground text-xs">
									{agentNames(context.agents)}
								</span>
							</>
						) : null}
					</span>
					<span className="flex @2xl:w-28 shrink-0 flex-col items-end gap-0.5">
						<BankAmount
							className={cn(
								"text-sm",
								selected ? "font-semibold" : "font-medium"
							)}
							currency={currency}
							transaction={transaction}
						/>
						<span className="text-muted-foreground text-xs tabular-nums">
							{clockTime(transaction.at)}
						</span>
					</span>
				</span>
			</button>
		</li>
	);
}

/**
 * Every day header carries the day's spend, the way bank feeds total a day;
 * a day with only money in shows that instead.
 */
function DayTotal({
	currency,
	group,
}: {
	currency: string;
	group: BankDayGroup;
}) {
	if (group.spent === 0 && group.credited > 0) {
		return (
			<span className="text-muted-foreground text-xs tabular-nums">
				<span className="sr-only">Money in </span>
				{formatMoney(group.credited, currency, { plus: true })}
			</span>
		);
	}
	return (
		<span className="text-muted-foreground text-xs tabular-nums">
			<span className="sr-only">Spent </span>
			{formatMoney(group.spent, currency)}
		</span>
	);
}

/** Up and down move between rows, like a native list. */
function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
		return;
	}
	const rows = [
		...event.currentTarget.querySelectorAll<HTMLButtonElement>(
			"button[data-transaction-id]"
		),
	];
	const active = document.activeElement;
	if (!(active instanceof HTMLButtonElement)) {
		return;
	}
	const index = rows.indexOf(active);
	if (index === -1) {
		return;
	}
	const next = rows[event.key === "ArrowDown" ? index + 1 : index - 1];
	if (next) {
		event.preventDefault();
		next.focus();
	}
}

/**
 * The bank feed: transactions grouped under day headers with each day's
 * spend, a search over label, model, provider, and conversation, and wide
 * rows that name the conversation a spend belongs to.
 */
export function BankFeed({
	currency,
	month,
	now,
	onClearMonth,
	onQuery,
	onSelect,
	query,
	selectedId,
	snapshot,
	transactions,
}: {
	currency: string;
	month: BankMonthFilter | null;
	now: number;
	onClearMonth: () => void;
	onQuery: (query: string) => void;
	onSelect: (id: string) => void;
	query: string;
	selectedId: string | null;
	snapshot: InterfaceSnapshot;
	transactions: InterfaceAccountTransaction[];
}) {
	const tl = useLiteralMessages();
	const searchRef = useRef<HTMLInputElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	const monthKey = month?.key ?? null;
	// Arriving from a statement: bring the narrowed feed into view.
	useEffect(() => {
		if (monthKey === null) {
			return;
		}
		headingRef.current?.focus({ preventScroll: true });
		headingRef.current?.scrollIntoView?.({ block: "start" });
	}, [monthKey]);
	const contexts = useMemo(
		() =>
			new Map(
				transactions.map((transaction) => [
					transaction.id,
					transactionContext(snapshot, transaction),
				])
			),
		[snapshot, transactions]
	);
	const visible = useMemo(
		() =>
			transactions.filter(
				(transaction) =>
					(monthKey === null || transactionMonth(transaction) === monthKey) &&
					matchesQuery(transaction, contexts.get(transaction.id) ?? null, query)
			),
		[transactions, contexts, query, monthKey]
	);
	const groups = useMemo(() => groupByDay(visible, now), [visible, now]);

	let body = (
		// biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the row buttons inside
		<div className="flex flex-col" onKeyDown={onListKeyDown}>
			{groups.map((group) => (
				<section aria-label={group.label} key={group.key}>
					<header className="flex items-baseline justify-between px-3 pt-5 pb-1.5">
						<h3 className="font-medium text-muted-foreground text-xs">
							{group.label}
						</h3>
						<DayTotal currency={currency} group={group} />
					</header>
					<ul className="flex flex-col">
						{group.transactions.map((transaction) => (
							<TransactionRow
								context={contexts.get(transaction.id) ?? null}
								currency={currency}
								key={transaction.id}
								onSelect={onSelect}
								selected={transaction.id === selectedId}
								transaction={transaction}
							/>
						))}
					</ul>
				</section>
			))}
		</div>
	);
	if (transactions.length === 0) {
		body = (
			<div className="flex flex-col gap-1 px-3 py-10">
				<p className="font-medium text-foreground text-sm">
					No transactions yet
				</p>
				<p className="text-muted-foreground text-sm">
					Agent runs and top-ups appear here as they happen.
				</p>
			</div>
		);
	} else if (visible.length === 0 && !query.trim() && month) {
		body = (
			<div className="flex flex-col gap-1 px-3 py-10">
				<p className="font-medium text-foreground text-sm">
					{tl("No transactions in {monthLabel}", { monthLabel: month.label })}
				</p>
			</div>
		);
	} else if (visible.length === 0) {
		body = (
			<div className="flex flex-col gap-1 px-3 py-10">
				<p className="font-medium text-foreground text-sm">
					{tl("No transactions match “{query}”", { query: query.trim() })}
				</p>
				<p className="text-muted-foreground text-sm">
					Search covers labels, models, providers, and conversations.
				</p>
			</div>
		);
	}

	return (
		<section
			aria-labelledby="bank-feed-heading"
			className="@container scroll-mt-20"
			data-testid="bank-feed"
		>
			<header className="flex items-center justify-between gap-4 px-3">
				<div className="flex min-w-0 items-center gap-3">
					<h2
						className="scroll-mt-20 font-semibold text-base text-foreground outline-none"
						id="bank-feed-heading"
						ref={headingRef}
						tabIndex={-1}
					>
						Transactions
						{month ? <span className="sr-only"> in {month.label}</span> : null}
					</h2>
					{month ? (
						<Button
							aria-label={tl("Show all months, not just {monthLabel}", {
								monthLabel: month.label,
							})}
							onClick={onClearMonth}
							radius="pill"
							size="xs"
							type="button"
							variant="secondary"
						>
							{month.label}
							<X aria-hidden="true" data-icon="inline-end" />
						</Button>
					) : null}
				</div>
				{transactions.length > 0 ? (
					<InputGroup className="h-8 w-64 max-sm:w-44">
						<InputGroupAddon>
							<Search aria-hidden="true" />
						</InputGroupAddon>
						<InputGroupInput
							aria-label="Search transactions"
							autoComplete="off"
							onChange={(event) => onQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape" && query) {
									event.stopPropagation();
									onQuery("");
								}
							}}
							placeholder="Search"
							ref={searchRef}
							value={query}
						/>
						{query ? (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									aria-label="Clear search"
									onClick={() => {
										onQuery("");
										searchRef.current?.focus();
									}}
									size="icon-xs"
								>
									<X aria-hidden="true" />
								</InputGroupButton>
							</InputGroupAddon>
						) : null}
					</InputGroup>
				) : null}
			</header>
			{body}
		</section>
	);
}
