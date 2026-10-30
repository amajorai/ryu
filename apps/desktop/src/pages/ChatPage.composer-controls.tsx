import { createComposerDirectory } from "@ryu/blocks/composer/composer-directory.ts";
import { deriveContextUsage } from "@ryu/blocks/desktop/agent-elements/context-usage.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useComposerAgentControls } from "@/components/agent-elements/input/composer-agent-controls.tsx";
import type { ComposerSettingsSection } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import {
	chatParameterModel,
	useModelParametersComposer,
} from "@/src/components/chat/ModelParametersComposer.tsx";
import { PluginComposerBarControls } from "@/src/components/composer/PluginComposerBarControls.tsx";
import {
	composerPluginSectionKey,
	composerSelectOptions,
	composerSelectValue,
	partitionComposerControls,
} from "@/src/components/composer/plugin-composer-controls.ts";
import { patchForFile } from "@/src/components/diffs/RichPatchDiff.tsx";
import { useWorktreeDiff } from "@/src/hooks/useGitStatus.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import { rememberLastUsedAgent } from "@/src/lib/composer-target.ts";
import { getAgentModel } from "@/src/lib/models.ts";
import { deriveTurnComposerProgress } from "@/src/lib/turn-composer-progress.ts";
import {
	publishSidebarTodoProgress,
	sidebarTodoProgressKey,
} from "@/src/store/useSidebarTodoProgressStore.ts";
import type { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import type { useChatMessagePipeline } from "./ChatPage.message-pipeline.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import type { useChatPresence } from "./ChatPage.presence.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatComposerControlsInput = ReturnType<
	typeof useChatPageChrome
> &
	ReturnType<typeof useChatComposerResources> &
	ReturnType<typeof useChatAssistantIdentity> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatPluginFlags> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatPresence> &
	ReturnType<typeof useChatMessagePipeline>;

/** Turn progress, context usage, and the composer's controls and sections. */
export function useChatComposerControls({
	messages,
	convId,
	chatTarget,
	getConversation,
	diffConvId,
	processedMessages,
	contextSize,
	cacheModelHint,
	agentId,
	contextUsageRef,
	pluginContributions,
	teamId,
	agents,
	effectiveModel,
	providerModelSelection,
	acp,
	chatPickerPlacement,
	teams,
	openCreateAgent,
	setTeamId,
	announceComposerSelection,
	setAgentId,
	setModelSelectionCleared,
	setSelectedModel,
	setProviderModelSelection,
	modelOptions,
	handleModelChange,
	handleProviderModelSelection,
	botProduct,
	firePluginActionFlag,
}: UseChatComposerControlsInput) {
	const turnProgress = useMemo(
		() => deriveTurnComposerProgress(messages),
		[messages]
	);
	useEffect(() => {
		if (!convId || messages.length === 0) {
			return;
		}
		publishSidebarTodoProgress({
			key: sidebarTodoProgressKey({
				conversationId: convId,
				nodeUrl: chatTarget.url,
			}),
			messages,
			revision: getConversation(convId)?.updatedAt ?? 0,
		});
	}, [chatTarget.url, convId, getConversation, messages]);
	const composerWorktreeDiff = useWorktreeDiff(chatTarget, diffConvId);
	const turnProgressWithPreviews = useMemo(() => {
		if (!turnProgress) {
			return undefined;
		}
		return {
			...turnProgress,
			files: turnProgress.files.map((file) => {
				const worktreeFile = composerWorktreeDiff.files.find(
					(candidate) =>
						candidate.path === file.path ||
						file.path.endsWith(`/${candidate.path}`) ||
						candidate.path.endsWith(`/${file.path}`)
				);
				return worktreeFile
					? {
							...file,
							preview: patchForFile(
								composerWorktreeDiff.unified_diff,
								worktreeFile.path
							),
						}
					: file;
			}),
		};
	}, [
		composerWorktreeDiff.files,
		composerWorktreeDiff.unified_diff,
		turnProgress,
	]);
	const turnProgressRef = useRef(turnProgressWithPreviews);
	turnProgressRef.current = turnProgressWithPreviews;

	// Codex-style composer controls: the project (folder) picker on the left,
	// agent + model pickers on the right, all inside the input card. Held in a
	// ref (assigned every render) so the slot component identity stays stable —
	// remounting it on each change would drop textarea focus.
	// Agent · Model · Approval (+ any agent config) are merged into ONE composer
	// dropdown (ComposerSettingsMenu) whose trigger shows every active value. Each
	// control becomes a labelled section; sections with no options are dropped, so
	// the exact same data-driven visibility as the old separate pickers holds —
	// nothing is hardcoded, an agent that advertises no model/modes just shows
	// fewer rows.

	// The Model + Approval/Thinking + config sections come from the shared
	// `useComposerAcpSections` hook (see `acp` above), so ChatPage, the launchpad,
	// and the dock build them from one place and can't diverge.

	// The composer's left cluster (Agent · Model · Approval · … + capability
	// badges + usage meters) is built by the ONE shared factory, so ChatPage, the
	// launchpad, and the Ask Ryu dock render an identical bar and can never drift.
	// ChatPage feeds its richer Model chain (ACP models / config option / engine
	// catalog) via `modelSection` and its Approval + config picks via
	// `extraSections`; the factory owns the agent picker, badges, and usage meters.
	// The create/team/agent sentinel routing lives in the factory's callbacks, and
	// its composed `sections` are reused by the empty-state header so the logo
	// opens the identical Agent · Model · Thinking dropdown.
	// Once a conversation has history the composer collapses to a single row
	// ("+" · input · model · mic · send): the agent/model cluster moves to the
	// right of the input and the usage meters fold into its dropdown. The fresh
	// launchpad surface (no history) keeps the roomy left-aligned stacked layout.
	// The SAME usage the composer ring shows, derived here too so the Context
	// panel and the ring can never report different numbers (the ring derives it
	// internally from the identical inputs — see `deriveContextUsage`).
	// The model/agent hints key the prompt-cache TTL when a part omits them; the
	// SAME hints reach AgentChat so the ring and this panel agree.
	const contextUsage = useMemo(
		() =>
			deriveContextUsage(processedMessages, contextSize, {
				model: cacheModelHint,
				provider: agentId,
			}),
		[processedMessages, contextSize, cacheModelHint, agentId]
	);
	contextUsageRef.current = contextUsage;

	const composerCompact = processedMessages.length > 0;
	const composerCompactRef = useRef(composerCompact);
	composerCompactRef.current = composerCompact;

	// ── App-contributed composer controls (`contributes.composer_controls`) ─────
	//
	// The manifest vocabulary is `toggle` | `select` | `chip` | `action`, and each
	// reaches the composer through one of its EXISTING seams (see
	// `plugin-composer-controls.ts`): toggles are "+" menu rows, menu-placed
	// selects are settings-menu sections (fed to the shared factory as
	// `extraSections`, the same seam the ACP approval/config pickers use), and
	// chips/actions/bar-placed selects render in the composer toolbar. Nothing here
	// is per-app: an entry whose `type` this build doesn't know is dropped by the
	// partition, so a newer control degrades to "not shown" instead of breaking the
	// composer.
	const partitionedComposerControls = useMemo(
		() => partitionComposerControls(pluginContributions.composer_controls),
		[pluginContributions.composer_controls]
	);

	// The string-valued controls (a `select`'s chosen option, a `chip`'s live id),
	// keyed by each control's `flag`. Separate from `pluginFlags` because the wire
	// `plugin_flags` map is bool-only (Core's `ChatRequest`), so these values stay
	// desktop-side for now — see the note on `buildPluginFlags`.
	const [pluginControlValues, setPluginControlValues] = useState<
		Record<string, string>
	>({});
	// Stable + idempotent: re-setting the same value returns the SAME object, so a
	// chip mirroring its polled value into state can't drive a render loop.
	const setPluginControlValue = useCallback(
		(flag: string, value: string | null) => {
			setPluginControlValues((prev) => {
				if (value === null) {
					if (!(flag in prev)) {
						return prev;
					}
					const next = { ...prev };
					delete next[flag];
					return next;
				}
				return prev[flag] === value ? prev : { ...prev, [flag]: value };
			});
		},
		[]
	);

	// Menu-placed `select` controls, as settings-menu sections. The section's items
	// ARE the control's options, so the shell renders a mode picker it knows
	// nothing about. An options-less one is auto-hidden by the menu.
	const pluginComposerSelectSections = useMemo<ComposerSettingsSection[]>(
		() =>
			partitionedComposerControls.selects.map((control) => ({
				key: composerPluginSectionKey(control),
				ariaLabel: control.label,
				label: control.label,
				items: composerSelectOptions(control).map((option) => ({
					id: option.value,
					name: option.label,
					description: option.description ?? null,
				})),
				value: composerSelectValue(control, pluginControlValues),
				onChange: (id: string) => setPluginControlValue(control.flag, id),
			})),
		[
			partitionedComposerControls.selects,
			pluginControlValues,
			setPluginControlValue,
		]
	);

	// Per-model sampling presets + editor for the model this chat sends to. Absent
	// for teams and external agents, which apply their own settings.
	const parameterModel = useMemo(() => {
		if (teamId) {
			return null;
		}
		const agent = agents.find((candidate) => candidate.id === agentId);
		return chatParameterModel({
			engine: agent ? engineForAgent(agent) : null,
			modelId: effectiveModel,
			providerId: providerModelSelection?.providerId,
		});
	}, [teamId, agents, agentId, effectiveModel, providerModelSelection]);
	const { dialog: modelParametersDialog, section: modelParametersSection } =
		useModelParametersComposer(parameterModel, chatTarget);

	// The factory's extra sections: ChatPage's own ACP approval/config pickers plus
	// whatever the enabled apps contributed.
	const composerExtraSections = useMemo(
		() => [
			...acp.extraSections,
			...pluginComposerSelectSections,
			...(modelParametersSection ? [modelParametersSection] : []),
		],
		[acp.extraSections, pluginComposerSelectSections, modelParametersSection]
	);

	const {
		infoBar: composerInfoBar,
		leftActions: composerLeft,
		picker: composerPicker,
		refreshRoutingAdvice,
		rightActions: composerRight,
		sections: composerSections,
		triggerSections: composerTriggerSections,
		renderBody: composerRenderBody,
	} = useComposerAgentControls({
		compact: composerCompact,
		placement: chatPickerPlacement,
		agents,
		// An empty thread is a conversation start, which is the only point an
		// agent-swapping fallback rule may move the whole agent. Mirrors the turn
		// path's own test (`conversation_id.is_none() || messages.len() <= 1`):
		// zero RENDERED messages here is the same moment the server sees a single
		// message — the turn it is about to run. Read from THIS tab's `convId`, not
		// the shared focused-tab id, or a background tab reports the focused tab's
		// thread state and its fallback notice describes the wrong turn.
		atConversationStart: convId === null || processedMessages.length === 0,
		teams,
		agentId,
		teamId,
		onCreateAgent: () => openCreateAgent(),
		onSelectTeam: (id) => {
			setTeamId(id);
			const team = teams.find((candidate) => candidate.id === id);
			announceComposerSelection("Agent", team?.name ?? "Team");
		},
		onSelectAgent: (id) => {
			setTeamId(null);
			setAgentId(id);
			// The pick is authoritative for THIS tab only. Remembering it seeds the
			// next brand-new chat; it must never reach back into another tab, which
			// is why nothing reads this key except a fresh composer's initializer.
			rememberLastUsedAgent(id);
			setModelSelectionCleared(false);
			setSelectedModel(getAgentModel(id));
			setProviderModelSelection(null);
			const selectedAgent = agents.find((candidate) => candidate.id === id);
			announceComposerSelection("Agent", selectedAgent?.name ?? id);
		},
		modelOptions,
		model: effectiveModel,
		onModelChange: handleModelChange,
		onProviderModelSelection: handleProviderModelSelection,
		modelSection: acp.modelSection,
		extraSections: composerExtraSections,
		managedProduct: botProduct,
	});
	const sideChatComposerDirectory = useMemo(
		() => createComposerDirectory(composerSections),
		[composerSections]
	);

	// Bar-placed controls (chips, actions, inline selects), rendered into the
	// composer toolbar's right slot below.
	const pluginComposerBar =
		!botProduct && partitionedComposerControls.bar.length > 0 ? (
			<PluginComposerBarControls
				controls={partitionedComposerControls.bar}
				onActionFired={firePluginActionFlag}
				onValueChange={setPluginControlValue}
				values={pluginControlValues}
			/>
		) : null;
	return {
		turnProgressRef,
		contextUsage,
		composerCompactRef,
		partitionedComposerControls,
		modelParametersDialog,
		composerInfoBar,
		composerLeft,
		composerPicker,
		refreshRoutingAdvice,
		composerRight,
		composerSections,
		composerTriggerSections,
		composerRenderBody,
		sideChatComposerDirectory,
		pluginComposerBar,
	} as const;
}
