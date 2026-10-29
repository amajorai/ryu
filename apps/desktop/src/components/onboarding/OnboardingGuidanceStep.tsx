import {
	Clock01Icon,
	Settings01Icon,
	Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ONBOARDING_CONTENT_DELAY_MS } from "@ryu/blocks/desktop/onboarding.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { RyuOnboardingAvatar } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";

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
		<div className="scroll-fade h-full w-full overflow-y-auto">
			<div
				className="flex min-h-full w-full flex-col items-center justify-center gap-8 p-8"
				data-tauri-drag-region="true"
			>
				<StaggerReveal>
					<div className="shrink-0">
						<RyuOnboardingAvatar />
					</div>
					<PageHeader stagger={false} title="A few things to know" />
				</StaggerReveal>

				<div
					className="flex w-full max-w-lg flex-col gap-6"
					data-testid="onboarding-guidance-step"
				>
					<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
						<div className="flex flex-col gap-5">
							{GUIDANCE_ITEMS.map((item) => (
								<div className="flex items-start gap-3" key={item.title}>
									<HugeiconsIcon
										aria-hidden="true"
										className="mt-0.5 size-5 shrink-0 opacity-80"
										icon={item.icon}
									/>
									<div className="min-w-0 space-y-1">
										<p className="font-medium text-sm">{item.title}</p>
										<p className="text-muted-foreground text-xs leading-relaxed">
											{item.description}
										</p>
									</div>
								</div>
							))}

							<div className="flex items-center justify-end">
								<Button
									data-testid="onboarding-guidance-continue"
									onClick={onContinue}
									size="lg"
									variant="mono"
								>
									Continue to privacy
								</Button>
							</div>
						</div>
					</StaggerReveal>
				</div>
			</div>
		</div>
	);
}
