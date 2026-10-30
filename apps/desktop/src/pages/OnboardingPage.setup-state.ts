import { INDIVIDUAL_PLANS_FLAG } from "@ryu/auth/lib/feature-flags";
import { useCallback, useMemo, useRef, useState } from "react";
import type {
	OnboardingOrganization,
	OnboardingThreadGroup,
} from "@/src/components/onboarding/OnboardingSetupStep.tsx";
import { useAutoImportThreads } from "@/src/hooks/useAutoImportThreads.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import type { ChannelConfig } from "@/src/lib/api/channels.ts";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import type {
	fetchGatewayOnboardingAccess,
	OnboardingAgentSuggestion,
	ProfileJobStatus,
} from "@/src/lib/api/onboarding-profile.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import {
	type ActivationRecommendation,
	buildActivationTaskDraft,
	deriveActivationEligibility,
} from "@/src/lib/onboarding-activation.ts";
import { sleep } from "./OnboardingPage.local-stack.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";

type OnboardingSetupStateInput = Pick<
	ReturnType<typeof useOnboardingPhase>,
	"entitlement" | "entitlementLoading"
>;

/** Workspace, connection, profile, agent-suggestion, and activation state. */
export function useOnboardingSetupState({
	entitlement,
	entitlementLoading,
}: OnboardingSetupStateInput) {
	const [organizations, setOrganizations] = useState<OnboardingOrganization[]>(
		[]
	);
	const [selectedOrganizationId, setSelectedOrganizationId] = useState<
		string | null
	>(null);
	const [piProviders, setPiProviders] = useState<PiProvider[]>([]);
	const [configuredProviderIds, setConfiguredProviderIds] = useState<string[]>(
		[]
	);
	const [providerBusyId, setProviderBusyId] = useState<string | null>(null);
	const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
	const [connections, setConnections] = useState<ComposioConnection[]>([]);
	const [channelConfigs, setChannelConfigs] = useState<ChannelConfig[] | null>(
		null
	);
	const [connectionsCheckFailed, setConnectionsCheckFailed] = useState(false);
	const [gatewaySetupAllowed, setGatewaySetupAllowed] = useState(true);
	const [gatewayAccess, setGatewayAccess] = useState<Awaited<
		ReturnType<typeof fetchGatewayOnboardingAccess>
	> | null>(null);
	const [connectionQuery, setConnectionQuery] = useState("");
	const [connectingToolkit, setConnectingToolkit] = useState<string | null>(
		null
	);
	const [threadGroups, setThreadGroups] = useState<OnboardingThreadGroup[]>([]);
	const [importing, setImporting] = useState(false);
	const [importedConversationIds, setImportedConversationIds] = useState<
		string[]
	>([]);
	const [profileJob, setProfileJob] = useState<ProfileJobStatus | null>(null);
	const [profileAlreadyBuilt, setProfileAlreadyBuilt] = useState<
		boolean | null
	>(null);
	const [profileStartedAt, setProfileStartedAt] = useState<number | null>(null);
	const [agentSuggestions, setAgentSuggestions] = useState<
		OnboardingAgentSuggestion[]
	>([]);
	const [selectedAgentSuggestions, setSelectedAgentSuggestions] = useState<
		Set<string>
	>(new Set());
	const [reviewedAgentSuggestions, setReviewedAgentSuggestions] = useState<
		Set<string>
	>(new Set());
	// How each suggested agent will work, by suggestion id; a missing entry
	// acts as you (`suggestionIdentityMode`).
	const [agentSuggestionIdentityModes, setAgentSuggestionIdentityModes] =
		useState<ReadonlyMap<string, AgentIdentityMode>>(new Map());
	const [agentSuggestionsSubmitting, setAgentSuggestionsSubmitting] =
		useState(false);
	const [agentSuggestionsError, setAgentSuggestionsError] = useState<
		string | null
	>(null);
	const [autoImport, setAutoImport] = useAutoImportThreads();
	const [activationSourceError, setActivationSourceError] = useState<
		string | null
	>(null);
	const [activationError, setActivationError] = useState<string | null>(null);
	const [activationRecommendations, setActivationRecommendations] = useState<
		ActivationRecommendation[]
	>([]);
	const [activationTaskSlug, setActivationTaskSlug] = useState<string | null>(
		null
	);
	const [activationBusySlug, setActivationBusySlug] = useState<string | null>(
		null
	);
	const [activationCheckoutPending, setActivationCheckoutPending] =
		useState(false);
	const [activationCheckoutOpened, setActivationCheckoutOpened] =
		useState(false);
	const [activationTaskPending, setActivationTaskPending] = useState(false);
	// Which feature the one-feature-per-step wizard is currently showing.
	const [featureIndex, setFeatureIndex] = useState(0);
	const paidPlan = Boolean(entitlement?.managedInference);
	const individualPlansEnabled = useFeatureFlag(INDIVIDUAL_PLANS_FLAG);
	const freeCloud = !paidPlan;
	const selectedOrganization = organizations.find(
		(organization) => organization.id === selectedOrganizationId
	);
	const ownerOrAdmin = ["owner", "admin"].includes(
		(selectedOrganization?.role ?? "").toLowerCase()
	);
	const activationEligibility = useMemo(
		() => deriveActivationEligibility({ gateway: gatewayAccess, ownerOrAdmin }),
		[gatewayAccess, ownerOrAdmin]
	);
	const activationTask = useMemo(
		() =>
			buildActivationTaskDraft(
				activationTaskSlug
					? activationRecommendations.filter(
							(item) => item.appSlug === activationTaskSlug
						)
					: activationRecommendations
			),
		[activationRecommendations, activationTaskSlug]
	);
	// The activation offer follows the workspace selected during onboarding. A
	// personal workspace must never be shown the five-seat Teams price or sent to
	// the organization checkout route; an organization workspace uses the Teams
	// seat offer. When no workspace has been selected yet, the safe default is the
	// one-person Pro offer.
	const activationUsesOrganizationPlan = Boolean(
		selectedOrganization && !selectedOrganization.isPersonal
	);
	const entitlementStateRef = useRef({
		loading: entitlementLoading,
		paid: paidPlan,
	});
	entitlementStateRef.current = {
		loading: entitlementLoading,
		paid: paidPlan,
	};
	const waitForPaidPlan = useCallback(async () => {
		const deadline = Date.now() + 15_000;
		while (entitlementStateRef.current.loading && Date.now() < deadline) {
			await sleep(100);
		}
		return entitlementStateRef.current.paid;
	}, []);
	return {
		activationBusySlug,
		activationCheckoutOpened,
		activationCheckoutPending,
		activationEligibility,
		activationError,
		activationRecommendations,
		activationSourceError,
		activationTask,
		activationTaskPending,
		activationUsesOrganizationPlan,
		agentSuggestionIdentityModes,
		agentSuggestions,
		agentSuggestionsError,
		agentSuggestionsSubmitting,
		autoImport,
		channelConfigs,
		configuredProviderIds,
		connectingToolkit,
		connectionQuery,
		connections,
		connectionsCheckFailed,
		entitlementStateRef,
		featureIndex,
		freeCloud,
		gatewaySetupAllowed,
		importedConversationIds,
		importing,
		individualPlansEnabled,
		organizations,
		paidPlan,
		piProviders,
		profileAlreadyBuilt,
		profileJob,
		profileStartedAt,
		providerBusyId,
		reviewedAgentSuggestions,
		selectedAgentSuggestions,
		selectedOrganizationId,
		setActivationBusySlug,
		setActivationCheckoutOpened,
		setActivationCheckoutPending,
		setActivationError,
		setActivationRecommendations,
		setActivationSourceError,
		setActivationTaskPending,
		setActivationTaskSlug,
		setAgentSuggestionIdentityModes,
		setAgentSuggestions,
		setAgentSuggestionsError,
		setAgentSuggestionsSubmitting,
		setAutoImport,
		setChannelConfigs,
		setConfiguredProviderIds,
		setConnectingToolkit,
		setConnectionQuery,
		setConnections,
		setConnectionsCheckFailed,
		setFeatureIndex,
		setGatewayAccess,
		setGatewaySetupAllowed,
		setImportedConversationIds,
		setImporting,
		setOrganizations,
		setPiProviders,
		setProfileAlreadyBuilt,
		setProfileJob,
		setProfileStartedAt,
		setProviderBusyId,
		setReviewedAgentSuggestions,
		setSelectedAgentSuggestions,
		setSelectedOrganizationId,
		setThreadGroups,
		setToolkits,
		threadGroups,
		toolkits,
		waitForPaidPlan,
	};
}
