// The title cell of a sidebar chat row: the inline rename input, or the
// hover-previewed title with its optional last-message preview line.

import type { ReactNode, RefObject } from "react";
import type { useInterfaceLevel } from "@/src/hooks/useInterfaceLevel.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { buildSidebarConversationPreviewStates } from "@/src/lib/sidebar-conversation-preview.ts";
import type { Conversation } from "@/types/chat.ts";
import { FadeLabel } from "./overflow-tooltip.tsx";
import {
	SidebarGitPullRequestPreview,
	SidebarLinkedPullRequestPreview,
} from "./sidebar-chat-row-preview.tsx";
import { SidebarConversationPreview } from "./sidebar-conversation-preview.tsx";
import { SidebarItemPreview } from "./sidebar-item-preview.tsx";

export function ChatRowTitle({
	cancelEditing,
	commitEditing,
	conv,
	draftTitle,
	folderPath,
	inputRef,
	interfaceLevel,
	isEditing,
	isRunning,
	isUnread,
	linkedPullRequests,
	previewContent,
	pullRequestsEnabled,
	setDraftTitle,
	showSidebarChatPreview,
	sidebarPreviewStates,
	startEditing,
	target,
}: {
	cancelEditing: () => void;
	commitEditing: () => void;
	conv: Conversation;
	draftTitle: string;
	folderPath: string | null;
	inputRef: RefObject<HTMLInputElement | null>;
	interfaceLevel: ReturnType<typeof useInterfaceLevel>;
	isEditing: boolean;
	isRunning: boolean;
	isUnread: boolean;
	linkedPullRequests: string[];
	previewContent: ReactNode;
	pullRequestsEnabled: boolean;
	setDraftTitle: (title: string) => void;
	showSidebarChatPreview: boolean;
	sidebarPreviewStates: ReturnType<
		typeof buildSidebarConversationPreviewStates
	>;
	startEditing: () => void;
	target: ApiTarget;
}) {
	return isEditing ? (
		<input
			aria-label="Chat title"
			className="min-w-0 flex-1 rounded-lg bg-transparent text-sm outline-none ring-1 ring-ring/50 focus:ring-ring"
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
	);
}
