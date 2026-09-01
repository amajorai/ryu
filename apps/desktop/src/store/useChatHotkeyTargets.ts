// A single shared slot the FOCUSED chat tab publishes its keyboard-shortcut
// handlers into, so one global registrant (Layout) can drive them.
//
// Why a store and not `useHotkey` inside ChatPage: every chat tab stays mounted
// at once (Layout keeps them all alive so switching tabs doesn't remount a live
// stream), and split view shows two — while the hotkey provider keeps exactly one
// handler per action id, last-writer-wins (`registerHandler` in
// `packages/hotkeys/src/react.tsx`). Registering the shortcut inside each
// ChatPage would hand the slot to whichever effect happened to run last, which is
// not necessarily the tab the user is looking at: pressing Stop could abort a
// background tab's stream while the visible one kept going.
//
// So the ACTIVE tab writes its live handlers here — the same mirroring
// `ChatPage` already does for its conversation id via `useIsActiveTab` — and
// Layout binds the actual hotkeys once, reading from this slot.
//
// `owner` is a per-instance token so a deactivating tab only clears the slot when
// it still owns it: a newer active tab that already took over is never clobbered
// by the old one's cleanup effect running afterwards.
//
// Only actions the CHAT owns belong here. The `global: true` actions
// (`voice.push-to-talk`, `dictation.toggle`, `island.summon`) are OS-level, are
// registered natively by Tauri/the island, and are deliberately skipped by the
// React dispatcher — they must not be routed through this slot.

import { create } from "zustand";

interface ChatHotkeyHandlers {
	/** True while this tab has a reply in flight — gates `chat.stop`. Read from
	 *  the chat's EFFECTIVE status, so a resumed turn (which streams outside
	 *  `useChat`) still counts as streaming. */
	isStreaming: boolean;
	/** Open the realtime voice-mode overlay for this conversation. */
	startVoiceMode: (() => void) | null;
	/** Interrupt the current turn. Null when this tab owns no stoppable turn. */
	stop: (() => void) | null;
	/** Show/hide this chat's bottom dock. Panel open state is ChatPage-local, so
	 *  it reaches a global hotkey the same way Stop does. */
	toggleBottomPanel: (() => void) | null;
	/** Show/hide this chat's right dock. */
	toggleRightPanel: (() => void) | null;
	/** Open or cycle the focused chat's message/file search. */
	toggleSearch: (() => void) | null;
}

interface ChatHotkeyTargetsState extends ChatHotkeyHandlers {
	/** Clear the slot only if `owner` still holds it (no-op otherwise). */
	clearIfOwner: (owner: string) => void;
	/** The tab instance that currently owns the slot, or null when empty. */
	owner: string | null;
	/** The active tab publishes its live handlers under its owner token. */
	publish: (owner: string, handlers: ChatHotkeyHandlers) => void;
}

const EMPTY: ChatHotkeyHandlers = {
	isStreaming: false,
	stop: null,
	startVoiceMode: null,
	toggleBottomPanel: null,
	toggleRightPanel: null,
	toggleSearch: null,
};

export const useChatHotkeyTargets = create<ChatHotkeyTargetsState>((set) => ({
	owner: null,
	...EMPTY,
	publish: (owner, handlers) => set({ owner, ...handlers }),
	clearIfOwner: (owner) =>
		set((state) => (state.owner === owner ? { owner: null, ...EMPTY } : state)),
}));
