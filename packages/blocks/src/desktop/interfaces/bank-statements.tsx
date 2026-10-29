import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type { InterfaceAccount } from "@ryuhq/protocol/interfaces";
import { ChevronRight } from "lucide-react";
import { useId, useMemo } from "react";
import type { BankMonthFilter } from "./bank-feed.tsx";
import {
	type BankStatement,
	formatMoney,
	monthlyStatements,
	shortDay,
	transactionCountLabel,
} from "./bank-model.ts";

const MONTH_ONLY = new Intl.DateTimeFormat(undefined, { month: "long" });

interface StatementYear {
	statements: BankStatement[];
	year: string;
}

/** Statements under year headers, newest year first, as statement lists file them. */
function byYear(statements: readonly BankStatement[]): StatementYear[] {
	const years: StatementYear[] = [];
	for (const statement of statements) {
		const year = statement.key.slice(0, 4);
		const last = years.at(-1);
		if (last?.year === year) {
			last.statements.push(statement);
		} else {
			years.push({ statements: [statement], year });
		}
	}
	return years;
}

/** `October` from a `2026-10` statement key. */
function monthName(key: string): string {
	const [year, month] = key.split("-").map(Number);
	if (year === undefined || month === undefined) {
		return key;
	}
	return MONTH_ONLY.format(new Date(year, month - 1, 1));
}

const RECONCILE_NOTE =
	"Opening balance plus money in, less money out, differs from the closing balance the host reported.";

/** The month's count line, with a marker when its balances disagree. */
function StatementMeta({ statement }: { statement: BankStatement }) {
	const noteId = useId();
	return (
		<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
			{transactionCountLabel(statement.count)}
			{statement.reconciles === false ? (
				<>
					<span aria-hidden="true">·</span>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									aria-describedby={noteId}
									className="cursor-help rounded-xs text-status-warning underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onClick={(event) => event.stopPropagation()}
									type="button"
								/>
							}
						>
							Doesn&apos;t reconcile
						</TooltipTrigger>
						<TooltipContent className="max-w-64">
							{RECONCILE_NOTE}
						</TooltipContent>
					</Tooltip>
					<span className="sr-only" id={noteId}>
						{RECONCILE_NOTE}
					</span>
				</>
			) : null}
		</span>
	);
}

/**
 * Statements: one row per calendar month with opening and closing balance,
 * money in, and money out, all summed from the account's own transactions.
 * A month opens the Home feed narrowed to that month's transactions.
 */
export function BankStatements({
	account,
	onOpenMonth,
}: {
	account: InterfaceAccount;
	onOpenMonth: (month: BankMonthFilter) => void;
}) {
	const tl = useLiteralMessages();
	const statements = useMemo(
		() => monthlyStatements(account.transactions),
		[account.transactions]
	);
	const years = useMemo(() => byYear(statements), [statements]);
	const money = (value: number | null) =>
		value === null ? "–" : formatMoney(value, account.currency);

	return (
		<section
			aria-labelledby="bank-statements-heading"
			className="flex flex-col"
			data-testid="bank-statements"
		>
			<div className="flex flex-col gap-1">
				<h2
					className="font-semibold text-base text-foreground"
					id="bank-statements-heading"
				>
					Statements
				</h2>
				<p className="text-muted-foreground text-sm">
					Monthly totals from your transaction history. Choose a month to see
					its transactions.
				</p>
			</div>
			{statements.length === 0 ? (
				<p className="py-10 text-muted-foreground text-sm">
					Your first statement appears after your first transaction.
				</p>
			) : (
				<table className="mt-8 w-full border-collapse text-sm">
					<thead>
						<tr className="border-border border-b text-left text-muted-foreground text-xs">
							<th className="pb-3 font-medium" scope="col">
								Month
							</th>
							<th
								className="w-32 pb-3 text-right font-medium max-md:hidden"
								scope="col"
							>
								Opening
							</th>
							<th className="w-32 pb-3 text-right font-medium" scope="col">
								Money in
							</th>
							<th className="w-32 pb-3 text-right font-medium" scope="col">
								Money out
							</th>
							<th
								className="w-32 pb-3 text-right font-medium max-sm:hidden"
								scope="col"
							>
								Closing
							</th>
							<th className="w-10 pb-3" scope="col">
								<span className="sr-only">Open</span>
							</th>
						</tr>
					</thead>
					{years.map((group) => (
						<tbody key={group.year}>
							<tr>
								<th
									className="pt-6 pb-2 text-left font-semibold text-foreground text-sm"
									colSpan={6}
									scope="rowgroup"
								>
									{group.year}
								</th>
							</tr>
							{group.statements.map((statement) => (
								<tr
									className="group/statement cursor-pointer border-border border-b transition-colors duration-100 hover:bg-muted/50 motion-reduce:transition-none"
									key={statement.key}
									onClick={() =>
										onOpenMonth({ key: statement.key, label: statement.label })
									}
								>
									<th className="py-3.5 pe-4 text-left font-normal" scope="row">
										<button
											className="block rounded-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
											data-statement-month={statement.key}
											onClick={(event) => {
												event.stopPropagation();
												onOpenMonth({
													key: statement.key,
													label: statement.label,
												});
											}}
											type="button"
										>
											{monthName(statement.key)}
											<span className="sr-only">
												{" "}
												{tl("{year}: {transactionCount}, view", {
													transactionCount: transactionCountLabel(
														statement.count
													),
													year: group.year,
												})}
											</span>
										</button>
										<StatementMeta statement={statement} />
										{statement.partialFrom === null ? null : (
											<span className="block text-muted-foreground text-xs">
												{tl("Partial: history starts {startDay}", {
													startDay: shortDay(new Date(statement.partialFrom)),
												})}
											</span>
										)}
									</th>
									<td className="py-3.5 text-right text-muted-foreground tabular-nums max-md:hidden">
										{money(statement.opening)}
									</td>
									<td className="py-3.5 text-right tabular-nums">
										{statement.credited > 0 ? (
											<span className="text-status-success">
												{formatMoney(statement.credited, account.currency, {
													plus: true,
												})}
											</span>
										) : (
											<span className="text-muted-foreground">
												{formatMoney(0, account.currency)}
											</span>
										)}
									</td>
									<td className="py-3.5 text-right text-foreground tabular-nums">
										{formatMoney(statement.spent, account.currency)}
									</td>
									<td className="py-3.5 text-right font-medium text-foreground tabular-nums max-sm:hidden">
										{money(statement.closing)}
									</td>
									<td aria-hidden="true" className="py-3.5 text-right">
										<ChevronRight className="ms-auto size-4 text-muted-foreground transition-colors group-hover/statement:text-foreground" />
									</td>
								</tr>
							))}
						</tbody>
					))}
				</table>
			)}
		</section>
	);
}
