import { useChat } from "@ai-sdk/react";
import { useModelContextStore } from "@ryu/app-host/model-context";
import {
	RyuAssistantRecentChats,
	RyuAssistantWidgetFrame,
	RyuAssistantWidgetHeader,
} from "@ryu/assistant-widget/surface";
import { AgentUiStateHostContext } from "@ryu/blocks/desktop/agent-elements/agent-ui/state-host-context.tsx";
import { ModelContextAttachments } from "@ryu/blocks/desktop/agent-elements/model-context-attachments.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { AgentChat } from "@/components/agent-elements/agent-chat.tsx";
import {
	EmptyStateHeader,
	type EmptyStateLogo,
} from "@/components/agent-elements/empty-state-header.tsx";
import { ClipComposerControls } from "@/src/components/clips/ClipComposerControls.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useBuilderRuntime } from "@/src/hooks/useBuilderRuntime.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import {
	sidebarFloatingChrome,
	useSidebarVariant,
} from "@/src/hooks/useSidebarVariant.ts";
import { useTitleBarClearsContent } from "@/src/hooks/useTitleBarClearsContent.ts";
import { engineForAgent } from "@/src/lib/agent-logos.tsx";
import { cancelChat } from "@/src/lib/api/chat.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { useAssistantStore } from "@/src/store/useAssistantStore.ts";
import { useAssistantComposers } from "./AssistantPanel-composers.ts";
import { useAssistantConversation } from "./AssistantPanel-conversation.ts";
import {
	BuilderEmptyState,
	GenericAssistantExtras,
} from "./AssistantPanel-extras.tsx";
import { AssistantHeaderActions } from "./AssistantPanel-header-actions.tsx";
import { useAssistantHistorySync } from "./AssistantPanel-history-sync.ts";
import { useAssistantImageGeneration } from "./AssistantPanel-image-generation.ts";
import { useAssistantPageContext } from "./AssistantPanel-page-context.ts";
import { useAssistantPermission } from "./AssistantPanel-permission.tsx";
import {
	BUILDER_AGENT_KEY,
	DEFAULT_AGENT_KEY,
} from "./AssistantPanel-request.ts";
import { useAssistantSend } from "./AssistantPanel-send.ts";
import { useAssistantTransport } from "./AssistantPanel-transport.ts";
import { useAssistantVoice } from "./AssistantPanel-voice.ts";
import { assistantDisplayMessages } from "./assistant-message-display.ts";
import { ASSISTANT_SURFACE_CONTENT } from "./skin.ts";

/**
 * The global "Ask Ryu" assistant panel — a Notion-AI-style chat that floats over
 * any page or docks as a right sidebar. It reuses the presentational `AgentChat`
 * (message list + composer) with its own lightweight chat transport, kept
 * deliberately minimal vs. the full ChatPage (no teams / ACP pickers / worktree /
 * realtime presence) so the panel stays compact and focused.
 *
 * It is ALSO context-aware: when a builder page (agent edit, workflows) registers
 * a builder takeover in the assistant store (`useAssistantBuilder`), this one
 * panel becomes that page's builder — injecting the builder preamble, driving the
 * `*_builder.*` tools with `persist: false`, showing the tool-permission prompt,
 * and refreshing the page after each settled turn. That is what replaced the old
 * inline `AgentBuilderChat` / `WorkflowBuilderChat` panes. When no builder is
 * registered it is the plain "Ask Ryu" chat (page context chips, onboarding,
 * full-screen hand-off).
 *
 * Layout only mounts this component while the panel is open, so its `useChat`
 * is fully unmounted on close. That is what lets the "open full screen" hand-off
 * mount a `/chat` tab on the SAME conversation id without two live `useChat`
 * instances colliding on that id (the per-tab-convId gotcha,
 * [[chat-history-per-tab-convid]]) — `handleOpenFullScreen` closes the panel as
 * it opens the tab.
 *
 * `bare` renders just the panel body (header + context + chat), without the
 * fixed-positioned `<aside>` shell, so it can be embedded as the content of the
 * morph launcher (which owns the floating window's glass frame + animation).
 */
export function AssistantPanel({ bare = false }: { bare?: boolean } = {}) {
	const interfaceLevel = useInterfaceLevel();
	const mode = useAssistantStore((s) => s.mode);
	const builder = useAssistantStore((s) => s.builder);
	const storeConvId = useAssistantStore((s) => s.conversationId);
	const pageContext = useAssistantStore((s) => s.pageContext);
	const hasAppContext = useModelContextStore((store) =>
		Object.values(store.entries).some(
			(entry) =>
				entry.scope === "assistant" &&
				(entry.state.content?.length || entry.state.structuredContent)
		)
	);
	const contextDismissed = useAssistantStore((s) => s.contextDismissed);
	const setLayout = useAssistantStore((s) => s.setLayout);
	const close = useAssistantStore((s) => s.close);
	const setConversationId = useAssistantStore((s) => s.setConversationId);
	const newConversation = useAssistantStore((s) => s.newConversation);
	const removePageContext = useAssistantStore((s) => s.removePageContext);
	const dismissContext = useAssistantStore((s) => s.dismissContext);
	const restoreContext = useAssistantStore((s) => s.restoreContext);

	const { openTab, tabs, activeTabId } = useTabsContext();
	const {
		createConversation,
		listConversations,
		seedTitleFromFirstMessage,
		setActiveConversationId,
		loadMessages,
		loadMessagesResult,
		refresh,
	} = useChatHistoryContext();

	const activeNode = useActiveNode();
	const chatTarget: ApiTarget = useMemo(
		() => ({
			url: activeNode.url,
			token: activeNode.token,
			userJwt: activeNode.userJwt ?? null,
		}),
		[activeNode.url, activeNode.token, activeNode.userJwt]
	);

	// Agent + model selection, shared with the main chat composer via the same
	// per-agent storage. Builder mode uses its own key (defaults to `ryu`, which
	// reliably runs the tool loop the `*_builder.*` tools need). Both runtimes are
	// created unconditionally (no conditional hooks) and the active one is picked.
	const genericRuntime = useBuilderRuntime(DEFAULT_AGENT_KEY);
	const builderRuntime = useBuilderRuntime(BUILDER_AGENT_KEY);
	const isBuilder = builder !== null;
	// An app-defined surface (Code Review, Weekly review, a dashboard, any
	// Companion) is about the page under it, so the page context stays visible,
	// removable, and attached to its turns. Only the two built-in builders are
	// scoped to the record they edit instead.
	const isAppSurface =
		builder !== null && builder.kind !== "agent" && builder.kind !== "workflow";

	// The big empty-state mark for the generic assistant — the driving agent's own
	// logo (or custom avatar), peeking out from behind the composer, exactly like
	// the main chat page. Clicking it opens the same Agent · Model · Thinking menu.
	const { agents } = useAgents();
	const genericLogo = useMemo<EmptyStateLogo>(() => {
		const agent = agents.find((a) => a.id === genericRuntime.agentId);
		if (agent?.avatarGlyph) {
			return { kind: "glyph", glyph: agent.avatarGlyph };
		}
		if (agent?.avatarUrl) {
			return { kind: "image", url: agent.avatarUrl };
		}
		return { kind: "single", engine: agent ? engineForAgent(agent) : null };
	}, [agents, genericRuntime.agentId]);

	const {
		activeConvId,
		activeConvIdRef,
		agentUiStateHost,
		convId,
		convIdRef,
		floatingRecentChats,
		floatingTitle,
	} = useAssistantConversation({ builder, listConversations, storeConvId });

	const { builderRef, targetIdRef, transport } = useAssistantTransport({
		activeConvIdRef,
		builder,
		builderRuntime,
		chatTarget,
		convIdRef,
		genericRuntime,
	});

	// App surfaces resume their in-memory thread when the panel remounts (it
	// unmounts on close) or when the user returns to an earlier thread.
	const isAppSurfaceThread =
		builder !== null && builder.kind !== "agent" && builder.kind !== "workflow";
	const resumedMessages = useMemo(
		() =>
			isAppSurfaceThread
				? useAssistantStore.getState().surfaceThreads[activeConvId]
				: undefined,
		[isAppSurfaceThread, activeConvId]
	);
	const { messages, sendMessage, setMessages, stop, status, error } = useChat({
		id: activeConvId,
		messages: resumedMessages,
		transport,
	});
	const statusRef = useRef(status);
	statusRef.current = status;
	const saveSurfaceThread = useAssistantStore((s) => s.saveSurfaceThread);
	useEffect(() => {
		if (isAppSurfaceThread && messages.length > 0) {
			saveSurfaceThread(activeConvId, messages);
		}
	}, [isAppSurfaceThread, activeConvId, messages, saveSurfaceThread]);
	const displayMessages = useMemo(
		() => assistantDisplayMessages(messages),
		[messages]
	);
	const { handleGenerateImage, handleRetryGeneration } =
		useAssistantImageGeneration(chatTarget, setMessages);

	// Stop aborts the stream AND cancels the turn on Core: a saved (generic-mode)
	// turn keeps running there after its request is gone. Builder turns are not
	// persisted, so the abort alone ends them.
	const handleStop = useCallback(() => {
		void stop();
		const conversationId = convIdRef.current;
		if (!builderRef.current && conversationId) {
			cancelChat(chatTarget, conversationId).catch(() => {
				// No live turn, or Core is unreachable; the abort above still stands.
			});
		}
	}, [chatTarget, stop]);

	const { handleSpeak, reconcileCallHistory } = useAssistantVoice({
		builderRef,
		chatTarget,
		convIdRef,
		loadMessagesResult,
		setMessages,
		statusRef,
	});
	const {
		activeComposer,
		attachClip,
		composerSlot,
		genericComposer,
		takeClipTextRef,
		takeImagesRef,
	} = useAssistantComposers({
		activeConvId,
		bare,
		builderRef,
		builderRuntime,
		chatTarget,
		convId,
		convIdRef,
		genericRuntime,
		handleGenerateImage,
		isAppSurface,
		isBuilder,
		reconcileCallHistory,
		refresh,
		setConversationId,
		setMessages,
		status,
	});
	useAssistantHistorySync({
		builderRef,
		convId,
		loadMessages,
		refresh,
		setMessages,
		status,
		targetIdRef,
	});
	const permissionComposerPrompt = useAssistantPermission({
		activeConvId,
		chatTarget,
		interfaceLevel,
		messages,
	});
	const { effectiveContext, effectiveContextRef, genericContext } =
		useAssistantPageContext({
			activeTabId,
			contextDismissed,
			pageContext,
			restoreContext,
			tabs,
		});
	const { handleAgentUiSubmit, handleSend } = useAssistantSend({
		activeConvId,
		activeConvIdRef,
		builderRef,
		convId,
		convIdRef,
		createConversation,
		effectiveContextRef,
		genericRuntime,
		messages,
		seedTitleFromFirstMessage,
		sendMessage,
		setActiveConversationId,
		setConversationId,
		takeClipTextRef,
		takeImagesRef,
		targetIdRef,
	});

	// An app asked a question on the user's behalf (`assistant.open({ prompt })`)
	// while the panel was closed — the panel unmounts when closed, so the store
	// held it. Send it once and clear the queue immediately, before the async send
	// resolves, so a re-render can never send it twice.
	const pendingPrompt = useAssistantStore((s) => s.pendingPrompt);
	const setPendingPrompt = useAssistantStore((s) => s.setPendingPrompt);
	useEffect(() => {
		if (!pendingPrompt) {
			return;
		}
		setPendingPrompt(null);
		handleSend({ role: "user", content: pendingPrompt });
	}, [pendingPrompt, setPendingPrompt, handleSend]);

	const handleOpenFullScreen = useCallback(() => {
		// Carry THIS conversation into a full `/chat` tab, then close the panel so
		// its `useChat` unmounts — two live hooks on one id would collide.
		setConversationId(convId);
		openTab("/chat", { conversationId: convId });
		close();
	}, [convId, openTab, setConversationId, close]);

	const handleSelectRecentConversation = useCallback(
		(id: string) => {
			setActiveConversationId(id);
			openTab("/chat", { conversationId: id });
			close();
		},
		[close, openTab, setActiveConversationId]
	);

	// Docked shell chrome tracks the app sidebar variant (must run before any
	// early return — bare/closed paths still need a stable hook order). The rail
	// also starts below the frosted titlebar when it's shown; auto-hide frees the
	// full height instead.
	const [sidebarVariant] = useSidebarVariant();
	const floatingChrome = sidebarVariant === "floating";
	const titleBarClearsContent = useTitleBarClearsContent();

	if (mode === "closed") {
		return null;
	}

	const isSidebar = mode === "sidebar";
	// Dividers read fine on the opaque sidebar, but the floating window is
	// deliberately borderless/backgroundless — drop them there.
	const divider = bare ? "" : "border-border border-b";
	// An app-defined surface names itself (`label`); the built-in builders keep
	// the "Build <target>" wording.
	const builderTitle = builder
		? builder.label?.trim() ||
			`Build ${builder.targetName.trim() || (builder.kind === "agent" ? "this agent" : builder.kind === "workflow" ? "this workflow" : "this")}`
		: null;

	// Builder threads get a worded prompt; the generic assistant reuses the main
	// chat's `EmptyStateHeader` so the driving agent's logo sits behind the
	// composer and opens the same Agent · Model · Thinking dropdown.
	const emptyHeader = builder ? (
		<BuilderEmptyState
			onPrompt={(prompt) => handleSend({ role: "user", content: prompt })}
			session={builder}
			title={builderTitle}
		/>
	) : (
		<EmptyStateHeader
			logo={genericLogo}
			renderBody={genericComposer.renderBody}
			// A settings trigger, so it summarises what the composer's trigger does.
			sections={genericComposer.triggerSections}
		/>
	);

	const headerActions = (
		<AssistantHeaderActions
			activeComposer={activeComposer}
			bare={bare}
			close={close}
			handleOpenFullScreen={handleOpenFullScreen}
			isBuilder={isBuilder}
			isSidebar={isSidebar}
			newConversation={newConversation}
			setLayout={setLayout}
		/>
	);

	const body = (
		<>
			<RyuAssistantWidgetHeader
				actions={headerActions}
				closeTitle={bare ? "Close assistant" : undefined}
				divider={Boolean(divider)}
				// Generic docked/floating chat closes from its overflow menu. The bare
				// floating window and the builders (which have no overflow menu) keep
				// the header's own close button.
				onClose={bare || isBuilder ? close : undefined}
				testId={bare ? "floating-assistant-header" : undefined}
				title={bare ? floatingTitle : "Chat"}
			/>

			{/* Page-context chips belong to generic chat and app-defined surfaces —
			    the built-in agent/workflow builders are scoped to the record they
			    edit, not the page they happen to sit over. Generic floating chat drops
			    them (the minimal window is just the conversation + composer islands),
			    but an app surface keeps them there too: its context (a PR diff, an
			    activity summary) rides the turn, so its removal control must show. */}
			{(isBuilder && !isAppSurface) || (bare && !isAppSurface) ? null : (
				<GenericAssistantExtras
					divider={divider}
					effectiveContext={effectiveContext}
					genericContext={genericContext}
					onDismissContext={dismissContext}
					onRemovePageContext={removePageContext}
					onRestoreContext={restoreContext}
				/>
			)}

			{/* Ryu Clips: record screen+audio or attach an existing recording, folding
			    its agent-context summary + key frames into the next turn. Generic chat
			    only (a builder is scoped to the record it edits). */}
			{isBuilder || bare ? null : (
				<ClipComposerControls
					className={cn("shrink-0 px-3 py-1.5", divider)}
					onAttach={attachClip}
				/>
			)}

			<div className="relative min-h-0 flex-1 overflow-hidden">
				<AgentUiStateHostContext.Provider value={agentUiStateHost}>
					<AgentChat
						attachments={activeComposer.attachments}
						composerHeader={
							hasAppContext ? (
								<ModelContextAttachments scope="assistant" />
							) : undefined
						}
						composerMenuGroups={activeComposer.composerMenuGroups}
						composerPrompt={permissionComposerPrompt}
						emptyStateFooter={
							bare && !isBuilder ? (
								<RyuAssistantRecentChats
									items={floatingRecentChats}
									onSelect={handleSelectRecentConversation}
								/>
							) : undefined
						}
						emptyStateHeader={bare ? undefined : emptyHeader}
						emptyStatePosition={bare ? "default" : "center"}
						error={error ?? undefined}
						key={`${activeNode.url}-${activeConvId}`}
						mentionItems={activeComposer.mentionItems}
						messages={displayMessages}
						onAgentUiSubmit={handleAgentUiSubmit}
						onComposerMenuSelect={activeComposer.onComposerMenuSelect}
						onRetryGeneration={handleRetryGeneration}
						onSend={handleSend}
						onSpeak={handleSpeak}
						onStop={handleStop}
						showCopyToolbar
						slots={{ InputBar: composerSlot }}
						status={status}
						voiceMode={activeComposer.voiceMode}
					/>
				</AgentUiStateHostContext.Provider>
			</div>
		</>
	);

	// Embedded in the morph launcher: fill its morphing frame, no shell of our own
	// (the launcher supplies the glass floating frame + spring animation).
	if (bare) {
		return (
			<RyuAssistantWidgetFrame
				className={cn(ASSISTANT_SURFACE_CONTENT)}
				placement="floating"
			>
				{body}
			</RyuAssistantWidgetFrame>
		);
	}

	// Docked sidebar: mirrors the left rail + workspace right dock. Floating
	// variant = inset rounded card (`rounded-3xl` tracks Appearance roundness);
	// inset variant = flush rail (the main SidebarInset already wears the card).
	// Both start below the titlebar while it's shown; with auto-hide the rail
	// takes the full window height. Below `md` a 380px rail would be wider than
	// the page it sits beside, so the panel spans the viewport instead — Layout
	// drops its width reservation at the same breakpoint.
	return (
		<RyuAssistantWidgetFrame
			ariaLabel={builder ? "Ryu builder" : "Ask Ryu assistant"}
			className={cn(
				"fixed z-40 flex flex-col overflow-hidden bg-sidebar text-sidebar-foreground md:left-auto md:w-[380px]",
				titleBarClearsContent
					? floatingChrome
						? cn("top-12 right-2 bottom-2 left-2", sidebarFloatingChrome)
						: "top-[54px] right-0 bottom-0 left-0 md:left-auto"
					: floatingChrome
						? cn("inset-y-0 right-2 bottom-2 left-2", sidebarFloatingChrome)
						: "inset-y-0 right-0 left-0 md:left-auto"
			)}
			placement="docked"
		>
			{body}
		</RyuAssistantWidgetFrame>
	);
}
