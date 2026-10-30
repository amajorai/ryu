// Hover-card content for a sidebar chat row: the title/meta preview, lazily
// loaded title history, and the app-owned pull-request summaries and status icons.

import { useLiteralMessages } from "@ryu/i18n/react";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { avatarStateFromRunStatus } from "@ryu/ui/components/avatar-conversation.tsx";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useEffect, useRef, useState } from "react";
import {
	GitPullRequestStatusIcon,
	GitPullRequestSummary,
} from "@/src/components/panels/GitPullRequestSummary.tsx";
import {
	useGitPullRequest,
	useLinkedPullRequest,
	useLinkedPullRequestStatus,
} from "@/src/hooks/useGitPullRequest.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getConversationTitleHistory,
	type TitleHistoryEntry,
} from "@/src/lib/api/conversation-flags.ts";
import type { ConversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import { recordChatBranchPullRequest } from "@/src/store/useChatPullRequestIndex.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	SidebarPreviewMeta,
	SidebarPreviewTitle,
	SidebarPreviewTitleHistory,
} from "./sidebar-item-preview.tsx";

const PATH_SEP_RE = /[\\/]/;

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
export function SidebarGitPullRequestPreview({
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
			<div className="border-border border-t pt-2 text-muted-foreground text-xs">
				Checking GitHub…
			</div>
		);
	}
	if (!data) {
		return null;
	}
	return (
		<div className="border-border border-t pt-2">
			<GitPullRequestSummary
				pullRequest={data}
				showStatusIcon={showStatusIcon}
			/>
		</div>
	);
}

/** Hover-card summary for one pull request explicitly linked to the chat. */
export function SidebarLinkedPullRequestPreview({
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
		<div className="border-border border-t pt-2">
			<GitPullRequestSummary
				pullRequest={data}
				showStatusIcon={showStatusIcon}
			/>
		</div>
	);
}

/** Row status icon for one explicitly linked pull request. Reads the light
 * status route, shared with the automation watcher's cache entry. */
export function SidebarLinkedPullRequestStatus({
	target,
	url,
}: {
	target: ApiTarget;
	url: string;
}) {
	const tl = useLiteralMessages();
	const { data } = useLinkedPullRequestStatus(target, url, true);
	if (!data) {
		return null;
	}
	return (
		<a
			aria-label={tl("Open pull request: {title}", { title: data.title })}
			className="flex size-5 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
export const MAX_LINKED_PULL_REQUEST_ICONS = 3;

export function SidebarGitPullRequestStatus({
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
	const tl = useLiteralMessages();
	const { data } = useGitPullRequest(target, cwd, branch, true, "all");
	useRecordBranchPullRequest(conversationId, data?.url);
	if (!data) {
		return null;
	}
	return (
		<a
			aria-label={tl("Open pull request: {title}", { title: data.title })}
			className="flex size-5 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			href={safeHttpUrl(data.url) ?? undefined}
			onClick={(event) => event.stopPropagation()}
			rel="noopener noreferrer"
			target="_blank"
		>
			<GitPullRequestStatusIcon pullRequest={data} />
		</a>
	);
}

/** The hover-card body for a chat row: branch, folder, worktree, message count,
 *  agents, run status and title history. */
export function chatRowPreviewContent({
	agents,
	conv,
	folderPath,
	runStatus,
	target,
}: {
	agents: AgentSummary[];
	conv: Conversation;
	folderPath: string | null;
	runStatus: ConversationRunStatusMeta | null;
	target: ApiTarget;
}) {
	const worktreeLeaf = conv.worktreePath
		? (conv.worktreePath.split(PATH_SEP_RE).pop() ?? conv.worktreePath)
		: null;
	return (
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
}
