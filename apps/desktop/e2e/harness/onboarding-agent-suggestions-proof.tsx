import { Button } from "@ryu/ui/components/button";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OnboardingSetupStep } from "@/src/components/onboarding/OnboardingSetupStep.tsx";
import type { OnboardingAgentSuggestion } from "@/src/lib/api/onboarding-profile.ts";
import { EMPTY_AGENT_SELECTION } from "@/src/lib/api/preferences.ts";
import "../../src/index.css";

const suggestions: OnboardingAgentSuggestion[] = [
	{
		description:
			"Keeps release checks together and turns them into a short brief.",
		id: "agent-suggestion-release-desk",
		name: "Release Desk",
		reason:
			"Release verification appeared repeatedly in your recent imported sessions.",
		systemPrompt:
			"Help me verify releases with an evidence-backed checklist. Ask before any external change.",
		title: "Release engineer",
		tools: ["search_conversations.search", "web.search", "routines.create"],
	},
	{
		description: "Turns recurring inbox work into a reviewable daily queue.",
		id: "agent-suggestion-inbox-triage",
		name: "Inbox Triage",
		reason:
			"Inbox sorting and follow-up questions were a recurring pattern in the sources you approved.",
		systemPrompt:
			"Organize incoming work into a concise queue, identify missing context, and ask before sending or changing anything.",
		title: "Operations assistant",
		tools: [
			"search_conversations.search",
			"memory.search",
			"workspace.open_tab",
		],
	},
];

const baseProps = {
	allowedAgentIds: ["ryu"],
	allowedProviderIds: ["local"],
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
	organizations: [],
	piProviders: [],
	profileJob: null,
	profileStartedAt: null,
	providerBusyId: null,
	selectedOrganizationId: null,
	target: { token: null, url: "http://127.0.0.1:7980", userJwt: null },
	threadGroups: [],
	toolkits: [],
};

function ProofApp() {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [added, setAdded] = useState<string[]>([]);
	const [skipped, setSkipped] = useState(false);

	const toggle = (id: string) => {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	return (
		<main className="relative h-screen bg-background text-foreground">
			<OnboardingSetupStep
				{...baseProps}
				agentSuggestions={suggestions}
				agentSuggestionsError={null}
				agentSuggestionsSelected={selected}
				agentSuggestionsSubmitting={false}
				kind="agent-suggestions"
				onBackgroundProfile={() => undefined}
				onCancelProfile={() => undefined}
				onChooseOrganization={() => undefined}
				onCloudSelectionChange={() => undefined}
				onConfigureProvider={() => undefined}
				onConnectToolkit={async () => undefined}
				onContinue={() => undefined}
				onCreateAgentSuggestions={() => {
					setAdded(
						suggestions
							.filter((suggestion) => selected.has(suggestion.id))
							.map((suggestion) => suggestion.name)
					);
				}}
				onImportThreads={() => undefined}
				onLocalSelectionChange={() => undefined}
				onSearchConnections={() => undefined}
				onSkip={() => setSkipped(true)}
				onToggleAgentSuggestion={toggle}
				onToggleAutoImport={() => undefined}
			/>

			{added.length > 0 ? (
				<div
					className="fixed top-4 right-4 z-10 max-w-sm rounded-xl border border-success/30 bg-background/95 px-4 py-3 shadow-lg backdrop-blur"
					data-testid="agent-suggestion-success"
				>
					<p className="font-medium text-sm">Added to your agent group</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{added.join(", ")} · Trial · read-only
					</p>
				</div>
			) : null}
			{skipped ? (
				<div className="fixed bottom-4 left-1/2 z-10 -translate-x-1/2">
					<Button
						data-testid="agent-suggestion-skipped"
						onClick={() => setSkipped(false)}
					>
						Review suggestions again
					</Button>
				</div>
			) : null}
		</main>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<ProofApp />);
