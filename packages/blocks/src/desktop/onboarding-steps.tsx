"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import { OnboardingActions, OnboardingCta } from "./onboarding-shell.tsx";
import type { OnboardingViewProps } from "./onboarding-types.ts";

// One feature per step: each optional feature gets its own screen explaining what
// it's for, with Enable / Not now. "Not now" hides that feature's sidebar section;
// either choice advances to the next feature (then the mic step).
export function FeatureStep({
	currentFeature,
	featureStepIndex,
	featureStepTotal,
	onEnableFeature,
	onSkipFeature,
}: Pick<
	OnboardingViewProps,
	| "currentFeature"
	| "featureStepIndex"
	| "featureStepTotal"
	| "onEnableFeature"
	| "onSkipFeature"
>) {
	const tl = useLiteralMessages();
	if (!currentFeature) {
		return null;
	}
	return (
		<>
			<div className="flex flex-col gap-1">
				{featureStepIndex && featureStepTotal ? (
					<p className="text-detail text-muted-foreground tabular-nums">
						{tl("Feature {featureStepIndex} of {featureStepTotal}", {
							featureStepIndex,
							featureStepTotal,
						})}
					</p>
				) : null}
				<p className="font-semibold text-sm">{currentFeature.name}</p>
				<p className="text-pretty text-muted-foreground text-sm">
					{currentFeature.description}
				</p>
			</div>

			<p className="text-detail text-muted-foreground">
				Turn it off and it's hidden from the sidebar. Turn it back on anytime in
				Settings → Features.
			</p>

			<OnboardingActions>
				<OnboardingCta onClick={onSkipFeature} tone="secondary">
					Not now
				</OnboardingCta>
				<OnboardingCta onClick={onEnableFeature}>Enable</OnboardingCta>
			</OnboardingActions>
		</>
	);
}

export function MicStep({
	micPrompt,
	micSubmitting,
	onSkipMic,
	onContinueMic,
}: Pick<
	OnboardingViewProps,
	"micPrompt" | "micSubmitting" | "onSkipMic" | "onContinueMic"
>) {
	return (
		<>
			<p className="text-muted-foreground text-sm">
				Ryu can listen when you want to talk to your agents. You can always
				change this later in Settings.
			</p>

			{micPrompt}

			<OnboardingActions>
				<OnboardingCta
					disabled={micSubmitting}
					onClick={onSkipMic}
					tone="secondary"
				>
					Skip
				</OnboardingCta>
				<OnboardingCta disabled={micSubmitting} onClick={onContinueMic}>
					{micSubmitting ? "Requesting…" : "Allow"}
				</OnboardingCta>
			</OnboardingActions>
		</>
	);
}
