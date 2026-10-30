// The values a sidebar chat row hands its two menus. The ⋯ dropdown and the
// right-click menu are separate primitives, so their rows cannot be shared, but
// both read every label, flag and action from this one model.

import type { IconSvgElement } from "@hugeicons/react";
import type { PluginContextMenuItem } from "@/src/lib/api/plugins.ts";
import type { ResourceVisibility } from "@/src/lib/resource-visibility.ts";
import type { Conversation } from "@/types/chat.ts";
import type {
	ChatRowHandlers,
	ProjectMoveTarget,
} from "./sidebar-chat-row-types.ts";

export interface ChatRowMenuModel {
	archiveIcon: IconSvgElement;
	archiveLabel: string;
	autoRename: () => void;
	chatDeepLink: string;
	contributedMenuRows: PluginContextMenuItem[];
	conv: Conversation;
	folderPath: string | null;
	handlers: ChatRowHandlers;
	isArchived: boolean;
	isPinned: boolean;
	isRetitling: boolean;
	isUnread: boolean;
	learningLabel: string;
	linkedPullRequests: string[];
	movable: boolean;
	moveTargets: readonly ProjectMoveTarget[];
	nextVisibility: ResourceVisibility;
	/** Called when the ⋯ menu opens or closes (lazy menu-only fetches). */
	onMenuOpenChange?: (open: boolean) => void;
	openHandoff: () => void;
	pinIcon: IconSvgElement;
	pinLabel: string;
	projectName: string | null;
	readLabel: string;
	runContributedRow: (item: PluginContextMenuItem) => void;
	setConfirmDeleteOpen: (open: boolean) => void;
	setConversationPullRequestLinked:
		| ((id: string, url: string, linked: boolean) => Promise<void>)
		| undefined;
	setIconDialogOpen: (open: boolean) => void;
	setPullRequestsDialogOpen: (open: boolean) => void;
	shared: boolean;
	startEditing: () => void;
	takeBack: () => void;
	toggleLearningExclusion: () => void;
	visibilityActionLabel: string;
	visibilityGroup: "private" | "team";
	workingDirectory: string | null;
}
