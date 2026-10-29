"use client";

import { ChatDisplayPrefsProvider as Provider } from "@ryu/blocks/desktop/agent-elements/chat-display-prefs.tsx";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useComposerSendShortcut } from "@/src/hooks/useComposerSendShortcut.ts";
import { usePersistedToggle } from "@/src/hooks/usePersistedToggle.ts";
import { usePrefersReducedMotion } from "@/src/hooks/usePrefersReducedMotion.ts";

/**
 * Desktop wrapper that reads the chat display prefs from localStorage (via
 * persisted toggles) and provides them to the blocks-level context so
 * ToolRenderer / EditTool / ToolGroup / Markdown can read the user's choices.
 */
export function ChatDisplayPrefs({ children }: { children: ReactNode }) {
	const [markdownComposer] = usePersistedToggle("ryu:markdown-composer", false);
	const [composerSendShortcut] = useComposerSendShortcut();
	const [groupToolUses] = usePersistedToggle("ryu:group-tool-uses", true);
	const [expandFileEdits] = usePersistedToggle("ryu:expand-file-edits", false);
	const [expandCommands] = usePersistedToggle("ryu:expand-commands", false);
	const [expandCodeBlocks] = usePersistedToggle(
		"ryu:expand-code-blocks",
		false
	);
	// Detail level "None" — the transcript shows no tool calls and no file edits
	// at all. Default FALSE; keep in step with APPEARANCE_DEFAULTS.hideToolDetail
	// and DEFAULT_PREFS.hideToolDetail.
	const [hideToolDetail] = usePersistedToggle("ryu:hide-tool-detail", false);
	const [pinUserMessage] = usePersistedToggle("ryu:pin-user-message", true);
	const [openAtBottom] = usePersistedToggle("ryu:open-chat-at-bottom", true);
	// Default ON — keep in step with APPEARANCE_DEFAULTS.inferenceStats.
	const [inferenceStats] = usePersistedToggle("ryu:inference-stats", true);

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

	// All prefs are stable primitives, so this object only changes when a
	// preference actually changes. It must be memoised HERE as well as inside the
	// blocks-level provider: a fresh literal at this level re-renders every chat
	// consumer (context reads bypass `memo()`) on every render of Layout.
	const prefs = useMemo(
		() => ({
			animationsEnabled,
			composerSendShortcut,
			markdownComposer,
			groupToolUses,
			hideToolDetail,
			expandFileEdits,
			expandCommands,
			expandCodeBlocks,
			inferenceStats,
			openAtBottom,
			pinUserMessage,
			streamAnimation,
		}),
		[
			animationsEnabled,
			composerSendShortcut,
			markdownComposer,
			groupToolUses,
			hideToolDetail,
			expandFileEdits,
			expandCommands,
			expandCodeBlocks,
			inferenceStats,
			openAtBottom,
			pinUserMessage,
			streamAnimation,
		]
	);

	return <Provider value={prefs}>{children}</Provider>;
}
