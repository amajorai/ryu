"use client";

import { SuccessCheck } from "@ryu/ui/components/success-check";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useReducedMotion } from "motion/react";
import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import styles from "./payment-success-receipt.module.css";

export type PaymentSuccessKind =
	| "payment"
	| "topup"
	| "plan"
	| "subscription"
	| "upgrade"
	| "purchase"
	| "gift"
	| "cloud";

interface PaymentSuccessCopy {
	description: string;
	detailLabel: string;
	detailValue: string;
	eyebrow: string;
	nextLabel: string;
	nextValue: string;
	title: string;
}

const PAYMENT_SUCCESS_COPY = {
	cloud: {
		detailLabel: "Cloud purchase",
		detailValue: "Payment received",
		description:
			"Your payment went through. We are sending you back to finish setting up your cloud server.",
		eyebrow: "Ryu / cloud receipt",
		nextLabel: "Next",
		nextValue: "Provisioning",
		title: "Payment received",
	},
	payment: {
		detailLabel: "Payment",
		detailValue: "Confirmed",
		description:
			"Your payment went through. Keep this receipt for your records.",
		eyebrow: "Ryu / payment receipt",
		nextLabel: "Account",
		nextValue: "Ready to use",
		title: "Payment successful",
	},
	plan: {
		detailLabel: "Plan",
		detailValue: "Active",
		description: "Your payment went through and your Ryu plan is ready to use.",
		eyebrow: "Ryu / plan receipt",
		nextLabel: "Access",
		nextValue: "Available now",
		title: "Your plan is active",
	},
	purchase: {
		detailLabel: "Purchase",
		detailValue: "Confirmed",
		description:
			"Your payment went through. Your purchase will appear in your account as it clears.",
		eyebrow: "Ryu / purchase receipt",
		nextLabel: "License",
		nextValue: "Being issued",
		title: "Purchase complete",
	},
	gift: {
		detailLabel: "Gift",
		detailValue: "Ready to share",
		description:
			"Your payment went through. The private gift link will appear once the payment is verified.",
		eyebrow: "Ryu / gift receipt",
		nextLabel: "Delivery",
		nextValue: "Share privately",
		title: "Gift purchase complete",
	},
	subscription: {
		detailLabel: "Subscription",
		detailValue: "Active",
		description:
			"Your payment went through and your included plan access is ready.",
		eyebrow: "Ryu / subscription receipt",
		nextLabel: "Credits",
		nextValue: "Ready for your team",
		title: "Subscription active",
	},
	topup: {
		detailLabel: "Wallet",
		detailValue: "Credit update",
		description:
			"Your payment went through. Your credited balance will appear as the wallet update clears.",
		eyebrow: "Ryu / top-up receipt",
		nextLabel: "Balance",
		nextValue: "Syncing",
		title: "Top-up complete",
	},
	upgrade: {
		detailLabel: "Plan change",
		detailValue: "Confirmed",
		description: "Your payment went through and your upgraded access is ready.",
		eyebrow: "Ryu / upgrade receipt",
		nextLabel: "Access",
		nextValue: "Upgraded",
		title: "Upgrade complete",
	},
} satisfies Record<PaymentSuccessKind, PaymentSuccessCopy>;

function hashValue(value: string): number {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

function receiptNumberFor(value: string): string {
	const encoded = hashValue(value).toString(36).toUpperCase();
	return `RYU-${encoded.padStart(7, "0").slice(-7)}`;
}

function formatAmount(amount: number, currency: string): string {
	try {
		return new Intl.NumberFormat("en-US", {
			currency: currency.toUpperCase(),
			style: "currency",
		}).format(amount);
	} catch {
		return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
	}
}

function formatDate(date: Date): string | null {
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return new Intl.DateTimeFormat("en-GB", {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
		year: "numeric",
	}).format(date);
}

function DashedLine() {
	return (
		<div
			aria-hidden="true"
			className="w-full border-border/80 border-t border-dashed"
		/>
	);
}

function Barcode({ value }: { value: string }) {
	const bars = useMemo(() => {
		const seed = hashValue(value);
		return Array.from({ length: 54 }, (_, index) => {
			const mixed = Math.imul(seed ^ index, 1_597_334_677) >>> 0;
			return {
				gap: mixed % 7 === 0 ? 2.4 : 1.4,
				width: mixed % 4 === 0 ? 2.2 : 1.2,
			};
		});
	}, [value]);

	const totalWidth = bars.reduce(
		(total, bar) => total + bar.width + bar.gap,
		-(bars.at(-1)?.gap ?? 0)
	);
	const svgWidth = 260;
	const svgHeight = 58;
	let currentX = (svgWidth - totalWidth) / 2;
	const rects: Array<{
		height: number;
		key: string;
		width: number;
		x: number;
	}> = [];

	for (const [index, bar] of bars.entries()) {
		rects.push({
			height: index % 9 === 0 ? 42 : 36,
			key: `${index}-${bar.width}-${bar.gap}`,
			width: bar.width,
			x: currentX,
		});
		currentX += bar.width + bar.gap;
	}

	return (
		<div className="flex flex-col items-center gap-2 pt-1">
			<svg
				aria-hidden="true"
				className="h-auto w-full max-w-[16rem] fill-current text-foreground"
				viewBox={`0 0 ${svgWidth} ${svgHeight}`}
				xmlns="http://www.w3.org/2000/svg"
			>
				{rects.map((rect) => (
					<rect
						height={rect.height}
						key={rect.key}
						width={rect.width}
						x={rect.x}
						y={(svgHeight - rect.height) / 2}
					/>
				))}
			</svg>
			<p
				className={cn(styles.barcodeNumber, "font-mono text-muted-foreground")}
			>
				{receiptNumberFor(value)}
			</p>
		</div>
	);
}

export interface PaymentSuccessReceiptProps
	extends HTMLAttributes<HTMLDivElement> {
	/** Optional amount when the caller has a verified checkout quote. */
	amount?: number;
	/** Optional value used to create the deterministic barcode. */
	barcodeValue?: string;
	/** Optional cardholder name from a trusted payment-method response. */
	cardHolder?: string;
	/** The opaque provider checkout id; never printed directly. */
	checkoutId?: string;
	/** ISO currency code for the optional amount. */
	currency?: string;
	/** Optional verified payment timestamp. */
	date?: Date;
	/** Optional replacement for the default success mark. */
	icon?: ReactNode;
	kind?: PaymentSuccessKind;
	/** Optional last four digits from a trusted payment-method response. */
	last4Digits?: string;
	/** Alias kept for callers that already use the provided ticket component. */
	ticketId?: string;
}

/**
 * Post-payment confirmation adapted from dqnamo's receipt printer:
 * https://www.dqnamo.com/experiments/receipt-printer
 * Feeds a single paper receipt through a printer slot. Provider checkout ids
 * remain deterministic seeds and are never printed directly.
 */
export function PaymentSuccessReceipt({
	amount,
	barcodeValue,
	cardHolder,
	checkoutId,
	currency = "USD",
	date,
	icon,
	kind = "payment",
	last4Digits,
	ticketId,
	className,
	...props
}: PaymentSuccessReceiptProps) {
	const copy = PAYMENT_SUCCESS_COPY[kind];
	const seedValue = checkoutId ?? ticketId ?? barcodeValue ?? "ryu-payment";
	const receiptNumber = useMemo(() => receiptNumberFor(seedValue), [seedValue]);
	const barcodeSeed = barcodeValue ?? checkoutId ?? receiptNumber;
	const amountLabel =
		amount === undefined ? null : formatAmount(amount, currency);
	const dateMs = date?.getTime();
	const [issuedLabel, setIssuedLabel] = useState<string | null>(null);

	useEffect(() => {
		const issuedAt = dateMs === undefined ? new Date() : new Date(dateMs);
		setIssuedLabel(formatDate(issuedAt));
	}, [dateMs]);

	const paymentMethod = cardHolder
		? `${cardHolder}${last4Digits ? ` · •••• ${last4Digits}` : ""}`
		: last4Digits
			? `Card ending ${last4Digits}`
			: "Secure checkout";

	return (
		<div
			className={cn(
				"flex min-h-[calc(100vh-5rem)] items-center justify-center px-4 py-10 sm:py-14",
				className
			)}
			data-testid="payment-success-receipt"
			{...props}
		>
			<PaymentReceiptPrinter
				amountLabel={amountLabel}
				key={`${kind}-${seedValue}`}
				title={copy.title}
			>
				<article aria-label="Payment receipt" className={styles.paper}>
					<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
						<span>{copy.eyebrow}</span>
						<span className="shrink-0 text-status-success">● paid</span>
					</div>
					<div className="py-6 text-center">
						<div className="mx-auto mb-3 flex size-8 items-center justify-center text-status-success">
							{icon ?? <SuccessCheck className="size-8" />}
						</div>
						<h1 className="font-medium text-xl tracking-tight">{copy.title}</h1>
						<p className="mt-2 text-muted-foreground text-xs leading-5">
							{copy.description}
						</p>
					</div>
					<DashedLine />
					<dl className={styles.details}>
						<ReceiptDetail label={copy.detailLabel} value={copy.detailValue} />
						{amountLabel ? (
							<ReceiptDetail label="Total paid" value={amountLabel} />
						) : null}
						<ReceiptDetail label="Receipt" value={receiptNumber} />
						<ReceiptDetail label="Status" value="Paid" />
						<ReceiptDetail label="Payment method" value={paymentMethod} />
						<ReceiptDetail
							label={kind === "subscription" ? "Team credits" : copy.nextLabel}
							value={copy.nextValue}
						/>
						{kind === "subscription" ? (
							<ReceiptDetail label="Credits" value="Included" />
						) : null}
						{issuedLabel ? (
							<ReceiptDetail label="Issued" value={issuedLabel} />
						) : null}
					</dl>
					<DashedLine />
					<div className="pt-5">
						<Barcode value={barcodeSeed} />
					</div>
				</article>
			</PaymentReceiptPrinter>
		</div>
	);
}

function ReceiptDetail({ label, value }: { label: string; value: string }) {
	return (
		<div className={styles.detail}>
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right font-medium">{value}</dd>
		</div>
	);
}

function PaymentReceiptPrinter({
	amountLabel,
	children,
	title,
}: {
	amountLabel: string | null;
	children: ReactNode;
	title: string;
}) {
	const reduceMotion = useReducedMotion();
	const [printing, setPrinting] = useState(true);
	const stage = printing && !reduceMotion ? "printing" : "complete";

	useEffect(() => {
		if (reduceMotion) {
			return;
		}
		const timer = setTimeout(() => setPrinting(false), 1750);
		return () => clearTimeout(timer);
	}, [reduceMotion]);

	return (
		<section
			aria-label="Receipt printer"
			className={styles.printer}
			data-stage={stage}
		>
			<div className={styles.machine}>
				<div className={styles.header}>
					<span className="font-medium font-mono text-xs tracking-widest">
						RYU
					</span>
					<span aria-hidden="true" className={styles.indicator} />
				</div>
				<div className={styles.screen}>
					<p className="font-medium text-sm">{title}</p>
					{amountLabel ? (
						<div className="mt-3 flex items-center justify-between gap-4 text-sm">
							<span className="opacity-60">Total paid</span>
							<span className="font-mono">{amountLabel}</span>
						</div>
					) : null}
					<div
						aria-live="polite"
						className="mt-4 flex items-center gap-2 text-xs"
						role="status"
					>
						<span aria-hidden="true" className={styles.statusIcon}>
							{stage === "complete" ? (
								<SuccessCheck className="size-4" />
							) : (
								<span className={styles.spinner} />
							)}
						</span>
						<span>
							{stage === "complete" ? "Receipt ready" : "Printing your receipt"}
						</span>
					</div>
				</div>
				<div aria-hidden="true" className={styles.slot} />
			</div>
			<div className={styles.output}>
				<div className={styles.feed}>{children}</div>
			</div>
		</section>
	);
}
