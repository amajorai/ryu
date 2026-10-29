import { restoreDockTabKind } from "@/src/components/panels/dock-panels.ts";
import type { WorkspaceSessionState } from "@/src/lib/workspace-session.ts";
import { isConversationPanelKind } from "./shell-panels.ts";
import type {
	WorkbenchToolOption,
	WorkbenchTools,
} from "./workbench-chrome.tsx";

const COPY_NUMBER_RE = /\s\d+$/;

/** "Terminal 2" → "Terminal": copies are renumbered when they reopen. */
export function baseToolLabel(label: string): string {
	return label.replace(COPY_NUMBER_RE, "") || label;
}

/** Chat panels that show data the chat holds only while it runs. */
const SESSION_ONLY_KINDS = new Set(["artifact", "inspector", "subagent"]);

export function hasDockSessionTabs(
	session: WorkspaceSessionState | undefined
): session is WorkspaceSessionState {
	return Boolean(
		session && (session.right.tabs.length > 0 || session.bottom.tabs.length > 0)
	);
}

/**
 * Reopen a chat's saved dock tabs (from before the workbench hosted them) as
 * background workbench tabs. Pinned project tabs are moved once by the shell,
 * and panels whose data died with the old session are dropped.
 */
export function migrateDockSession(
	session: WorkspaceSessionState,
	{
		conversation,
		folder,
		openPanel,
	}: {
		conversation: WorkbenchToolOption["conversation"];
		folder: string | null | undefined;
		openPanel: WorkbenchTools["openPanel"];
	}
): void {
	for (const side of ["right", "bottom"] as const) {
		for (const tab of session[side].tabs) {
			const kind = restoreDockTabKind(tab.kind).kind;
			if (
				kind === "unavailable" ||
				tab.pinned ||
				SESSION_ONLY_KINDS.has(kind)
			) {
				continue;
			}
			if (isConversationPanelKind(kind)) {
				if (conversation) {
					openPanel(
						{ conversation, id: kind, label: tab.label, region: side },
						{ activate: false }
					);
				}
				continue;
			}
			openPanel(
				{ id: kind, label: baseToolLabel(tab.label), region: side },
				{
					activate: false,
					folder: folder ?? undefined,
					forceNew: kind === "terminal",
				}
			);
		}
	}
}
