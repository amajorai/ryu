"use client";

// Presentational layer of the desktop Onboarding wizard. The live app
// (`apps/desktop/src/pages/OnboardingPage.tsx`) is a thin container that polls
// Core's catalog, detects installable CLI agents, and drives the phase machine,
// then renders this view with the resolved state + real handlers; the storyboard
// renders the same component with mock data and no-op handlers. One source of
// truth, so editing this block changes the real desktop too.
//
// Like the `AgentsView` / login reference, the real page's bespoke
// framer-motion mount transitions are intentionally dropped — `motion` is not
// resolvable at the shared block boundary.

import type { ReactNode } from "react";
import { AgentPicker } from "./onboarding-agents.tsx";
import { ChooseStep, ConnectStep } from "./onboarding-choose.tsx";
import { OnboardingShell, ProgressBar } from "./onboarding-shell.tsx";
import { SkillPackPicker } from "./onboarding-skills.tsx";
import { FeatureStep, MicStep } from "./onboarding-steps.tsx";
import type { OnboardingViewProps } from "./onboarding-types.ts";

export {
	ONBOARDING_CONTENT_DELAY_MS,
	OnboardingActions,
	OnboardingCta,
	OnboardingShell,
	type OnboardingShellWidth,
} from "./onboarding-shell.tsx";
export type {
	OnboardingAgentOption,
	OnboardingFeatureOption,
	OnboardingSkillPackOption,
	OnboardingStep,
	OnboardingViewProps,
} from "./onboarding-types.ts";

export function OnboardingView(props: OnboardingViewProps) {
	const { agentAvatarGlyph, step, title, subtitle } = props;

	// Agents step: when we detected installs, lead with that — otherwise a
	// generic pick-your-agents prompt. Overrides the container's default copy.
	let headerTitle = title;
	let headerSubtitle = subtitle;
	if (step === "agents") {
		const detectedCount = props.agents?.length ?? 0;
		if (detectedCount > 0) {
			headerTitle = "We found agents on this device";
			headerSubtitle = "Pick which ones to add, and install more later";
		} else {
			headerTitle = "Add your agents";
			headerSubtitle = "Pick any you'd like to set up, and install more later";
		}
	}
	if (step === "skills") {
		headerTitle = "Choose recommended skills";
		headerSubtitle =
			"Select the optional skill collections to install on this node";
	}

	let body: ReactNode;
	let progressStep = false;
	if (step === "choose") {
		body = <ChooseStep {...props} />;
	} else if (step === "connect") {
		body = <ConnectStep {...props} />;
	} else if (step === "agents") {
		body = <AgentPicker {...props} />;
	} else if (step === "skills") {
		body = <SkillPackPicker {...props} />;
	} else if (step === "features") {
		body = <FeatureStep {...props} />;
	} else if (step === "mic") {
		body = <MicStep {...props} />;
	} else {
		// The auto-advancing steps (starting / installing / finishing / done).
		progressStep = true;
		body = <ProgressBar done={step === "done"} value={props.progress} />;
	}

	// One shell for every step. Keyed per step (and per feature, since every
	// feature is the same component in the same slot) so each fades in once.
	const stepKey =
		step === "features" ? `features-${props.featureStepIndex ?? 0}` : step;
	return (
		<OnboardingShell
			avatarGlyph={agentAvatarGlyph}
			liveSubtitle={progressStep}
			stepKey={stepKey}
			subtitle={headerSubtitle}
			title={headerTitle}
			width={step === "choose" ? "wide" : "form"}
		>
			{body}
		</OnboardingShell>
	);
}
