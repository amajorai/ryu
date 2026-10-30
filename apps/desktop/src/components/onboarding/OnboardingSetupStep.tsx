import { lazy, Suspense } from "react";
import {
	ConnectionSetup,
	connectedAppDetails,
} from "./OnboardingSetupStep.connections.tsx";
import {
	ImportSetup,
	LanePicker,
	OrganizationPicker,
	Shell,
} from "./OnboardingSetupStep.parts.tsx";
import { ProfileSetup } from "./OnboardingSetupStep.profile.tsx";
import { ProviderSetup } from "./OnboardingSetupStep.providers.tsx";
import type { OnboardingSetupStepProps } from "./OnboardingSetupStep.types.ts";

// Migration and agent suggestions are heavy and optional: load them on demand.
const AgentSuggestionsStep = lazy(() =>
	import("@/src/components/onboarding/AgentSuggestionsStep.tsx").then(
		(module) => ({ default: module.AgentSuggestionsStep })
	)
);
const MigrationSetup = lazy(() =>
	import("@/src/components/onboarding/MigrationSetup.tsx").then((module) => ({
		default: module.MigrationSetup,
	}))
);

export type {
	OnboardingOrganization,
	OnboardingSetupKind,
	OnboardingThreadGroup,
} from "./OnboardingSetupStep.types.ts";

export function OnboardingSetupStep(props: OnboardingSetupStepProps) {
	const { kind } = props;
	if (kind === "local-default") {
		return (
			<Shell
				subtitle="Choose the local default used by plugins and utility work. Ryu starts with Gemma 4."
				title="Set your local default"
			>
				<LanePicker
					allowedAgentIds={props.allowedAgentIds}
					busy={props.busy}
					cloud={false}
					error={props.laneSaveError}
					onChange={props.onLocalSelectionChange}
					onContinue={props.onContinue}
					selection={props.localSelection}
					target={props.target}
				/>
			</Shell>
		);
	}
	if (kind === "organization") {
		return (
			<Shell
				subtitle="Choose the workspace Ryu should open with. You can switch organizations later."
				title="Choose your organization"
			>
				<OrganizationPicker
					onChoose={props.onChooseOrganization}
					onContinue={props.onContinue}
					organizations={props.organizations}
					selectedOrganizationId={props.selectedOrganizationId}
				/>
			</Shell>
		);
	}
	if (kind === "providers") {
		return (
			<Shell
				subtitle="Connect a provider only if you want cloud chats on the free plan. You can add more later."
				title="Configure provider keys"
			>
				<ProviderSetup
					busyId={props.providerBusyId}
					defaultProviderIds={props.defaultProviderIds}
					freeCloud={props.freeCloud}
					onConfigure={props.onConfigureProvider}
					onContinue={props.onContinue}
					onProviderConnected={props.onProviderConnected ?? (() => undefined)}
					providers={props.piProviders}
				/>
			</Shell>
		);
	}
	if (kind === "connections") {
		return (
			<Shell
				subtitle="Connect Gmail, Notion, Slack, GitHub, or another Composio source. You can connect more later."
				title="Connect your accounts"
			>
				<ConnectionSetup
					connectingToolkit={props.connectingToolkit}
					connections={props.connections}
					connectionsCheckFailed={props.connectionsCheckFailed}
					onConnect={props.onConnectToolkit}
					onContinue={props.onContinue}
					onQuery={props.onSearchConnections}
					query={props.connectionQuery}
					toolkits={props.toolkits}
				/>
			</Shell>
		);
	}
	if (kind === "cloud-default") {
		return (
			<Shell
				subtitle={
					props.freeCloud
						? "Choose a configured BYOK provider, or keep cloud unset and use local chats."
						: "Paid plans start with Ryu on managed OpenRouter. You can choose another configured provider."
				}
				title="Set your cloud default"
			>
				<LanePicker
					allowedAgentIds={props.allowedAgentIds}
					allowedProviderIds={props.allowedProviderIds}
					busy={props.busy}
					cloud
					error={props.laneSaveError}
					onChange={props.onCloudSelectionChange}
					onContinue={props.onContinue}
					onSkip={props.freeCloud ? props.onSkip : undefined}
					selection={props.cloudSelection}
					target={props.target}
				/>
			</Shell>
		);
	}
	if (kind === "imports") {
		return (
			<Shell
				subtitle="Bring existing agent sessions into Ryu as searchable conversations."
				title="Import existing threads"
			>
				<ImportSetup
					autoImport={props.autoImport}
					busy={props.busy}
					groups={props.threadGroups}
					importing={props.importing}
					onImport={props.onImportThreads}
					onSkip={props.onSkip}
					onToggle={props.onToggleAutoImport}
				/>
			</Shell>
		);
	}
	if (kind === "migrate") {
		return (
			<Shell
				subtitle="Bring your chats, agents, memory, and skills with you."
				title="Coming from another agent?"
			>
				<Suspense fallback={null}>
					<MigrationSetup
						onContinue={props.onContinue}
						onSkip={props.onSkip}
						target={props.target}
					/>
				</Suspense>
			</Shell>
		);
	}
	if (kind === "agent-suggestions") {
		return (
			<Shell
				subtitle="Review each draft's prompt and tools, then confirm the helpers you want to add."
				title="Suggested agents for your work"
			>
				<Suspense fallback={null}>
					<AgentSuggestionsStep
						busy={props.agentSuggestionsSubmitting}
						connectedApps={connectedAppDetails(
							props.connections,
							props.toolkits
						)}
						error={props.agentSuggestionsError}
						identityModes={props.agentSuggestionsIdentityModes}
						onCreate={props.onCreateAgentSuggestions}
						onIdentityModeChange={props.onAgentSuggestionIdentityModeChange}
						onReview={props.onReviewAgentSuggestion}
						onSkip={props.onSkip}
						onToggle={props.onToggleAgentSuggestion}
						reviewed={props.agentSuggestionsReviewed}
						selected={props.agentSuggestionsSelected}
						suggestions={props.agentSuggestions}
					/>
				</Suspense>
			</Shell>
		);
	}
	return (
		<Shell
			subtitle={
				props.nodeSetupKind === "team"
					? "Build shared company knowledge from approved sources without changing external accounts or agents."
					: "Build a private starting profile without changing your accounts or agents."
			}
			title={
				props.nodeSetupKind === "team"
					? "Build shared company knowledge"
					: "Build your private profile"
			}
		>
			<ProfileSetup
				alreadyBuilt={props.alreadyBuilt}
				job={props.profileJob}
				nodeSetupKind={props.nodeSetupKind}
				onBackground={props.onBackgroundProfile}
				onCancel={props.onCancelProfile}
				onContinueAfterBackground={props.onContinueBackgroundProfile}
				onSkip={props.onSkip}
				onStart={props.onContinue}
				startedAt={props.profileStartedAt}
			/>
		</Shell>
	);
}
