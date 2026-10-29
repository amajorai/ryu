import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	AGENT_STEP_MODEL,
	agentStepCostUsd,
	approximateCount,
	type PlanCreditEstimate,
	planCreditEstimates,
	SMALL_BOX,
	smallBoxHourUsd,
	toolCallUsd,
} from "./pricing-credit-estimates.ts";

interface UsageMeasure {
	description: string;
	id: string;
	read: (plan: PlanCreditEstimate) => number;
	title: string;
	unit: string;
}

const usd = (amount: number, fractionDigits: number): string =>
	`$${amount.toFixed(fractionDigits)}`;

function usageMeasures(tl: LiteralMessage): UsageMeasure[] {
	return [
		{
			description: tl(
				"On {name}, at about {stepCost} a step: 20k input tokens, mostly cached, and 1k output.",
				{ name: AGENT_STEP_MODEL.name, stepCost: usd(agentStepCostUsd(), 4) }
			),
			id: "agent-steps",
			read: (plan) => plan.agentSteps,
			title: "Agent steps",
			unit: "steps",
		},
		{
			description: tl(
				"A small Box ({vcpu} vCPU, {memoryGib} GiB) running at {hourCost} an hour.",
				{
					hourCost: usd(smallBoxHourUsd(), 4),
					memoryGib: String(SMALL_BOX.memoryGib),
					vcpu: String(SMALL_BOX.vcpu),
				}
			),
			id: "box-hours",
			read: (plan) => plan.boxHours,
			title: "Box hours",
			unit: "hours",
		},
		{
			description: tl("Composio managed-app tool calls at {callCost} a call.", {
				callCost: usd(toolCallUsd(), 4),
			}),
			id: "tool-calls",
			read: (plan) => plan.toolCalls,
			title: "Tool calls",
			unit: "calls",
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
										${plan.poolUsd} {plan.cadence}
									</span>
								</dt>
								<dd className="shrink-0 tabular-nums">
									~{approximateCount(value)} {measure.unit}
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
	const plans = planCreditEstimates();
	return (
		<section
			aria-labelledby="credit-estimates-heading"
			className="container mx-auto px-4 pb-12"
			data-testid="pricing-credit-estimates"
			id="what-credits-buy"
		>
			<div className="mx-auto max-w-6xl">
				<h2
					className="font-medium text-2xl tracking-tight md:text-3xl"
					id="credit-estimates-heading"
				>
					What your credits buy
				</h2>
				<p className="mt-3 max-w-3xl text-muted-foreground text-sm leading-relaxed sm:text-base">
					Each plan includes monthly AI credits. Here is roughly how far they go
					if you spend them all on one kind of usage.
				</p>
				<div className="mt-6 grid gap-4 md:grid-cols-3">
					{usageMeasures(tl).map((measure) => (
						<UsageMeasureCard
							key={measure.id}
							measure={measure}
							plans={plans}
						/>
					))}
				</div>
				<p className="mt-4 text-muted-foreground text-xs leading-relaxed">
					These are estimates. Credits are shared across all your usage, so
					spending on one thing leaves less for the others, and Box hours count
					running time only.
				</p>
			</div>
		</section>
	);
}
