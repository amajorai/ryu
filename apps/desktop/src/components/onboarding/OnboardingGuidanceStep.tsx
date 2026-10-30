import {
	Clock01Icon,
	Settings01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	OnboardingActions,
	OnboardingCta,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

const GUIDANCE_ITEMS = [
	{
		description:
			"Agents can message people or update apps after you approve each action.",
		icon: Shield01Icon,
		title: "Can take actions for you",
	},
	{
		description:
			"Active turns and scheduled runs can continue after you close the app. Track or stop them in Ryu.",
		icon: Clock01Icon,
		title: "Can keep working in the background",
	},
	{
		description:
			"Choose connected apps, agent access, and approval rules in Settings.",
		icon: Settings01Icon,
		title: "You stay in control",
	},
] as const;

interface OnboardingGuidanceStepProps {
	onContinue: () => void;
}

export function OnboardingGuidanceStep({
	onContinue,
}: OnboardingGuidanceStepProps) {
	return (
		<ActivationStepShell title="A few things to know">
			<ul
				className="flex flex-col gap-4"
				data-testid="onboarding-guidance-step"
			>
				{GUIDANCE_ITEMS.map((item) => (
					<li className="flex items-start gap-3" key={item.title}>
						<HugeiconsIcon
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-muted-foreground"
							icon={item.icon}
							size={16}
						/>
						<div className="min-w-0">
							<p className="font-medium text-sm">{item.title}</p>
							<p className="text-pretty text-detail text-muted-foreground">
								{item.description}
							</p>
						</div>
					</li>
				))}
			</ul>
			<OnboardingActions>
				<OnboardingCta
					data-testid="onboarding-guidance-continue"
					onClick={onContinue}
				>
					Continue to privacy
				</OnboardingCta>
			</OnboardingActions>
		</ActivationStepShell>
	);
}
