import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal.tsx";
import { GatewayPostureCard } from "@/src/components/gateway/GatewayPostureCard.tsx";
import { RyuOnboardingAvatar } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";

interface SafetyPostureStepProps {
	onContinue: () => void;
	target: ApiTarget;
}

export function SafetyPostureStep({
	target,
	onContinue,
}: SafetyPostureStepProps) {
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
					<PageHeader
						stagger={false}
						subtitle="Choose how much autonomy your agents should have. You can change this later in Device settings."
						title="Set your safety posture"
					/>
				</StaggerReveal>
				<div className="w-full max-w-xl">
					<GatewayPostureCard
						canConfigure
						onContinue={onContinue}
						reachable
						target={target}
					/>
				</div>
			</div>
		</div>
	);
}
