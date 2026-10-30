import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type AgentHealthInput,
	runAgentScorecard,
} from "@ryu/marketplace/catalog/scorecard";
import { useMemo } from "react";
import {
	identityModeAccountWarning,
	isRemotePeerEngine,
} from "@/src/components/agents/AgentIdentityModePicker.tsx";
import { agentIsConfined } from "@/src/components/agents/AgentLaunchWarning.tsx";
import { pausedTriggerIds } from "@/src/components/agents/agent-account-keys.ts";
import { useAgentLaunchCheck } from "@/src/hooks/useAgentLaunchCheck.ts";
import { updateAgentAccountSettings } from "@/src/lib/api/agents.ts";
import type { AgentEditBase } from "./AgentEditPage-base.ts";
import type { AgentEditComposio } from "./AgentEditPage-composio.ts";
import type { AgentEditFormState } from "./AgentEditPage-form-state.ts";
import type { AgentEditHydrate } from "./AgentEditPage-hydrate.ts";
import type { AgentEditLoaders } from "./AgentEditPage-loaders.ts";
import {
	ACP_CUSTOM_ENGINE,
	ACP_EXEC_PREFIX,
	isHighImpactTool,
	scheduleSummary,
	toneLabel,
} from "./AgentEditPage-options.ts";
import type { AgentEditPostureActions } from "./AgentEditPage-posture-actions.ts";
import type { AgentEditSave } from "./AgentEditPage-save.ts";
import type { AgentEditVersions } from "./AgentEditPage-versions.tsx";

export type AgentEditHealth = ReturnType<typeof useAgentEditHealth>;

export function useAgentEditHealth(
	ctx: AgentEditBase &
		AgentEditFormState &
		AgentEditComposio &
		AgentEditLoaders &
		AgentEditHydrate &
		AgentEditSave &
		AgentEditPostureActions &
		AgentEditVersions
) {
	const {
		agentToolsData,
		availableTools,
		existing,
		installedAgentEngineOptions,
		chatModel,
		tone,
		customTone,
		scheduleEnabled,
		schedulePhrase,
		dailyTime,
		weeklyDay,
		weeklyTime,
		selectedTools,
		availableSkills,
		selectedUninstalledAgent,
		acpCommand,
		identityMode,
		accountAccess,
		triggerSubs,
		agentId,
		dismissingPendingMode,
		activeRecordScope,
		setDismissingPendingMode,
		target,
		editorMounted,
		setIdentityMode,
		setExisting,
		setFormError,
		selectedIdentities,
		effectiveAgentId,
		selectedComposio,
		memoryWriteEnabled,
		description,
		systemPrompt,
		lifecycleStatus,
		agentModel,
		name,
		safetyProfile,
		selectedSkills,
		skillsLoading,
		toolsLoading,
	} = ctx;
	// Merge MCP tools from the loaded agent record with the available tools list
	// so tools already on the agent show up even if the MCP endpoint returned empty.
	const mcpToolNames = agentToolsData?.mcp.map((t) => t.name) ?? [];
	const mergedTools = Array.from(
		new Set([...availableTools, ...mcpToolNames, ...(existing?.tools ?? [])])
	);

	const tl = useLiteralMessages();
	// Live-preview derivations — kept side-effect-free so the card mirrors the form.
	const modelLabel =
		installedAgentEngineOptions.find((e) => e.id === chatModel)?.label ??
		(chatModel || null);
	const toneLabelValue = toneLabel(tone, customTone);
	const scheduleSummaryValue = scheduleSummary(
		scheduleEnabled,
		schedulePhrase,
		dailyTime,
		weeklyDay,
		weeklyTime,
		tl
	);
	const selectedToolsList = Array.from(selectedTools);
	const enabledSkillCount = availableSkills.filter(
		(skill) => skill.enabled
	).length;
	const runtimeStatus: AgentHealthInput["runtime"]["status"] = chatModel
		? selectedUninstalledAgent
			? "unavailable"
			: chatModel === ACP_CUSTOM_ENGINE
				? acpCommand.trim()
					? "custom"
					: "missing"
				: "ready"
		: "missing";
	// Event triggers whose events Core would skip under the identity and
	// account access on screen (the same check it makes on every event). Each
	// is marked paused; the ones that fire today are counted in the warning.
	const pausedTriggers = new Set(
		pausedTriggerIds(identityMode, accountAccess, triggerSubs)
	);
	const savedPausedTriggers = existing
		? new Set(
				pausedTriggerIds(
					existing.identityMode,
					existing.accountAccess,
					triggerSubs
				)
			)
		: pausedTriggers;
	const stoppingTriggerCount = [...pausedTriggers].filter(
		(id) => !savedPausedTriggers.has(id)
	).length;
	const triggerRows = triggerSubs.map((sub) => ({
		...sub,
		paused: pausedTriggers.has(sub.id),
	}));
	// Shown under the Identity cards when the chosen mode switches off accounts
	// that are selected right now, or stops triggers that fire today. The
	// selection is kept for switching back.
	// A mode a newer version of this app's agent asked for. Core keeps the saved
	// mode until the user accepts it (by saving the agent with it) or dismisses it.
	const pendingIdentityMode = existing?.appIdentity?.pendingMode ?? null;
	const keepCurrentIdentityMode = async () => {
		if (!(agentId && existing) || dismissingPendingMode) {
			return;
		}
		const recordScope = activeRecordScope.current;
		setDismissingPendingMode(true);
		try {
			await updateAgentAccountSettings(target, agentId, {
				dismissPendingIdentityMode: true,
			});
			if (editorMounted.current && activeRecordScope.current === recordScope) {
				setIdentityMode(existing.identityMode);
				setExisting((previous) =>
					previous?.appIdentity
						? {
								...previous,
								appIdentity: {
									appMode:
										previous.appIdentity.pendingMode ??
										previous.appIdentity.appMode,
									pendingMode: null,
								},
							}
						: previous
				);
			}
		} catch {
			if (editorMounted.current) {
				setFormError("Couldn't dismiss the identity request. Try again.");
			}
		} finally {
			if (editorMounted.current) {
				setDismissingPendingMode(false);
			}
		}
	};
	const identityModeWarning = identityModeAccountWarning(
		identityMode,
		accountAccess,
		selectedIdentities.size,
		stoppingTriggerCount
	);
	// The engine as it would be saved, and Core's answer for whether it starts
	// under the identity and account access on screen (`useAgentLaunchCheck`).
	const launchEngine =
		chatModel === ACP_CUSTOM_ENGINE
			? `${ACP_EXEC_PREFIX}${acpCommand.trim()}`
			: chatModel || null;
	const launch = useAgentLaunchCheck({
		accountAccess,
		agentId: effectiveAgentId,
		engine: launchEngine,
		identityMode,
	});
	// A remote A2A peer runs on another node under that node's accounts, so the
	// editor shows a note instead of the identity choice and account access, and
	// saves the record's identity and access unchanged.
	const remotePeer = isRemotePeerEngine(launchEngine);
	const agentConfined = agentIsConfined(identityMode, accountAccess);
	// Core's refusal for a limited agent, when its engine won't start.
	const limitedLaunchRefusal = agentConfined
		? (launch.check?.reason ?? null)
		: null;
	// Shown in the Codex and custom-agent routing settings of a limited agent:
	// those switches decide whether its engine may start at all. Claude Code's
	// switch does not (it always calls Anthropic itself), so its settings show
	// only Core's refusal.
	const limitedRoutingNotice = agentConfined
		? (limitedLaunchRefusal ??
			"This agent's account access is limited, so this routing decides whether its engine may start. Ryu checks again before every start.")
		: null;
	const agentHealthInput = useMemo<AgentHealthInput>(
		() => ({
			access: {
				composioActionCount: selectedComposio.size,
				highImpactCount:
					selectedToolsList.filter(isHighImpactTool).length +
					selectedComposio.size +
					selectedIdentities.size +
					(memoryWriteEnabled ? 1 : 0),
				identityProfileCount: selectedIdentities.size,
			},
			automation: {
				scheduleEnabled,
				triggerCount: triggerSubs.length,
			},
			description,
			instructions: systemPrompt,
			lifecycleStatus,
			memoryWriteEnabled,
			model: {
				configured: Boolean(agentModel.trim()),
				required: chatModel !== ACP_CUSTOM_ENGINE,
			},
			name,
			runtime: {
				label: modelLabel,
				status: runtimeStatus,
			},
			safetyProfile,
			skills: {
				allSelected:
					enabledSkillCount > 0 &&
					selectedSkills.size === enabledSkillCount &&
					availableSkills
						.filter((skill) => skill.enabled)
						.every((skill) => selectedSkills.has(skill.id)),
				availableCount: enabledSkillCount,
				loaded: !skillsLoading,
				selectedCount: selectedSkills.size,
			},
			tools: {
				allSelected:
					availableTools.length > 0 &&
					selectedTools.size === availableTools.length &&
					availableTools.every((tool) => selectedTools.has(tool)),
				availableCount: availableTools.length,
				loaded: !toolsLoading,
				selectedCount: selectedTools.size,
			},
		}),
		[
			agentModel,
			availableSkills,
			availableTools,
			chatModel,
			description,
			enabledSkillCount,
			lifecycleStatus,
			memoryWriteEnabled,
			modelLabel,
			name,
			runtimeStatus,
			safetyProfile,
			selectedComposio,
			selectedIdentities,
			selectedSkills,
			selectedTools,
			selectedToolsList,
			scheduleEnabled,
			skillsLoading,
			systemPrompt,
			toolsLoading,
			triggerSubs.length,
		]
	);
	const agentHealthScorecard = useMemo(
		() => runAgentScorecard(agentHealthInput),
		[agentHealthInput]
	);
	return {
		mcpToolNames,
		mergedTools,
		modelLabel,
		toneLabelValue,
		scheduleSummaryValue,
		selectedToolsList,
		enabledSkillCount,
		runtimeStatus,
		pausedTriggers,
		savedPausedTriggers,
		stoppingTriggerCount,
		triggerRows,
		pendingIdentityMode,
		keepCurrentIdentityMode,
		identityModeWarning,
		launchEngine,
		launch,
		remotePeer,
		agentConfined,
		limitedLaunchRefusal,
		limitedRoutingNotice,
		agentHealthInput,
		agentHealthScorecard,
	};
}
