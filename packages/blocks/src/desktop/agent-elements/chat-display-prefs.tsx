"use client";

import { createContext, useContext, useMemo } from "react";
import type { ComposerSendShortcut } from "./composer-send-shortcut.ts";

/**
 * Global display preferences for the chat message list. Consumed by tool
 * renderers (ToolGroup, EditTool) to honour user settings without prop-drilling.
 * The desktop wraps the message list with `<ChatDisplayPrefsProvider>` and reads
 * values from localStorage-backed hooks.
 */
export interface ChatDisplayPrefs {
	/**
	 * Global motion master switch. New chat animations must read this value;
	 * callers still need to respect the OS reduced-motion preference as well.
	 * Default: true.
	 */
	animationsEnabled: boolean;
	/**
	 * Which Enter-key combo sends the current composer draft. Default: "enter".
	 */
	composerSendShortcut: ComposerSendShortcut;
	/**
	 * How much room the transcript gives each turn.
	 * - "comfortable" (default): the full desktop chat — centred 720px column,
	 *   generous padding, floating table of contents, pinned user message.
	 * - "compact": the same components in a narrow surface (the island's mini
	 *   chat, a companion popover). Tighter padding, no centring column, and the
	 *   reading aids that need width (TOC, pinned bar) are dropped.
	 *
	 * This is the ONE knob that makes the desktop message list reusable in a small
	 * surface — the alternative is a second transcript implementation that drifts
	 * every time the desktop one gains a part type.
	 */
	density: "comfortable" | "compact";
	/**
	 * When true, fenced code blocks in assistant markdown render at their full
	 * height. When false, a long block is capped and scrolls inside its own box,
	 * so one 300-line paste cannot bury the rest of the reply.
	 *
	 * This is the "Tool detail" knob reaching past tool calls: a reply's code is
	 * the same kind of bulk the Bash/Edit caps already govern, and capping it is
	 * what makes the Compact level actually compact. Capped means SCROLLABLE, not
	 * clipped — code the model wrote must always stay readable and selectable.
	 * Default: false (capped).
	 */
	expandCodeBlocks: boolean;
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
	 * When true, consecutive compact tool calls are collapsed into a single
	 * AgentActivity disclosure with a summary. Rich and interactive tools stay
	 * standalone. When false, every tool call renders individually.
	 * Default: true.
	 */
	groupToolUses: boolean;
	/**
	 * The "None" rung of the Detail level ladder: the transcript shows NO tool
	 * calls and NO file edits at all, leaving a pure messaging view of the
	 * conversation. Default: false.
	 *
	 * This is a VISIBILITY knob and the other four transcript-detail prefs
	 * (`groupToolUses` / `expandFileEdits` / `expandCommands` /
	 * `expandCodeBlocks`) are all EXPANSION knobs — no combination of them can
	 * express "not shown", which is why this is its own pref rather than another
	 * derived preset. It overrides them: at None the expansion toggles have
	 * nothing left to expand.
	 *
	 * What it hides, and what it deliberately does not:
	 * - HIDDEN: every tool row, including reasoning/thinking traces (those arrive
	 *   as tool parts routed to `ThinkingTool`, so they go for free) and the app
	 *   widget parts that attach to a tool call.
	 * - KEPT: assistant text and every non-tool part (images, generated images,
	 *   file/audio attachments), `type: "error"` parts, and — the one deliberate
	 *   exception — tool rows that FAILED. A tool-only turn that died is the case
	 *   where hiding everything leaves the user staring at a silent gap, and a
	 *   turn-level error part is not always produced. The cost, accepted: a
	 *   transient failure the agent retried and recovered from still shows one
	 *   row at None.
	 * - KEPT: the "interrupted" marker. Interruption is turn STATUS, not tool
	 *   detail, and it now rides on the message as `_interrupted` metadata
	 *   rather than as a text part — so the message list counts an interrupted
	 *   message as visible content in its own right. Without that, a turn that
	 *   died with nothing but hidden tool work would vanish at None and take its
	 *   crash notice with it.
	 * - UNAFFECTED: the pinned summary (Cowork context) panel and the subagent
	 *   panels. Those derive their own rollups straight from the message parts
	 *   and never read this context — showing what the agent did IS their whole
	 *   job, and blanking a panel the user deliberately opened would leave it
	 *   empty rather than clean. None is a TRANSCRIPT setting.
	 *
	 * See `tool-detail-visibility.ts` for the predicate, and note the empty-turn
	 * trap documented there: a turn whose entire content is hidden must not
	 * render an empty row.
	 */
	hideToolDetail: boolean;
	/**
	 * When true, each completed assistant turn shows its inference stats footer:
	 * token counts, tokens/sec, first-response time and the turn's duration
	 * (`data-ryu-stats` for local engines, `data-acp-usage` for ACP agents).
	 *
	 * Default: FALSE. This is a developer readout — most turns run against agents
	 * that report no token usage at all, and the numbers mean different things per
	 * transport. Note the cost of the default: with it off, a live ACP turn shows
	 * no token counter, which is the transcript's only in-line liveness cue. That
	 * is the intended trade, not an oversight.
	 */
	inferenceStats: boolean;
	/**
	 * Render the composer through the shared Plate Markdown editor. When false,
	 * the lightweight textarea remains the default. Default: false.
	 */
	markdownComposer: boolean;
	/**
	 * When true, opening a conversation jumps the transcript to the newest message
	 * instead of leaving it wherever the scroller happened to settle while the
	 * history was still loading. The jump fires once per conversation (on mount,
	 * on hydration, and when the surface first gains layout — a tab restored
	 * behind `display:none` has none), never mid-read. Default: true.
	 */
	openAtBottom: boolean;
	/**
	 * When true, the latest scrolled-past user message appears in a compact pinned
	 * bar while scrolling upward through a long assistant reply (Cursor-style),
	 * and hides again when the reader scrolls down. Default: true.
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
	markdownComposer: false,
	animationsEnabled: true,
	composerSendShortcut: "enter",
	density: "comfortable",
	groupToolUses: true,
	expandFileEdits: false,
	expandCommands: false,
	expandCodeBlocks: false,
	// Must equal APPEARANCE_DEFAULTS.hideToolDetail in
	// apps/desktop/src/lib/appearance-settings.ts AND the usePersistedToggle
	// default in apps/desktop/src/components/chat/ChatDisplayPrefsProvider.tsx.
	// Three defaults, one value — two that disagree means the slider and the
	// transcript disagree until the user touches the setting.
	hideToolDetail: false,
	openAtBottom: true,
	pinUserMessage: true,
	streamAnimation: true,
	// Must equal APPEARANCE_DEFAULTS.inferenceStats in
	// apps/desktop/src/lib/appearance-settings.ts.
	inferenceStats: true,
};

const ChatDisplayPrefsContext = createContext<ChatDisplayPrefs>(DEFAULT_PREFS);

export function ChatDisplayPrefsProvider({
	children,
	value,
}: {
	children: React.ReactNode;
	value: Partial<ChatDisplayPrefs>;
}) {
	const parent = useContext(ChatDisplayPrefsContext);
	// Memoised because a context value is NOT gated by `memo()`: a fresh object
	// here re-renders every consumer in the transcript (MessageList, every tool
	// row, every markdown block) on every render of the provider's parent.
	const merged = useMemo(() => ({ ...parent, ...value }), [parent, value]);
	return (
		<ChatDisplayPrefsContext.Provider value={merged}>
			{children}
		</ChatDisplayPrefsContext.Provider>
	);
}

export function useChatDisplayPrefs(): ChatDisplayPrefs {
	return useContext(ChatDisplayPrefsContext);
}
