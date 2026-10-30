import {
	type OnboardingStep,
	OnboardingView,
} from "@ryu/blocks/desktop/onboarding.tsx";
import { lazy, Suspense } from "react";
import { ColorStep } from "@/src/components/onboarding/ColorStep.tsx";
import { NotificationsStep } from "@/src/components/onboarding/NotificationsStep.tsx";
import { OnboardingGuidanceStep } from "@/src/components/onboarding/OnboardingGuidanceStep.tsx";
import { PreferencesStep } from "@/src/components/onboarding/PreferencesStep.tsx";
import { PrivacyStep } from "@/src/components/onboarding/PrivacyStep.tsx";
import { SafetyPostureStep } from "@/src/components/onboarding/SafetyPostureStep.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import { TOGGLEABLE_FEATURES } from "@/src/lib/features.ts";
import type { useOnboardingActivation } from "./OnboardingPage.activation.ts";
import { withAgentLogo } from "./OnboardingPage.agents.tsx";
import type { useOnboardingAgentsStep } from "./OnboardingPage.agents-step.ts";
import type { useOnboardingNodeChoice } from "./OnboardingPage.node-choice.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";
import type { useOnboardingSteps } from "./OnboardingPage.steps.ts";

// The activation steps are seen once, late in the flow: load them on demand.
const AcquisitionSourceStep = lazy(() =>
	import("@/src/components/onboarding/AcquisitionSourceStep.tsx").then(
		(module) => ({
			default: module.AcquisitionSourceStep,
		})
	)
);
const ActivationOfferStep = lazy(() =>
	import("@/src/components/onboarding/ActivationOfferStep.tsx").then(
		(module) => ({
			default: module.ActivationOfferStep,
		})
	)
);
const ActivationRecommendationsStep = lazy(() =>
	import("@/src/components/onboarding/ActivationRecommendationsStep.tsx").then(
		(module) => ({
			default: module.ActivationRecommendationsStep,
		})
	)
);
const ActivationTaskStep = lazy(() =>
	import("@/src/components/onboarding/ActivationTaskStep.tsx").then(
		(module) => ({
			default: module.ActivationTaskStep,
		})
	)
);
const ActivationValueStep = lazy(() =>
	import("@/src/components/onboarding/ActivationValueStep.tsx").then(
		(module) => ({
			default: module.ActivationValueStep,
		})
	)
);

type OnboardingPhaseInput = Pick<
	ReturnType<typeof useOnboardingSetupState>,
	| "activationBusySlug"
	| "activationCheckoutOpened"
	| "activationCheckoutPending"
	| "activationError"
	| "activationRecommendations"
	| "activationSourceError"
	| "activationTask"
	| "activationTaskPending"
	| "activationUsesOrganizationPlan"
	| "featureIndex"
	| "individualPlansEnabled"
	| "paidPlan"
	| "setActivationError"
	| "setActivationTaskSlug"
> &
	Pick<
		ReturnType<typeof useOnboardingFlowState>,
		| "agentsRetrying"
		| "agentsUnavailable"
		| "foundAgents"
		| "localChecking"
		| "localError"
		| "localPercent"
		| "localUnreachable"
		| "managedBusy"
		| "remoteChecking"
		| "remoteError"
		| "selected"
		| "submitting"
		| "suggestedAgents"
	> &
	Pick<
		ReturnType<typeof useOnboardingAgentsStep>,
		"applyFeatureChoice" | "handleRetryAgents"
	> &
	Pick<
		ReturnType<typeof useOnboardingActivation>,
		| "confirmActivationSubscription"
		| "continueActivationApps"
		| "continueActivationOffer"
		| "continueActivationValue"
		| "continueAfterPrivacy"
		| "continueWithOwnModel"
		| "enterActivationApps"
		| "handleActivationConnect"
		| "handleActivationSource"
		| "startActivationCheckout"
		| "startActivationTask"
	> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		| "entitlement"
		| "entitlementLoading"
		| "getActiveNode"
		| "isDesktop"
		| "onboardingPersona"
		| "phase"
		| "setPhase"
		| "stepUp"
	> &
	Pick<ReturnType<typeof useOnboardingNodeSetup>, "goToFeatures"> &
	Pick<
		ReturnType<typeof useOnboardingSteps>,
		| "goToGuidanceStep"
		| "goToNotificationsStep"
		| "goToPreferences"
		| "goToPrivacyStep"
		| "goToSafety"
		| "handleAllowMic"
		| "handleContinue"
		| "handleSkipMic"
		| "subtitle"
		| "title"
		| "toggle"
	> &
	Pick<
		ReturnType<typeof useOnboardingNodeChoice>,
		| "handleBackFromConnect"
		| "handleChooseLocal"
		| "handleChooseManaged"
		| "handleChooseRemote"
		| "handleConnectRemote"
		| "handleDownloadDesktop"
	>;

/** The desktop-only, activation, and shared-block phases. */
export function renderOnboardingPhase({
	activationBusySlug,
	activationCheckoutOpened,
	activationCheckoutPending,
	activationError,
	activationRecommendations,
	activationSourceError,
	activationTask,
	activationTaskPending,
	activationUsesOrganizationPlan,
	agentsRetrying,
	agentsUnavailable,
	applyFeatureChoice,
	confirmActivationSubscription,
	continueActivationApps,
	continueActivationOffer,
	continueActivationValue,
	continueAfterPrivacy,
	continueWithOwnModel,
	enterActivationApps,
	entitlement,
	entitlementLoading,
	featureIndex,
	foundAgents,
	getActiveNode,
	goToFeatures,
	goToGuidanceStep,
	goToNotificationsStep,
	goToPreferences,
	goToPrivacyStep,
	goToSafety,
	handleActivationConnect,
	handleActivationSource,
	handleAllowMic,
	handleBackFromConnect,
	handleChooseLocal,
	handleChooseManaged,
	handleChooseRemote,
	handleConnectRemote,
	handleContinue,
	handleDownloadDesktop,
	handleRetryAgents,
	handleSkipMic,
	individualPlansEnabled,
	isDesktop,
	localChecking,
	localError,
	localPercent,
	localUnreachable,
	managedBusy,
	onboardingPersona,
	paidPlan,
	phase,
	remoteChecking,
	remoteError,
	selected,
	setActivationError,
	setActivationTaskSlug,
	setPhase,
	startActivationCheckout,
	startActivationTask,
	stepUp,
	submitting,
	subtitle,
	suggestedAgents,
	title,
	toggle,
}: OnboardingPhaseInput) {
	// The theme/safety/preferences/final step are desktop-only (they drive the
	// desktop's own theme setters, appearance toggles, autostart registration,
	// and Core privacy prefs), so they render here rather than through the shared
	// block, whose `OnboardingStep` union has no member for them.
	if (phase === "theme") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<ColorStep busy={submitting} onContinue={goToSafety} />
			</div>
		);
	}
	if (phase === "safety") {
		const activeNode = getActiveNode();
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<SafetyPostureStep
					onContinue={goToPreferences}
					target={toTarget(activeNode)}
				/>
			</div>
		);
	}
	if (phase === "preferences") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<PreferencesStep busy={submitting} onContinue={goToGuidanceStep} />
			</div>
		);
	}
	if (phase === "guidance") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<OnboardingGuidanceStep onContinue={goToNotificationsStep} />
			</div>
		);
	}
	if (phase === "notifications") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<NotificationsStep busy={submitting} onContinue={goToPrivacyStep} />
			</div>
		);
	}
	if (phase === "privacy") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<PrivacyStep busy={submitting} onContinue={continueAfterPrivacy} />
			</div>
		);
	}
	if (phase === "activation-source") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<Suspense fallback={null}>
					<AcquisitionSourceStep
						busy={submitting}
						error={activationSourceError}
						onContinue={handleActivationSource}
						onSkip={enterActivationApps}
					/>
				</Suspense>
			</div>
		);
	}
	if (phase === "activation-apps") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<Suspense fallback={null}>
					<ActivationRecommendationsStep
						busySlug={activationBusySlug}
						error={activationError}
						onContinue={continueActivationApps}
						onPreview={(recommendation) => {
							setActivationTaskSlug(recommendation.appSlug);
							setActivationError(null);
							setPhase("activation-task");
						}}
						recommendations={activationRecommendations}
					/>
				</Suspense>
			</div>
		);
	}
	if (phase === "activation-value") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<Suspense fallback={null}>
					<ActivationValueStep
						onContinue={continueActivationValue}
						organizationPlan={activationUsesOrganizationPlan}
					/>
				</Suspense>
			</div>
		);
	}
	if (phase === "activation-offer") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<Suspense fallback={null}>
					<ActivationOfferStep
						checkoutOpened={activationCheckoutOpened}
						dialog={stepUp.dialog}
						error={activationError}
						individualPlansEnabled={individualPlansEnabled}
						onConfirmCheckout={confirmActivationSubscription}
						onContinue={continueActivationOffer}
						onSkip={continueWithOwnModel}
						onStartCheckout={() => {
							void startActivationCheckout();
						}}
						organizationPlan={activationUsesOrganizationPlan}
						pending={activationCheckoutPending}
						subscribed={paidPlan}
					/>
				</Suspense>
			</div>
		);
	}
	if (phase === "activation-task") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<Suspense fallback={null}>
					<ActivationTaskStep
						connected={activationRecommendations.some(
							(item) => item.appSlug === activationTask.appSlug && item.active
						)}
						draft={activationTask}
						error={activationError}
						onBack={enterActivationApps}
						onConnect={async (accessLevel) => {
							const recommendation = activationRecommendations.find(
								(item) => item.appSlug === activationTask.appSlug
							);
							if (recommendation) {
								await handleActivationConnect(recommendation, accessLevel);
							}
						}}
						onStart={() => {
							void startActivationTask();
						}}
						onUseOwnModel={continueWithOwnModel}
						pending={activationTaskPending || activationBusySlug !== null}
						subscribed={paidPlan}
					/>
				</Suspense>
			</div>
		);
	}
	return (
		<div className="size-full" data-tauri-drag-region="true">
			<OnboardingView
				agentAvatarGlyph={onboardingPersona.avatar}
				agents={foundAgents.map(withAgentLogo)}
				agentsRetrying={agentsRetrying}
				agentsUnavailable={agentsUnavailable}
				currentFeature={TOGGLEABLE_FEATURES[featureIndex]}
				featureStepIndex={featureIndex + 1}
				featureStepTotal={TOGGLEABLE_FEATURES.length}
				isDesktop={isDesktop}
				localChecking={localChecking}
				localError={localError}
				localUnreachable={localUnreachable}
				managedBusy={managedBusy}
				managedEntitled={Boolean(entitlement?.managedInference)}
				managedLoading={entitlementLoading}
				micSubmitting={submitting}
				onBackFromConnect={handleBackFromConnect}
				onChooseLocal={handleChooseLocal}
				onChooseManaged={handleChooseManaged}
				onChooseRemote={handleChooseRemote}
				onConnectRemote={handleConnectRemote}
				onContinueAgents={handleContinue}
				onContinueMic={handleAllowMic}
				onDownloadDesktop={handleDownloadDesktop}
				onEnableFeature={() => applyFeatureChoice(true)}
				onRetryAgents={handleRetryAgents}
				onSkipAgents={() => goToFeatures([])}
				onSkipFeature={() => applyFeatureChoice(false)}
				onSkipMic={handleSkipMic}
				onToggleAgent={toggle}
				progress={
					phase === "installing" ? (localPercent ?? undefined) : undefined
				}
				remoteChecking={remoteChecking}
				remoteError={remoteError}
				selected={selected}
				// Every phase without a shared-block step returned earlier, in
				// renderOnboardingSetupPhase or above; that narrowing does not cross
				// the function boundary.
				step={phase as OnboardingStep}
				subtitle={subtitle}
				suggestedAgents={suggestedAgents.map(withAgentLogo)}
				title={title}
			/>
		</div>
	);
}
