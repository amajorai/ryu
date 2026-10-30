import type { NativeThread } from "@/src/lib/api/agent-threads.ts";
import type { AgentIdentityMode } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type {
	ComposioConnection,
	ComposioToolkit,
} from "@/src/lib/api/composio.ts";
import type {
	NodeSetupKind,
	OnboardingAgentSuggestion,
	ProfileJobStatus,
} from "@/src/lib/api/onboarding-profile.ts";
import type { PiProvider } from "@/src/lib/api/pi-config.ts";
import type { AgentSelection } from "@/src/lib/api/preferences.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";

export type OnboardingSetupKind =
	| "local-default"
	| "organization"
	| "providers"
	| "connections"
	| "cloud-default"
	| "imports"
	| "migrate"
	| "profile"
	| "agent-suggestions";

export interface OnboardingOrganization {
	id: string;
	isPersonal: boolean;
	logo: string | null;
	name: string;
	role: string | null;
	slug: string;
}

export interface OnboardingThreadGroup {
	agentId: string;
	agentName: string;
	threads: NativeThread[];
}

export interface OnboardingSetupStepProps {
	agentSuggestions: OnboardingAgentSuggestion[];
	agentSuggestionsError: string | null;
	/** The identity mode chosen per suggestion id; a missing one acts as you. */
	agentSuggestionsIdentityModes: ReadonlyMap<string, AgentIdentityMode>;
	agentSuggestionsReviewed: ReadonlySet<string>;
	agentSuggestionsSelected: ReadonlySet<string>;
	agentSuggestionsSubmitting: boolean;
	allowedAgentIds: readonly string[];
	allowedProviderIds?: readonly string[];
	alreadyBuilt: boolean | null;
	autoImport: boolean;
	/** A parent setup save is pending; selection controls must remain locked. */
	busy?: boolean;
	cloudSelection: AgentSelection;
	connectingToolkit: string | null;
	connectionQuery: string;
	connections: ComposioConnection[];
	connectionsCheckFailed: boolean;
	defaultProviderIds: readonly string[];
	freeCloud: boolean;
	importing: boolean;
	kind: OnboardingSetupKind;
	laneSaveError?: string | null;
	localSelection: AgentSelection;
	nodeSetupKind: NodeSetupKind | null;
	onAgentSuggestionIdentityModeChange: (
		id: string,
		mode: AgentIdentityMode
	) => void;
	onBackgroundProfile: () => void;
	onCancelProfile: () => void;
	onChooseOrganization: (organizationId: string) => void;
	onCloudSelectionChange: (selection: AgentSelection) => void;
	onConfigureProvider: (providerId: string, apiKey: string) => void;
	onConnectToolkit: (
		toolkit: ComposioToolkit,
		accessLevel: ConnectionAccessLevel
	) => Promise<void>;
	onContinue: () => void;
	onContinueBackgroundProfile: () => void;
	onCreateAgentSuggestions: () => void;
	onImportThreads: () => void;
	onLocalSelectionChange: (selection: AgentSelection) => void;
	onProviderConnected?: () => void;
	onReviewAgentSuggestion: (id: string, reviewed: boolean) => void;
	onSearchConnections: (query: string) => void;
	onSkip: () => void;
	onToggleAgentSuggestion: (id: string) => void;
	onToggleAutoImport: (enabled: boolean) => void;
	organizations: OnboardingOrganization[];
	piProviders: PiProvider[];
	profileJob: ProfileJobStatus | null;
	profileStartedAt: number | null;
	providerBusyId: string | null;
	selectedOrganizationId: string | null;
	target: ApiTarget;
	threadGroups: OnboardingThreadGroup[];
	toolkits: ComposioToolkit[];
}
