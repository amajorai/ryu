import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { ActivationStepShell } from "./ActivationStepShell.tsx";
import { activationOfferCopy } from "./activation-offer-copy.ts";

const HIRING_COSTS = [
	"Recruiting and ramp-up",
	"Salary and payroll",
	"Management time",
	"The tools around the role",
] as const;

export function ActivationValueStep({
	organizationPlan = false,
	onContinue,
}: {
	organizationPlan?: boolean;
	onContinue: () => void;
}) {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	const offer = activationOfferCopy(tl, organizationPlan, locale);
	return (
		<ActivationStepShell
			subtitle="Ryu fits into the tools you already use, so the work can start without a new operating system."
			title="Put the work in perspective"
			width="wide"
		>
			<div className="grid gap-8 md:grid-cols-2">
				<section className="flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Hire for the workflow</h2>
					<ul className="flex flex-col gap-2 text-muted-foreground text-sm">
						{HIRING_COSTS.map((item) => (
							<li key={item}>{item}</li>
						))}
					</ul>
				</section>
				<section className="flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Start with Ryu</h2>
					<div>
						<p className="font-medium font-sans text-2xl tabular-nums tracking-tight">
							{offer.amount}
						</p>
						<p className="text-muted-foreground text-sm">{offer.cadence}</p>
					</div>
					<p className="text-detail text-muted-foreground">{offer.recurring}</p>
				</section>
			</div>
			<OnboardingActions>
				<OnboardingCta onClick={onContinue}>See your first task</OnboardingCta>
			</OnboardingActions>
		</ActivationStepShell>
	);
}
