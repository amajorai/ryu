import { formatNumberValue } from "@ryu/i18n/format-intl";
import {
	type LiteralMessage,
	useLiteralMessages,
	useOptionalI18n,
} from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { BUSINESS_CREDIT_BUNDLE_SIZE } from "./business-pricing.ts";
import { landingContainerClass } from "./landing-typography.ts";
import { TEAMS_INCLUDED_CREDIT_BUNDLE_SIZE } from "./pricing.tsx";
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

function UsageMeasureCard({
	measure,
	plans,
}: {
	measure: UsageMeasure;
	plans: PlanCreditEstimate[];
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const largest = Math.max(1, ...plans.map((plan) => measure.read(plan)));
	const headingId = `credit-estimate-${measure.id}`;
	return (
		<div
			aria-labelledby={headingId}
			className="rounded-2xl border border-border/60 bg-card p-5"
			role="group"
		>
			<h3 className="font-medium text-base" id={headingId}>
				{measure.title}
			</h3>
			<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
				{measure.description}
			</p>
			<dl className="mt-4 space-y-3">
				{plans.map((plan) => {
					const value = measure.read(plan);
					const share = Math.max(2, Math.round((value / largest) * 100));
					return (
						<div key={plan.id}>
							<div className="flex items-baseline justify-between gap-3 text-sm">
								<dt>
									<span className="font-medium">{plan.name}</span>{" "}
									<span className="text-muted-foreground text-xs">
										{planCadence(plan, tl, locale)}
									</span>
								</dt>
								<dd className="shrink-0 tabular-nums">
									{measure.amount(
										approximateValue(value),
										approximateCount(value, locale)
									)}
								</dd>
							</div>
							<div
								aria-hidden="true"
								className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
							>
								<div
									className="h-full rounded-full bg-primary"
									style={{ width: `${share}%` }}
								/>
							</div>
						</div>
					);
				})}
			</dl>
		</div>
	);
}

/**
 * "What your credits buy": each public plan's monthly AI credits expressed as
 * agent steps, Box hours, and tool calls, from published rates.
 */
export function PricingCreditEstimatesSection() {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const plans = planCreditEstimates();
	return (
		<section
			aria-label={tl("What your credits buy")}
			className={cn(landingContainerClass, "py-12 md:py-16")}
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
			<div className="grid gap-4 md:grid-cols-3">
				{usageMeasures(tl, locale).map((measure) => (
					<UsageMeasureCard key={measure.id} measure={measure} plans={plans} />
				))}
			</div>
			<p className="mt-4 text-muted-foreground text-xs leading-relaxed">
				These are estimates. Credits are shared across all your usage, so
				spending on one thing leaves less for the others, and Box hours count
				running time only.
			</p>
		</section>
	);
}
