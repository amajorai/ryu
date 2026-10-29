// Persistence seam for generative-UI widgets (`ui.render`). The desktop injects a
// host that loads every saved widget state for the open conversation in one call
// and saves edits back to Core, so a checklist, form or calculator reopens the way
// the user left it. Blocks cannot import the app's API client, hence the context;
// without a host (tests, temporary chats) widgets simply start from their spec.

import type { StateModel } from "@json-render/core";
import { createContext, useContext } from "react";

/** What is saved per widget: its json-render state, and whether it was submitted
 *  (so a submitted form stays locked after a reload). */
export interface AgentUiSavedState {
	state: StateModel;
	submitted?: boolean;
	/** The widget's heading, so the agent can tell saved widgets apart. */
	title?: string;
}

export interface AgentUiStateHost {
	/** Latest saved state for a widget, including edits made this session. */
	read(toolCallId: string): AgentUiSavedState | undefined;
	/**
	 * Changes only when saved state is (re)loaded from the server. Widgets remount
	 * on a change to pick it up; local writes never bump it, so typing into a
	 * widget never remounts it.
	 */
	version: number;
	/** Save a widget's state. Best-effort: a failed save never breaks the UI. */
	write(toolCallId: string, saved: AgentUiSavedState): void;
}

export const AgentUiStateHostContext = createContext<AgentUiStateHost | null>(
	null
);

export function useAgentUiStateHost(): AgentUiStateHost | null {
	return useContext(AgentUiStateHostContext);
}
