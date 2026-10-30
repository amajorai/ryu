import type { BoardParams } from "@ryuhq/protocol/interfaces";

export type GroupBy = BoardParams["groupBy"];
export type View = BoardParams["view"];

export const GROUP_REGION_LABEL: Record<GroupBy, string> = {
	agent: "Threads by agent",
	project: "Threads by project",
	status: "Threads by status",
};
/** The command menu's Mod+Shift+K chord as the platform writes it, for its hint. */
export const COMMANDS_SHORTCUT =
	typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
		? "⇧⌘K"
		: "Ctrl+Shift+K";
