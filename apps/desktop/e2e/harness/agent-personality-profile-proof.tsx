import {
	AgentSettingsForm,
	type SlotOption,
	type ToneOptionItem,
} from "@ryu/blocks/desktop/agent-edit.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsCard } from "../../src/components/settings/shared/settings-items.tsx";
import "../../src/index.css";

const AGENT_OWN_VOICE_PROFILE = "__agent_own_voice__";

const personalityProfiles: SlotOption[] = [
	{ id: AGENT_OWN_VOICE_PROFILE, label: "Agent's own voice" },
	{ id: "eli5", label: "ELI5" },
	{ id: "proactive", label: "Proactive" },
	{ id: "concise", label: "Concise" },
	{ id: "explanatory", label: "Explanatory" },
	{ id: "learning", label: "Learning" },
	{ id: "plain-technical", label: "Plain Technical" },
	{ id: "no-ai-slop", label: "No AI slop" },
	{ id: "no-hype", label: "No Hype" },
];

const toneOptions: ToneOptionItem[] = [
	{ value: "neutral", label: "Neutral (default)" },
	{ value: "professional", label: "Professional" },
	{ value: "friendly", label: "Friendly" },
	{ value: "pirate", label: "Pirate" },
	{ value: "custom", label: "Custom" },
];

function profileLabel(id: string | null): string {
	return (
		personalityProfiles.find((profile) => profile.id === id)?.label ??
		"Agent's own voice"
	);
}

function noop(): void {}

function AgentPersonalityProfileProof() {
	const [profile, setProfile] = useState(AGENT_OWN_VOICE_PROFILE);
	const [savedProfile, setSavedProfile] = useState<string | null>(null);

	const save = () => {
		setSavedProfile(profile === AGENT_OWN_VOICE_PROFILE ? null : profile);
	};

	return (
		<main className="min-h-screen bg-background px-6 py-10 text-foreground">
			<div className="mx-auto max-w-5xl">
				<header className="mb-7">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-section">
						Production component proof
					</p>
					<div className="mt-2 flex flex-wrap items-center gap-3">
						<h1 className="font-semibold text-3xl tracking-tight">
							Agent personality profiles
						</h1>
						<Badge variant="secondary">Per agent</Badge>
					</div>
					<p className="mt-3 max-w-2xl text-muted-foreground">
						Each agent can keep its own voice or use a reusable profile
						contributed by a plugin or authored in the user's style folder.
					</p>
				</header>

				<div className="mb-5 grid gap-3 sm:grid-cols-[1fr_auto]">
					<SettingsCard className="flex items-center gap-3">
						<div className="flex size-10 items-center justify-center rounded-2xl bg-primary/10 font-semibold text-primary">
							AG
						</div>
						<div className="min-w-0">
							<p className="font-medium">Research guide</p>
							<p className="text-muted-foreground text-sm">
								The selected profile is stored on this agent card.
							</p>
						</div>
					</SettingsCard>
					<SettingsCard className="flex min-w-56 flex-col justify-center gap-1">
						<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
							Saved on agent
						</span>
						<strong data-testid="saved-profile">
							{profileLabel(savedProfile ?? profile)}
						</strong>
					</SettingsCard>
				</div>

				<section className="rounded-3xl border bg-card p-4 shadow-sm sm:p-6">
					<AgentSettingsForm
						acpCommand=""
						agentIcon={<span className="text-primary">AG</span>}
						agentTitle="Research assistant"
						chatModel="acp:pi"
						composioActions={[]}
						composioConfigured={false}
						composioToolkit={null}
						composioToolkitItems={[]}
						composioTriggers={[]}
						connectedAccountId=""
						customCron=""
						customTone=""
						dailyTime="09:00"
						description="A focused research assistant."
						engineOptions={[{ id: "acp:pi", label: "Ryu" }]}
						formError={null}
						instructionsEditor={
							<textarea
								aria-label="Agent instructions"
								className="min-h-32 w-full resize-y bg-card p-3 text-sm"
								readOnly
								value="Research carefully and cite the source of each important claim."
							/>
						}
						isBuiltIn={false}
						isLocked={false}
						isNew={false}
						memoryReadLevels={new Set()}
						memorySpaceIds={new Set()}
						memoryWriteEnabled={false}
						name="Research guide"
						onMemoryWriteEnabledChange={noop}
						onNameChange={noop}
						onPersonaDisplayNameChange={noop}
						onPersonalityProfileChange={setProfile}
						onSave={save}
						onToneChange={noop}
						personaDisplayName="Ari"
						personalityProfile={profile}
						personalityProfiles={personalityProfiles}
						rules={[]}
						schedulePhrase="daily"
						selectedComposio={new Set()}
						selectedSkills={new Set()}
						selectedTools={new Set()}
						skills={[]}
						spaces={[]}
						systemPrompt="Research carefully and cite the source of each important claim."
						tone="neutral"
						toneOptions={toneOptions}
						tools={[]}
						triggerSlug=""
						triggerSubs={[]}
						weeklyDay="monday"
						weeklyTime="09:00"
					/>
				</section>

				<p className="mt-4 text-muted-foreground text-xs">
					The Store provides profiles; assignment is an agent-level setting.
				</p>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root")!).render(
	<AgentPersonalityProfileProof />
);
