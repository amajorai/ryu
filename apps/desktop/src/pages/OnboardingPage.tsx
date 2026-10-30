import { RyuOnboardingPersonaProvider } from "@/src/components/onboarding/RyuOnboardingPersona.tsx";
import { useOnboardingActivation } from "./OnboardingPage.activation.ts";
import { useOnboardingAgentsStep } from "./OnboardingPage.agents-step.ts";
import type { OnboardingPageProps } from "./OnboardingPage.copy.ts";
import { useOnboardingLocalProgress } from "./OnboardingPage.local-progress.ts";
import { useOnboardingNodeChoice } from "./OnboardingPage.node-choice.ts";
import { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import { useOnboardingProfileFlow } from "./OnboardingPage.profile.ts";
import { renderOnboardingPhase } from "./OnboardingPage.render.tsx";
import { renderOnboardingSetupPhase } from "./OnboardingPage.render-setup.tsx";
import { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import { useOnboardingFlowState } from "./OnboardingPage.state.ts";
import { useOnboardingSteps } from "./OnboardingPage.steps.ts";
import { useOnboardingSyncEffects } from "./OnboardingPage.sync-effects.ts";
import { useOnboardingWorkspace } from "./OnboardingPage.workspace.ts";

type OnboardingPageScope = {
	initialNodeOnboardingState: OnboardingPageProps["nodeOnboardingState"];
	nodeOnboardingStateAvailable: OnboardingPageProps["nodeOnboardingStateAvailable"];
} & ReturnType<typeof useOnboardingPhase> &
	ReturnType<typeof useOnboardingFlowState> &
	ReturnType<typeof useOnboardingLocalProgress> &
	ReturnType<typeof useOnboardingSyncEffects> &
	ReturnType<typeof useOnboardingSetupState> &
	ReturnType<typeof useOnboardingNodeSetup> &
	ReturnType<typeof useOnboardingWorkspace> &
	ReturnType<typeof useOnboardingProfileFlow> &
	ReturnType<typeof useOnboardingAgentsStep> &
	ReturnType<typeof useOnboardingNodeChoice> &
	ReturnType<typeof useOnboardingSteps> &
	ReturnType<typeof useOnboardingActivation>;

export default function OnboardingPage(props: OnboardingPageProps) {
	return (
		<div className="size-full bg-background">
			<RyuOnboardingPersonaProvider>
				<OnboardingPageContent {...props} />
			</RyuOnboardingPersonaProvider>
		</div>
	);
}

function OnboardingPageContent({
	nodeOnboardingState: initialNodeOnboardingState,
	nodeOnboardingStateAvailable,
}: OnboardingPageProps) {
	const scope = {
		initialNodeOnboardingState,
		nodeOnboardingStateAvailable,
	} as OnboardingPageScope;
	Object.assign(scope, useOnboardingPhase(scope));
	Object.assign(scope, useOnboardingFlowState(scope));
	Object.assign(scope, useOnboardingLocalProgress(scope));
	Object.assign(scope, useOnboardingSyncEffects(scope));
	Object.assign(scope, useOnboardingSetupState(scope));
	Object.assign(scope, useOnboardingNodeSetup(scope));
	Object.assign(scope, useOnboardingWorkspace(scope));
	Object.assign(scope, useOnboardingProfileFlow(scope));
	Object.assign(scope, useOnboardingAgentsStep(scope));
	Object.assign(scope, useOnboardingNodeChoice(scope));
	Object.assign(scope, useOnboardingSteps(scope));
	Object.assign(scope, useOnboardingActivation(scope));
	const renderedOnboardingSetupPhase = renderOnboardingSetupPhase(scope);
	if (renderedOnboardingSetupPhase !== undefined) {
		return renderedOnboardingSetupPhase;
	}
	return renderOnboardingPhase(scope);
}
