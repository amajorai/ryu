import "./ChatPage.css";
import { ArtifactHostContext } from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { AgentActivityPanel } from "@/src/components/agents/AgentActivityPanel.tsx";
import { BtwOverlay } from "@/src/components/chat/BtwOverlay.tsx";
import { ChatSearchBar } from "@/src/components/chat/ChatSearchBar.tsx";
import { DiffReviewPane } from "@/src/components/chat/DiffReviewPane.tsx";
import { DrawesomeSketchDialog } from "@/src/components/chat/DrawesomeSketchDialog.tsx";
import { ForkDialog } from "@/src/components/chat/ForkDialog.tsx";
import {
	McpFormOwnerProvider,
	McpForms,
} from "@/src/components/chat/McpForms.tsx";
import { RewindDialog } from "@/src/components/chat/RewindDialog.tsx";
import { RunTracePanel } from "@/src/components/chat/RunTracePanel.tsx";
import { ShareConversationDialog } from "@/src/components/chat/ShareConversationDialog.tsx";
import { WorkspaceRequiredDialog } from "@/src/components/chat/WorkspaceRequiredDialog.tsx";
import { ImageEditorDialog } from "@/src/components/media/ImageEditorDialog.tsx";
import { SubagentActivityChips } from "@/src/components/panels/CoworkContextPanel.tsx";
import { PinnedSummaryPanel } from "@/src/components/panels/PinnedSummaryPanel.tsx";
import { WorkspacePanels } from "@/src/components/panels/WorkspacePanels.tsx";
import { useChatAcpNotices } from "./ChatPage.acp-notices.ts";
import { useChatAcpStream } from "./ChatPage.acp-stream.ts";
import { useChatAnswerNow } from "./ChatPage.answer-now.ts";
import { useChatAssistantIdentity } from "./ChatPage.assistant-identity.tsx";
import { useChatAttachments } from "./ChatPage.attachments.ts";
import { useChatAutoActions } from "./ChatPage.auto-actions.ts";
import { useChatPageChrome } from "./ChatPage.chrome.ts";
import { useChatComposerControls } from "./ChatPage.composer-controls.tsx";
import { useChatComposerRefs } from "./ChatPage.composer-refs.tsx";
import { useChatComposerResources } from "./ChatPage.composer-resources.ts";
import { useChatConversationState } from "./ChatPage.conversation-state.ts";
import { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import { useChatDraftsAndRewind } from "./ChatPage.drafts-rewind.ts";
import { useChatForkAndVersions } from "./ChatPage.fork-versions.ts";
import { useChatGoals } from "./ChatPage.goals.ts";
import { useChatHistoryLoading } from "./ChatPage.history-loading.ts";
import { useChatMediaAndVoice } from "./ChatPage.media-voice.ts";
import { useChatMessagePipeline } from "./ChatPage.message-pipeline.ts";
import { useChatModelSelection } from "./ChatPage.model-selection.ts";
import { useChatPanelRequests } from "./ChatPage.panel-requests.ts";
import { useChatPermissionsAndLinks } from "./ChatPage.permissions-links.ts";
import { useChatPlans } from "./ChatPage.plans.tsx";
import { useChatPluginFlags } from "./ChatPage.plugin-flags.ts";
import { useChatPresence } from "./ChatPage.presence.ts";
import { useChatQueueAndReplies } from "./ChatPage.queue-replies.ts";
import { useChatRealtimeRoom } from "./ChatPage.realtime-room.ts";
import { useChatResume } from "./ChatPage.resume.ts";
import { useChatSend } from "./ChatPage.send.ts";
import { useChatSideChats } from "./ChatPage.side-chats.ts";
import { useChatTitlebar } from "./ChatPage.titlebar.tsx";
import {
	renderChatTranscript,
	useChatTranscriptStableProps,
} from "./ChatPage.transcript.tsx";
import { useChatTransport } from "./ChatPage.transport.ts";
import type { ChatPageProps, ChatPageScope } from "./ChatPage.types.ts";

export { buildPluginFlags } from "./ChatPage.helpers.ts";
export type { ChatPageProps } from "./ChatPage.types.ts";

export default function ChatPage({
	mcpAppHost = false,
	...props
}: ChatPageProps) {
	// Each hook reads only bindings that earlier hooks already assigned.
	const scope = { ...props, mcpAppHost } as ChatPageScope;
	Object.assign(scope, useChatPageChrome(scope));
	Object.assign(scope, useChatComposerResources(scope));
	Object.assign(scope, useChatAssistantIdentity(scope));
	Object.assign(scope, useChatModelSelection(scope));
	Object.assign(scope, useChatConversationState(scope));
	Object.assign(scope, useChatConversationSync(scope));
	Object.assign(scope, useChatPluginFlags(scope));
	Object.assign(scope, useChatTransport(scope));
	Object.assign(scope, useChatGoals(scope));
	Object.assign(scope, useChatMediaAndVoice(scope));
	Object.assign(scope, useChatPermissionsAndLinks(scope));
	Object.assign(scope, useChatAcpStream(scope));
	Object.assign(scope, useChatAcpNotices(scope));
	Object.assign(scope, useChatHistoryLoading(scope));
	Object.assign(scope, useChatResume(scope));
	Object.assign(scope, useChatAnswerNow(scope));
	Object.assign(scope, useChatRealtimeRoom(scope));
	Object.assign(scope, useChatPresence(scope));
	Object.assign(scope, useChatAttachments(scope));
	Object.assign(scope, useChatSend(scope));
	Object.assign(scope, useChatSideChats(scope));
	Object.assign(scope, useChatPanelRequests(scope));
	Object.assign(scope, useChatForkAndVersions(scope));
	Object.assign(scope, useChatQueueAndReplies(scope));
	Object.assign(scope, useChatDraftsAndRewind(scope));
	Object.assign(scope, useChatAutoActions(scope));
	Object.assign(scope, useChatMessagePipeline(scope));
	Object.assign(scope, useChatComposerControls(scope));
	Object.assign(scope, useChatComposerRefs(scope));
	Object.assign(scope, useChatPlans(scope));
	Object.assign(scope, useChatTitlebar(scope));
	const transcriptProps = useChatTranscriptStableProps(scope);
	const {
		convId,
		chatTarget,
		artifactHostValue,
		setForkRequest,
		handleForkDestination,
		forkRequest,
		modelParametersDialog,
		activeConversationId,
		ghostChatActive,
		setShareDialogOpen,
		shareDialogOpen,
		conversationTitle,
		drawesomeCompanion,
		handleAttachSketch,
		handleDrawesomeDialogOpenChange,
		drawesomeDialogOpen,
		drawesomeSourceImage,
		imageEditorAsset,
		handleAiResize,
		setImageEditorAsset,
		handleAnnotateImage,
		addImages,
		handleWorkspaceFolderSelected,
		setPendingWorkspaceMessage,
		pendingWorkspaceMessage,
		selectedAgent,
		teamId,
		connectionPhase,
		activeNode,
		agentActivityReq,
		artifactReq,
		bottomPanelOpen,
		collectionReq,
		contextReq,
		draftConvId,
		contextUsage,
		coworkData,
		fileReviewRequest,
		fileSearchRequest,
		chatFolder,
		setBottomPanelOpen,
		setRightPanelOpen,
		pinnedSummaryVisible,
		pinnedSummaryFolder,
		handleAttachTextFile,
		dismissPinnedSummary,
		handleHandOffToWorktree,
		handleStop,
		handleWorktreeModeChange,
		pullRequestsEnabled,
		interfaceLevel,
		rightPanelOpen,
		subagentReq,
		handleOpenSubagent,
		subagentSummaries,
		botProduct,
		handleDragLeave,
		handleDragOver,
		handleDrop,
		chatSearch,
		activeChatSearchMatchIndex,
		chatSearchMatches,
		closeChatSearch,
		changeChatSearchMode,
		nextChatSearchMatch,
		previousChatSearchMatch,
		changeChatSearchQuery,
		presenceLabel,
		diffConvId,
		isActiveTab,
		effectiveStatus,
		setRewindDialogOpen,
		handleRewindRestored,
		rewindDialogOpen,
		rewindPreselect,
		sideChatsPluginEnabled,
		sideChatComposerDirectory,
		resolvedMentionItems,
		maybeHandleBtwCommand,
		dismissSideChat,
		stopSideChat,
		btwState,
		activePluginNote,
		setDismissedPluginNotes,
		tabWorktreeMode,
	} = scope;
	return (
		<McpFormOwnerProvider conversationId={convId} target={chatTarget}>
			<ArtifactHostContext.Provider value={artifactHostValue}>
				<ForkDialog
					onOpenChange={(open) => {
						if (!open) {
							setForkRequest(null);
						}
					}}
					onSelect={handleForkDestination}
					open={forkRequest !== null}
				/>
				{modelParametersDialog}
				{activeConversationId && !ghostChatActive ? (
					<ShareConversationDialog
						conversationId={activeConversationId}
						onOpenChange={setShareDialogOpen}
						open={shareDialogOpen}
						target={chatTarget}
						title={conversationTitle}
					/>
				) : null}
				<DrawesomeSketchDialog
					companion={drawesomeCompanion}
					onAttach={handleAttachSketch}
					onOpenChange={handleDrawesomeDialogOpenChange}
					open={drawesomeDialogOpen}
					sourceImage={drawesomeSourceImage ?? undefined}
				/>
				<ImageEditorDialog
					image={imageEditorAsset}
					onAiResize={handleAiResize}
					onClose={() => setImageEditorAsset(null)}
					onOpenDrawesome={drawesomeCompanion ? handleAnnotateImage : undefined}
					onUseInChat={(file) => addImages([file])}
					open={imageEditorAsset !== null}
				/>
				<WorkspaceRequiredDialog
					onFolderSelected={handleWorkspaceFolderSelected}
					onOpenChange={(open) => {
						if (!open) {
							setPendingWorkspaceMessage(null);
						}
					}}
					open={pendingWorkspaceMessage !== null}
				/>
				<WorkspacePanels
					agentActivityAvailable={Boolean(selectedAgent && !teamId)}
					agentActivityPanel={
						selectedAgent && !teamId ? (
							<AgentActivityPanel
								agent={selectedAgent}
								connectionPhase={connectionPhase}
								organizationId={activeNode.orgId ?? null}
								target={chatTarget}
							/>
						) : null
					}
					agentActivityRequest={agentActivityReq}
					artifactRequest={artifactReq}
					bottomOpen={bottomPanelOpen}
					collectionRequest={collectionReq}
					contextRequest={contextReq}
					contextView={{
						conversationId: activeConversationId ?? draftConvId.current,
						target: chatTarget,
						usage: contextUsage,
					}}
					cowork={coworkData}
					fileReviewRequest={fileReviewRequest}
					fileSearchRequest={fileSearchRequest}
					folder={chatFolder}
					onBottomOpenChange={setBottomPanelOpen}
					onRightOpenChange={setRightPanelOpen}
					renderPinnedSummary={
						pinnedSummaryVisible
							? ({ floating }) => (
									<PinnedSummaryPanel
										conversationId={convId ?? draftConvId.current}
										cowork={coworkData}
										folder={pinnedSummaryFolder}
										onAttachTextFile={handleAttachTextFile}
										onDismiss={floating ? dismissPinnedSummary : undefined}
										onHandOffToWorktree={handleHandOffToWorktree}
										onInterruptChat={handleStop}
										onWorktreeModeChange={handleWorktreeModeChange}
										pullRequestsEnabled={pullRequestsEnabled}
										showLineStats={interfaceLevel !== "simple"}
										target={chatTarget}
										worktreeModeOverride={tabWorktreeMode}
									/>
								)
							: null
					}
					rightOpen={rightPanelOpen}
					subagentRequest={subagentReq}
				>
					<div className="flex h-full flex-col overflow-hidden">
						<SubagentActivityChips
							onOpen={handleOpenSubagent}
							subagents={subagentSummaries}
						/>
						{/* custom drag/resize interaction */}
						<div
							className={`relative flex-1 overflow-hidden ${botProduct ? "" : "chat-page-titlebar-owner"}`}
							data-testid="chat-file-drop-zone"
							onDragLeave={handleDragLeave}
							onDragOver={handleDragOver}
							onDrop={handleDrop}
						>
							{chatSearch.open && (
								<ChatSearchBar
									activeMatchIndex={activeChatSearchMatchIndex}
									folderAvailable={Boolean(chatFolder)}
									matches={chatSearchMatches}
									mode={chatSearch.mode}
									onClose={closeChatSearch}
									onModeChange={changeChatSearchMode}
									onNextMatch={nextChatSearchMatch}
									onPreviousMatch={previousChatSearchMatch}
									onQueryChange={changeChatSearchQuery}
									query={chatSearch.query}
								/>
							)}
							{renderChatTranscript(scope, transcriptProps)}
							{/* The Pinned summary sidebar (project ▸ branch ▸ worktree + git
					    changes + commit & push) is rendered by WorkspacePanels via
					    renderPinnedSummary — docked column stacked with the right panel,
					    auto-demoted to a floating overlay when the chat gets narrow. */}
							{/* Multi-user presence: who else is in this conversation, and whether
					    they are typing. Hidden when alone (single-user flow unchanged). */}
							{presenceLabel && (
								<div
									aria-live="polite"
									className="absolute top-14 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center rounded-full bg-muted px-3 text-muted-foreground text-xs"
								>
									{presenceLabel}
								</div>
							)}
						</div>
						{diffConvId && (
							<div className="shrink-0 px-4 pb-3">
								<DiffReviewPane runId={diffConvId} target={chatTarget} />
								{interfaceLevel !== "simple" && !botProduct && (
									<div className="mt-2">
										<RunTracePanel runId={diffConvId} target={chatTarget} />
									</div>
								)}
							</div>
						)}
					</div>
					<McpForms
						conversationId={convId}
						enabled={Boolean(convId) && (isActiveTab || mcpAppHost)}
						target={chatTarget}
					/>
					<RewindDialog
						conversationId={activeConversationId ?? null}
						disabled={
							effectiveStatus === "streaming" || effectiveStatus === "submitted"
						}
						onOpenChange={setRewindDialogOpen}
						onRestored={handleRewindRestored}
						open={rewindDialogOpen}
						preselect={rewindPreselect}
						target={chatTarget}
					/>
					{sideChatsPluginEnabled && (
						<BtwOverlay
							composerMenuGroups={sideChatComposerDirectory.groups}
							mentionItems={resolvedMentionItems}
							onAsk={(question) => {
								maybeHandleBtwCommand(`/btw ${question}`);
							}}
							onClose={dismissSideChat}
							onStop={stopSideChat}
							state={btwState}
						/>
					)}
					{activePluginNote && (
						// A floating note (it stays until dismissed, so it is not an
						// auto-expiring toast): the popover surface and its own shadow.
						<div className="fixed bottom-28 left-1/2 z-50 w-[min(40rem,90vw)] -translate-x-1/2 rounded-xl border border-border bg-popover p-3 text-popover-foreground text-sm shadow-lg">
							<div className="mb-1 flex h-6 items-center justify-between">
								<span className="text-muted-foreground text-xs">
									{activePluginNote.question
										? "Action summary"
										: "Double-check"}
								</span>
								<Button
									onClick={() =>
										setDismissedPluginNotes((prev) => {
											const next = new Set(prev);
											next.add(activePluginNote.id);
											return next;
										})
									}
									size="xs"
									type="button"
									variant="ghost"
								>
									Dismiss
								</Button>
							</div>
							{activePluginNote.question && (
								<p className="mb-1 font-medium">{activePluginNote.question}</p>
							)}
							<p className="whitespace-pre-wrap">{activePluginNote.text}</p>
						</div>
					)}
				</WorkspacePanels>
			</ArtifactHostContext.Provider>
		</McpFormOwnerProvider>
	);
}
