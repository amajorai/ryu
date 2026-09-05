import { Button } from "@ryu/ui/components/button";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { sileo } from "sileo";
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
	connections: [
		{
			accessLevel: "risk_based",
			active: true,
			id: "gmail-1",
			status: "ACTIVE",
			toolkit: "gmail",
		},
		{
			accessLevel: "risk_based",
			active: true,
			id: "notion-1",
			status: "ACTIVE",
			toolkit: "notion",
		},
	],
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
	toolkits: [
		{ description: "Inbox", logo: null, name: "Gmail", slug: "gmail" },
		{ description: "Knowledge", logo: null, name: "Notion", slug: "notion" },
	],
};

function ProofApp() {
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [reviewed, setReviewed] = useState<Set<string>>(new Set());
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
				agentSuggestionsReviewed={reviewed}
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
					const added = suggestions
						.filter((suggestion) => selected.has(suggestion.id))
						.map((suggestion) => suggestion.name);
					if (added.length === 0) {
						return;
					}
					sileo.success({
						description:
							added.length === 1
								? `${added[0]} is ready for your next task.`
								: `${added.join(", ")} are ready for your next task.`,
						id: "agent-suggestions-proof",
						title: added.length === 1 ? "Agent added" : "Agents added",
					});
				}}
				onImportThreads={() => undefined}
				onLocalSelectionChange={() => undefined}
				onReviewAgentSuggestion={(id, next) => {
					setReviewed((current) => {
						const updated = new Set(current);
						if (next) {
							updated.add(id);
						} else {
							updated.delete(id);
						}
						return updated;
					});
				}}
				onSearchConnections={() => undefined}
				onSkip={() => setSkipped(true)}
				onToggleAgentSuggestion={toggle}
				onToggleAutoImport={() => undefined}
			/>

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
			<Toaster position="bottom-right" theme="system" />
		</main>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<ProofApp />);
