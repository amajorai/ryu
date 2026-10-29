import type { NodeOnboardingSnapshot } from "@/src/lib/api/onboarding-profile.ts";
import { PluginAvatarContributions } from "../components/avatar/PluginAvatarContributions.tsx";
import OnboardingPage from "../pages/OnboardingPage.tsx";

/**
 * Onboarding sits outside Layout, which owns the shell's avatar-contributions
 * provider; give its persona picker the same plugin avatar styles and
 * accessories.
 */
export default function OnboardingRoute({
	nodeOnboardingState,
	nodeOnboardingStateAvailable,
}: {
	nodeOnboardingState: NodeOnboardingSnapshot | null;
	nodeOnboardingStateAvailable: boolean;
}) {
	return (
		<PluginAvatarContributions>
			<OnboardingPage
				nodeOnboardingState={nodeOnboardingState}
				nodeOnboardingStateAvailable={nodeOnboardingStateAvailable}
			/>
		</PluginAvatarContributions>
	);
}
