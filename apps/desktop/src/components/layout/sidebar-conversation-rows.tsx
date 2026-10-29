import {
	type AvatarConversationState,
	avatarStateFromRunStatus,
} from "@ryu/ui/components/avatar-conversation.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties as LayoutCSSProperties } from "react";
import layoutStyles from "./sidebar-conversation-rows.module.css";
// Conversation rows for the desktop sidebar.
//
// AppSidebar owns the conversation state and callbacks. This module owns only
// the row-level rendering and local disclosure state, so group/list composition
// can remain with the sidebar section that supplies it.

import {
	Archive01Icon,
	ArchiveRestoreIcon,
	ArrowDown01Icon,
	ArrowUpRight01Icon,
	Calendar04Icon,
	ClipboardIcon,
	Copy01Icon,
	Delete01Icon,
	Folder01Icon,
	FolderTreeIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	ImageAdd01Icon,
	LaptopIcon,
	LinkSquare02Icon,
	Mail01Icon,
	MailReply01Icon,
	MessageQuestionIcon,
	MoreHorizontalIcon,
	PencilEdit01Icon,
	PinIcon,
	PinOffIcon,
	UserMultiple02Icon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChatDisplayPrefs } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { resolveRnpNode } from "@ryuhq/protocol/continuity";
import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";
import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ContinuedOnBadge } from "@/src/components/chat/ContinuedOnBanner.tsx";
import { ContinueOnNodeDialog } from "@/src/components/chat/ContinueOnNodeDialog.tsx";
import type { ForkDestination } from "@/src/components/chat/ForkDialog.tsx";
import {
	GitPullRequestStatusIcon,
	GitPullRequestSummary,
} from "@/src/components/panels/GitPullRequestSummary.tsx";
import {
	useOptionalChatHistoryContext,
	useRunningMainThreadIds,
} from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import {
	useGitPullRequest,
	useLinkedPullRequest,
	useLinkedPullRequestStatus,
} from "@/src/hooks/useGitPullRequest.ts";
import { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import { useModifierClickHold } from "@/src/hooks/useModifierClickHold.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useQuickPreviewModifier } from "@/src/hooks/useQuickPreviewModifier.ts";
import {
	quickReplyModifierMatches,
	readQuickReplyModifier,
} from "@/src/hooks/useQuickReplyModifier.ts";
import { useSidebarChatPreview } from "@/src/hooks/useSidebarChatPreview.ts";
import {
	conversationParticipantIds,
	isForkedConversation,
	isGroupConversation,
} from "@/src/lib/agent-conversation-groups.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { listBtw } from "@/src/lib/api/btw.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	clearRnpContinued,
	workspaceErrorMessage,
} from "@/src/lib/api/continuity-workspace.ts";
import {
	getConversationTitleHistory,
	type TitleHistoryEntry,
} from "@/src/lib/api/conversation-flags.ts";
import {
	getConversationLearningExclusion,
	setConversationLearningExclusion,
} from "@/src/lib/api/learn.ts";
import {
	type PluginContextMenuItem,
	pluginHostInvoke,
} from "@/src/lib/api/plugins.ts";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import { copyChatTranscriptAsMarkdown } from "@/src/lib/copy-chat-transcript.ts";
import { folderKey } from "@/src/lib/folder-path.ts";
import {
	RESOURCE_VISIBILITY_DND_MIME,
	type ResourceVisibility,
	resourceVisibilityDndMime,
	resourceVisibilityGroup,
	serializeVisibilityDragPayload,
	type VisibilityChangeRequest,
} from "@/src/lib/resource-visibility.ts";
import { buildSidebarConversationPreviewStates } from "@/src/lib/sidebar-conversation-preview.ts";
import { compactAge } from "@/src/lib/time.ts";
import { recordChatBranchPullRequest } from "@/src/store/useChatPullRequestIndex.ts";
import { useConversationFlagsStore } from "@/src/store/useConversationFlagsStore.ts";
import { type Node, useNodeStore } from "@/src/store/useNodeStore.ts";
import type { Conversation, Message } from "@/types/chat.ts";
import { EntityIconDialog } from "./EntityIconDialog.tsx";
import { LinkedPullRequestsDialog } from "./LinkedPullRequestsDialog.tsx";
import {
	OpenInNewWindowContextMenuItem,
	OpenInNewWindowDropdownMenuItem,
} from "./OpenInNewWindowMenuItem.tsx";
import { FadeLabel, OverflowTooltip } from "./overflow-tooltip.tsx";
import { ResourceVisibilityIndicator } from "./ResourceVisibilityIndicator.tsx";
import { SidebarTodoProgress } from "./SidebarTodoProgress.tsx";
import {
	ChatRowSubAccordion,
	SidebarChatMessages,
} from "./sidebar-chat-messages.tsx";
import {
	applySidebarChatArrowKey,
	applySidebarChatSelectionClick,
	clearSidebarChatSelection,
	endSidebarChatDrag,
	type SidebarChatBulkActions,
	SidebarChatBulkContextMenuContent,
	sidebarChatRowAttributes,
	startSidebarChatDrag,
	useSidebarChatSelection,
} from "./sidebar-chat-selection.tsx";
import { SidebarConversationPreview } from "./sidebar-conversation-preview.tsx";
import { groupAvatarPositions } from "./sidebar-group-avatar.ts";
import {
	SidebarItemPreview,
	SidebarPreviewMeta,
	SidebarPreviewTitle,
	SidebarPreviewTitleHistory,
} from "./sidebar-item-preview.tsx";
import { sidebarUnreadRowAttributes } from "./sidebar-more-unreads.tsx";

const PATH_SEP_RE = /[\\/]/;
// How long the pointer must rest on a chat row before its history is prefetched.
const HOVER_PREFETCH_DELAY_MS = 100;

export function UnreadMessageCountBadge({
	conversationId,
	count,
}: {
	conversationId: string;
	count: number;
}) {
	if (count <= 0) {
		return null;
	}

	const label = `${count} unread ${count === 1 ? "message" : "messages"}`;
	return (
		<span
			aria-atomic="true"
			aria-label={label}
			className="type-micro flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 font-semibold text-primary-foreground tabular-nums leading-none"
			data-testid={`sidebar-unread-count-${conversationId}`}
			role="status"
			title={label}
		>
			<span className={count >= 10 ? "relative top-px" : undefined}>
				{count > 99 ? "99+" : count}
			</span>
		</span>
	);
}

async function copyChatValue(value: string, success: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(value);
		toast.success(success);
	} catch {
		toast.error("Couldn't copy to clipboard");
	}
}

export interface ProjectMoveTarget {
	name: string;
	/** The project's primary folder; the chat's folder becomes this. */
	path: string;
	/** Every folder the project groups, primary first. */
	sourceFolders: readonly string[];
}

/** Projects a chat can move into: every project except the one it is in.
 * Compared by folder, never by name: two projects can share a leaf name. */
function moveTargetsFor(
	targets: readonly ProjectMoveTarget[],
	folderPath: string | null
): readonly ProjectMoveTarget[] {
	if (!folderPath) {
		return targets;
	}
	const current = folderKey(folderPath);
	return targets.filter(
		(target) =>
			!target.sourceFolders.some((folder) => folderKey(folder) === current)
	);
}

export interface ChatRowHandlers {
	activeConversationId: string | null;
	agents: AgentSummary[];
	archivedIds: Set<string>;
	/** Multi-select bulk actions and drop targets; omitted where rows render
	 *  outside the sidebar (stories), which disables multi-select gestures. */
	bulk?: SidebarChatBulkActions;
	/** UI courtesy; Core remains the authority for this admin-only transition. */
	canMakePrivate: boolean;
	loadMessages: (id: string) => Promise<Message[]>;
	onAddScheduledTask: (id: string) => void;
	onAutoRenameConversation?: (id: string) => Promise<string>;
	onDeleteConversation: (id: string) => void;
	onForkConversation: (id: string, destination: ForkDestination) => void;
	onJumpToMessage: (conversationId: string, messageId: string) => void;
	onMarkRead: (id: string) => void;
	onMarkUnread: (id: string) => void;
	/** Re-file the chat under the folder project rooted at `path`. */
	onMoveToProject: (id: string, path: string) => void;
	onOpenInNewTab: (id: string) => void;
	onOpenInNewWindow: (id: string) => void;
	/** Open an empty side chat composer for this conversation. */
	onOpenNewSideChat: (conversationId: string) => void;
	/** Open a read-only, non-selecting long-press conversation preview. */
	onOpenQuickPreview?: (id: string) => void;
	onOpenQuickReply: (id: string) => void;
	/** Open a persisted side chat: select the thread + surface it in the overlay. */
	onOpenSideChat: (conversationId: string, entry: BtwEntry) => void;
	onRemoveFromProject: (id: string) => void;
	onRenameConversation: (id: string, title: string) => void;
	/** Open the confirmation flow for an owner-only/team visibility change. */
	onRequestConversationVisibility: (request: VisibilityChangeRequest) => void;
	onSelectConversation: (id: string) => void;
	/** Set or clear a conversation's Notion-style glyph. */
	onSetConversationIcon: (id: string, icon: GlyphValue) => void;
	onToggleArchive: (id: string) => void;
	onTogglePin: (id: string) => void;
	pinnedIds: Set<string>;
	projectNameForFolder: (folderPath: string) => string;
	/** Folder projects a chat can be moved into, in sidebar order. */
	projectTargets: readonly ProjectMoveTarget[];
	/** Whether the app-owned GitHub provider can answer PR/check lookups. */
	pullRequestsEnabled?: boolean;
	/** Whether the Calendar app owns the scheduled-task affordance. */
	schedulingEnabled?: boolean;
	/** Whether the Side Chats plugin owns the nested side-chat affordance. */
	sideChatsEnabled?: boolean;
	/** Node target for lazily listing a conversation's side chats. */
	target: ApiTarget;
	unreadIds: Set<string>;
}

/** Lazily-loaded list of a conversation's persisted `/btw` side chats, shown
 *  indented under its row. Only mounted when the row is expanded, so collapsed
 *  rows never hit Core. Reads the node target through a ref so the fresh
 *  `toTarget()` object identity each render doesn't retrigger the fetch (see the
 *  desktop target-object deps gotcha). */
export function SidebarSideChats({
	conversationId,
	target,
	onOpen,
}: {
	conversationId: string;
	onOpen: (entry: BtwEntry) => void;
	target: ApiTarget;
}) {
	const [entries, setEntries] = useState<BtwEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		const controller = new AbortController();
		listBtw(targetRef.current, conversationId, controller.signal)
			.then((list) => {
				if (!controller.signal.aborted) {
					setEntries(list);
				}
			})
			.catch(() => {
				/* treated as no side chats */
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [conversationId]);

	if (loading) {
		return <p className="py-1 pl-8 text-muted-foreground text-xs">Loading…</p>;
	}
	if (entries.length === 0) {
		return (
			<p className="py-1 pl-8 text-muted-foreground text-xs">No side chats</p>
		);
	}
	return (
		<div className="relative ml-2 border-sidebar-border/70 border-l pl-2">
			<SidebarMenu>
				{entries.map((entry) => {
					const answerPreview = entry.answer.split(/\r?\n/)[0]?.trim() ?? "";
					const kindLabel =
						entry.kind === "subagent" ? "Subagent" : "Side chat";
					return (
						<SidebarMenuItem key={entry.id}>
							<button
								aria-label={`Open ${kindLabel.toLowerCase()}: ${entry.question}`}
								className="group relative flex min-h-10 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
								onClick={() => onOpen(entry)}
								type="button"
							>
								<span
									aria-hidden="true"
									className="absolute top-3 -left-[5px] size-2 rounded-full bg-primary ring-2 ring-sidebar"
								/>
								<HugeiconsIcon
									className="mt-0.5 size-3.5 shrink-0 text-primary/75"
									icon={MessageQuestionIcon}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex min-w-0 items-center gap-1.5">
										<OverflowTooltip
											className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium text-foreground/85 text-xs"
											fade
											text={entry.question}
										/>
										<span className="type-compact shrink-0 text-muted-foreground/60">
											{compactAge(entry.created_at)}
										</span>
									</span>
									<span className="type-compact mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground/65">
										<span className="shrink-0">{kindLabel}</span>
										{answerPreview && (
											<OverflowTooltip
												className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
												fade
												text={answerPreview}
											/>
										)}
									</span>
								</span>
							</button>
						</SidebarMenuItem>
					);
				})}
			</SidebarMenu>
		</div>
	);
}

/** Lazily loads title history for the chat-row hover preview. */
function ChatTitleHistoryPreview({
	conversationId,
	target,
}: {
	conversationId: string;
	target: ApiTarget;
}) {
	const [entries, setEntries] = useState<TitleHistoryEntry[]>([]);
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		let cancelled = false;
		getConversationTitleHistory(targetRef.current, conversationId).then(
			(rows) => {
				if (!cancelled) {
					setEntries(rows);
				}
			}
		);
		return () => {
			cancelled = true;
		};
	}, [conversationId]);

	return <SidebarPreviewTitleHistory entries={entries} />;
}

/** Remember the pull request a chat's branch owns so chat search can match its
 * number (see `useChatPullRequestIndex`). */
function useRecordBranchPullRequest(
	conversationId: string,
	url: string | undefined
) {
	useEffect(() => {
		if (url) {
			recordChatBranchPullRequest(conversationId, url);
		}
	}, [conversationId, url]);
}

/** App-owned PR/CI metadata for a chat's hover card. The child is mounted only
 * when the preview opens, so a long sidebar does not wake the Pull Requests
 * sidecar for every row. */
function SidebarGitPullRequestPreview({
	branch,
	conversationId,
	cwd,
	showStatusIcon,
	target,
}: {
	branch: string | null;
	conversationId: string;
	cwd: string | null;
	showStatusIcon: boolean;
	target: ApiTarget;
}) {
	const { data, isLoading } = useGitPullRequest(
		target,
		cwd,
		branch,
		Boolean(cwd && branch),
		"all"
	);
	useRecordBranchPullRequest(conversationId, data?.url);
	if (isLoading) {
		return (
			<div className="border-border/60 border-t pt-2 text-muted-foreground text-xs">
				Checking GitHub…
			</div>
		);
	}
	if (!data) {
		return null;
	}
	return (
		<div className="border-border/60 border-t pt-2">
			<GitPullRequestSummary
				pullRequest={data}
				showStatusIcon={showStatusIcon}
			/>
		</div>
	);
}

/** Hover-card summary for one pull request explicitly linked to the chat. */
function SidebarLinkedPullRequestPreview({
	showStatusIcon,
	target,
	url,
}: {
	showStatusIcon: boolean;
	target: ApiTarget;
	url: string;
}) {
	const { data } = useLinkedPullRequest(target, url, true);
	if (!data) {
		return null;
	}
	return (
		<div className="border-border/60 border-t pt-2">
			<GitPullRequestSummary
				pullRequest={data}
				showStatusIcon={showStatusIcon}
			/>
		</div>
	);
}

/** Row status icon for one explicitly linked pull request. Reads the light
 * status route, shared with the automation watcher's cache entry. */
function SidebarLinkedPullRequestStatus({
	target,
	url,
}: {
	target: ApiTarget;
	url: string;
}) {
	const { data } = useLinkedPullRequestStatus(target, url, true);
	if (!data) {
		return null;
	}
	return (
		<a
			aria-label={`Open pull request: ${data.title}`}
			className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			href={safeHttpUrl(data.url) ?? undefined}
			onClick={(event) => event.stopPropagation()}
			rel="noopener noreferrer"
			target="_blank"
		>
			<GitPullRequestStatusIcon pullRequest={data} />
		</a>
	);
}

/** Linked pull requests shown as row icons before the rest collapse. */
const MAX_LINKED_PULL_REQUEST_ICONS = 3;

function SidebarGitPullRequestStatus({
	branch,
	conversationId,
	cwd,
	target,
}: {
	branch: string;
	conversationId: string;
	cwd: string;
	target: ApiTarget;
}) {
	const { data } = useGitPullRequest(target, cwd, branch, true, "all");
	useRecordBranchPullRequest(conversationId, data?.url);
	if (!data) {
		return null;
	}
	return (
		<a
			aria-label={`Open pull request: ${data.title}`}
			className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			href={safeHttpUrl(data.url) ?? undefined}
			onClick={(event) => event.stopPropagation()}
			rel="noopener noreferrer"
			target="_blank"
		>
			<GitPullRequestStatusIcon pullRequest={data} />
		</a>
	);
}

/** Cells in a group tile's 2x2 grid. Up to this many participants each get a
 *  cell; past it, the bottom-right cell turns into a "+N" count of the rest. */
const GROUP_AVATAR_CELLS = 4;

/** Grid of participant avatars for a multi-agent conversation: up to four
 *  avatars fill the 2x2 grid; a larger group shows three (top-left, top-right,
 *  bottom-left) and counts the rest in the bottom-right cell ("+N"). It stays
 *  legible at the 16px disclosure size and makes a council/team thread read as
 *  a group before its title is read. */
export function ParticipantOrbitAvatar({
	conversationState,
	participants,
	agents,
	size = "sm",
}: {
	agents: AgentSummary[];
	participants: string[];
	conversationState?: AvatarConversationState;
	size?: "md" | "sm";
}) {
	const large = size === "md";
	const members = participants
		.map((id) => agents.find((agent) => agent.id === id))
		.filter((agent): agent is AgentSummary => Boolean(agent));
	if (members.length === 0) {
		return (
			<HugeiconsIcon
				aria-label={`${participants.length} participants`}
				className={
					large
						? "size-8 text-muted-foreground"
						: "size-4 text-muted-foreground"
				}
				icon={UserMultiple02Icon}
			/>
		);
	}
	const shown = members.slice(
		0,
		participants.length > GROUP_AVATAR_CELLS
			? GROUP_AVATAR_CELLS - 1
			: GROUP_AVATAR_CELLS
	);
	const hiddenCount = participants.length - shown.length;
	const positions = groupAvatarPositions(shown.length, hiddenCount);
	const cell = `absolute flex items-center justify-center overflow-hidden rounded-full ring-1 ring-sidebar ${large ? "size-5 ring-2" : "size-2.5"}`;
	return (
		<span
			aria-label={`${participants.length} participants`}
			className={`relative flex shrink-0 ${large ? "size-9" : "size-4"}`}
			role="img"
			title={`${participants.length} participants`}
		>
			{shown.map((agent, index) => {
				const cssVariables1: LayoutCssVariables = {
					"--desktop-inline1-z-Index": shown.length - index,
				};
				return (
					<span
						className={cn(
							`${cell} bg-sidebar ${positions[index]}`,
							layoutStyles.inline1
						)}
						key={agent.id}
						style={cssVariables1}
					>
						<AgentAvatar
							className={`${large ? "size-5" : "size-2.5"} object-cover`}
							conversationState={conversationState}
							engine={engineForAgent(agent)}
							glyph={agent.avatarGlyph}
							presentation="portrait"
							size={large ? "20px" : "10px"}
						/>
					</span>
				);
			})}
			{hiddenCount > 0 ? (
				<span
					aria-hidden="true"
					className={`${cell} right-0 bottom-0 bg-muted font-medium text-muted-foreground tabular-nums leading-none ${large ? "text-[9px]" : "text-[5px]"}`}
				>
					+{Math.min(hiddenCount, 99)}
				</span>
			) : null}
		</span>
	);
}

/** A single-line chat row, Codex style: title only, actions on hover.
 *
 *  Exported for `e2e/harness/chat-row-menus-story.tsx`, which mounts the real row
 *  to prove its ⋯ dropdown and its right-click menu list the SAME app-contributed
 *  rows — a fact no type-check can see, and one the two menus had already lost. */
export function ChatRow({
	conv,
	handlers,
}: {
	conv: Conversation;
	handlers: ChatRowHandlers;
}) {
	const { openTab } = useTabsContext();
	const resolveConfiguredNodes = useCallback(
		() => useNodeStore.getState().nodes,
		[]
	);
	const {
		activeConversationId,
		agents,
		archivedIds,
		pinnedIds,
		unreadIds,
		loadMessages,
		onAddScheduledTask,
		onDeleteConversation,
		onForkConversation,
		onJumpToMessage,
		onMarkRead,
		onMarkUnread,
		onOpenQuickReply,
		onOpenInNewTab,
		onOpenInNewWindow,
		onOpenNewSideChat,
		onOpenQuickPreview,
		onOpenSideChat,
		onAutoRenameConversation,
		onRenameConversation,
		onMoveToProject,
		onRemoveFromProject,
		onSelectConversation,
		onSetConversationIcon,
		onToggleArchive,
		onTogglePin,
		projectNameForFolder,
		projectTargets,
		pullRequestsEnabled = false,
		schedulingEnabled = true,
		target,
		sideChatsEnabled = true,
	} = handlers;
	const [isRetitling, setIsRetitling] = useState(false);
	const retitlingRef = useRef(false);
	const autoRename = () => {
		if (retitlingRef.current || !onAutoRenameConversation) {
			return;
		}
		retitlingRef.current = true;
		setIsRetitling(true);
		const pending = onAutoRenameConversation(conv.id).finally(() => {
			retitlingRef.current = false;
			setIsRetitling(false);
		});
		toast.promise(pending, {
			loading: "Renaming chat…",
			success: (title: string) => `Renamed to "${title}"`,
			error: (error) =>
				error instanceof ApiError
					? (error.serverMessage ?? "Couldn't auto-rename chat")
					: error instanceof Error
						? error.message
						: "Couldn't auto-rename chat",
		});
	};
	const isActive = activeConversationId === conv.id;
	// Fetch the thread's newest page once the pointer rests on the row (or the
	// row takes focus), so opening it renders without the history skeleton.
	// The short delay keeps a pointer sweeping down the list from fetching
	// every row it crosses.
	const chatHistory = useOptionalChatHistoryContext();
	const prefetchConversation = chatHistory?.prefetchConversation;
	const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const cancelPrefetch = () => {
		if (prefetchTimerRef.current) {
			clearTimeout(prefetchTimerRef.current);
			prefetchTimerRef.current = null;
		}
	};
	const schedulePrefetch = () => {
		if (!prefetchConversation || isActive || prefetchTimerRef.current) {
			return;
		}
		prefetchTimerRef.current = setTimeout(() => {
			prefetchTimerRef.current = null;
			prefetchConversation(conv.id);
		}, HOVER_PREFETCH_DELAY_MS);
	};
	useEffect(
		() => () => {
			if (prefetchTimerRef.current) {
				clearTimeout(prefetchTimerRef.current);
			}
		},
		[]
	);
	const isUnread = unreadIds.has(conv.id);
	const unreadMessageCount = useConversationFlagsStore((state) =>
		state.unreadIds.has(conv.id)
			? (state.unreadMessageCounts.get(conv.id) ?? 1)
			: 0
	);
	const isPinned = pinnedIds.has(conv.id);
	const isArchived = archivedIds.has(conv.id);
	const bulk = handlers.bulk;
	const isSelected = useSidebarChatSelection((state) =>
		state.selectedIds.has(conv.id)
	);
	// Size of the selection this row belongs to (0 when unselected), so only
	// selected rows re-render as the selection grows.
	const bulkSelectionSize = useSidebarChatSelection((state) =>
		state.selectedIds.has(conv.id) ? state.selectedIds.size : 0
	);
	const showBulkMenu = Boolean(bulk) && bulkSelectionSize > 1;
	const runStatus = conversationRunStatusMeta(conv.runStatus);
	const [showSidebarChatPreview] = useSidebarChatPreview();
	const [quickPreviewModifier] = useQuickPreviewModifier();
	const interfaceLevel = useInterfaceLevel();
	const { animationsEnabled } = useChatDisplayPrefs();
	const sidebarPreviewStates = buildSidebarConversationPreviewStates({
		lastMessage: conv.lastMessage,
		lastMessageRole: conv.lastMessageRole,
		statusLabel: runStatus?.label,
		statusVisible: runStatus?.isRunning || runStatus?.needsAttention,
	});
	// A state that cannot make progress without attention badges itself even when
	// the chat is read. In particular, interrupted is not failed: it is a partial
	// reply Core recovered after the local engine stopped, and it cannot auto-resume.
	const showDot = runStatus?.needsAttention === true;
	// A main thread shows the live spinner while any session it spawned runs,
	// since those sessions are not rows of their own.
	const sessionRunning = useRunningMainThreadIds().has(conv.id);
	const isRunning = runStatus?.isRunning === true || sessionRunning;
	// Who last took this thread. The row leads with that agent's mark — the same
	// avatar the Messages sub-accordion puts on each turn — so a sidebar full of
	// chats says WHO is on each one before it says anything else.
	//
	// A council thread (more than one participant) reads its LAST entry: Core
	// appends on join and never sorts (`add_participant`), so that is the most
	// recent joiner. Anything else prefers `agentId`, which tracks the agent the
	// chat is bound to NOW — on a thread whose agent was swapped, a one-entry
	// participants list still holds the original.
	const participants = conv.participants ?? [];
	const groupConversation = isGroupConversation(conv);
	const latestAgentId =
		participants.length > 1
			? participants.at(-1)
			: (conv.agentId ?? participants[0] ?? null);
	const latestAgent = latestAgentId
		? agents.find((a) => a.id === latestAgentId)
		: undefined;
	// Ring colour matches the surface the badge sits ON, which is the sidebar at
	// rest and `muted` once the row is hovered or active — a fixed sidebar-coloured
	// ring would read as a mis-tinted halo on exactly the row being pointed at.
	const dotRingClass = isActive
		? "ring-2 ring-muted"
		: "ring-2 ring-sidebar group-hover/row:ring-muted";

	const pinLabel = isPinned ? "Unpin" : "Pin";
	const pinIcon = isPinned ? PinOffIcon : PinIcon;
	const archiveLabel = isArchived ? "Unarchive" : "Archive";
	const archiveIcon = isArchived ? ArchiveRestoreIcon : Archive01Icon;
	const readLabel = isUnread ? "Mark as read" : "Mark as unread";
	const handleOpenQuickPreview = useCallback(
		() => onOpenQuickPreview?.(conv.id),
		[conv.id, onOpenQuickPreview]
	);
	const quickPreviewHold = useModifierClickHold({
		modifier: onOpenQuickPreview ? quickPreviewModifier : "none",
		onTrigger: handleOpenQuickPreview,
	});
	const shared = resourceVisibilityGroup(conv.visibility) === "team";
	const visibilityActionLabel = shared ? "Make private" : "Share with team";
	const nextVisibility: ResourceVisibility = shared ? "private" : "org";
	const visibilityGroup = shared ? "team" : "private";
	const handleVisibilityDragStart = (event: ReactDragEvent<HTMLDivElement>) => {
		event.dataTransfer.effectAllowed = "move";
		const payload = serializeVisibilityDragPayload({
			from: visibilityGroup,
			id: conv.id,
			name: conv.title,
			resourceType: "chat",
		});
		event.dataTransfer.setData(RESOURCE_VISIBILITY_DND_MIME, payload);
		event.dataTransfer.setData(resourceVisibilityDndMime("chat"), "1");
		event.dataTransfer.setData("text/plain", payload);
	};
	const [learningExcluded, setLearningExcluded] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getConversationLearningExclusion(target, conv.id)
			.then(({ excluded }) => {
				if (!cancelled) {
					setLearningExcluded(excluded);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [conv.id, target.token, target.url]);

	const toggleLearningExclusion = useCallback(() => {
		const next = !learningExcluded;
		setLearningExcluded(next);
		setConversationLearningExclusion(target, conv.id, next).catch(() => {
			setLearningExcluded(!next);
			toast.error("Couldn't update this chat's learning privacy", {
				description: "Check your connection and try again.",
			});
		});
	}, [conv.id, learningExcluded, target.token, target.url]);
	const learningLabel = learningExcluded
		? "Include in learning"
		: "Exclude from learning";

	// App-registered conversation-menu rows from the contributions feed, filtered
	// to the `conversation` anchor. The "Make a skill from this chat" row is a
	// Learning contribution, not a hardcoded menu item — disabling the app removes
	// the row. Each row dispatches its declared capability through the owning
	// plugin's granted host seam (`pluginHostInvoke`), never inline code.
	const { context_menu_items } = usePluginContributions();
	const contributedMenuRows = useMemo(
		() =>
			context_menu_items
				.filter((item) => item.anchor === "conversation")
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				),
		[context_menu_items]
	);

	// One dispatcher, both surfaces. The ⋯ dropdown and the right-click menu are
	// separate primitives (`DropdownMenuItem` vs `ContextMenuItem`, so the rendered
	// rows genuinely cannot be shared), but the *action* must be defined once —
	// they had already drifted, with the right-click menu shipping no contributed
	// rows at all.
	const runContributedRow = useCallback(
		(item: PluginContextMenuItem) => {
			const feedback = item.feedback;
			const run = () =>
				pluginHostInvoke(target, item.plugin, item.capability ?? "", {
					...item.args,
					conversation_id: conv.id,
				});
			// `success` is passed unconditionally. That collapses what used to be two
			// branches here without changing behavior: `toastPromise` already falls
			// back to `loading` when `success` is omitted (`sileo.tsx`), so the
			// no-feedback case resolved to this exact label before too.
			toast.promise(run(), {
				loading: feedback?.loading ?? item.label,
				success: feedback?.success ?? item.label,
				error: feedback?.error ?? `${item.label} failed`,
			});
		},
		[conv.id, target]
	);

	// Inline rename: when `isEditing`, the title is replaced by a text input.
	// Commit on Enter / blur, cancel on Escape. Seeded from the current title.
	const [isEditing, setIsEditing] = useState(false);
	const [draftTitle, setDraftTitle] = useState(conv.title);
	const inputRef = useRef<HTMLInputElement | null>(null);

	// Row disclosure expands nested Messages + Side chats sub-accordions.
	const [rowExpanded, setRowExpanded] = useState(false);
	const [messagesExpanded, setMessagesExpanded] = useState(true);
	const [sideChatsExpanded, setSideChatsExpanded] = useState(false);

	// Deleting a chat is permanent, so both the dropdown and context-menu Delete
	// actions open a confirmation dialog rather than wiping the thread outright.
	const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	const [pullRequestsDialogOpen, setPullRequestsDialogOpen] = useState(false);
	const setConversationPullRequestLinked =
		useOptionalChatHistoryContext()?.setConversationPullRequestLinked;
	const linkedPullRequests = conv.linkedPullRequests ?? [];
	const [handoff, setHandoff] = useState<{
		nodes: Node[];
		sourceNode: Node;
	} | null>(null);

	const openHandoff = () => {
		const nodes = useNodeStore.getState().nodes;
		const source = resolveRnpNode(target.url, nodes);
		if (source.kind === "blocked") {
			toast.error("This chat's source is not a configured node");
			return;
		}
		setHandoff({ nodes, sourceNode: source.node });
	};

	// Clear the "Continued on" marker so this computer owns the thread again.
	const takeBack = () => {
		const pending = clearRnpContinued(target, conv.id).then(() =>
			chatHistory?.refresh()
		);
		toast.promise(pending, {
			loading: "Taking the thread back…",
			success: "Thread taken back",
			error: (cause: unknown) =>
				workspaceErrorMessage(cause, "Could not take the thread back"),
		});
	};

	const startEditing = () => {
		setDraftTitle(conv.title);
		setIsEditing(true);
	};
	const commitEditing = () => {
		if (!isEditing) {
			return;
		}
		setIsEditing(false);
		const next = draftTitle.trim();
		if (next && next !== conv.title) {
			onRenameConversation(conv.id, next);
		}
	};
	const cancelEditing = () => setIsEditing(false);

	useEffect(() => {
		if (isEditing) {
			inputRef.current?.focus();
			inputRef.current?.select();
		}
	}, [isEditing]);

	// The FULL folder path, not its leaf. The leaf is the project name the row is
	// already filed under, so it carried no information at all; the path is the
	// only place the user can see which of two same-named folders a chat belongs
	// to (and the only way to tell an imported thread's folder from a native one).
	const folderPath = conv.folderPath || null;
	const workingDirectory = conv.worktreePath || folderPath;
	const projectName = folderPath ? projectNameForFolder(folderPath) : null;
	// A project's main thread is the project; it never moves out of it.
	const movable = conv.hierarchy?.role !== "main";
	const moveTargets = movable ? moveTargetsFor(projectTargets, folderPath) : [];
	const chatDeepLink = buildRyuDeepLink({
		kind: "chat",
		conversationId: conv.id,
	});
	const codeSession = Boolean(folderPath && conv.branch);
	const worktreeLeaf = conv.worktreePath
		? (conv.worktreePath.split(PATH_SEP_RE).pop() ?? conv.worktreePath)
		: null;
	const previewContent = (
		<SidebarPreviewTitle title={conv.title}>
			{conv.branch ? (
				<SidebarPreviewMeta label="Branch" value={conv.branch} />
			) : null}
			{folderPath ? (
				<SidebarPreviewMeta label="Folder" value={folderPath} wrap />
			) : null}
			{worktreeLeaf ? (
				<SidebarPreviewMeta label="Worktree" value={worktreeLeaf} />
			) : null}
			{isNativeNumber(conv.messageCount) ? (
				<SidebarPreviewMeta
					label="Messages"
					value={formatCount(conv.messageCount) ?? "0"}
				/>
			) : null}
			{(conv.participants?.length || conv.agentId) && (
				// `items-center`, not `items-baseline`: the value column holds avatars,
				// and a baseline box aligns the text's baseline while the 14px image sits
				// on it — which reads as the logo hanging below its own name.
				<div className="flex min-w-0 items-center gap-2 text-xs">
					<span className="shrink-0 text-muted-foreground">Agents</span>
					<span className="flex min-w-0 flex-wrap items-center gap-1.5">
						{(conv.participants ?? (conv.agentId ? [conv.agentId] : [])).map(
							(id) => {
								const agent = agents.find((a) => a.id === id);
								return (
									<span className="flex items-center gap-1" key={id}>
										<AgentAvatar
											className="size-3.5 shrink-0 object-contain"
											conversationState={avatarStateFromRunStatus(
												conv.runStatus
											)}
											engine={engineForAgent({
												id,
												engine: agent?.engine ?? null,
												builtIn: null,
											})}
											glyph={agent?.avatarGlyph}
											presentation="compact"
											size="14px"
										/>
										<span className="truncate text-foreground/90">
											{agent?.name ?? id.split("/").pop() ?? id}
										</span>
									</span>
								);
							}
						)}
					</span>
				</div>
			)}
			{conv.runStatus ? (
				<SidebarPreviewMeta
					label="Status"
					value={runStatus?.label ?? conv.runStatus}
				/>
			) : null}
			<ChatTitleHistoryPreview conversationId={conv.id} target={target} />
		</SidebarPreviewTitle>
	);

	return (
		<SidebarMenuItem>
			<ContextMenu>
				<ContextMenuTrigger>
					{/* sidebar row combines nested controls with drag/middle-click */}
					<div
						className={`group/row relative flex cursor-grab items-center gap-2 overflow-hidden rounded-md px-2 transition-colors hover:bg-muted active:cursor-grabbing ${showSidebarChatPreview ? "min-h-11 py-1" : "h-8"} ${isSelected ? "bg-primary/10 ring-1 ring-primary/40 ring-inset hover:bg-primary/15" : isActive ? "bg-muted" : ""}`}
						data-testid={`sidebar-chat-row-${conv.id}`}
						{...sidebarChatRowAttributes(conv.id, isSelected)}
						{...sidebarUnreadRowAttributes(isUnread)}
						draggable
						onAuxClick={(e) => {
							// Middle-click opens the chat in a new tab.
							if (e.button === 1) {
								e.preventDefault();
								onOpenInNewTab(conv.id);
							}
						}}
						onClick={(event) => {
							if (quickPreviewHold.consumeTriggered()) {
								event.preventDefault();
								return;
							}
							if (quickReplyModifierMatches(event, readQuickReplyModifier())) {
								event.preventDefault();
								onOpenQuickReply(conv.id);
								return;
							}
							if (
								bulk &&
								applySidebarChatSelectionClick(
									event,
									conv.id,
									activeConversationId
								)
							) {
								event.preventDefault();
								return;
							}
							onSelectConversation(conv.id);
						}}
						onContextMenu={() => {
							// Right-clicking outside the selection targets just this row.
							if (!isSelected) {
								clearSidebarChatSelection();
							}
						}}
						onDragEnd={endSidebarChatDrag}
						onDragStart={(event) => {
							handleVisibilityDragStart(event);
							startSidebarChatDrag(event, conv.id);
						}}
						onFocus={() => {
							if (!isActive) {
								prefetchConversation?.(conv.id);
							}
						}}
						onKeyDown={(e) => {
							// The row also contains real controls (pin/archive/menu). Let their
							// native Enter/Space handlers run without selecting the parent row.
							if (e.target !== e.currentTarget) {
								return;
							}
							if (bulk && applySidebarChatArrowKey(e, conv.id)) {
								return;
							}
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onSelectConversation(conv.id);
							}
						}}
						onPointerCancel={quickPreviewHold.onPointerCancel}
						onPointerDown={quickPreviewHold.onPointerDown}
						onPointerEnter={schedulePrefetch}
						onPointerLeave={cancelPrefetch}
						onPointerUp={quickPreviewHold.onPointerUp}
						role="button"
						tabIndex={0}
					>
						<SidebarTodoProgress
							celebrate={isUnread}
							conversation={conv}
							loadMessages={loadMessages}
							nodeUrl={target.url}
						/>
						<button
							aria-label={
								rowExpanded ? "Collapse chat details" : "Expand chat details"
							}
							className="relative flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
							onClick={(e) => {
								e.stopPropagation();
								setRowExpanded((v) => !v);
							}}
							type="button"
						>
							{/* The agent that last took this thread, in the same slot the
							    chevron lives in: shown at rest, crossfading out on hover (and
							    hidden while expanded) so the disclosure affordance can morph
							    in exactly as it did when this slot held only a dot. */}
							{groupConversation ? (
								<span
									className={`absolute inset-0 flex items-center justify-center transition-opacity ${
										rowExpanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0"
									}`}
								>
									<ParticipantOrbitAvatar
										agents={agents}
										conversationState={avatarStateFromRunStatus(conv.runStatus)}
										participants={conversationParticipantIds(conv)}
									/>
								</span>
							) : latestAgent ? (
								<span
									className={`absolute inset-0 m-auto size-4 object-contain transition-opacity ${
										rowExpanded
											? "opacity-0"
											: "opacity-100 group-hover/row:opacity-0"
									}`}
								>
									<AgentAvatar
										className="size-4 object-contain"
										conversationState={avatarStateFromRunStatus(conv.runStatus)}
										engine={engineForAgent(latestAgent)}
										glyph={latestAgent.avatarGlyph}
										presentation="compact"
										size="16px"
									/>
								</span>
							) : null}
							{/* Attention dot. With an avatar it becomes a badge pinned to the
							    avatar's top-right corner, ringed in the colour of whatever
							    surface is behind it, and stays put through hover — the avatar
							    fades to reveal the chevron, but a failed or interrupted run
							    must not blink out from under the pointer. Without an agent
							    there is nothing to badge, so it keeps its original behaviour:
							    centred in the slot, crossfading out for the chevron.
							    The unread count is shown at the row's trailing edge. */}
							{showDot &&
								(latestAgent || groupConversation ? (
									<span
										aria-label={runStatus.description}
										className={`absolute -top-0.5 -right-0.5 size-1.5 rounded-full ${dotRingClass} ${runStatus.dotClass}`}
										role="img"
										title={runStatus.description}
									/>
								) : (
									<span
										aria-label={runStatus.description}
										className={`absolute inset-0 m-auto size-1.5 rounded-full transition-opacity ${
											rowExpanded
												? "opacity-0"
												: "opacity-100 group-hover/row:opacity-0"
										} ${runStatus.dotClass}`}
										role="img"
										title={runStatus.description}
									/>
								))}
							{/* Chevron: hidden at rest, fades in on hover; always shown (and
							    un-rotated) once expanded so it can be collapsed again. */}
							<HugeiconsIcon
								className={`size-3 transition-[opacity,rotate] motion-reduce:transition-opacity ${
									rowExpanded
										? "opacity-100"
										: "-rotate-90 opacity-0 group-hover/row:opacity-100"
								}`}
								icon={ArrowDown01Icon}
							/>
						</button>
						{conv.icon ? (
							<span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
								<GlyphDisplay fallback={null} size={14} value={conv.icon} />
							</span>
						) : null}
						{isPinned && (
							<HugeiconsIcon
								className="size-3 shrink-0 text-muted-foreground/70"
								icon={PinIcon}
							/>
						)}
						{isForkedConversation(conv) ? (
							<HugeiconsIcon
								aria-label="Forked thread"
								className="size-3 shrink-0 text-primary/75"
								icon={GitBranchIcon}
							/>
						) : null}
						<ResourceVisibilityIndicator visibility={conv.visibility} />
						{isEditing ? (
							<input
								aria-label="Chat title"
								className="min-w-0 flex-1 rounded-sm bg-transparent text-sm outline-none ring-1 ring-primary/40 focus:ring-primary"
								onBlur={commitEditing}
								onChange={(e) => setDraftTitle(e.target.value)}
								onClick={(e) => e.stopPropagation()}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Enter") {
										commitEditing();
									} else if (e.key === "Escape") {
										cancelEditing();
									}
								}}
								ref={inputRef}
								value={draftTitle}
							/>
						) : (
							// Wrap the preview so a double-click on the title starts an
							// inline rename (SidebarItemPreview doesn't forward DOM handlers).
							// double-click rename on tooltip wrapper
							<span
								className="flex min-w-0 flex-1 flex-col justify-center"
								onDoubleClick={(e) => {
									e.stopPropagation();
									startEditing();
								}}
							>
								<span className="flex min-w-0 items-center">
									{/* One label for both states (FadeLabel, not OverflowTooltip —
									    the row already has the hover-card preview, and a second
									    popup would fight it). Running only swaps the shimmer onto
									    the same clipped line, so the title dissolves at the edge in
									    either state and the row cannot jump when a run starts. */}
									<SidebarItemPreview
										className="min-w-0 flex-1"
										content={previewContent}
										renderContent={(open) =>
											open && pullRequestsEnabled ? (
												<>
													{folderPath && conv.branch ? (
														<SidebarGitPullRequestPreview
															branch={conv.branch}
															conversationId={conv.id}
															cwd={folderPath}
															showStatusIcon={interfaceLevel !== "simple"}
															target={target}
														/>
													) : null}
													{linkedPullRequests.map((url) => (
														<SidebarLinkedPullRequestPreview
															key={url}
															showStatusIcon={interfaceLevel !== "simple"}
															target={target}
															url={url}
														/>
													))}
												</>
											) : null
										}
										spacing="conversation-preview"
									>
										<FadeLabel
											className={`flex-1 text-sm ${isUnread ? "font-medium" : ""}`}
											shimmer={isRunning}
											text={conv.title}
										/>
									</SidebarItemPreview>
								</span>
								{showSidebarChatPreview ? (
									<SidebarConversationPreview
										className="px-1"
										states={sidebarPreviewStates}
										testId={`sidebar-chat-preview-${conv.id}`}
									/>
								) : null}
							</span>
						)}
						{interfaceLevel !== "simple" &&
						pullRequestsEnabled &&
						codeSession &&
						folderPath &&
						conv.branch ? (
							<SidebarGitPullRequestStatus
								branch={conv.branch}
								conversationId={conv.id}
								cwd={folderPath}
								target={target}
							/>
						) : null}
						{interfaceLevel !== "simple" && pullRequestsEnabled
							? linkedPullRequests
									.slice(0, MAX_LINKED_PULL_REQUEST_ICONS)
									.map((url) => (
										<SidebarLinkedPullRequestStatus
											key={url}
											target={target}
											url={url}
										/>
									))
							: null}
						{conv.continuedOn ? (
							<ContinuedOnBadge continuedOn={conv.continuedOn} />
						) : null}
						<UnreadMessageCountBadge
							conversationId={conv.id}
							count={unreadMessageCount}
						/>
						{isRunning ? (
							// A live run shows a spinner in place of the age (like ChatGPT's
							// per-chat "running" indicator) so several concurrent chats are
							// legible at a glance. Hidden on hover so the ⋯ menu can take its slot.
							<span
								className={
									"size-3.5 shrink-0 text-muted-foreground/70 group-hover/row:hidden"
								}
							>
								<Spinner
									animated={animationsEnabled}
									aria-label={
										runStatus?.isRunning ? "Running" : "A session is running"
									}
								/>
							</span>
						) : runStatus?.needsAttention ? (
							<span
								className={`type-compact shrink-0 tabular-nums ${
									conv.runStatus === "failed"
										? "text-status-destructive"
										: "text-status-warning"
								}`}
								title={runStatus.description}
							>
								{runStatus.label}
							</span>
						) : (
							<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums group-focus-within/row:hidden group-hover/row:hidden">
								{compactAge(conv.updatedAt)}
							</span>
						)}
						<button
							aria-label={pinLabel}
							aria-pressed={isPinned}
							className="hidden h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-accent group-focus-within/row:inline-flex group-hover/row:inline-flex"
							onClick={(e) => {
								e.stopPropagation();
								onTogglePin(conv.id);
							}}
							type="button"
						>
							<HugeiconsIcon icon={pinIcon} size={12} />
						</button>
						<button
							aria-label={archiveLabel}
							aria-pressed={isArchived}
							className="hidden h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-accent group-focus-within/row:inline-flex group-hover/row:inline-flex"
							onClick={(e) => {
								e.stopPropagation();
								onToggleArchive(conv.id);
							}}
							type="button"
						>
							<HugeiconsIcon icon={archiveIcon} size={12} />
						</button>
						<DropdownMenu>
							{/* data-[popup-open] keeps the trigger visible while the menu is
							    open. Without it, moving onto the menu drops group-hover, the
							    trigger goes display:none, and Base UI loses its anchor (the menu
							    jumps to the top-left). Base UI sets data-popup-open, not
							    data-state, on the trigger. */}
							<DropdownMenuTrigger
								aria-label="Chat options"
								onClick={(e) => e.stopPropagation()}
								variant="conversation-options"
							>
								<HugeiconsIcon icon={MoreHorizontalIcon} size={12} />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onTogglePin(conv.id);
									}}
								>
									<HugeiconsIcon className="mr-2" icon={pinIcon} size={12} />
									{pinLabel} chat
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										startEditing();
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={PencilEdit01Icon}
										size={12}
									/>
									Rename chat
								</DropdownMenuItem>
								{onAutoRenameConversation && (
									<DropdownMenuItem disabled={isRetitling} onClick={autoRename}>
										Auto-rename
									</DropdownMenuItem>
								)}

								{moveTargets.length > 0 ? (
									<DropdownMenuSub>
										<DropdownMenuSubTrigger>
											<HugeiconsIcon
												className="mr-2"
												icon={Folder01Icon}
												size={12}
											/>
											{projectName
												? "Move to another project"
												: "Move to project"}
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											{moveTargets.map((project) => (
												<DropdownMenuItem
													key={project.path}
													onClick={(e) => {
														e.stopPropagation();
														onMoveToProject(conv.id, project.path);
													}}
												>
													<HugeiconsIcon
														className="mr-2"
														icon={Folder01Icon}
														size={12}
													/>
													{project.name}
												</DropdownMenuItem>
											))}
										</DropdownMenuSubContent>
									</DropdownMenuSub>
								) : null}
								{movable && folderPath && projectName ? (
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											onRemoveFromProject(conv.id);
										}}
									>
										<HugeiconsIcon
											className="mr-2"
											icon={Folder01Icon}
											size={12}
										/>
										{`Remove from ${projectName}`}
									</DropdownMenuItem>
								) : null}
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onToggleArchive(conv.id);
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={archiveIcon}
										size={12}
									/>
									{archiveLabel} chat
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										onOpenQuickReply(conv.id);
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={MailReply01Icon}
										size={12}
									/>
									Quick reply
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								{sideChatsEnabled ? (
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											onOpenNewSideChat(conv.id);
										}}
									>
										<HugeiconsIcon
											className="mr-2"
											icon={MessageQuestionIcon}
											size={12}
										/>
										Open side chat
									</DropdownMenuItem>
								) : null}
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>
										<HugeiconsIcon
											className="mr-2"
											icon={Copy01Icon}
											size={12}
										/>
										Copy
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										<DropdownMenuItem
											disabled={!workingDirectory}
											onClick={() => {
												if (workingDirectory) {
													void copyChatValue(
														workingDirectory,
														"Working directory copied"
													);
												}
											}}
										>
											<HugeiconsIcon
												className="mr-2"
												icon={Folder01Icon}
												size={12}
											/>
											Copy working directory
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												void copyChatValue(conv.id, "Session ID copied")
											}
										>
											<HugeiconsIcon
												className="mr-2"
												icon={ClipboardIcon}
												size={12}
											/>
											Copy session ID
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() =>
												void copyChatValue(chatDeepLink, "Chat deeplink copied")
											}
										>
											<HugeiconsIcon
												className="mr-2"
												icon={LinkSquare02Icon}
												size={12}
											/>
											Copy deeplink
										</DropdownMenuItem>
										<DropdownMenuItem onClick={openHandoff}>
											<HugeiconsIcon
												className="mr-2"
												icon={LaptopIcon}
												size={12}
											/>
											Continue on another node
										</DropdownMenuItem>
										{conv.continuedOn ? (
											<DropdownMenuItem onClick={takeBack}>
												<HugeiconsIcon
													className="mr-2"
													icon={LaptopIcon}
													size={12}
												/>
												Take back here
											</DropdownMenuItem>
										) : null}
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() =>
												void copyChatTranscriptAsMarkdown(
													() => loadMessages(conv.id),
													{ title: conv.title }
												)
											}
										>
											<HugeiconsIcon
												className="mr-2"
												icon={Copy01Icon}
												size={12}
											/>
											Copy as Markdown
										</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								<DropdownMenuSub>
									<DropdownMenuSubTrigger>
										<HugeiconsIcon
											className="mr-2"
											icon={GitBranchIcon}
											size={12}
										/>
										Fork…
									</DropdownMenuSubTrigger>
									<DropdownMenuSubContent>
										<DropdownMenuItem
											onClick={() => onForkConversation(conv.id, "workspace")}
										>
											<HugeiconsIcon
												className="mr-2"
												icon={LaptopIcon}
												size={12}
											/>
											Fork in this workspace
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => onForkConversation(conv.id, "worktree")}
										>
											<HugeiconsIcon
												className="mr-2"
												icon={FolderTreeIcon}
												size={12}
											/>
											Fork in a new worktree
										</DropdownMenuItem>
									</DropdownMenuSubContent>
								</DropdownMenuSub>
								{pullRequestsEnabled && setConversationPullRequestLinked ? (
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											setPullRequestsDialogOpen(true);
										}}
									>
										<HugeiconsIcon
											className="mr-2"
											icon={GitPullRequestIcon}
											size={12}
										/>
										{linkedPullRequests.length > 0
											? `Linked pull requests (${linkedPullRequests.length})…`
											: "Link pull request…"}
									</DropdownMenuItem>
								) : null}
								{schedulingEnabled ? (
									<DropdownMenuItem onClick={() => onAddScheduledTask(conv.id)}>
										<HugeiconsIcon
											className="mr-2"
											icon={Calendar04Icon}
											size={12}
										/>
										Add scheduled task…
									</DropdownMenuItem>
								) : null}
								<DropdownMenuSeparator />
								<OpenInNewWindowDropdownMenuItem
									iconClassName="mr-2 size-3"
									onClick={() => onOpenInNewWindow(conv.id)}
								/>
								<DropdownMenuItem onClick={() => onOpenInNewTab(conv.id)}>
									<HugeiconsIcon
										className="mr-2"
										icon={ArrowUpRight01Icon}
										size={12}
									/>
									Open in new tab
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={() =>
										isUnread ? onMarkRead(conv.id) : onMarkUnread(conv.id)
									}
								>
									<HugeiconsIcon className="mr-2" icon={Mail01Icon} size={12} />
									{readLabel}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										setIconDialogOpen(true);
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={ImageAdd01Icon}
										size={12}
									/>
									Change icon…
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={shared && !handlers.canMakePrivate}
									onClick={(e) => {
										e.stopPropagation();
										handlers.onRequestConversationVisibility({
											from: visibilityGroup,
											id: conv.id,
											name: conv.title,
											resourceType: "chat",
											to: nextVisibility === "private" ? "private" : "team",
										});
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={shared ? ViewOffSlashIcon : UserMultiple02Icon}
										size={12}
									/>
									{shared && !handlers.canMakePrivate
										? "Make private (admins only)"
										: visibilityActionLabel}
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										toggleLearningExclusion();
									}}
								>
									<HugeiconsIcon
										className="mr-2"
										icon={ViewOffSlashIcon}
										size={12}
									/>
									{learningLabel}
								</DropdownMenuItem>
								{contributedMenuRows.length > 0 && <DropdownMenuSeparator />}
								{contributedMenuRows.map((item) => (
									<DropdownMenuItem
										key={item.id}
										onClick={(e) => {
											e.stopPropagation();
											runContributedRow(item);
										}}
									>
										{item.icon ? (
											<Icon className="mr-2" icon={item.icon} size={12} />
										) : (
											<HugeiconsIcon
												className="mr-2"
												icon={MoreHorizontalIcon}
												size={12}
											/>
										)}
										{item.label}
									</DropdownMenuItem>
								))}
								<DropdownMenuSeparator />
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										setConfirmDeleteOpen(true);
									}}
									tone="destructive"
								>
									<HugeiconsIcon
										className="mr-2"
										icon={Delete01Icon}
										size={12}
									/>
									Delete
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</ContextMenuTrigger>
				{showBulkMenu && bulk ? (
					<SidebarChatBulkContextMenuContent
						actions={bulk}
						archivedIds={archivedIds}
						pinnedIds={pinnedIds}
						unreadIds={unreadIds}
					/>
				) : (
					<ContextMenuContent>
						<ContextMenuItem onClick={() => onTogglePin(conv.id)}>
							<HugeiconsIcon className="mr-2 size-4" icon={pinIcon} />
							{pinLabel} chat
						</ContextMenuItem>
						<ContextMenuItem onClick={startEditing}>
							<HugeiconsIcon className="mr-2 size-4" icon={PencilEdit01Icon} />
							Rename chat
						</ContextMenuItem>
						{onAutoRenameConversation && (
							<ContextMenuItem disabled={isRetitling} onClick={autoRename}>
								Auto-rename
							</ContextMenuItem>
						)}
						{moveTargets.length > 0 ? (
							<ContextMenuSub>
								<ContextMenuSubTrigger>
									<HugeiconsIcon className="mr-2 size-4" icon={Folder01Icon} />
									{projectName ? "Move to another project" : "Move to project"}
								</ContextMenuSubTrigger>
								<ContextMenuSubContent>
									{moveTargets.map((project) => (
										<ContextMenuItem
											key={project.path}
											onClick={() => onMoveToProject(conv.id, project.path)}
										>
											<HugeiconsIcon
												className="mr-2 size-4"
												icon={Folder01Icon}
											/>
											{project.name}
										</ContextMenuItem>
									))}
								</ContextMenuSubContent>
							</ContextMenuSub>
						) : null}
						{movable && folderPath && projectName ? (
							<ContextMenuItem onClick={() => onRemoveFromProject(conv.id)}>
								<HugeiconsIcon className="mr-2 size-4" icon={Folder01Icon} />
								{`Remove from ${projectName}`}
							</ContextMenuItem>
						) : null}
						<ContextMenuItem onClick={() => onToggleArchive(conv.id)}>
							<HugeiconsIcon className="mr-2 size-4" icon={archiveIcon} />
							{archiveLabel} chat
						</ContextMenuItem>
						<ContextMenuItem onClick={() => onOpenQuickReply(conv.id)}>
							<HugeiconsIcon className="mr-2 size-4" icon={MailReply01Icon} />
							Quick reply
						</ContextMenuItem>
						<ContextMenuSeparator />
						{sideChatsEnabled ? (
							<ContextMenuItem onClick={() => onOpenNewSideChat(conv.id)}>
								<HugeiconsIcon
									className="mr-2 size-4"
									icon={MessageQuestionIcon}
								/>
								Open side chat
							</ContextMenuItem>
						) : null}
						<ContextMenuSub>
							<ContextMenuSubTrigger>
								<HugeiconsIcon className="mr-2 size-4" icon={Copy01Icon} />
								Copy
							</ContextMenuSubTrigger>
							<ContextMenuSubContent>
								<ContextMenuItem
									disabled={!workingDirectory}
									onClick={() => {
										if (workingDirectory) {
											void copyChatValue(
												workingDirectory,
												"Working directory copied"
											);
										}
									}}
								>
									<HugeiconsIcon className="mr-2 size-4" icon={Folder01Icon} />
									Copy working directory
								</ContextMenuItem>
								<ContextMenuItem
									onClick={() =>
										void copyChatValue(conv.id, "Session ID copied")
									}
								>
									<HugeiconsIcon className="mr-2 size-4" icon={ClipboardIcon} />
									Copy session ID
								</ContextMenuItem>
								<ContextMenuItem
									onClick={() =>
										void copyChatValue(chatDeepLink, "Chat deeplink copied")
									}
								>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={LinkSquare02Icon}
									/>
									Copy deeplink
								</ContextMenuItem>
								<ContextMenuItem onClick={openHandoff}>
									<HugeiconsIcon className="mr-2 size-4" icon={LaptopIcon} />
									Continue on another node
								</ContextMenuItem>
								{conv.continuedOn ? (
									<ContextMenuItem onClick={takeBack}>
										<HugeiconsIcon className="mr-2 size-4" icon={LaptopIcon} />
										Take back here
									</ContextMenuItem>
								) : null}
								<ContextMenuSeparator />
								<ContextMenuItem
									onClick={() =>
										void copyChatTranscriptAsMarkdown(
											() => loadMessages(conv.id),
											{ title: conv.title }
										)
									}
								>
									<HugeiconsIcon className="mr-2 size-4" icon={Copy01Icon} />
									Copy as Markdown
								</ContextMenuItem>
							</ContextMenuSubContent>
						</ContextMenuSub>
						<ContextMenuSub>
							<ContextMenuSubTrigger>
								<HugeiconsIcon className="mr-2 size-4" icon={GitBranchIcon} />
								Fork…
							</ContextMenuSubTrigger>
							<ContextMenuSubContent>
								<ContextMenuItem
									onClick={() => onForkConversation(conv.id, "workspace")}
								>
									<HugeiconsIcon className="mr-2 size-4" icon={LaptopIcon} />
									Fork in this workspace
								</ContextMenuItem>
								<ContextMenuItem
									onClick={() => onForkConversation(conv.id, "worktree")}
								>
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={FolderTreeIcon}
									/>
									Fork in a new worktree
								</ContextMenuItem>
							</ContextMenuSubContent>
						</ContextMenuSub>
						{pullRequestsEnabled && setConversationPullRequestLinked ? (
							<ContextMenuItem onClick={() => setPullRequestsDialogOpen(true)}>
								<HugeiconsIcon
									className="mr-2 size-4"
									icon={GitPullRequestIcon}
								/>
								{linkedPullRequests.length > 0
									? `Linked pull requests (${linkedPullRequests.length})…`
									: "Link pull request…"}
							</ContextMenuItem>
						) : null}
						{schedulingEnabled ? (
							<ContextMenuItem onClick={() => onAddScheduledTask(conv.id)}>
								<HugeiconsIcon className="mr-2 size-4" icon={Calendar04Icon} />
								Add scheduled task…
							</ContextMenuItem>
						) : null}
						<ContextMenuSeparator />
						<OpenInNewWindowContextMenuItem
							onClick={() => onOpenInNewWindow(conv.id)}
						/>
						<ContextMenuItem onClick={() => onOpenInNewTab(conv.id)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<ContextMenuItem
							onClick={() =>
								isUnread ? onMarkRead(conv.id) : onMarkUnread(conv.id)
							}
						>
							<HugeiconsIcon className="mr-2 size-4" icon={Mail01Icon} />
							{readLabel}
						</ContextMenuItem>
						<ContextMenuItem onClick={() => setIconDialogOpen(true)}>
							<HugeiconsIcon className="mr-2 size-4" icon={ImageAdd01Icon} />
							Change icon…
						</ContextMenuItem>
						<ContextMenuItem
							disabled={shared && !handlers.canMakePrivate}
							onClick={() =>
								handlers.onRequestConversationVisibility({
									from: visibilityGroup,
									id: conv.id,
									name: conv.title,
									resourceType: "chat",
									to: nextVisibility === "private" ? "private" : "team",
								})
							}
						>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={shared ? ViewOffSlashIcon : UserMultiple02Icon}
							/>
							{shared && !handlers.canMakePrivate
								? "Make private (admins only)"
								: visibilityActionLabel}
						</ContextMenuItem>
						<ContextMenuItem onClick={toggleLearningExclusion}>
							<HugeiconsIcon className="mr-2 size-4" icon={ViewOffSlashIcon} />
							{learningLabel}
						</ContextMenuItem>
						{/* Same contributed rows the ⋯ dropdown renders, in the same slot and
					    order. Right-clicking a chat is the more discoverable gesture of the
					    two, so an app-registered row missing here read as the app simply
					    not contributing anything. */}
						{contributedMenuRows.length > 0 && <ContextMenuSeparator />}
						{contributedMenuRows.map((item) => (
							<ContextMenuItem
								key={item.id}
								onClick={() => runContributedRow(item)}
							>
								{item.icon ? (
									<Icon className="mr-2 size-4" icon={item.icon} size={16} />
								) : (
									<HugeiconsIcon
										className="mr-2 size-4"
										icon={MoreHorizontalIcon}
									/>
								)}
								{item.label}
							</ContextMenuItem>
						))}
						<ContextMenuSeparator />
						<ContextMenuItem
							onClick={() => setConfirmDeleteOpen(true)}
							variant="destructive"
						>
							<HugeiconsIcon className="mr-2 size-4" icon={Delete01Icon} />
							Delete
						</ContextMenuItem>
					</ContextMenuContent>
				)}
			</ContextMenu>
			{rowExpanded && (
				<div className="flex flex-col gap-0.5 pb-1">
					<ChatRowSubAccordion
						expanded={messagesExpanded}
						label="Messages"
						onToggle={() => setMessagesExpanded((v) => !v)}
					>
						<SidebarChatMessages
							agentId={conv.agentId}
							conversationId={conv.id}
							loadMessages={loadMessages}
							onJump={(messageId) => onJumpToMessage(conv.id, messageId)}
						/>
					</ChatRowSubAccordion>
					{sideChatsEnabled && (
						<ChatRowSubAccordion
							expanded={sideChatsExpanded}
							label="Side chats"
							onToggle={() => setSideChatsExpanded((v) => !v)}
						>
							<SidebarSideChats
								conversationId={conv.id}
								onOpen={(entry) => onOpenSideChat(conv.id, entry)}
								target={target}
							/>
						</ChatRowSubAccordion>
					)}
				</div>
			)}
			{handoff ? (
				<ContinueOnNodeDialog
					conversationId={conv.id}
					conversationTitle={conv.title}
					nodes={handoff.nodes}
					onCompleted={async (destination, _result, workspaceResult) => {
						// A resumed working tree is a handed-off worktree; Core refuses
						// to fork a managed worktree from it, so this tab runs Local.
						openTab("/chat", {
							conversationId: conv.id,
							node: destination.name,
							worktreeMode: workspaceResult ? false : undefined,
						});
						toast.success(`Continued on ${destination.name}`);
					}}
					onOpenChange={(open) => {
						if (!open) {
							setHandoff(null);
						}
					}}
					open
					resolveNodes={resolveConfiguredNodes}
					sourceNode={handoff.sourceNode}
					sourceUpdatedAt={conv.updatedAt}
				/>
			) : null}
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this chat?</AlertDialogTitle>
						<AlertDialogDescription>
							{`"${conv.title}" will be permanently deleted. This cannot be undone.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => onDeleteConversation(conv.id)}
							variant="destructive"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			{pullRequestsEnabled && setConversationPullRequestLinked ? (
				<LinkedPullRequestsDialog
					linkedPullRequests={linkedPullRequests}
					onOpenChange={setPullRequestsDialogOpen}
					onSetLinked={(url, linked) =>
						setConversationPullRequestLinked(conv.id, url, linked)
					}
					open={pullRequestsDialogOpen}
					target={target}
					title={conv.title}
				/>
			) : null}
			<EntityIconDialog
				description={conv.title}
				onChange={(icon) => onSetConversationIcon(conv.id, icon)}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Chat icon"
				value={conv.icon ?? null}
			/>
		</SidebarMenuItem>
	);
}

interface LayoutCssVariables extends LayoutCSSProperties {
	"--desktop-inline1-z-Index"?: string | number;
}
