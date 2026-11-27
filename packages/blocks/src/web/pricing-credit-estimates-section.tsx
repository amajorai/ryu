"use client";

import { formatNumberValue } from "@ryu/i18n/format-intl";
import {
	type LiteralMessage,
	useLiteralMessages,
	useOptionalI18n,
} from "@ryu/i18n/react";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs";
import { cn } from "@ryu/ui/lib/utils";
import { Bot, Box, ChevronDown, type LucideIcon, Wrench } from "lucide-react";
import { useState } from "react";
import { BUSINESS_CREDIT_BUNDLE_SIZE } from "./business-pricing.ts";
import { landingContainerClass } from "./landing-typography.ts";
import {
	type PricingAudience,
	TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE,
} from "./pricing.tsx";
import {
	AGENT_STEP_MODEL,
	agentStepCostUsd,
	approximateCount,
	approximateValue,
	type PlanCreditEstimate,
	planCreditEstimates,
	SMALL_BOX,
	smallBoxHourUsd,
	toolCallUsd,
} from "./pricing-credit-estimates.ts";
import { SectionHeading } from "./sections.tsx";

interface UsageMeasure {
	/** "~9,700 steps": the approximate amount with its unit, in one message. */
	amount: (count: number, countText: string) => string;
	description: string;
	Icon: LucideIcon;
	id: string;
	read: (plan: PlanCreditEstimate) => number;
	title: string;
}

const usd = (
	locale: string | undefined,
	amount: number,
	fractionDigits: number
): string =>
	formatNumberValue(locale, amount, {
		currency: "USD",
		maximumFractionDigits: fractionDigits,
		minimumFractionDigits: fractionDigits,
		style: "currency",
	});

/** "$20 a month", "$100 per 5 seats a month", in the reader's language. */
function planCadence(
	plan: PlanCreditEstimate,
	tl: LiteralMessage,
	locale: string | undefined
): string {
	const price = usd(locale, plan.poolUsd, 0);
	if (plan.id === "teams") {
		return tl("{price} per {seats} seats a month", {
			price,
			seats: TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE,
		});
	}
	if (plan.id === "business") {
		return tl("{price} per full {seats} seats a month", {
			price,
			seats: BUSINESS_CREDIT_BUNDLE_SIZE,
		});
	}
	return tl("{price} a month", { price });
}

function usageMeasures(
	tl: LiteralMessage,
	locale: string | undefined
): UsageMeasure[] {
	return [
		{
			description: tl(
				"On {name}, at about {stepCost} a step: 20k input tokens, mostly cached, and 1k output.",
				{
					name: AGENT_STEP_MODEL.name,
					stepCost: usd(locale, agentStepCostUsd(), 4),
				}
			),
			Icon: Bot,
			id: "agent-steps",
			read: (plan) => plan.agentSteps,
			title: tl("Agent steps"),
			amount: (count, countText) =>
				tl(
					"{count, plural, one {~{countText} step} other {~{countText} steps}}",
					{
						count,
						countText,
					}
				),
		},
		{
			description: tl(
				"A small Box ({vcpu} vCPU, {memoryGib} GiB) running at {hourCost} an hour.",
				{
					hourCost: usd(locale, smallBoxHourUsd(), 4),
					memoryGib: String(SMALL_BOX.memoryGib),
					vcpu: String(SMALL_BOX.vcpu),
				}
			),
			Icon: Box,
			id: "box-hours",
			read: (plan) => plan.boxHours,
			title: tl("Box hours"),
			amount: (count, countText) =>
				tl(
					"{count, plural, one {~{countText} hour} other {~{countText} hours}}",
					{
						count,
						countText,
					}
				),
		},
		{
			description: tl("Composio managed-app tool calls at {callCost} a call.", {
				callCost: usd(locale, toolCallUsd(), 4),
			}),
			Icon: Wrench,
			id: "tool-calls",
			read: (plan) => plan.toolCalls,
			title: tl("Tool calls"),
			amount: (count, countText) =>
				tl(
					"{count, plural, one {~{countText} call} other {~{countText} calls}}",
					{
						count,
						countText,
					}
				),
		},
	];
}

function UsageTile({
	measure,
	plans,
	selected,
}: {
	measure: UsageMeasure;
	plans: PlanCreditEstimate[];
	selected: PlanCreditEstimate;
}) {
	const locale = useOptionalI18n()?.locale;
	const largest = Math.max(1, ...plans.map((plan) => measure.read(plan)));
	const value = measure.read(selected);
	const headingId = `credit-estimate-${measure.id}`;
	return (
		<div
			aria-labelledby={headingId}
			className="flex flex-col rounded-2xl bg-card p-5 md:p-6"
			role="group"
		>
			<h3
				className="flex items-center gap-2 font-medium text-muted-foreground text-sm"
				id={headingId}
			>
				<measure.Icon aria-hidden="true" className="size-4" />
				{measure.title}
			</h3>
			<p
				className="mt-3 font-heading font-medium text-3xl tabular-nums tracking-tight lg:text-4xl"
				data-credit-estimate={measure.id}
			>
				{measure.amount(
					approximateValue(value),
					approximateCount(value, locale)
				)}
			</p>
			{/* The same figure for every plan, as bars: the picked plan is filled. */}
			<div aria-hidden="true" className="mt-5 flex gap-2">
				{plans.map((plan) => (
					<div className="flex min-w-0 flex-1 flex-col gap-1.5" key={plan.id}>
						<div className="flex h-14 items-end">
							<div
								className={cn(
									"w-full rounded-sm transition-colors motion-reduce:transition-none",
									plan.id === selected.id ? "bg-primary" : "bg-muted"
								)}
								style={{
									height: `${Math.max(4, Math.round((measure.read(plan) / largest) * 100))}%`,
								}}
							/>
						</div>
						<span
							className={cn(
								"truncate text-xs",
								plan.id === selected.id
									? "font-medium text-foreground"
									: "text-muted-foreground"
							)}
						>
							{plan.name}
						</span>
					</div>
				))}
			</div>
			<p className="mt-4 text-muted-foreground text-xs leading-relaxed">
				{measure.description}
			</p>
		</div>
	);
}

/** Every plan's three figures in one real table, for readers who want them all. */
function AllPlansTable({
	measures,
	plans,
}: {
	measures: UsageMeasure[];
	plans: PlanCreditEstimate[];
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	return (
		<details
			className="group mt-4 rounded-2xl bg-card px-5 py-2"
			data-testid="pricing-credit-estimates-all-plans"
		>
			<summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-4 rounded-sm font-medium text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
				Compare all plans
				<ChevronDown
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
				/>
			</summary>
			<div className="overflow-x-auto pb-3">
				<table className="w-full min-w-[32rem] border-collapse text-sm">
					<caption className="sr-only">What your credits buy</caption>
					<thead>
						<tr className="text-muted-foreground text-xs">
							<th className="py-2 pe-3 text-start font-medium" scope="col">
								Plan
							</th>
							{measures.map((measure) => (
								<th
									className="px-3 py-2 text-end font-medium"
									key={measure.id}
									scope="col"
								>
									{measure.title}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{plans.map((plan) => (
							<tr key={plan.id}>
								<th className="py-2.5 pe-3 text-start font-normal" scope="row">
									<span className="font-medium">{plan.name}</span>{" "}
									<span className="text-muted-foreground text-xs">
										{planCadence(plan, tl, locale)}
									</span>
								</th>
								{measures.map((measure) => (
									<td
										className="px-3 py-2.5 text-end tabular-nums"
										key={measure.id}
									>
										{measure.amount(
											approximateValue(measure.read(plan)),
											approximateCount(measure.read(plan), locale)
										)}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</details>
	);
}

/**
 * "What your credits buy": pick a plan and read its monthly AI credits as
 * agent steps, Box hours, or tool calls, from published rates. The bars under
 * each figure place the picked plan against the others, and the table below
 * lists every plan for readers who want all the numbers.
 */
export function PricingCreditEstimatesSection({
	audience = "individual",
}: {
	/** The shelf on screen: it decides which plan is picked first. */
	audience?: PricingAudience;
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const plans = planCreditEstimates();
	const measures = usageMeasures(tl, locale);
	const [picked, setPicked] = useState<PlanCreditEstimate["id"] | null>(null);
	const fallback = audience === "business" ? "teams" : "pro";
	const selected =
		plans.find((plan) => plan.id === (picked ?? fallback)) ?? plans[0];
	if (!selected) {
		return null;
	}
	return (
		<section
			aria-label={tl("What your credits buy")}
			className={cn(landingContainerClass, "scroll-mt-20 py-12 md:py-16")}
			data-testid="pricing-credit-estimates"
			id="what-credits-buy"
		>
			<SectionHeading
				className="mb-8 md:mb-10"
				subtitle={tl(
					"Each plan includes monthly AI credits. Here is roughly how far they go if you spend them all on one kind of usage."
				)}
				title={tl("What your credits buy")}
			/>
			<div className="flex flex-col gap-3">
				<div className="flex flex-col gap-4 rounded-2xl bg-card p-5 md:flex-row md:items-center md:justify-between md:px-6">
					<Tabs
						onValueChange={(value) =>
							// SAFETY: the triggers below are exactly `plans`, whose ids are the estimate plan ids.
							setPicked(value as PlanCreditEstimate["id"])
						}
						value={selected.id}
					>
						<TabsList
							aria-label="Plan"
							className="flex-wrap"
							manageLayout={false}
							variant="pills"
						>
							{plans.map((plan) => (
								<TabsTrigger key={plan.id} value={plan.id}>
									{plan.name}
								</TabsTrigger>
							))}
						</TabsList>
					</Tabs>
					<p className="text-sm" data-credit-pool={selected.id}>
						<span className="text-muted-foreground">Credits</span>{" "}
						<span className="font-medium tabular-nums">
							{planCadence(selected, tl, locale)}
						</span>
					</p>
				</div>
				<div className="grid gap-3 md:grid-cols-3">
					{measures.map((measure) => (
						<UsageTile
							key={measure.id}
							measure={measure}
							plans={plans}
							selected={selected}
						/>
					))}
				</div>
			</div>
			<AllPlansTable measures={measures} plans={plans} />
			<p className="mt-4 text-muted-foreground text-xs leading-relaxed">
				These are estimates. Credits are shared across all your usage, so
				spending on one thing leaves less for the others, and Box hours count
				running time only.
			</p>
		</section>
	);
}
