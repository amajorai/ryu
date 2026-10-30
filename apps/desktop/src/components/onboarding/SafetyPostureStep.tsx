import { GatewayPostureCard } from "@/src/components/gateway/GatewayPostureCard.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { ActivationStepShell } from "./ActivationStepShell.tsx";

interface SafetyPostureStepProps {
	onContinue: () => void;
	target: ApiTarget;
}

export function SafetyPostureStep({
	target,
	onContinue,
}: SafetyPostureStepProps) {
	return (
		<ActivationStepShell
			subtitle="Choose how much autonomy your agents should have. You can change this later in Device settings."
			title="Set your safety posture"
		>
			<GatewayPostureCard
				canConfigure
				onContinue={onContinue}
				reachable
				target={target}
			/>
		</ActivationStepShell>
	);
}
