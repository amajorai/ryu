/* @jsxImportSource @opentui/react */
// Cross-tab bridge for chat-scoped actions reachable from the global command
// palette (New chat, Sessions, Toggle double-check).
//
// The Chat tab owns its own state and is unmounted while another tab is active,
// so the palette cannot call into it directly. Instead the palette records a
// pending intent here and jumps to the Chat tab; ChatTab consumes the intent once
// it is active. This mirrors apps/cli, where the same palette actions operate on
// the single shared App state regardless of the focused tab.

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";

export type ChatIntent = "new" | "sessions" | "toggle-check";

interface ChatIntentValue {
	/** Clear the pending intent (ChatTab calls this after applying it). */
	clear: () => void;
	/** The intent waiting to be applied by the Chat tab, or null. */
	pending: ChatIntent | null;
	/** Record an intent for the Chat tab to apply when it becomes active. */
	request: (intent: ChatIntent) => void;
}

const ChatIntentContext = createContext<ChatIntentValue | null>(null);

export function ChatIntentProvider({ children }: { children: ReactNode }) {
	const [pending, setPending] = useState<ChatIntent | null>(null);
	const request = useCallback((intent: ChatIntent) => setPending(intent), []);
	const clear = useCallback(() => setPending(null), []);
	const value = useMemo<ChatIntentValue>(
		() => ({ pending, request, clear }),
		[pending, request, clear]
	);
	return (
		<ChatIntentContext.Provider value={value}>
			{children}
		</ChatIntentContext.Provider>
	);
}

/** Read the chat-intent bridge. Throws if used outside ChatIntentProvider. */
export function useChatIntent(): ChatIntentValue {
	const ctx = useContext(ChatIntentContext);
	if (!ctx) {
		throw new Error("useChatIntent must be used within a ChatIntentProvider");
	}
	return ctx;
}
