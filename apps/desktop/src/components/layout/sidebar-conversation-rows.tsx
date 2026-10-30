// Conversation rows for the desktop sidebar.
//
// AppSidebar owns the conversation state and callbacks. The row modules own only
// the row-level rendering and local disclosure state, so group/list composition
// can remain with the sidebar section that supplies it. This module keeps the
// public import path stable; the implementation lives in the sibling
// `sidebar-chat-row*.ts(x)`, `sidebar-side-chats.tsx` and
// `sidebar-unread-count-badge.tsx` modules.

export { ChatRow } from "./sidebar-chat-row.tsx";
export { ParticipantOrbitAvatar } from "./sidebar-chat-row-group-avatar.tsx";
export type {
	ChatRowHandlers,
	ProjectMoveTarget,
} from "./sidebar-chat-row-types.ts";
export { SidebarSideChats } from "./sidebar-side-chats.tsx";
export { UnreadMessageCountBadge } from "./sidebar-unread-count-badge.tsx";
