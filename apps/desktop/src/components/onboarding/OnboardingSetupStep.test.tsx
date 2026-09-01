import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_AGENT_SELECTION } from "@/src/lib/api/preferences.ts";
import { OnboardingSetupStep } from "./OnboardingSetupStep.tsx";

const baseProps = {
	agentSuggestions: [],
	agentSuggestionsError: null,
	agentSuggestionsSelected: new Set<string>(),
	agentSuggestionsSubmitting: false,
	allowedAgentIds: ["ryu"],
	alreadyBuilt: false,
	autoImport: true,
	cloudSelection: EMPTY_AGENT_SELECTION,
	connectingToolkit: null,
	connectionQuery: "",
	connections: [],
	connectionsCheckFailed: false,
	defaultProviderIds: [],
	freeCloud: false,
	importing: false,
	localSelection: EMPTY_AGENT_SELECTION,
	onBackgroundProfile: () => undefined,
	onCancelProfile: () => undefined,
	onChooseOrganization: () => undefined,
	onCloudSelectionChange: () => undefined,
	onConfigureProvider: () => undefined,
	onConnectToolkit: async () => undefined,
	onContinue: () => undefined,
	onContinueBackgroundProfile: () => undefined,
	onCreateAgentSuggestions: () => undefined,
	onImportThreads: () => undefined,
	onLocalSelectionChange: () => undefined,
	onSearchConnections: () => undefined,
	onSkip: () => undefined,
	onToggleAgentSuggestion: () => undefined,
	onToggleAutoImport: () => undefined,
	organizations: [],
	piProviders: [],
	profileStartedAt: Date.now() - 30_000,
	providerBusyId: null,
	selectedOrganizationId: null,
	target: { token: null, url: "http://127.0.0.1:7980", userJwt: null },
	threadGroups: [],
	toolkits: [],
};

describe("desktop onboarding profile handoff", () => {
	test("keeps a materialized background build on the profile screen", () => {
		const html = renderToStaticMarkup(
			<OnboardingSetupStep
				{...baseProps}
				kind="profile"
				profileJob={{
					agentSuggestions: [],
					conversationId: "profile-1",
					error: null,
					id: "job-1",
					materialized: true,
					startedAtMs: Date.now() - 30_000,
					state: "building",
				}}
			/>
		);

		expect(html).toContain("Continue setup");
		expect(html).toContain("Wait here to review agent drafts");
		expect(html).not.toContain("Open profile chat later");
	});
});
