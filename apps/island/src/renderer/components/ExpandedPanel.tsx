import { CompanionPanel } from "./CompanionPanel.tsx";

// The expanded island surface: the companion surface — the mini chat plus any
// enabled Ryu App (Companion) that carries a UI bundle, exposed as tabs. With no
// companion apps enabled this is just the chat (a blended composer that grows a
// plain-text transcript once a conversation exists), so it opens straight on the
// chat input. Screen-context / proactive consent is granted from the settings
// panel's Permissions section, not a first-run gate — the Shadow HARD GATE stays
// closed until explicitly allowed there. The proactive inbox lives in the desktop
// app's sidebar; the island keeps surfacing live suggestions as chips (see
// use-suggestion-queue / use-meeting-detect).

export function ExpandedPanel() {
	return <CompanionPanel />;
}
