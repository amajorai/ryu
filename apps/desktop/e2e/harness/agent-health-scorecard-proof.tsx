import { Button } from "@ryu/ui/components/button.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	AgentSettingsForm,
	type AgentSettingsFormProps,
} from "../../../../packages/blocks/src/desktop/agent-edit.tsx";
import {
	ScorecardBadge,
	ScorecardPanel,
} from "../../../../packages/marketplace/src/catalog/detail/scorecard-panel.tsx";
import {
	type AgentHealthInput,
	runAgentScorecard,
} from "../../../../packages/marketplace/src/catalog/scorecard.ts";
import "../../src/index.css";

const BASE_INPUT: AgentHealthInput = {
	access: {
		composioActionCount: 1,
		highImpactCount: 2,
		identityProfileCount: 0,
	},
	automation: { scheduleEnabled: true, triggerCount: 0 },
	description: "Reviews release changes and prepares a careful handoff.",
	instructions:
		"Review release changes, explain the risk, and ask before sending any external update.",
	lifecycleStatus: "active",
	memoryWriteEnabled: true,
	model: { configured: true, required: true },
	name: "Release desk",
	runtime: { label: "Ryu", status: "ready" },
	safetyProfile: "autonomous",
	skills: {
		allSelected: false,
		availableCount: 3,
		loaded: true,
		selectedCount: 1,
	},
	tools: {
		allSelected: true,
		availableCount: 6,
		loaded: true,
		selectedCount: 6,
	},
};

const EDITOR_PROPS: AgentSettingsFormProps = {
	acpCommand: "",
	chatModel: "acp:ryu",
	composioActions: [],
	composioConfigured: false,
	composioToolkit: null,
	composioToolkitItems: [],
	composioTriggers: [],
	connectedAccountId: "",
	customCron: "",
	customTone: "",
	dailyTime: "09:00",
	employeeBadge: (
		<div className="flex h-full items-center justify-center p-4">
			<div className="rounded-lg border border-white/20 bg-background/70 px-3 py-2 text-center text-white shadow-xl backdrop-blur">
				<p className="font-semibold text-xs">Release desk</p>
				<p className="mt-1 text-[10px] text-white/70">AGENT</p>
			</div>
		</div>
	),
	engineOptions: [{ id: "acp:ryu", label: "Ryu" }],
	isBuiltIn: false,
	isLocked: false,
	isNew: false,
	memoryReadLevels: new Set(),
	memorySpaceIds: new Set(),
	memoryWriteEnabled: true,
	name: "Release desk",
	personaDisplayName: "",
	rules: [],
	scheduleEnabled: true,
	schedulePhrase: "daily",
	selectedComposio: new Set(["release.create_update"]),
	selectedSkills: new Set(["release-review"]),
	selectedTools: new Set([
		"files.read",
		"files.write",
		"web.search",
		"code.execute",
		"release.create",
		"release.delete",
	]),
	skills: [
		{
			description: "Review release changes.",
			enabled: true,
			id: "release-review",
			name: "Release review",
		},
		{
			description: "Summarize handoffs.",
			enabled: true,
			id: "handoff",
			name: "Handoff summary",
		},
		{
			description: "Inspect project context.",
			enabled: true,
			id: "project-context",
			name: "Project context",
		},
	],
	spaces: [],
	systemPrompt:
		"Review release changes, explain the risk, and ask before sending any external update.",
	tone: "neutral",
	toneOptions: [{ label: "Neutral", value: "neutral" }],
	tools: [
		"files.read",
		"files.write",
		"web.search",
		"code.execute",
		"release.create",
		"release.delete",
	],
	triggerError: null,
	triggerSlug: "",
	triggerSubs: [],
	weeklyDay: "monday",
	weeklyTime: "09:00",
};

function AgentHealthScorecardProof() {
	const [guarded, setGuarded] = useState(false);
	const input = useMemo<AgentHealthInput>(
		() => ({
			...BASE_INPUT,
			safetyProfile: guarded ? "approval_required" : "autonomous",
		}),
		[guarded]
	);
	const scorecard = useMemo(() => runAgentScorecard(input), [input]);

	return (
		<main className="min-h-screen bg-background px-4 py-8 text-foreground sm:px-8">
			<div className="mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex flex-col gap-3">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.2em]">
						Production editor proof
					</p>
					<h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
						Agent health scorecard in the editor
					</h1>
					<p className="max-w-2xl text-muted-foreground text-sm leading-relaxed">
						The Health tab is a live, read-only review of the same configuration
						shown in the editor. Warnings guide review; they never replace Core
						or Gateway enforcement.
					</p>
				</header>

				<section className="rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
					<div className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-muted/30 p-4">
						<div>
							<h2 className="font-medium text-sm">Live editor state</h2>
							<p className="mt-1 text-muted-foreground text-xs">
								Autonomous access starts with a review warning.
							</p>
						</div>
						<label
							className="flex items-center gap-3 text-sm"
							htmlFor="guarded-access"
						>
							<span>Require approval for high-impact access</span>
							<Switch
								checked={guarded}
								id="guarded-access"
								onCheckedChange={setGuarded}
							/>
						</label>
					</div>

					<AgentSettingsForm
						{...EDITOR_PROPS}
						healthBadge={
							<div data-testid="health-grade">
								<ScorecardBadge scorecard={scorecard} />
							</div>
						}
						healthPanel={
							<ScorecardPanel
								dataTestId="agent-health-scorecard"
								disclaimer={
									<p className="text-muted-foreground text-xs leading-relaxed">
										This scorecard is a configuration review. It does not
										execute the agent or guarantee a provider, runtime binary,
										or model will answer.
									</p>
								}
								rulesetLabel="Agent ruleset"
								scorecard={scorecard}
								title="Agent health"
							/>
						}
						initialTab="health"
					/>
				</section>

				<div className="flex items-center justify-between gap-3 text-muted-foreground text-xs">
					<span data-testid="proof-status">PRODUCTION EDITOR</span>
					<Button
						onClick={() => setGuarded((value) => !value)}
						size="sm"
						variant="ghost"
					>
						Toggle guardrails
					</Button>
				</div>
			</div>
		</main>
	);
}

createRoot(document.getElementById("root") as HTMLElement).render(
	<AgentHealthScorecardProof />
);
