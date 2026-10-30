import type { ContextUsage } from "@ryu/blocks/desktop/agent-elements/context-usage.tsx";
import { modelSwitchCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import type {
	AgentMessageContext,
	AgentMessageIdentity,
} from "@ryu/blocks/desktop/agent-elements/types.ts";
import { Avatar } from "@ryu/ui/components/avatar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EmptyStateLogo } from "@/components/agent-elements/empty-state-header.tsx";
import { useTabBoundNode } from "@/src/contexts/TabNodeChatHistory.tsx";
import {
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import {
	composerSelectionToastDescription,
	shouldShowComposerSelectionToast,
	useComposerSelectionApplyMode,
} from "@/src/hooks/useComposerSelectionApplyMode.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import {
	CLIPS_QUICK_ATTACH_EVENT,
	parseClipsQuickAttachRequest,
} from "@/src/lib/clips-quick-attach.ts";
import { getAgentModel, modelsForAgent } from "@/src/lib/models.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatComposerResources } from "./ChatPage.composer-resources.ts";

export type UseChatAssistantIdentityInput = ReturnType<
	typeof useChatPageChrome
> &
	ReturnType<typeof useChatComposerResources>;

/** Tab bindings, model options, and the assistant identity shown on the empty state and turns. */
export function useChatAssistantIdentity({
	setClipsDraftInsertion,
	setAttachedImages,
	clipsDraftInsertionSequence,
	agentId,
	agents,
	engineModels,
	modelSelectionCleared,
	providerModelSelection,
	selectedModel,
	selectedModelRef,
	teamId,
	teams,
	botProduct,
}: UseChatAssistantIdentityInput) {
	// Remember the last picked agent so a new chat opens with it preselected. The
	// agent itself is owned by Core (CRUD via U6); this is only the local "last
	// used" hint, not agent storage.
	const openTab = useTabSelector((state) => state.openTab);
	const updateTabBusy = useTabSelector((state) => state.updateTabBusy);
	const updateTabWorktreeMode = useTabSelector(
		(state) => state.updateTabWorktreeMode
	);
	const bindTabConversation = useTabSelector(
		(state) => state.bindTabConversation
	);
	const clearScrollToMessage = useTabSelector(
		(state) => state.clearScrollToMessage
	);
	const currentTabId = useCurrentTabId();
	// The computer this tab is bound to when it is not the default one. Its
	// chat history (and so `forkConversation`) is pinned to that computer, so a
	// thread this tab creates or opens from its own list must open there too.
	const tabBoundNodeName = useTabBoundNode(currentTabId)?.name;
	const handleDraftInsertionConsumed = useCallback((id: number) => {
		setClipsDraftInsertion((pending) => (pending?.id === id ? null : pending));
	}, []);
	useEffect(() => {
		const onClipsQuickAttach = (event: Event) => {
			if (!(event instanceof CustomEvent)) {
				return;
			}
			const request = parseClipsQuickAttachRequest(event.detail);
			if (!request || request.tabId !== currentTabId) {
				return;
			}
			if (request.images.length > 0) {
				setAttachedImages((current) => [
					...current,
					...request.images.map((image) => ({
						...image,
						mimeType: image.mimeType ?? "image/png",
					})),
				]);
			}
			if (request.prompt?.trim()) {
				clipsDraftInsertionSequence.current += 1;
				setClipsDraftInsertion({
					id: clipsDraftInsertionSequence.current,
					text: request.prompt,
				});
			}
		};
		window.addEventListener(CLIPS_QUICK_ATTACH_EVENT, onClipsQuickAttach);
		return () => {
			window.removeEventListener(CLIPS_QUICK_ATTACH_EVENT, onClipsQuickAttach);
		};
	}, [currentTabId]);
	const scrollToMessageId = useTabSelector(
		(state) =>
			state.tabs.find((tab) => tab.id === currentTabId)?.scrollToMessageId
	);

	// Model options follow the active agent's engine binding. Provider-specific
	// picks stay explicit even when they are absent from that engine's catalog.
	// Otherwise the effective value follows the per-agent choice and catalog.
	const modelOptions = useMemo(
		() => modelsForAgent(agentId, agents, engineModels),
		[agentId, agents, engineModels]
	);
	const effectiveModel = modelSelectionCleared
		? null
		: (providerModelSelection?.modelId ??
			[selectedModel, getAgentModel(agentId)].find(
				(id) => id && modelOptions.some((m) => m.id === id)
			) ??
			modelOptions[0]?.id ??
			null);
	selectedModelRef.current = effectiveModel;

	// The empty-state logo reflects the active target: a team fans out its
	// members' engine logos; any single agent (Ryu included) shows its own mark.
	const emptyStateLogo = useMemo<EmptyStateLogo>(() => {
		if (teamId) {
			const team = teams.find((t) => t.id === teamId);
			const engines = (team?.members ?? []).map((id) => {
				const member = agents.find((a) => a.id === id);
				return member ? engineForAgent(member) : null;
			});
			if (engines.length > 0) {
				return { kind: "stack", engines };
			}
		}
		const agent = agents.find((a) => a.id === agentId);
		if (agent?.avatarGlyph) {
			return { kind: "glyph", glyph: agent.avatarGlyph };
		}
		if (agent?.avatarUrl) {
			return { kind: "image", url: agent.avatarUrl };
		}
		return { kind: "single", engine: agent ? engineForAgent(agent) : null };
	}, [agentId, teamId, agents, teams]);

	// Avatar + name shown beside each assistant turn in the transcript. A single
	// agent shows its engine logo in a circular avatar; a team shows its name
	// (the fanned member avatars are wired separately). Mirrors emptyStateLogo.
	const assistantIdentity = useMemo<{
		avatar?: React.ReactNode;
		name?: string;
		title?: string;
	}>(() => {
		if (teamId) {
			const team = teams.find((t) => t.id === teamId);
			return { name: team?.name };
		}
		const agent = agents.find((a) => a.id === agentId);
		if (!agent) {
			return {};
		}
		return {
			name: agent.name,
			title: agent.title,
			avatar: (
				<Avatar
					className="flex items-center justify-center after:hidden"
					size="sm"
				>
					<AgentAvatar
						className="size-full object-contain"
						engine={engineForAgent(agent)}
						fit="contain"
						glyph={agent.avatarGlyph}
						presentation="portrait"
						size="16px"
					/>
				</Avatar>
			),
		};
	}, [agentId, teamId, agents, teams]);
	const selectedAgent = agents.find((agent) => agent.id === agentId) ?? null;
	const botHeaderAgent = useMemo(
		() => (botProduct ? agents.find((agent) => agent.id === "ryu") : null),
		[agents, botProduct]
	);

	// The agent-comms transcript renderer uses the same roster and avatar primitive
	// as the main assistant header, so a sender stays recognizable in both places.
	const agentMessageContext = useMemo<AgentMessageContext>(() => {
		const identityForAgent = (
			agent: AgentSummary,
			id = agent.id
		): AgentMessageIdentity => ({
			avatar: (
				<AgentAvatar
					className="size-full object-contain"
					engine={engineForAgent(agent)}
					fit="contain"
					glyph={agent.avatarGlyph}
					presentation="portrait"
					size="16px"
				/>
			),
			id,
			name: agent.name,
		});
		const activeAgent = agents.find((agent) => agent.id === agentId);
		const current = activeAgent
			? identityForAgent(activeAgent)
			: {
					avatar: assistantIdentity.avatar,
					id: agentId ?? "agent",
					name: assistantIdentity.name ?? "Agent",
				};

		return {
			current,
			resolve: (id) => {
				const normalizedId = id.startsWith("acp:") ? id.slice(4) : id;
				const agent = agents.find(
					(candidate) => candidate.id === id || candidate.id === normalizedId
				);
				return agent ? identityForAgent(agent, id) : undefined;
			},
		};
	}, [agentId, agents, assistantIdentity]);

	// Marks for the live status row. A team is the case where more than one agent
	// is genuinely on the same turn, so it contributes one mark per member; a
	// single agent contributes its own. Built from the same `agents`/`teams`
	// lookups as the identity above rather than from the transcript, because a
	// turn that has produced nothing yet carries no agent attribution at all —
	// and that is exactly when this row is on screen.
	const assistantPlanningAvatars = useMemo<React.ReactNode[]>(() => {
		// `AgentAvatar` with an explicit 16px class, NOT the `<Avatar size="sm">`
		// wrapper the transcript's per-turn identity uses: that component carries its
		// own size class, which wins over whatever slot it is dropped into, so a row
		// of them would not line up with the 16px status line they sit on. This is
		// the same shape the sidebar's ChatRow draws its agent mark with.
		const mark = (agent: (typeof agents)[number]) => (
			<AgentAvatar
				className="size-4 shrink-0 object-contain"
				engine={engineForAgent(agent)}
				glyph={agent.avatarGlyph}
				key={agent.id}
				presentation="compact"
				size="16px"
				thinking
			/>
		);
		if (teamId) {
			const team = teams.find((t) => t.id === teamId);
			const members = (team?.members ?? [])
				.map((id) => agents.find((a) => a.id === id))
				.filter((a): a is (typeof agents)[number] => Boolean(a));
			if (members.length > 0) {
				return members.map(mark);
			}
		}
		const agent = agents.find((a) => a.id === agentId);
		return agent ? [mark(agent)] : [];
	}, [agentId, teamId, agents, teams]);

	// Whether a turn is in flight, for the pick notice below. A ref because the
	// notice callback is created here, above `useChat`'s `status` (assigned into
	// this ref right after that hook), and reading it live would be a TDZ error.
	const turnInFlightRef = useRef(false);
	const [composerSelectionApplyMode] = useComposerSelectionApplyMode();
	// The latest turn's usage, read by the model-switch warning. Assigned where
	// `contextUsage` is derived further below (it depends on the processed list).
	const contextUsageRef = useRef<ContextUsage | null>(null);
	// Provider prompt caches are keyed by model, so a mid-chat switch re-sends the
	// whole context uncached. Console only: Bot mode has no model picker.
	const warnModelSwitchCacheReset = useCallback(
		(nextModel: string) => {
			if (botProduct) {
				return;
			}
			const warning = modelSwitchCacheWarning(
				contextUsageRef.current,
				nextModel,
				Date.now()
			);
			if (warning) {
				toast.warning({ id: "ryu-model-switch-cache", ...warning });
			}
		},
		[botProduct]
	);

	const announceComposerSelection = useCallback(
		(setting: string, value: string) => {
			// An idle picker already makes the next message's target obvious. The
			// toast is only useful when a response is in flight and the pick cannot
			// change that response.
			if (!shouldShowComposerSelectionToast(turnInFlightRef.current)) {
				return;
			}
			toast.info({
				id: "ryu-composer-selection-applied",
				title: `${setting}: ${value}`,
				description: composerSelectionToastDescription(
					composerSelectionApplyMode
				),
			});
		},
		[composerSelectionApplyMode]
	);
	return {
		openTab,
		updateTabBusy,
		updateTabWorktreeMode,
		bindTabConversation,
		clearScrollToMessage,
		currentTabId,
		tabBoundNodeName,
		handleDraftInsertionConsumed,
		scrollToMessageId,
		modelOptions,
		effectiveModel,
		emptyStateLogo,
		assistantIdentity,
		selectedAgent,
		botHeaderAgent,
		agentMessageContext,
		assistantPlanningAvatars,
		turnInFlightRef,
		contextUsageRef,
		warnModelSwitchCacheReset,
		announceComposerSelection,
	} as const;
}
