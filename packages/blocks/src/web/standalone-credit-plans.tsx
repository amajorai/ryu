"use client";

import {
	STANDALONE_CREDIT_TIERS,
	type StandaloneCreditTierId,
	standaloneCreditQuote,
} from "@ryu/auth/lib/standalone-credit-tiers";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ryu/ui/components/card";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { Input } from "@ryu/ui/components/input";
import PageHeader from "@ryu/ui/components/page-header.tsx";
import { planCardConicGradient } from "@ryu/ui/components/plan-badge";
import {
	Ban,
	CalendarX,
	Check,
	Coins,
	FlaskConical,
	Globe,
	Repeat,
	Wallet,
	Zap,
} from "lucide-react";
import { useState } from "react";
import motionStyles from "./pricing-motion.module.css";

export type StandaloneFundingChoice =
	| { kind: "topup"; amountCents: number }
	| { kind: "monthly"; tierId: StandaloneCreditTierId };
const money = (cents: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
		maximumFractionDigits: 2,
	}).format(cents / 100);

export function StandaloneCreditPlans({
	onCheckout,
	busy = false,
	error,
	subscriptions = [],
	onCancel,
	balanceMicroUsd,
}: {
	onCheckout: (choice: StandaloneFundingChoice) => void;
	busy?: boolean;
	error?: string | null;
	subscriptions?: Array<{
		id: string;
		tierId: string;
		cancelAtPeriodEnd: boolean;
	}>;
	onCancel?: (id: string) => void;
	balanceMicroUsd?: number | null;
}) {
	const tl = useLiteralMessages();
	const [choice, setChoice] = useState<"topup" | StandaloneCreditTierId>(
		"topup"
	);
	const [amount, setAmount] = useState("50");
	const [agreed, setAgreed] = useState(false);
	const amountCents = Math.round(Number(amount) * 100);
	const validAmount =
		Number.isSafeInteger(amountCents) &&
		amountCents >= 500 &&
		amountCents <= 100_000 &&
		/^\d+(?:\.\d{1,2})?$/.test(amount);
	const tier = STANDALONE_CREDIT_TIERS.find(
		(candidate) => candidate.id === choice
	);
	const quote = standaloneCreditQuote(
		tier?.faceCents ?? (validAmount ? amountCents : 500)
	);
	return (
		<section
			aria-label="Credits for standalone services"
			className="mx-auto mb-12 max-w-7xl"
			data-testid="standalone-credit-plans"
			id="standalone-credit-plans"
		>
			<div className="mb-8">
				<PageHeader
					as="h2"
					className="text-left sm:text-center"
					subtitle="Use Gateway and eligible metered services without a workspace subscription. Top up when you need credits, or fund your wallet every month."
					title="Credits for standalone services"
				/>
				{typeof balanceMicroUsd === "number" ? (
					<p className="mt-3 text-left font-medium sm:text-center">
						{tl("Standalone wallet balance: {balance}", {
							balance: money(Math.floor(balanceMicroUsd / 10_000)),
						})}
					</p>
				) : null}
			</div>
			<div
				aria-label="Standalone credit funding"
				className="grid gap-6 md:grid-cols-3"
				role="radiogroup"
			>
				{[
					{ id: "topup", name: "Pay as you go", faceCents: null },
					...STANDALONE_CREDIT_TIERS,
				].map((option) => {
					const Icon =
						option.id === "topup"
							? Wallet
							: option.id === "prototype"
								? FlaskConical
								: Zap;
					return (
						<div
							className="group corner-squircle relative rounded-[calc(var(--radius-4xl)+2px)] bg-border p-[2px] dark:bg-transparent"
							key={option.id}
						>
							<div
								aria-hidden
								className={`t-card-border-spin corner-squircle pointer-events-none absolute inset-0 rounded-[inherit] transition-opacity duration-500 ease-out ${choice === option.id ? "opacity-100" : `opacity-0 group-hover:opacity-100 ${motionStyles.idleRing}`}`}
								style={{
									backgroundImage: planCardConicGradient("gateway-payg"),
								}}
							/>
							<Card className="relative flex h-full flex-col border-transparent">
								<CardHeader>
									<button
										aria-checked={choice === option.id}
										aria-label={option.name}
										className="flex w-full items-center justify-between rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => {
											setChoice(option.id as typeof choice);
											setAgreed(false);
										}}
										onKeyDown={(event) => {
											const keys = [
												"topup",
												"prototype",
												"accelerate",
											] as const;
											const index = keys.indexOf(choice);
											const next =
												event.key === "Home"
													? 0
													: event.key === "End"
														? 2
														: ["ArrowRight", "ArrowDown"].includes(event.key)
															? (index + 1) % 3
															: ["ArrowLeft", "ArrowUp"].includes(event.key)
																? (index + 2) % 3
																: null;
											if (next === null) {
												return;
											}
											const nextChoice = keys[next];
											if (!nextChoice) {
												return;
											}
											event.preventDefault();
											setChoice(nextChoice);
											setAgreed(false);
											const group = event.currentTarget.closest(
												'[role="radiogroup"]'
											);
											group
												?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
												[next]?.focus();
										}}
										role="radio"
										tabIndex={choice === option.id ? 0 : -1}
										type="button"
									>
										<CardTitle className="flex items-center gap-2 text-xl">
											<Icon aria-hidden className="size-5 shrink-0" />
											{option.name}
										</CardTitle>
										<span
											className={`flex size-6 items-center justify-center rounded-full border ${choice === option.id ? "bg-foreground text-background" : "border-muted-foreground"}`}
										>
											{choice === option.id ? (
												<Check aria-hidden className="size-4" />
											) : null}
										</span>
									</button>
									<CardDescription>
										{option.faceCents === null
											? "Top up when you need credits. No monthly fee."
											: option.id === "prototype"
												? "Monthly credits for prototypes and small workloads."
												: "Monthly credits for production and larger workloads."}
									</CardDescription>
								</CardHeader>
								<CardContent className="flex-1">
									<div className="mb-1 flex flex-wrap items-baseline gap-x-1">
										<span className="font-heading font-medium text-4xl tabular-nums">
											{option.faceCents === null
												? "$5–$1,000"
												: money(option.faceCents)}
										</span>
										<span className="text-muted-foreground">
											{option.faceCents === null ? "/top-up" : "credits/mo"}
										</span>
									</div>
									<p className="mb-6 text-muted-foreground text-sm">
										{option.faceCents === null
											? "Credits plus deposit fee"
											: tl(
													"{monthlyCharge} billed monthly, including the deposit fee.",
													{
														monthlyCharge: money(
															standaloneCreditQuote(option.faceCents)
																.chargeCents
														),
													}
												)}
									</p>
									<ul className="space-y-3">
										<li className="flex items-start">
											<Globe
												aria-hidden
												className="mt-0.5 mr-2 size-4 shrink-0"
											/>
											<span>
												Gateway and eligible metered standalone services
											</span>
										</li>
										<li className="flex items-start">
											<Repeat
												aria-hidden
												className="mt-0.5 mr-2 size-4 shrink-0"
											/>
											<span>Unused paid credits roll over</span>
										</li>
										<li className="flex items-start">
											<Coins
												aria-hidden
												className="mt-0.5 mr-2 size-4 shrink-0"
											/>
											<span>27% deposit fee ($5 minimum)</span>
										</li>
										<li className="flex items-start">
											<Ban
												aria-hidden
												className="mt-0.5 mr-2 size-4 shrink-0"
											/>
											<span>
												No workspace plan, seats, or managed server included
											</span>
										</li>
										{option.faceCents === null ? null : (
											<li className="flex items-start">
												<CalendarX
													aria-hidden
													className="mt-0.5 mr-2 size-4 shrink-0"
												/>
												<span>Cancel future renewals at any time</span>
											</li>
										)}
									</ul>
								</CardContent>
								<CardFooter>
									<Button
										className="w-full"
										disabled={choice === option.id}
										onClick={() => {
											setChoice(option.id as typeof choice);
											setAgreed(false);
										}}
										variant={choice === option.id ? "secondary" : "mono"}
									>
										{choice === option.id
											? "Selected"
											: tl("Choose {planName}", { planName: option.name })}
									</Button>
								</CardFooter>
							</Card>
						</div>
					);
				})}
			</div>
			<div className="mx-auto mt-8 max-w-xl space-y-4">
				{choice === "topup" ? (
					<div>
						<label
							className="mb-2 block font-medium text-sm"
							htmlFor="standalone-credit-amount"
						>
							Wallet credits in USD
						</label>
						<Input
							id="standalone-credit-amount"
							inputMode="decimal"
							max="1000"
							min="5"
							onChange={(event) => setAmount(event.target.value)}
							step="0.01"
							type="number"
							value={amount}
						/>
						{validAmount ? null : (
							<p className="mt-2 text-destructive text-sm">
								Enter $5 to $1,000, with at most two decimal places.
							</p>
						)}
					</div>
				) : null}
				<dl className="space-y-2 rounded-xl border p-4 text-sm">
					<div className="flex justify-between">
						<dt>Credits added</dt>
						<dd>{money(quote.faceCents)}</dd>
					</div>
					<div className="flex justify-between">
						<dt>Deposit fee, 27% with a $5 minimum</dt>
						<dd>{money(quote.feeCents)}</dd>
					</div>
					<div className="flex justify-between pt-2 font-medium">
						<dt>{tier ? "Monthly total before tax" : "Total before tax"}</dt>
						<dd>{money(quote.chargeCents)}</dd>
					</div>
				</dl>
				{tier ? (
					<label className="flex items-start gap-2 text-sm">
						<Checkbox
							checked={agreed}
							onCheckedChange={(value) => setAgreed(value === true)}
						/>
						<span>
							{tl(
								"I agree to a recurring {monthlyCharge} monthly charge until canceled.",
								{ monthlyCharge: money(quote.chargeCents) }
							)}
						</span>
					</label>
				) : null}
				{error ? (
					<p className="text-destructive text-sm" role="alert">
						{error}
					</p>
				) : null}
				<Button
					className="w-full"
					disabled={
						busy ||
						!(tier || validAmount) ||
						Boolean(tier && (!agreed || subscriptions.length > 0))
					}
					onClick={() =>
						onCheckout(
							tier
								? { kind: "monthly", tierId: tier.id }
								: { kind: "topup", amountCents }
						)
					}
					variant="mono"
				>
					{busy
						? "Opening checkout…"
						: tier
							? tl("Subscribe to {planName}", { planName: tier.name })
							: "Top up wallet"}
				</Button>
				{subscriptions.map((subscription) => (
					<div
						className="flex items-center justify-between gap-3 rounded-xl border p-4 text-sm"
						key={subscription.id}
					>
						<span>
							{subscription.tierId === "prototype" ? "Prototype" : "Accelerate"}
							{subscription.cancelAtPeriodEnd
								? ": ends after the current period"
								: ": monthly funding active"}
						</span>
						{!subscription.cancelAtPeriodEnd && onCancel ? (
							<Button
								disabled={busy}
								onClick={() => onCancel(subscription.id)}
								size="sm"
								variant="outline"
							>
								Cancel renewal
							</Button>
						) : null}
					</div>
				))}
			</div>
		</section>
	);
}
