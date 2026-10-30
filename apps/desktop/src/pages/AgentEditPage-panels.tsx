import { AcpAgentSettingsPanel } from "@/src/components/agents/AcpAgentSettingsPanel.tsx";
import { AcpSessionControls } from "@/src/components/agents/AcpSessionControls.tsx";
import { AgentAccountAccessPanel } from "@/src/components/agents/AgentAccountAccessPanel.tsx";
import { AgentBudgetPanel } from "@/src/components/agents/AgentBudgetPanel.tsx";
import { AgentCalendarView } from "@/src/components/agents/AgentCalendarView.tsx";
import { AgentCapabilitiesPanel } from "@/src/components/agents/AgentCapabilitiesPanel.tsx";
import { AgentChannelsSection } from "@/src/components/agents/AgentChannelsSection.tsx";
import { AgentEmailAliasSection } from "@/src/components/agents/AgentEmailAliasSection.tsx";
import { AgentEvalsView } from "@/src/components/agents/AgentEvalsView.tsx";
import { AgentExecutionPolicyPanel } from "@/src/components/agents/AgentExecutionPolicyPanel.tsx";
import { AgentGoalPanel } from "@/src/components/agents/AgentGoalPanel.tsx";
import { AgentImageField } from "@/src/components/agents/AgentImageField.tsx";
import { AgentLanyardCard } from "@/src/components/agents/AgentLanyardCard.tsx";
import { MANAGED_PI_NOTE } from "@/src/components/agents/AgentLaunchWarning.tsx";
import { AgentRoutePoolEditor } from "@/src/components/agents/AgentRoutePoolEditor.tsx";
import { AgentSetupComposer } from "@/src/components/agents/AgentSetupComposer.tsx";
import { AgentSmartRouteOverride } from "@/src/components/agents/AgentSmartRouteOverride.tsx";
import { ClaudeGatewayConfig } from "@/src/components/agents/ClaudeGatewayConfig.tsx";
import { CodexGatewayConfig } from "@/src/components/agents/CodexGatewayConfig.tsx";
import { GatewayRoutingConfig } from "@/src/components/agents/GatewayRoutingConfig.tsx";
import { OrchestrationPanel } from "@/src/components/agents/OrchestrationPanel.tsx";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import { AgentLogo } from "@/src/lib/agent-logos.tsx";
import type { AgentEditContext } from "./AgentEditPage-context.ts";
import { ACP_CUSTOM_ENGINE } from "./AgentEditPage-options.ts";
import { agentPostureResources } from "./AgentEditPage-posture-resource.ts";

export function buildAgentEditPanels(ctx: AgentEditContext) {
	const {
		remotePeer,
		accountAccess,
		effectiveAgentId,
		isLocked,
		launchEngine,
		identityMode,
		simpleEditor,
		setAccountAccess,
		toggleIdentity,
		savedIdentityMode,
		selectedIdentities,
		isNew,
		chatModel,
		setAvatarGlyph,
		avatarGlyph,
		agents,
		launch,
		systemPrompt,
		agentModel,
		agentModelEngine,
		setChatModel,
		setSystemPrompt,
		setAgentModel,
		setAgentModelEngine,
		agentId,
		canCreateAgents,
		setCanCreateAgents,
		setOrchestrator,
		orchestrator,
		limitedLaunchRefusal,
		limitedRoutingNotice,
		isBuiltIn,
		description,
		name,
		activeNode,
		modelLabel,
		existing,
		target,
		postureLoadedScope,
		recordScope,
		lifecycleStatus,
		savePosture,
		postureError,
		retryPostureRead,
		postureEndpoint,
		postureSaving,
		posturePendingScope,
		safetyProfile,
	} = ctx;
	return {
		accountAccessPanel: remotePeer ? null : (
			<AgentAccountAccessPanel
				accountAccess={accountAccess}
				agentId={effectiveAgentId}
				disabled={isLocked}
				engine={launchEngine}
				identityMode={identityMode}
				launchNoticesShownElsewhere={simpleEditor}
				onAccountAccessChange={setAccountAccess}
				onToggleIdentity={toggleIdentity}
				savedIdentityMode={savedIdentityMode}
				selectedIdentities={selectedIdentities}
			/>
		),
		acpSessionPanel:
			!isNew && effectiveAgentId ? (
				<AcpSessionControls agentId={effectiveAgentId} />
			) : null,
		advancedInference: (
			<SettingsSection caption="Engine launch options and sampling defaults apply across agents.">
				<p className="text-muted-foreground text-sm leading-relaxed">
					Choose Store → Engines, select the runtime, then edit its Advanced
					configuration. Request-level overrides remain available to the chat
					caller.
				</p>
			</SettingsSection>
		),
		agentIcon: (
			<AgentImageField
				disabled={isLocked}
				fallback={<AgentLogo engine={chatModel} size="24px" />}
				onChange={setAvatarGlyph}
				value={avatarGlyph}
			/>
		),
		agentSetupComposer: (
			<AgentSetupComposer
				agents={agents}
				disabled={isLocked}
				engine={chatModel}
				engineNote={launch.check?.runsOnManagedPi ? MANAGED_PI_NOTE : null}
				identityMode={identityMode}
				instructions={systemPrompt}
				model={agentModel}
				modelEngine={agentModelEngine}
				onEngineChange={setChatModel}
				onInstructionsChange={setSystemPrompt}
				onModelChange={setAgentModel}
				onModelEngineChange={setAgentModelEngine}
			/>
		),
		budgetPanel:
			!isNew && effectiveAgentId ? (
				<AgentBudgetPanel agentId={effectiveAgentId} disabled={isLocked} />
			) : null,
		calendarPanel:
			isNew || !agentId ? null : <AgentCalendarView agentId={agentId} />,
		capabilitiesPanel: (
			<>
				{effectiveAgentId ? (
					<AgentCapabilitiesPanel
						agentId={effectiveAgentId}
						disabled={isLocked}
					/>
				) : null}
				{!isNew && effectiveAgentId && effectiveAgentId !== "ryu" ? (
					<AcpAgentSettingsPanel
						agentId={effectiveAgentId}
						disabled={isLocked}
						limitedOnManagedPi={launch.check?.runsOnManagedPi ?? false}
					/>
				) : null}
				<OrchestrationPanel
					canCreateAgents={canCreateAgents}
					disabled={isLocked}
					onChangeCanCreateAgents={setCanCreateAgents}
					onChangeOrchestrator={setOrchestrator}
					orchestrator={orchestrator}
				/>
			</>
		),
		channelsPanel: (
			<>
				<AgentChannelsSection agentId={effectiveAgentId} />
				<AgentEmailAliasSection agentId={isNew ? null : effectiveAgentId} />
			</>
		),
		claudeConfig:
			agentId === "acp:claude" ? (
				<ClaudeGatewayConfig limitedNotice={limitedLaunchRefusal} />
			) : null,
		codexConfig:
			agentId === "acp:codex" ? (
				<CodexGatewayConfig limitedNotice={limitedRoutingNotice} />
			) : null,
		employeeBadge: (
			<AgentLanyardCard
				builtIn={isBuiltIn}
				description={description}
				engine={chatModel}
				name={name}
				node={activeNode.name}
				role={modelLabel}
				version={existing?.version ?? "1.0.0"}
			/>
		),
		evalsPanel: isNew ? null : (
			<AgentEvalsView
				agentId={agentId ?? null}
				defaultModel={agentModel}
				target={target}
			/>
		),
		executionPolicyPanel: (
			<AgentExecutionPolicyPanel
				disabled={
					isLocked || (!isNew && postureLoadedScope.current !== recordScope)
				}
				isNew={isNew}
				lifecycleStatus={lifecycleStatus}
				onLifecycleStatusChange={(status) =>
					savePosture({ lifecycleStatus: status })
				}
				onPostureRetry={
					postureError?.scope === recordScope && postureError.readRetry
						? retryPostureRead
						: undefined
				}
				onSafetyProfileChange={(profile) =>
					savePosture({ safetyProfile: profile })
				}
				postureError={
					postureError?.scope === recordScope ? postureError.message : null
				}
				postureSaving={
					Boolean(
						postureEndpoint &&
							agentPostureResources.get(postureEndpoint)?.pending
					) ||
					(postureSaving && posturePendingScope.current === recordScope)
				}
				safetyProfile={safetyProfile}
			/>
		),
		gatewayRoutingConfig:
			!isNew && agentId ? (
				<div className="flex flex-col gap-6">
					{chatModel === ACP_CUSTOM_ENGINE ? (
						<GatewayRoutingConfig
							agentId={agentId}
							limitedNotice={limitedRoutingNotice}
						/>
					) : null}
					<AgentSmartRouteOverride agentId={agentId} />
					<AgentRoutePoolEditor agentId={agentId} />
				</div>
			) : null,
		goalPanel:
			isNew || !effectiveAgentId ? null : (
				<AgentGoalPanel
					agentId={effectiveAgentId}
					disabled={isLocked}
					target={target}
				/>
			),
	};
}
