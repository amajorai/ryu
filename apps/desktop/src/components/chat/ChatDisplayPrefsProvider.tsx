"use client";

import { ChatDisplayPrefsProvider as Provider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";

const REDUCE_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduceMotion(cb: () => void): () => void {
	if (typeof window === "undefined" || !window.matchMedia) {
		return () => {
			// nothing to unsubscribe from
		};
	}
	const mql = window.matchMedia(REDUCE_MOTION_QUERY);
	mql.addEventListener("change", cb);
	return () => mql.removeEventListener("change", cb);
}

function readReduceMotion(): boolean {
	if (typeof window === "undefined" || !window.matchMedia) {
		return false;
	}
	return window.matchMedia(REDUCE_MOTION_QUERY).matches;
}

/** OS-level "reduce motion" accessibility preference, reactive to changes. */
function usePrefersReducedMotion(): boolean {
	return useSyncExternalStore(
		subscribeReduceMotion,
		readReduceMotion,
		() => false
	);
}

/**
 * Desktop wrapper that reads the chat display prefs from localStorage (via
 * persisted toggles) and provides them to the blocks-level context so
 * ToolRenderer / EditTool / ToolGroup / Markdown can read the user's choices.
 */
export function ChatDisplayPrefs({ children }: { children: ReactNode }) {
	const [groupToolUses] = usePersistedToggle("ryu:group-tool-uses", true);
	const [expandFileEdits] = usePersistedToggle("ryu:expand-file-edits", false);
	const [expandCommands] = usePersistedToggle("ryu:expand-commands", false);
	const [pinUserMessage] = usePersistedToggle("ryu:pin-user-message", true);

	// Two-level motion control: a global master ("Enable animations") and a
	// per-feature toggle ("Animate streaming text"). Global overrides individual,
	// and the OS reduce-motion preference overrides both (accessibility wins).
	const [animationsEnabled] = usePersistedToggle(
		"ryu:animations-enabled",
		true
	);
	const [streamAnimationPref] = usePersistedToggle(
		"ryu:stream-animation",
		true
	);
	const prefersReducedMotion = usePrefersReducedMotion();
	const streamAnimation =
		animationsEnabled && streamAnimationPref && !prefersReducedMotion;

	return (
		<Provider
			value={{
				groupToolUses,
				expandFileEdits,
				expandCommands,
				pinUserMessage,
				streamAnimation,
			}}
		>
			{children}
		</Provider>
	);
}
