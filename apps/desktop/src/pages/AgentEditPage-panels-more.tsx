import {
	ScorecardBadge,
	ScorecardPanel,
} from "@ryu/marketplace/catalog/detail/scorecard-panel";
import {
	AgentIdentityModePicker,
	AgentRemotePeerIdentityNote,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import {
	AgentLaunchWarning,
	agentModelsLimited,
	RYU_ENGINE_ID,
} from "@/src/components/agents/AgentLaunchWarning.tsx";
import { AgentObservabilityView } from "@/src/components/agents/AgentObservabilityView.tsx";
import { AgentOptimizationsView } from "@/src/components/agents/AgentOptimizationsView.tsx";
import { AgentPassportPanel } from "@/src/components/agents/AgentPassportPanel.tsx";
import { AgentPendingIdentityModeNotice } from "@/src/components/agents/AgentPendingIdentityModeNotice.tsx";
import { AgentRoutinesPanel } from "@/src/components/agents/AgentRoutinesPanel.tsx";
import { AgentRunHistoryView } from "@/src/components/agents/AgentRunHistoryView.tsx";
import { AgentVersionHistoryPanel } from "@/src/components/agents/AgentVersionHistoryPanel.tsx";
import { RulesAgentEditPanel } from "@/src/components/agents/RulesAgentEditPanel.tsx";
import { RyuPiConfig } from "@/src/components/agents/RyuPiConfig.tsx";
import { PromptStudio } from "@/src/components/PromptStudio.tsx";
import { runCatalogScan } from "@/src/lib/api/catalog-scan.ts";
import type { AgentEditContext } from "./AgentEditPage-context.ts";
import { IntegrationsPanel } from "./AgentEditPage-integrations-panel.tsx";

export function buildAgentEditMorePanels(ctx: AgentEditContext) {
	const {
		agentHealthScorecard,
		target,
		agentId,
		name,
		description,
		agentHealthInput,
		openTab,
		isNew,
		remotePeer,
		pendingIdentityMode,
		existing,
		dismissingPendingMode,
		savingScope,
		isLocked,
		setIdentityMode,
		keepCurrentIdentityMode,
		identityMode,
		identityModeWarning,
		launch,
		launchEngine,
		accountAccess,
		isBuiltIn,
		setChatModel,
		setAgentModel,
		setAgentModelEngine,
		agentModel,
		reloadAfterOptimization,
		effectiveAgentId,
		activeNode,
		chatModel,
		setSystemPrompt,
		systemPrompt,
		agentEditPanels,
		rules,
		projectCwd,
		agentVersionSource,
		currentAgentVersionValue,
		handleAgentVersionRestored,
	} = ctx;
	return {
		healthBadge: <ScorecardBadge scorecard={agentHealthScorecard} />,
		healthPanel: (
			<ScorecardPanel
				agentScan={() =>
					runCatalogScan(target, {
						kind: "agent",
						id: agentId || "draft",
						name: name.trim() || "Untitled agent",
						description,
						metadata: { configuration: agentHealthInput },
						scorecard: agentHealthScorecard,
					})
				}
				dataTestId="agent-health-scorecard"
				disclaimer={
					<p className="text-muted-foreground text-xs leading-relaxed">
						These checks update as you edit the agent. They inspect its
						configuration only; they do not run the agent or replace Core and
						Gateway authorization.
					</p>
				}
				key={JSON.stringify([target.url, agentId, agentHealthInput])}
				onOpenConversation={(conversationId) =>
					openTab("/chat", { conversationId })
				}
				rulesetLabel="Agent ruleset"
				scorecard={agentHealthScorecard}
				title="Agent health"
			/>
		),
		historyPanel:
			isNew || !agentId ? null : <AgentRunHistoryView agentId={agentId} />,
		identityModePanel: remotePeer ? (
			<AgentRemotePeerIdentityNote />
		) : (
			<div className="flex flex-col gap-3">
				{pendingIdentityMode && existing ? (
					<AgentPendingIdentityModeNotice
						busy={dismissingPendingMode || savingScope !== null}
						disabled={isLocked}
						keptMode={existing.identityMode}
						onAccept={setIdentityMode}
						onKeepCurrent={() => void keepCurrentIdentityMode()}
						pendingMode={pendingIdentityMode}
						selectedMode={identityMode}
					/>
				) : null}
				<AgentIdentityModePicker
					disabled={isLocked}
					onChange={setIdentityMode}
					value={identityMode}
				/>
				{identityModeWarning ? (
					<p
						className="px-3.5 text-status-warning text-xs leading-snug"
						role="status"
					>
						{identityModeWarning}
					</p>
				) : null}
				<AgentLaunchWarning
					check={launch.check}
					disabled={isLocked}
					engine={launchEngine}
					modelsLimited={agentModelsLimited(identityMode, accountAccess)}
					onUseRyu={
						isBuiltIn
							? undefined
							: () => {
									setChatModel(RYU_ENGINE_ID);
									setAgentModel("");
									setAgentModelEngine(null);
								}
					}
				/>
			</div>
		),
		integrationsPanel:
			isNew || !agentId ? null : (
				<IntegrationsPanel agentId={agentId} target={target} />
			),
		observabilityPanel:
			isNew || !agentId ? null : (
				<AgentObservabilityView
					agentId={agentId}
					defaultModel={agentModel}
					onOpenRun={(conversationId) => openTab("/chat", { conversationId })}
					target={target}
				/>
			),
		optimizationsPanel:
			isNew || !agentId ? null : (
				<AgentOptimizationsView
					agentId={agentId}
					disabled={isLocked}
					onApplied={reloadAfterOptimization}
					target={target}
				/>
			),
		passportPanel:
			isNew || !effectiveAgentId || !existing ? null : (
				<AgentPassportPanel
					agent={existing}
					organizationId={activeNode.orgId ?? null}
					target={target}
				/>
			),
		piConfig: agentId === "ryu" ? <RyuPiConfig /> : null,
		promptStudioPanel: isNew ? null : (
			<PromptStudio
				agentId={agentId ?? null}
				engine={chatModel}
				locked={isLocked}
				model={agentModel}
				onChange={setSystemPrompt}
				target={target}
				value={systemPrompt}
				version={existing?.version ?? "1.0.0"}
			/>
		),
		routinesPanel:
			isNew || !agentId ? null : (
				<AgentRoutinesPanel agentId={agentId} disabled={isLocked} />
			),
		rulesPanel:
			effectiveAgentId && agentEditPanels.length > 0
				? agentEditPanels.map((panel) => (
						<RulesAgentEditPanel
							agentId={effectiveAgentId}
							key={`${panel.plugin}:${panel.id}`}
							legacyRules={rules}
							locked={isLocked}
							prefKeyPrefix={panel.pref_key_prefix}
							projectCwd={projectCwd}
							target={target}
							title={panel.title}
						/>
					))
				: null,
		versionHistoryPanel: agentVersionSource ? (
			<AgentVersionHistoryPanel
				currentValue={currentAgentVersionValue}
				disabled={isLocked}
				onRestored={handleAgentVersionRestored}
				source={agentVersionSource}
			/>
		) : null,
	};
}
