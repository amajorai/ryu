import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAccountTransaction,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, Check, Copy, MessageSquare, X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, type Ref, useEffect, useState } from "react";
import { BankAmount, BankMerchantTile } from "./bank-feed.tsx";
import {
	agentNames,
	type BankTransactionContext,
	formatCount,
	formatMoney,
	fullDateTime,
} from "./bank-model.ts";
import { BoardStatusDot } from "./board-status.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const PANEL_CLASS =
	"absolute inset-y-0 right-0 z-30 flex min-h-0 w-full flex-col border-border bg-background xl:static xl:shrink-0 xl:border-l xl:shadow-none";
const PANEL_TRANSITION = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

function CloseButton({
	label,
	onClose,
}: {
	label: string;
	onClose: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<Button
			aria-label={label}
			onClick={onClose}
			size="icon-sm"
			title={tl("{label} (Esc)", { label })}
			type="button"
			variant="ghost"
		>
			<X aria-hidden="true" />
		</Button>
	);
}

interface DetailRow {
	label: string;
	value: string;
}

/**
 * The transaction's reference, quiet at the foot of the sheet with a copy
 * control, the way bank apps offer "Copy reference" for support.
 */
function ReferenceLine({ reference }: { reference: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = window.setTimeout(() => setCopied(false), 1600);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(reference);
			setCopied(true);
		} catch {
			setCopied(false);
		}
	};
	return (
		<div className="flex items-center justify-between gap-4 px-6 pt-2 pb-6">
			<p className="min-w-0 truncate text-muted-foreground text-xs">
				Reference <span className="font-mono">{reference}</span>
			</p>
			<Button
				className="-me-2 text-muted-foreground"
				onClick={copy}
				size="xs"
				type="button"
				variant="ghost"
			>
				{copied ? (
					<Check aria-hidden="true" data-icon="inline-start" />
				) : (
					<Copy aria-hidden="true" data-icon="inline-start" />
				)}
				{copied ? "Copied" : "Copy reference"}
			</Button>
			<span aria-live="polite" className="sr-only">
				{copied ? "Reference copied" : ""}
			</span>
		</div>
	);
}

function detailRows(
	transaction: InterfaceAccountTransaction,
	currency: string
): DetailRow[] {
	const rows: DetailRow[] = [];
	if (transaction.model) {
		rows.push({ label: "Model", value: transaction.model });
	}
	if (transaction.provider) {
		rows.push({ label: "Provider", value: transaction.provider });
	}
	if (transaction.inputTokens !== null) {
		rows.push({
			label: "Input tokens",
			value: formatCount(transaction.inputTokens),
		});
	}
	if (transaction.outputTokens !== null) {
		rows.push({
			label: "Output tokens",
			value: formatCount(transaction.outputTokens),
		});
	}
	if (transaction.balanceAfter !== null) {
		rows.push({
			label: "Balance after",
			value: formatMoney(transaction.balanceAfter, currency),
		});
	}
	rows.push({
		label: "Type",
		value: transaction.kind === "credit" ? "Credit" : "Spend",
	});
	return rows;
}

/**
 * The transaction sheet: the merchant tile, the amount large, when it
 * happened, the conversation it belongs to (with a way into it), and the
 * usage line by line.
 */
export function BankTransactionPanel({
	context,
	currency,
	headingRef,
	onClose,
	onViewConversation,
	transaction,
}: {
	context: BankTransactionContext | null;
	currency: string;
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	onViewConversation: (threadId: string) => void;
	transaction: InterfaceAccountTransaction;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const label = transaction.label.trim() || "Transaction";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Transaction: {label}", { label })}
			className={cn(
				PANEL_CLASS,
				"sm:w-[26rem] sm:border-l sm:shadow-xl xl:w-[clamp(22rem,30vw,28rem)]"
			)}
			data-testid="bank-transaction-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 16 }}
			transition={PANEL_TRANSITION}
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
				<p className="flex-1 font-medium text-foreground text-sm">
					Transaction
				</p>
				<CloseButton label="Close transaction" onClose={onClose} />
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="flex flex-col items-center gap-3 px-6 pt-8 pb-6 text-center">
					<BankMerchantTile
						className="size-12 text-base"
						transaction={transaction}
					/>
					<h2
						className="font-medium text-base text-foreground outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{label}
					</h2>
					<BankAmount
						className="font-semibold text-4xl tracking-tight"
						currency={currency}
						transaction={transaction}
					/>
					<p className="text-muted-foreground text-sm">
						{fullDateTime(transaction.at)}
					</p>
				</div>
				{context ? (
					<section
						aria-label="Conversation"
						className="mx-6 flex items-center gap-3 border-border border-y py-4"
					>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="text-muted-foreground text-xs">
								Conversation
							</span>
							<span className="truncate font-medium text-foreground text-sm">
								{context.thread.title.trim() || "Untitled conversation"}
							</span>
							<span className="truncate text-muted-foreground text-xs">
								{agentNames(context.agents)}
							</span>
						</div>
						<Button
							onClick={() => onViewConversation(context.thread.id)}
							radius="pill"
							size="sm"
							type="button"
							variant="secondary"
						>
							<MessageSquare aria-hidden="true" data-icon="inline-start" />
							View conversation
						</Button>
					</section>
				) : null}
				<dl className="flex flex-col px-6 py-2">
					{detailRows(transaction, currency).map((row) => (
						<div
							className="flex items-baseline justify-between gap-6 border-border border-b py-3 last:border-b-0"
							key={row.label}
						>
							<dt className="shrink-0 text-muted-foreground text-sm">
								{row.label}
							</dt>
							<dd className="min-w-0 truncate text-right text-foreground text-sm tabular-nums">
								{row.value}
							</dd>
						</div>
					))}
				</dl>
				<ReferenceLine key={transaction.id} reference={transaction.id} />
			</div>
		</motion.aside>
	);
}

/**
 * The open conversation over the host's real thread view. When it was
 * reached from a transaction, a back control returns to that sheet.
 */
export function BankThreadPanel({
	agentsLabel,
	headingRef,
	onBack,
	onClose,
	thread,
	threadView,
}: {
	agentsLabel: string | null;
	headingRef: Ref<HTMLHeadingElement>;
	onBack: (() => void) | null;
	onClose: () => void;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread
		? thread.title.trim() || "Untitled conversation"
		: "New thread";
	const status = thread ? threadStatus(thread) : null;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className={cn(PANEL_CLASS, "xl:w-[clamp(26rem,38vw,40rem)]")}
			data-testid="bank-thread-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 16 }}
			transition={PANEL_TRANSITION}
		>
			<header className="flex h-14 shrink-0 items-center gap-2 border-border border-b px-4">
				{onBack ? (
					<Button
						aria-label="Back to transaction"
						onClick={onBack}
						size="icon-sm"
						title="Back to transaction"
						type="button"
						variant="ghost"
					>
						<ArrowLeft aria-hidden="true" />
					</Button>
				) : null}
				<div className="flex min-w-0 flex-1 flex-col">
					<h2
						className="truncate font-medium text-foreground text-sm leading-tight outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-tight">
						<span className="truncate">
							{agentsLabel ?? "No agent assigned"}
						</span>
						{status ? (
							<>
								<span aria-hidden="true">·</span>
								<span
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5",
										status === "attention" && "text-status-destructive",
										status === "working" && "text-status-success"
									)}
								>
									<BoardStatusDot className="size-1.5" status={status} />
									{THREAD_STATUS_LABELS[status]}
								</span>
							</>
						) : null}
					</p>
				</div>
				<CloseButton label="Close thread" onClose={onClose} />
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
