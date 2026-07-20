"use client";

import { createContext, useContext } from "react";

/**
 * Global display preferences for the chat message list. Consumed by tool
 * renderers (ToolGroup, EditTool) to honour user settings without prop-drilling.
 * The desktop wraps the message list with `<ChatDisplayPrefsProvider>` and reads
 * values from localStorage-backed hooks.
 */
export interface ChatDisplayPrefs {
	/**
	 * When true, bash/command tool output renders fully expanded (no height cap).
	 * When false, output is capped at a few lines with overflow hidden.
	 * Default: false (collapsed).
	 */
	expandCommands: boolean;
	/**
	 * When true, file edit diffs (Edit/Write tool) render expanded by default.
	 * When false, they start collapsed and require a click to expand.
	 * Default: false (collapsed).
	 */
	expandFileEdits: boolean;
	/**
	 * When true, consecutive tool calls (Task/Agent) are collapsed into a single
	 * grouped row with a summary. When false, every tool call renders individually.
	 * Default: true.
	 */
	groupToolUses: boolean;
	/**
	 * When true, the latest scrolled-past user message stays pinned at the top of
	 * the chat while reading a long assistant reply (Cursor-style). Default: true.
	 */
	pinUserMessage: boolean;
	/**
	 * When true, streaming assistant markdown fades/blurs in word-by-word as it
	 * arrives (Streamdown's animate plugin). The desktop resolves this from the
	 * global "Enable animations" master toggle, the per-feature stream toggle, and
	 * the OS `prefers-reduced-motion` setting (any of which off ⇒ false).
	 * Default: true.
	 */
	streamAnimation: boolean;
}

const DEFAULT_PREFS: ChatDisplayPrefs = {
	groupToolUses: true,
	expandFileEdits: false,
	expandCommands: false,
	pinUserMessage: true,
	streamAnimation: true,
};

const ChatDisplayPrefsContext = createContext<ChatDisplayPrefs>(DEFAULT_PREFS);

export function ChatDisplayPrefsProvider({
	children,
	value,
}: {
	children: React.ReactNode;
	value: Partial<ChatDisplayPrefs>;
}) {
	const merged = { ...DEFAULT_PREFS, ...value };
	return (
		<ChatDisplayPrefsContext.Provider value={merged}>
			{children}
		</ChatDisplayPrefsContext.Provider>
	);
}

export function useChatDisplayPrefs(): ChatDisplayPrefs {
	return useContext(ChatDisplayPrefsContext);
}
