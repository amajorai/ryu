// The trailing cluster of a sidebar chat row: pull-request status icons, the
// continued-on badge, unread count, run spinner or age, and the hover archive
// button (pin lives in the ⋯ and right-click menus).

import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { ContinuedOnBadge } from "@/src/components/chat/ContinuedOnBanner.tsx";
import type { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ConversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import { compactAge } from "@/src/lib/time.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	MAX_LINKED_PULL_REQUEST_ICONS,
	SidebarGitPullRequestStatus,
	SidebarLinkedPullRequestStatus,
} from "./sidebar-chat-row-preview.tsx";
import { UnreadMessageCountBadge } from "./sidebar-unread-count-badge.tsx";

export function ChatRowTrailing({
	animationsEnabled,
	archiveIcon,
	archiveLabel,
	codeSession,
	conv,
	folderPath,
	interfaceLevel,
	isArchived,
	isRunning,
	linkedPullRequests,
	onToggleArchive,
	pullRequestsEnabled,
	runStatus,
	target,
	unreadMessageCount,
}: {
	animationsEnabled: boolean;
	archiveIcon: IconSvgElement;
	archiveLabel: string;
	codeSession: boolean;
	conv: Conversation;
	folderPath: string | null;
	interfaceLevel: ReturnType<typeof useInterfaceLevel>;
	isArchived: boolean;
	isRunning: boolean;
	linkedPullRequests: string[];
	onToggleArchive: (id: string) => void;
	pullRequestsEnabled: boolean;
	runStatus: ConversationRunStatusMeta | null;
	target: ApiTarget;
	unreadMessageCount: number;
}) {
	return (
		<>
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
					className={`shrink-0 text-xs tabular-nums ${
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
			<Button
				aria-label={archiveLabel}
				aria-pressed={isArchived}
				className="hidden size-6 rounded-lg group-focus-within/row:inline-flex group-hover/row:inline-flex"
				onClick={(e) => {
					e.stopPropagation();
					onToggleArchive(conv.id);
				}}
				size="icon-xs"
				type="button"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-3.5" icon={archiveIcon} />
			</Button>
		</>
	);
}
