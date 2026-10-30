// Shared contracts for desktop sidebar chat rows: the handler bag AppSidebar
// threads down to every row, plus the project move-target helpers the row menus use.

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { ForkDestination } from "@/src/components/chat/ForkDialog.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { folderKey } from "@/src/lib/folder-path.ts";
import type { VisibilityChangeRequest } from "@/src/lib/resource-visibility.ts";
import type { Message } from "@/types/chat.ts";
import type { SidebarChatBulkActions } from "./sidebar-chat-selection.tsx";

export async function copyChatValue(
	value: string,
	success: string
): Promise<void> {
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

export function moveTargetsFor(
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
