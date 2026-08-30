"use client";

import { SuccessCheck } from "@ryu/ui/components/success-check";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { HTMLAttributes, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

export type PaymentSuccessKind =
	| "payment"
	| "topup"
	| "plan"
	| "subscription"
	| "upgrade"
	| "purchase"
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

const PAYMENT_SUCCESS_COPY: Record<PaymentSuccessKind, PaymentSuccessCopy> = {
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
		detailLabel: "Balance",
		detailValue: "Rollover credits",
		description:
			"Your payment went through. Your credited balance will appear as the wallet update clears.",
		eyebrow: "Ryu / top-up receipt",
		nextLabel: "Credits",
		nextValue: "Being added",
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
};

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
			<p className="font-mono text-[0.65rem] text-muted-foreground tracking-[0.28em]">
				{receiptNumberFor(value)}
			</p>
		</div>
	);
}

function PrintLine({
	children,
	delay,
}: {
	children: ReactNode;
	delay: number;
}) {
	return (
		<div
			className="payment-success-receipt-line"
			style={{
				animationDelay: `${delay}s`,
			}}
		>
			{children}
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
 * A reusable post-payment receipt. The paper prints top-to-bottom so the
 * confirmation feels like a physical receipt arriving, while the receipt
 * details remain useful for plan activations, upgrades, and credit top-ups.
 * Provider checkout ids are used only as a deterministic seed; raw ids are not
 * shown to customers.
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
			<style>{`
				@keyframes ryu-payment-receipt-card-in {
					from {
						opacity: 0;
						transform: translateY(22px) scale(0.98) rotate(-1.2deg);
					}
					to {
						opacity: 1;
						transform: translateY(0) scale(1) rotate(0deg);
					}
				}
				@keyframes ryu-payment-receipt-line-in {
					from {
						clip-path: inset(0 0 100% 0);
						filter: blur(3px);
						opacity: 0;
						transform: translateY(6px);
					}
					to {
						clip-path: inset(0 0 0% 0);
						filter: blur(0);
						opacity: 1;
						transform: translateY(0);
					}
				}
				.payment-success-receipt-card {
					animation: ryu-payment-receipt-card-in 700ms cubic-bezier(0.22, 1, 0.36, 1) both;
				}
				.payment-success-receipt-line {
					animation: ryu-payment-receipt-line-in 500ms cubic-bezier(0.22, 1, 0.36, 1) both;
				}
				@media (prefers-reduced-motion: reduce) {
					.payment-success-receipt-card,
					.payment-success-receipt-line {
						animation: none !important;
						clip-path: inset(0 0 0% 0) !important;
						filter: none !important;
						opacity: 1 !important;
						transform: none !important;
					}
				}
			`}</style>
			<div className="payment-success-receipt-card relative w-full max-w-lg">
				<div
					aria-hidden="true"
					className="absolute top-1/2 -left-3 z-10 size-6 -translate-y-1/2 rounded-full bg-background sm:-left-4 sm:size-8"
				/>
				<div
					aria-hidden="true"
					className="absolute top-1/2 -right-3 z-10 size-6 -translate-y-1/2 rounded-full bg-background sm:-right-4 sm:size-8"
				/>

				<div className="overflow-hidden rounded-[2rem] border border-border/70 bg-card text-card-foreground shadow-2xl shadow-foreground/10">
					<div className="border-border/70 border-b border-dashed px-6 py-4 sm:px-9">
						<PrintLine delay={0.12}>
							<div className="flex items-center justify-between gap-4 font-mono text-[0.65rem] text-muted-foreground uppercase tracking-[0.18em]">
								<span>{copy.eyebrow}</span>
								<span className="text-success">● paid</span>
							</div>
						</PrintLine>
					</div>

					<div className="px-6 pt-8 pb-7 text-center sm:px-9 sm:pt-10">
						<PrintLine delay={0.2}>
							<div className="mx-auto flex size-16 items-center justify-center rounded-full bg-success/12 text-success ring-8 ring-success/5 sm:size-20">
								{icon ?? <SuccessCheck className="size-9 sm:size-10" />}
							</div>
						</PrintLine>
						<PrintLine delay={0.28}>
							<h1 className="mt-6 font-heading font-medium text-3xl tracking-tight sm:text-4xl">
								{copy.title}
							</h1>
						</PrintLine>
						<PrintLine delay={0.36}>
							<p className="mx-auto mt-2 max-w-sm text-muted-foreground text-sm leading-6 sm:text-base">
								{copy.description}
							</p>
						</PrintLine>
					</div>

					<div className="space-y-6 px-6 pb-8 sm:px-9 sm:pb-10">
						<DashedLine />

						<PrintLine delay={0.46}>
							<div className="grid grid-cols-2 gap-5">
								<div className="min-w-0">
									<p className="text-[0.65rem] text-muted-foreground uppercase tracking-[0.16em]">
										Receipt
									</p>
									<p className="mt-1 truncate font-medium font-mono text-sm">
										{receiptNumber}
									</p>
								</div>
								<div className="text-right">
									<p className="text-[0.65rem] text-muted-foreground uppercase tracking-[0.16em]">
										Status
									</p>
									<p className="mt-1 font-medium text-sm text-success">Paid</p>
								</div>
							</div>
						</PrintLine>

						{amountLabel ? (
							<PrintLine delay={0.54}>
								<div className="flex items-baseline justify-between gap-4">
									<p className="text-[0.65rem] text-muted-foreground uppercase tracking-[0.16em]">
										Amount
									</p>
									<p className="font-heading font-medium text-2xl">
										{amountLabel}
									</p>
								</div>
							</PrintLine>
						) : null}

						<PrintLine delay={amountLabel ? 0.62 : 0.54}>
							<div className="grid grid-cols-2 gap-5 rounded-2xl bg-muted/55 p-4">
								<div className="min-w-0">
									<p className="text-[0.65rem] text-muted-foreground uppercase tracking-[0.16em]">
										{copy.detailLabel}
									</p>
									<p className="mt-1 truncate font-medium text-sm">
										{copy.detailValue}
									</p>
								</div>
								<div className="min-w-0 text-right">
									<p className="text-[0.65rem] text-muted-foreground uppercase tracking-[0.16em]">
										Payment method
									</p>
									<p className="mt-1 truncate font-mono text-sm">
										{paymentMethod}
									</p>
								</div>
							</div>
						</PrintLine>

						<PrintLine delay={amountLabel ? 0.7 : 0.62}>
							<div className="flex items-baseline justify-between gap-4">
								<p className="text-[0.65rem] text-muted-foreground uppercase tracking-[0.16em]">
									{copy.nextLabel}
								</p>
								<p className="font-medium text-sm">{copy.nextValue}</p>
							</div>
						</PrintLine>

						{issuedLabel ? (
							<PrintLine delay={amountLabel ? 0.78 : 0.7}>
								<p className="text-center text-muted-foreground text-xs">
									Issued {issuedLabel}
								</p>
							</PrintLine>
						) : null}

						<DashedLine />
						<PrintLine delay={amountLabel ? 0.86 : 0.78}>
							<Barcode value={barcodeSeed} />
						</PrintLine>
					</div>
				</div>
			</div>
		</div>
	);
}
