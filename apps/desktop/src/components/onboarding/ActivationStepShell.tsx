import {
	OnboardingShell,
	type OnboardingShellWidth,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import type { ReactNode } from "react";
import { RyuOnboardingAvatar } from "./RyuOnboardingPersona.tsx";

/**
 * The desktop onboarding step frame. Every desktop-only step renders through
 * it, so it shares the block steps' `OnboardingShell`: the persona mark, one
 * centered header and a single fade per step.
 */
export function ActivationStepShell({
	children,
	stepKey,
	subtitle,
	title,
	width = "form",
}: {
	children: ReactNode;
	stepKey?: string;
	subtitle?: ReactNode;
	title: ReactNode;
	width?: OnboardingShellWidth;
}) {
	return (
		<OnboardingShell
			avatar={<RyuOnboardingAvatar size={48} />}
			stepKey={stepKey}
			subtitle={subtitle}
			title={title}
			width={width}
		>
			{children}
		</OnboardingShell>
	);
}
