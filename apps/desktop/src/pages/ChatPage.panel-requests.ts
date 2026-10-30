import type { FileEditUndoPlan } from "@ryu/blocks/desktop/agent-elements/turn-end-cards.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SubagentSummary } from "@/src/components/panels/CoworkContextPanel.tsx";
import type { FileReviewRequest } from "@/src/components/panels/WorkspacePanels.tsx";
import {
	invalidateGitStatus,
	invalidateWorktreeDiff,
	invalidateWorktreeStatus,
} from "@/src/hooks/useGitStatus.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { cancelChat } from "@/src/lib/api/chat.ts";
import { reverseGitEdits } from "@/src/lib/api/git.ts";
import type { ArtifactView } from "@/src/lib/live-artifacts.ts";
import { CHAT_RECOVERY_STOP_EVENT } from "@/src/lib/reconnect-retry.ts";
import { useChatHotkeyTargets } from "@/src/store/useChatHotkeyTargets.ts";
import { useFileTreeSearchStore } from "@/src/store/useFileTreeSearchStore.ts";
import type { useChatAnswerNow } from "./ChatPage.answer-now.ts";
import type { useChatPageChrome } from "./ChatPage.chrome.ts";
import type { useChatConversationState } from "./ChatPage.conversation-state.ts";
import type { useChatConversationSync } from "./ChatPage.conversation-sync.ts";
import { RESUME_STOP_GRACE_MS } from "./ChatPage.helpers.ts";
import type { useChatMediaAndVoice } from "./ChatPage.media-voice.ts";
import type { useChatModelSelection } from "./ChatPage.model-selection.ts";
import type { useChatResume } from "./ChatPage.resume.ts";
import type { useChatSideChats } from "./ChatPage.side-chats.ts";
import type { useChatTransport } from "./ChatPage.transport.ts";

export type UseChatPanelRequestsInput = ReturnType<typeof useChatPageChrome> &
	ReturnType<typeof useChatModelSelection> &
	ReturnType<typeof useChatConversationState> &
	ReturnType<typeof useChatConversationSync> &
	ReturnType<typeof useChatTransport> &
	ReturnType<typeof useChatMediaAndVoice> &
	ReturnType<typeof useChatResume> &
	ReturnType<typeof useChatAnswerNow> &
	ReturnType<typeof useChatSideChats>;

/** Panel open requests, file edit undo, stop, find in chat, and hotkeys. */
export function useChatPanelRequests({
	setRightPanelOpen,
	folder,
	convId,
	isTranscriptCurrent,
	chatTarget,
	convIdRef,
	handleOpenSideChatRequest,
	stop,
	resumeAbort,
	setResumeStreaming,
	resumeSuppressedUntil,
	draftConvId,
	chatTargetRef,
	setActiveChatSearchMatchIndex,
	setChatSearch,
	isActiveTab,
	effectiveStatus,
	voiceMode,
	showBottomPanelToggle,
	toggleBottomPanel,
	toggleRightPanel,
	fileSearchRequest,
	chatSearch,
}: UseChatPanelRequestsInput) {
	const tl = useLiteralMessages();
	// `tl` is a fresh function on every render; memos and callbacks read it
	// through this ref so their identities stay stable.
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// Open a spawned subagent's transcript in the right panel. The nonce makes each
	// click a distinct request so re-selecting the same subagent re-focuses the tab;
	// opening the right panel auto-hides the (overlapping) pinned summary card.
	const [subagentReq, setSubagentReq] = useState<{
		id: string;
		nonce: number;
	} | null>(null);
	const subagentNonce = useRef(0);
	const handleOpenSubagent = useCallback((subagent: SubagentSummary) => {
		subagentNonce.current += 1;
		setSubagentReq({
			id: subagent.id,
			nonce: subagentNonce.current,
		});
		setRightPanelOpen(true);
	}, []);

	const [agentActivityReq, setAgentActivityReq] = useState<{
		nonce: number;
	} | null>(null);
	const agentActivityNonce = useRef(0);
	const handleOpenAgentActivity = useCallback(() => {
		agentActivityNonce.current += 1;
		setAgentActivityReq({ nonce: agentActivityNonce.current });
		setRightPanelOpen(true);
	}, []);

	// Capped pinned-summary sections open their complete live collections in
	// reusable workspace tabs. One nonce stream is enough because the request also
	// carries the collection kind.
	const [collectionReq, setCollectionReq] = useState<{
		kind: "sources" | "subagents";
		nonce: number;
	} | null>(null);
	const collectionNonce = useRef(0);
	const openCollection = useCallback((kind: "sources" | "subagents") => {
		collectionNonce.current += 1;
		setCollectionReq({ kind, nonce: collectionNonce.current });
		setRightPanelOpen(true);
	}, []);
	const handleOpenSources = useCallback(
		() => openCollection("sources"),
		[openCollection]
	);
	const handleOpenSubagents = useCallback(
		() => openCollection("subagents"),
		[openCollection]
	);

	// Open a rendered/canvas artifact in the right panel — the same nonce flow as
	// the subagent, but WorkspacePanels opens ONE DEDICATED TAB per artifact (no
	// one-at-a-time limit), so clicking a second artifact stacks it alongside the
	// first rather than replacing it.
	const [artifactReq, setArtifactReq] = useState<{
		artifact: ArtifactView;
		nonce: number;
	} | null>(null);
	const artifactNonce = useRef(0);
	const handleOpenArtifact = useCallback((artifact: ArtifactView) => {
		artifactNonce.current += 1;
		setArtifactReq({ artifact, nonce: artifactNonce.current });
		setRightPanelOpen(true);
	}, []);

	// Open the context-window breakdown in the right panel (composer ring click).
	// Same nonce-per-click flow as the subagent tab, but the request carries no
	// payload: the panel reads `contextView` live so it keeps tracking the
	// conversation instead of freezing at the moment it was opened.
	const [contextReq, setContextReq] = useState<{ nonce: number } | null>(null);
	const contextNonce = useRef(0);
	const handleOpenContext = useCallback(() => {
		contextNonce.current += 1;
		setContextReq({ nonce: contextNonce.current });
		setRightPanelOpen(true);
	}, []);

	const [fileReviewRequest, setFileReviewRequest] =
		useState<FileReviewRequest | null>(null);
	const fileReviewNonce = useRef(0);
	const handleReviewFileEdits = useCallback((paths: string[]) => {
		fileReviewNonce.current += 1;
		setFileReviewRequest({ nonce: fileReviewNonce.current, paths });
		setRightPanelOpen(true);
	}, []);
	// A completed HTTP mutation still belongs to the workspace/connection that
	// started it. A → B → A must not re-adopt the first A's acknowledgement.
	const fileUndoOwner = useMemo(
		() => ({ folder, conversationId: convId, isTranscriptCurrent }),
		[folder, convId, isTranscriptCurrent]
	);
	const fileUndoOwnerRef = useRef(fileUndoOwner);
	fileUndoOwnerRef.current = fileUndoOwner;
	const handleUndoFileEdits = useCallback(
		async (plan: FileEditUndoPlan) => {
			if (!folder) {
				throw new Error("Open the project folder before undoing this turn.");
			}
			const ownsResult = () =>
				fileUndoOwnerRef.current === fileUndoOwner &&
				fileUndoOwner.isTranscriptCurrent();
			if (!ownsResult()) {
				return;
			}
			let result: Awaited<ReturnType<typeof reverseGitEdits>>;
			try {
				result = await reverseGitEdits(chatTarget, folder, plan);
			} catch (error) {
				if (!ownsResult()) {
					return;
				}
				throw error;
			}
			if (!ownsResult()) {
				return;
			}
			if (result.kind === "conflict") {
				const reason =
					result.reason === "staged_changes"
						? "One of these files has staged changes. Unstage it before retrying."
						: result.reason === "unsupported_file"
							? "One of these files is not reversible text."
							: "The edited text changed after this turn. No files were changed.";
				throw new Error(reason);
			}
			invalidateGitStatus();
			if (fileUndoOwner.conversationId) {
				invalidateWorktreeStatus(fileUndoOwner.conversationId);
				invalidateWorktreeDiff(fileUndoOwner.conversationId);
			}
			toast.success(
				result.paths.length === 1
					? "Turn edit undone"
					: tlRef.current("{count} turn edits undone", {
							count: String(result.paths.length),
						})
			);
		},
		[chatTarget, fileUndoOwner, folder]
	);
	// Close the review pane when THIS tab's conversation (or the workspace)
	// changes. Never key this on the shared focused-tab `activeConversationId`:
	// every chat tab stays mounted, so focusing another tab would close the open
	// review pane of every background tab.
	useEffect(() => {
		setFileReviewRequest(null);
	}, [convId, folder]);

	// Sidebar → side chat: the sidebar selects the thread then dispatches this
	// event. Only the tab whose conversation matches opens the overlay; if the
	// tab is still mounting (convId not yet set), stash it and flush once convId
	// catches up. Mirrors the run-notification-click decoupling below.
	const pendingSideChatRef = useRef<{
		conversationId: string;
		entry?: BtwEntry;
	} | null>(null);
	useEffect(() => {
		const handler = (e: Event) => {
			const detail =
				/* SAFETY: Both AppSidebar.tsx ryu:open-side-chat publishers construct native CustomEvent detail with a string conversationId and the optional complete BtwEntry argument; this listener retains that full payload. */ (
					e as CustomEvent<{ conversationId: string; entry?: BtwEntry }>
				).detail;
			if (!detail?.conversationId) {
				return;
			}
			if (detail.conversationId === convIdRef.current) {
				handleOpenSideChatRequest(detail.entry);
			} else {
				// Another tab (or one still mounting) — stash it, keyed by the target
				// conversation so only the matching tab flushes it.
				pendingSideChatRef.current = detail;
			}
		};
		window.addEventListener("ryu:open-side-chat", handler);
		return () => window.removeEventListener("ryu:open-side-chat", handler);
	}, [handleOpenSideChatRequest]);

	// Flush a pending side chat once this tab's conversation matches the one the
	// sidebar asked to open (exact id match, so other tabs never steal it).
	useEffect(() => {
		const pending = pendingSideChatRef.current;
		if (pending && pending.conversationId === convId) {
			pendingSideChatRef.current = null;
			handleOpenSideChatRequest(pending.entry);
		}
	}, [convId, handleOpenSideChatRequest]);

	// Stop the current stream. Aborting the SSE (`stop()`) only halts the client's
	// read — an ACP agent keeps running to completion server-side — so we ALSO ask
	// Core to cancel the live turn for this conversation. Best-effort: the endpoint
	// returns `{ cancelled: false }` when there is no live turn, and any error is
	// ignored so Stop always feels instant. The id is the same session key sent as
	// `conversation_id` on each turn.
	const handleStop = useCallback(() => {
		stop();
		// A resumed turn is read by our own fetch, not by useChat — `stop()` does
		// not touch it, so abort that reader explicitly or Stop would look dead.
		resumeAbort.current?.abort();
		setResumeStreaming(false);
		resumeSuppressedUntil.current = Date.now() + RESUME_STOP_GRACE_MS;
		const conversationId = convIdRef.current ?? draftConvId.current;
		window.dispatchEvent(
			new CustomEvent(CHAT_RECOVERY_STOP_EVENT, {
				detail: { conversationId, nodeUrl: chatTargetRef.current.url },
			})
		);
		cancelChat(chatTargetRef.current, conversationId).catch(() => {
			// No live turn (or Core unreachable) — the SSE abort above still stands.
		});
	}, [stop]);

	const toggleChatSearch = useCallback(() => {
		setActiveChatSearchMatchIndex(0);
		setChatSearch((current) =>
			current.open
				? {
						...current,
						mode: current.mode === "chat" ? "files" : "chat",
						nonce: current.nonce + 1,
					}
				: {
						...current,
						mode: "chat",
						nonce: current.nonce + 1,
						open: true,
						query: "",
					}
		);
	}, []);

	// Publish this tab's chat-owned shortcut handlers while it is the FOCUSED tab.
	// Every chat tab stays mounted, and the hotkey provider keeps one handler per
	// action id (last-writer-wins), so binding `chat.stop` inside ChatPage would
	// let a hidden tab own it and abort the wrong stream. Layout binds the ids
	// once and reads this slot; the owner token means a deactivating tab only
	// clears the slot when a newer tab has not already claimed it.
	const hotkeyOwner = useId();
	const publishHotkeyTargets = useChatHotkeyTargets((s) => s.publish);
	const clearHotkeyTargets = useChatHotkeyTargets((s) => s.clearIfOwner);
	const publishFileTreeSearch = useFileTreeSearchStore((s) => s.publish);
	const clearFileTreeSearch = useFileTreeSearchStore((s) => s.clearIfOwner);
	useEffect(() => {
		if (!isActiveTab) {
			clearHotkeyTargets(hotkeyOwner);
			clearFileTreeSearch(hotkeyOwner);
			return;
		}
		publishHotkeyTargets(hotkeyOwner, {
			// `effectiveStatus`, not `status`: a resumed turn streams outside
			// useChat, and Stop must stay live for it.
			isStreaming:
				effectiveStatus === "streaming" || effectiveStatus === "submitted",
			stop: handleStop,
			startVoiceMode: voiceMode.start,
			toggleBottomPanel: showBottomPanelToggle ? toggleBottomPanel : null,
			toggleRightPanel,
			toggleSearch: toggleChatSearch,
		});
		publishFileTreeSearch(hotkeyOwner, fileSearchRequest);
		return () => {
			clearHotkeyTargets(hotkeyOwner);
			clearFileTreeSearch(hotkeyOwner);
		};
	}, [
		chatSearch,
		clearFileTreeSearch,
		fileSearchRequest,
		isActiveTab,
		hotkeyOwner,
		effectiveStatus,
		handleStop,
		voiceMode.start,
		toggleChatSearch,
		showBottomPanelToggle,
		toggleBottomPanel,
		toggleRightPanel,
		publishHotkeyTargets,
		publishFileTreeSearch,
		clearHotkeyTargets,
	]);
	return {
		subagentReq,
		handleOpenSubagent,
		agentActivityReq,
		handleOpenAgentActivity,
		collectionReq,
		handleOpenSources,
		handleOpenSubagents,
		artifactReq,
		handleOpenArtifact,
		contextReq,
		handleOpenContext,
		fileReviewRequest,
		handleReviewFileEdits,
		handleUndoFileEdits,
		handleStop,
	} as const;
}
