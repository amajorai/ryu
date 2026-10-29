import { ONBOARDING_CONTENT_DELAY_MS } from "@ryu/blocks/desktop/onboarding.tsx";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import type { ReactNode } from "react";
import { RyuOnboardingAvatar } from "./RyuOnboardingPersona.tsx";

export function ActivationStepShell({
	children,
	subtitle,
	title,
}: {
	children: ReactNode;
	subtitle: string;
	title: string;
}) {
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
					<PageHeader stagger={false} subtitle={subtitle} title={title} />
				</StaggerReveal>
				<StaggerReveal startDelay={ONBOARDING_CONTENT_DELAY_MS} wrap>
					{children}
				</StaggerReveal>
			</div>
		</div>
	);
}
