import { create } from "zustand";
import type { IslandAttachment } from "../../shared/ipc.ts";

/**
 * The island states, in increasing prominence:
 * - `collapsed`  a tiny round island showing just the Ryu logo (resting default)
 * - `idle`       compact text pill (the Ryu mark + label)
 * - `context`    slightly wider, shows the active app/context label
 * - `recording`  push-to-talk voice capture: a pill with the live waveform
 * - `suggestion` a chip with suggestion text + inline actions
 * - `expanded`   the full panel surface (variable height)
 *
 * `collapsed` is the resting shape: the island sits as a small logo circle and
 * the user taps it to "split out" into the longer text pill (`idle`/`context`).
 *
 * Real data for each state lands in later units (U3/U4/U5); U1 only owns the
 * state machine and the morphing shell.
 */
export type IslandState =
	| "collapsed"
	| "idle"
	| "context"
	| "recording"
	| "suggestion"
	| "expanded";

/** Ordered cycle used by the dev-only state switcher and number keys. */
export const ISLAND_STATE_ORDER: readonly IslandState[] = [
	"collapsed",
	"idle",
	"context",
	"recording",
	"suggestion",
	"expanded",
] as const;

/**
 * Which surface the `expanded` state shows:
 * - `panel`   the companion panel (chat + the proactive inbox; Store + Settings
 *             were removed — they live in the desktop app now)
 * - `command` the Cmd+K-style command palette + mini-chat (the merged command bar)
 *
 * Both share the same `expanded` footprint; this picks the content. The command
 * surface is the hotkey-summoned entry point (it absorbs the old standalone
 * `apps/command` bar), while a pill tap opens the panel as before.
 */
export type ExpandedView = "panel" | "command" | "voice";

interface IslandStore {
	/** Stage attachments (de-duped by path) and open the chat panel to send them. */
	attachAndOpen: (files: IslandAttachment[]) => void;
	/** Text to seed the chat input with when the panel opens (U4 Accept flow). */
	chatPrefill: string | null;
	/** Drop all staged attachments (after a send, or on a fresh open). */
	clearAttachments: () => void;
	/** Clear the pending prefill once the chat input has consumed it. */
	clearChatPrefill: () => void;
	/**
	 * The composer's measured height (px). The compact expanded bar sizes itself to
	 * this (plus padding) so it stays tight on one row and grows as the draft wraps.
	 */
	composerHeight: number;
	/** Advance to the next state in `ISLAND_STATE_ORDER`, wrapping around. */
	cycle: () => void;
	/**
	 * Whether the expanded surface takes its full (tall) height. False by default so
	 * an empty expand is just a short composer bar; the chat sets it true once there
	 * is history, and the inbox view sets it true while open.
	 */
	expandedTall: boolean;
	/** Which surface the `expanded` state renders (panel vs command palette). */
	expandedView: ExpandedView;
	/**
	 * Expand the island into the chat panel with `text` staged in the input.
	 * Used by U4 when a proactive suggestion is accepted so the conversation
	 * starts from the suggestion body.
	 */
	openChatWithPrefill: (text: string) => void;
	/** Open the command palette surface (the hotkey-summoned merged command bar). */
	openCommand: () => void;
	/** Open the tabbed companion panel (the pill-tap surface). */
	openPanel: () => void;
	/** Open the continuous voice-mode surface (its own expanded view). */
	openVoice: () => void;
	/**
	 * Images staged on the composer by the attach action, sent with the next
	 * message as multimodal file-parts. The chat clears them once a turn is sent.
	 */
	pendingAttachments: IslandAttachment[];
	/** Remove one staged attachment (the chip's ✕). */
	removeAttachment: (path: string) => void;
	/** Report the composer's measured height (from a ResizeObserver in the input). */
	setComposerHeight: (height: number) => void;
	/** Set whether the expanded surface is tall (history/inbox) or the compact bar. */
	setExpandedTall: (tall: boolean) => void;
	setState: (state: IslandState) => void;
	state: IslandState;
	/**
	 * Tap-to-expand toggle for the resting island. From the `collapsed` logo
	 * circle it splits out into the `idle` text pill (which the live-context
	 * effect may then promote to `context`); from either text-pill state it
	 * folds back down to `collapsed`. From the `expanded` panel the logo doubles
	 * as the close affordance, folding all the way back to `collapsed` (the same
	 * target as the panel's own ✕ button). The transient `suggestion`/`recording`
	 * surfaces are left untouched so their own controls own the transition.
	 */
	toggleCollapse: () => void;
}

export const useIslandState = create<IslandStore>((set) => ({
	state: "collapsed",
	chatPrefill: null,
	pendingAttachments: [],
	expandedView: "panel",
	expandedTall: false,
	setExpandedTall: (tall) => set({ expandedTall: tall }),
	composerHeight: 0,
	setComposerHeight: (height) => set({ composerHeight: height }),
	setState: (state) => set({ state }),
	toggleCollapse: () =>
		set((prev) => {
			if (prev.state === "collapsed") {
				return { state: "idle" };
			}
			// The text pills and the expanded panel all fold back to the resting
			// logo on a logo tap; `expanded` here is what lets the logo close the
			// full panel (matching the panel's own ✕). The transient
			// suggestion/recording surfaces keep their own dismiss controls.
			if (
				prev.state === "idle" ||
				prev.state === "context" ||
				prev.state === "expanded"
			) {
				return { state: "collapsed" };
			}
			return prev;
		}),
	cycle: () =>
		set((prev) => {
			const index = ISLAND_STATE_ORDER.indexOf(prev.state);
			const next = ISLAND_STATE_ORDER[(index + 1) % ISLAND_STATE_ORDER.length];
			return { state: next };
		}),
	openChatWithPrefill: (text) =>
		set({ state: "expanded", expandedView: "panel", chatPrefill: text }),
	// The command surface (palette list + mini-chat) needs the full panel height —
	// unlike the panel's empty composer bar, it always has rows to show — so open it
	// tall. The panel chat re-derives `expandedTall` from its own history on mount.
	openCommand: () =>
		set({ state: "expanded", expandedView: "command", expandedTall: true }),
	// Continuous voice mode takes the full expanded height for its orb + captions.
	openVoice: () =>
		set({ state: "expanded", expandedView: "voice", expandedTall: true }),
	openPanel: () => set({ state: "expanded", expandedView: "panel" }),
	clearChatPrefill: () => set({ chatPrefill: null }),
	attachAndOpen: (files) =>
		set((prev) => {
			// De-dupe by absolute path so re-picking the same image is a no-op.
			const seen = new Set(prev.pendingAttachments.map((a) => a.path));
			const added = files.filter((f) => !seen.has(f.path));
			return {
				state: "expanded",
				expandedView: "panel",
				pendingAttachments: [...prev.pendingAttachments, ...added],
			};
		}),
	removeAttachment: (path) =>
		set((prev) => ({
			pendingAttachments: prev.pendingAttachments.filter(
				(a) => a.path !== path
			),
		})),
	clearAttachments: () => set({ pendingAttachments: [] }),
}));
