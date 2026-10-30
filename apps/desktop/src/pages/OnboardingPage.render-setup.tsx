import { OnboardingView } from "@ryu/blocks/desktop/onboarding.tsx";
import {
	OnboardingActions,
	OnboardingCta,
	OnboardingShell,
} from "@ryu/blocks/desktop/onboarding-shell.tsx";
import { lazy, Suspense } from "react";
import { WEB_URL } from "@/lib/app-urls.ts";
import { getActiveUserId } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { FirstProjectStep } from "@/src/components/onboarding/FirstProjectStep.tsx";
import { NodePersonalizationStep } from "@/src/components/onboarding/NodePersonalizationStep.tsx";
import { OnboardingSetupStep } from "@/src/components/onboarding/OnboardingSetupStep.tsx";
import { RyuPersonalizationStep } from "@/src/components/onboarding/RyuPersonalizationStep.tsx";
import { UpdateStep } from "@/src/components/onboarding/UpdateStep.tsx";
import { WelcomeStep } from "@/src/components/onboarding/WelcomeStep.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import { phaseAfterIntro } from "@/src/lib/desktop-onboarding-state.ts";
import { markFirstProjectSkipped } from "@/src/lib/first-project.ts";
import {
	bindOnboardingProjectTarget,
	clearOnboardingProjectPointer,
	persistAcknowledgedOnboardingProject,
	sameOnboardingProjectBinding,
} from "@/src/lib/onboarding-project-persistence.ts";
import { isTauriReady } from "@/src/lib/tauri-ready.ts";
import type { useOnboardingAgentsStep } from "./OnboardingPage.agents-step.ts";
import { PHASE_SUBTITLES, PHASE_TITLES } from "./OnboardingPage.copy.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingProfileFlow } from "./OnboardingPage.profile.ts";
import type { useOnboardingSetupState } from "./OnboardingPage.setup-state.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";
import type { useOnboardingSteps } from "./OnboardingPage.steps.ts";
import type { useOnboardingWorkspace } from "./OnboardingPage.workspace.ts";

// The welcome's prism and the Telegram step are heavy and seen once; load them
// only when their phase is reached.
const OnboardingPrismLayer = lazy(() =>
	import("@/src/components/onboarding/OnboardingPrismBackground.tsx").then(
		(module) => ({ default: module.OnboardingPrismLayer })
	)
);
const TelegramOnboardingStep = lazy(() =>
	import("@/src/components/onboarding/TelegramOnboardingStep.tsx").then(
		(module) => ({ default: module.TelegramOnboardingStep })
	)
);

type OnboardingSetupPhaseInput = Pick<
	ReturnType<typeof useOnboardingSetupState>,
	| "agentSuggestionIdentityModes"
	| "agentSuggestions"
	| "agentSuggestionsError"
	| "agentSuggestionsSubmitting"
	| "autoImport"
	| "channelConfigs"
	| "configuredProviderIds"
	| "connectingToolkit"
	| "connectionQuery"
	| "connections"
	| "connectionsCheckFailed"
	| "freeCloud"
	| "importing"
	| "organizations"
	| "paidPlan"
	| "piProviders"
	| "profileAlreadyBuilt"
	| "profileJob"
	| "profileStartedAt"
	| "providerBusyId"
	| "reviewedAgentSuggestions"
	| "selectedAgentSuggestions"
	| "selectedOrganizationId"
	| "setAutoImport"
	| "setConnectionQuery"
	| "setSelectedOrganizationId"
	| "threadGroups"
	| "toolkits"
> &
	Pick<
		ReturnType<typeof useOnboardingFlowState>,
		| "agentsNode"
		| "allowedAgentIds"
		| "cloudSelection"
		| "companyContext"
		| "laneSaveError"
		| "localSelection"
		| "nodeSetupError"
		| "nodeSetupKind"
		| "onboardingSkills"
		| "selectedSkillPackIds"
		| "setCloudSelection"
		| "setLocalSelection"
		| "skillsError"
		| "skillsLoading"
		| "skillsSubmitting"
		| "submitting"
		| "userPersonalization"
	> &
	Pick<
		ReturnType<typeof useOnboardingProfileFlow>,
		| "backgroundOnboardingProfile"
		| "cancelOnboardingProfile"
		| "continueAfterImports"
		| "continueAfterNode"
		| "continueAfterProfile"
		| "createOnboardingAgents"
		| "goToTelegram"
		| "importOnboardingThreads"
		| "reviewAgentSuggestion"
		| "setAgentSuggestionIdentityMode"
		| "skipCloudDefault"
		| "startOnboardingProfile"
		| "toggleAgentSuggestion"
	> &
	Pick<
		ReturnType<typeof useOnboardingSteps>,
		| "clearAllSkillPacks"
		| "coreFailed"
		| "handleContinueSkills"
		| "handleRestart"
		| "retryOnboardingSkills"
		| "selectAllSkillPacks"
		| "toggleSkillPack"
	> &
	Pick<
		ReturnType<typeof useOnboardingWorkspace>,
		| "configureOnboardingProvider"
		| "connectOnboardingToolkit"
		| "continueCloudDefault"
		| "continueConnections"
		| "continueLocalDefault"
		| "continueOrganization"
		| "continueProviders"
		| "loadProviderCatalog"
	> &
	Pick<
		ReturnType<typeof useOnboardingAgentsStep>,
		"continueToAgents" | "continueToFirstProject"
	> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		| "getActiveNode"
		| "nodeOnboardingState"
		| "onboardingPersona"
		| "phase"
		| "setPhase"
	> &
	Pick<ReturnType<typeof useOnboardingNodeSetup>, "handleNodeSetupContinue">;

/** The core-failure screen and the setup phases; undefined for every other phase. */
export function renderOnboardingSetupPhase({
	agentSuggestionIdentityModes,
	agentSuggestions,
	agentSuggestionsError,
	agentSuggestionsSubmitting,
	agentsNode,
	allowedAgentIds,
	autoImport,
	backgroundOnboardingProfile,
	cancelOnboardingProfile,
	channelConfigs,
	clearAllSkillPacks,
	cloudSelection,
	companyContext,
	configureOnboardingProvider,
	configuredProviderIds,
	connectOnboardingToolkit,
	connectingToolkit,
	connectionQuery,
	connections,
	connectionsCheckFailed,
	continueAfterImports,
	continueAfterNode,
	continueAfterProfile,
	continueCloudDefault,
	continueConnections,
	continueLocalDefault,
	continueOrganization,
	continueProviders,
	continueToAgents,
	continueToFirstProject,
	coreFailed,
	createOnboardingAgents,
	freeCloud,
	getActiveNode,
	goToTelegram,
	handleContinueSkills,
	handleNodeSetupContinue,
	handleRestart,
	importOnboardingThreads,
	importing,
	laneSaveError,
	loadProviderCatalog,
	localSelection,
	nodeOnboardingState,
	nodeSetupError,
	nodeSetupKind,
	onboardingPersona,
	onboardingSkills,
	organizations,
	paidPlan,
	phase,
	piProviders,
	profileAlreadyBuilt,
	profileJob,
	profileStartedAt,
	providerBusyId,
	retryOnboardingSkills,
	reviewAgentSuggestion,
	reviewedAgentSuggestions,
	selectAllSkillPacks,
	selectedAgentSuggestions,
	selectedOrganizationId,
	selectedSkillPackIds,
	setAgentSuggestionIdentityMode,
	setAutoImport,
	setCloudSelection,
	setConnectionQuery,
	setLocalSelection,
	setPhase,
	setSelectedOrganizationId,
	skillsError,
	skillsLoading,
	skillsSubmitting,
	skipCloudDefault,
	startOnboardingProfile,
	submitting,
	threadGroups,
	toggleAgentSuggestion,
	toggleSkillPack,
	toolkits,
	userPersonalization,
}: OnboardingSetupPhaseInput) {
	if (coreFailed) {
		return (
			<OnboardingShell
				subtitle="Something stopped Ryu from starting up. Restarting the app usually fixes it."
				title="Couldn't start Ryu"
			>
				<OnboardingActions className="justify-center">
					<OnboardingCta onClick={handleRestart}>Restart Ryu</OnboardingCta>
				</OnboardingActions>
			</OnboardingShell>
		);
	}
	const setupTarget = toTarget(getActiveNode());
	// A plain function, not useCallback: this render helper returns early on
	// `coreFailed` above, so a hook here would change OnboardingPage's hook count.
	const refreshOnboardingProviderCatalog = () => {
		void loadProviderCatalog(toTarget(getActiveNode()));
	};
	const setupProviderIds = paidPlan
		? Array.from(new Set([...configuredProviderIds, "managed-openrouter"]))
		: configuredProviderIds;
	const setupProps = {
		busy: submitting,
		laneSaveError,
		allowedAgentIds,
		agentSuggestions,
		agentSuggestionsError,
		agentSuggestionsIdentityModes: agentSuggestionIdentityModes,
		agentSuggestionsReviewed: reviewedAgentSuggestions,
		agentSuggestionsSelected: selectedAgentSuggestions,
		agentSuggestionsSubmitting,
		allowedProviderIds:
			phase === "local-default" ? ["local"] : setupProviderIds,
		autoImport,
		alreadyBuilt: profileAlreadyBuilt,
		cloudSelection,
		connections,
		connectionQuery,
		connectionsCheckFailed,
		connectingToolkit,
		defaultProviderIds: configuredProviderIds,
		freeCloud,
		importing,
		localSelection,
		organizations,
		piProviders,
		nodeSetupKind,
		profileJob,
		profileStartedAt,
		providerBusyId,
		selectedOrganizationId,
		target: setupTarget,
		threadGroups,
		toolkits,
		onBackgroundProfile: backgroundOnboardingProfile,
		onCancelProfile: cancelOnboardingProfile,
		onCreateAgentSuggestions: () => {
			void createOnboardingAgents();
		},
		onChooseOrganization: setSelectedOrganizationId,
		onConfigureProvider: configureOnboardingProvider,
		onProviderConnected: refreshOnboardingProviderCatalog,
		onConnectToolkit: connectOnboardingToolkit,
		onContinue:
			phase === "local-default"
				? continueLocalDefault
				: phase === "organization"
					? continueOrganization
					: phase === "providers"
						? continueProviders
						: phase === "connections"
							? continueConnections
							: phase === "cloud-default"
								? continueCloudDefault
								: phase === "imports"
									? importOnboardingThreads
									: phase === "migrate"
										? continueToFirstProject
										: startOnboardingProfile,
		onImportThreads: importOnboardingThreads,
		onContinueBackgroundProfile: goToTelegram,
		onLocalSelectionChange: setLocalSelection,
		onCloudSelectionChange: setCloudSelection,
		onSearchConnections: setConnectionQuery,
		onSkip:
			phase === "cloud-default"
				? skipCloudDefault
				: phase === "imports"
					? continueAfterImports
					: phase === "migrate"
						? continueToFirstProject
						: phase === "profile"
							? continueAfterProfile
							: goToTelegram,
		onToggleAutoImport: setAutoImport,
		onToggleAgentSuggestion: toggleAgentSuggestion,
		onReviewAgentSuggestion: reviewAgentSuggestion,
		onAgentSuggestionIdentityModeChange: setAgentSuggestionIdentityMode,
	};
	if (phase === "intro") {
		return (
			<div
				className="relative isolate size-full overflow-hidden"
				data-tauri-drag-region="true"
			>
				<Suspense fallback={null}>
					<OnboardingPrismLayer />
				</Suspense>
				<div className="relative z-10 size-full">
					<WelcomeStep
						onContinue={() => setPhase(phaseAfterIntro(isTauriReady()))}
					/>
				</div>
			</div>
		);
	}
	if (phase === "updates") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<UpdateStep onContinue={() => setPhase("choose")} />
			</div>
		);
	}
	if (phase === "personalize-agent") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<RyuPersonalizationStep
					onContinue={continueToFirstProject}
					onSkip={continueToFirstProject}
					target={toTarget(agentsNode ?? getActiveNode())}
				/>
			</div>
		);
	}
	if (phase === "first-project") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<FirstProjectStep
					onCreated={async (project, binding) => {
						const current = await bindOnboardingProjectTarget(
							toTarget(getActiveNode()),
							getActiveUserId()
						);
						if (!sameOnboardingProjectBinding(binding, current)) {
							throw new Error(
								"The active node or account changed. Return to the project owner's node and account, then retry continuation."
							);
						}
						persistAcknowledgedOnboardingProject(project, binding);
						continueToAgents();
					}}
					onSkip={() => {
						clearOnboardingProjectPointer();
						markFirstProjectSkipped();
						continueToAgents();
					}}
					target={toTarget(agentsNode ?? getActiveNode())}
				/>
			</div>
		);
	}
	if (phase === "skills") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<OnboardingView
					agentAvatarGlyph={onboardingPersona.avatar}
					onClearAllSkillPacks={clearAllSkillPacks}
					onContinueSkillPacks={() => {
						void handleContinueSkills();
					}}
					onRetrySkillPacks={retryOnboardingSkills}
					onSelectAllSkillPacks={selectAllSkillPacks}
					onToggleSkillPack={toggleSkillPack}
					selectedSkillPackIds={selectedSkillPackIds}
					skillPacks={onboardingSkills?.options}
					skillPacksCanConfigure={onboardingSkills?.canConfigure ?? true}
					skillPacksError={skillsError}
					skillPacksLoading={skillsLoading}
					skillPacksSubmitting={skillsSubmitting}
					step="skills"
					subtitle={PHASE_SUBTITLES.get("skills")}
					title={PHASE_TITLES.get("skills")!}
				/>
			</div>
		);
	}
	if (phase === "node-setup") {
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<NodePersonalizationStep
					busy={submitting}
					canConfigure={nodeOnboardingState?.canConfigure ?? true}
					companyContext={companyContext}
					error={nodeSetupError}
					initialPersonalization={userPersonalization}
					initialSetupKind={nodeSetupKind}
					onContinue={handleNodeSetupContinue}
				/>
			</div>
		);
	}
	if (
		phase === "local-default" ||
		phase === "organization" ||
		phase === "providers" ||
		phase === "connections" ||
		phase === "cloud-default" ||
		phase === "imports" ||
		phase === "migrate" ||
		phase === "profile" ||
		phase === "agent-suggestions"
	) {
		return (
			<fieldset
				aria-busy={submitting}
				className="size-full min-w-0"
				data-tauri-drag-region="true"
				disabled={submitting}
			>
				<OnboardingSetupStep {...setupProps} kind={phase} />
			</fieldset>
		);
	}
	if (phase === "telegram") {
		const openTelegramLogin = () => {
			void openExternal(`${WEB_URL}/telegram/connect`).catch(() => undefined);
		};
		return (
			<div className="size-full" data-tauri-drag-region="true">
				<Suspense fallback={null}>
					<TelegramOnboardingStep
						existingChannelCount={channelConfigs?.length ?? null}
						onContinue={continueAfterNode}
						onSkip={continueAfterNode}
						onUseTelegramLogin={openTelegramLogin}
					/>
				</Suspense>
			</div>
		);
	}
}
