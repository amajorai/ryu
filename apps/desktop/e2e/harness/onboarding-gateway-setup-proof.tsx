import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
	type OnboardingSetupKind,
	OnboardingSetupStep,
} from "../../src/components/onboarding/OnboardingSetupStep.tsx";
import { TelegramOnboardingStep } from "../../src/components/onboarding/TelegramOnboardingStep.tsx";
import { EMPTY_AGENT_SELECTION } from "../../src/lib/api/preferences.ts";
import "../../src/index.css";

const target = { token: null, url: "http://127.0.0.1:7980" };

const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	if (url.endsWith("/api/channels/managed-bot/pair")) {
		return Response.json({
			deep_link: "https://t.me/ryu_manager?start=mb_proof",
			expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
			nonce: "proof",
		});
	}
	if (url.endsWith("/api/channels/managed-bot/proof/confirm")) {
		return Response.json({
			bot_id: 42,
			bot_username: "ryu_onboarding_bot",
			channel_id: "channel-proof",
			status: "ready",
		});
	}
	if (url.endsWith("/api/channels/managed-bot/proof")) {
		return Response.json({
			bot_id: 42,
			bot_username: "ryu_onboarding_bot",
			owner_telegram_user_id: 7,
			status: "confirm",
		});
	}
	return originalFetch(input, init);
};

function profileProps(onContinue: () => void) {
	return {
		agentSuggestions: [],
		agentSuggestionsError: null,
		agentSuggestionsSelected: new Set<string>(),
		agentSuggestionsSubmitting: false,
		allowedAgentIds: ["ryu"],
		alreadyBuilt: true,
		autoImport: true,
		cloudSelection: EMPTY_AGENT_SELECTION,
		connectingToolkit: null,
		connectionQuery: "",
		connections: [],
		connectionsCheckFailed: false,
		defaultProviderIds: [],
		freeCloud: false,
		importing: false,
		kind: "profile" as OnboardingSetupKind,
		localSelection: EMPTY_AGENT_SELECTION,
		onBackgroundProfile: () => undefined,
		onCancelProfile: () => undefined,
		onChooseOrganization: () => undefined,
		onCloudSelectionChange: () => undefined,
		onConfigureProvider: () => undefined,
		onConnectToolkit: () => undefined,
		onContinue,
		onContinueBackgroundProfile: onContinue,
		onCreateAgentSuggestions: () => undefined,
		onImportThreads: () => undefined,
		onLocalSelectionChange: () => undefined,
		onSearchConnections: () => undefined,
		onSkip: onContinue,
		onToggleAgentSuggestion: () => undefined,
		onToggleAutoImport: () => undefined,
		organizations: [],
		piProviders: [],
		profileJob: null,
		profileStartedAt: null,
		providerBusyId: null,
		selectedOrganizationId: null,
		target,
		threadGroups: [],
		toolkits: [],
	};
}

function Proof() {
	const [status, setStatus] = useState(
		"Waiting for the managed Telegram proof"
	);
	return (
		<main className="min-h-screen bg-background p-6 text-foreground">
			<div className="mx-auto max-w-[1500px]">
				<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
					Onboarding · React verification artifact
				</p>
				<h1 className="mt-3 font-semibold text-3xl">
					Gateway setup is duplicate-safe
				</h1>
				<p className="mt-2 max-w-3xl text-muted-foreground">
					Existing gateway state is surfaced before onboarding offers another
					mutation. The empty Telegram path uses the default Ryu agent.
				</p>
				<output
					aria-live="polite"
					className="mt-4 block rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm"
					data-testid="proof-status"
				>
					{status}
				</output>
				<div className="mt-6 grid gap-6 xl:grid-cols-3">
					<section
						className="min-h-[620px] rounded-2xl border border-border/70 bg-muted/10"
						data-testid="existing-channels-proof"
					>
						<TelegramOnboardingStep
							existingChannelCount={2}
							onContinue={() => setStatus("Existing channels preserved")}
							onSkip={() => setStatus("Existing channels preserved")}
							onUseTelegramLogin={() => undefined}
						/>
					</section>
					<section
						className="min-h-[620px] rounded-2xl border border-border/70 bg-muted/10"
						data-testid="new-telegram-proof"
					>
						<TelegramOnboardingStep
							existingChannelCount={0}
							onContinue={() => setStatus("Telegram setup complete")}
							onSkip={() => setStatus("Telegram setup skipped")}
							onUseTelegramLogin={() => undefined}
						/>
					</section>
					<section
						className="min-h-[620px] rounded-2xl border border-border/70 bg-muted/10"
						data-testid="profile-rebuild-proof"
					>
						<OnboardingSetupStep
							{...profileProps(() => setStatus("Profile rebuild selected"))}
						/>
					</section>
				</div>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(<Proof />);
