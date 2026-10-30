// apps/desktop/src/components/shell/NodeLayerMenu-types.ts
//
// Public prop and option types for NodeLayerMenu; re-exported from NodeLayerMenu.tsx.

import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";

/**
 * Run state of a layer:
 *   `true`/`false` — up / down (green / red dot);
 *   `null`         — probed but unknown, or not relevant yet (neutral dot);
 *   omitted        — the layer HAS no run state (a pure preference, like the
 *                    nested voice picker), so no dot is drawn at all. A grey dot
 *                    on something that cannot run reads as "broken".
 */
export type LayerRunState = boolean | null;

/** A top-of-submenu verb: Start / Stop / Update / Restart / Launch. */
export interface LayerAction {
	/** Rendered while `run()` is in flight ("Starting…"). Falls back to `label`. */
	busyLabel?: string;
	icon?: IconSvgElement;
	/** Stable key for the pending state — also the React key. */
	id: string;
	label: string;
	run: () => Promise<void> | void;
	/** Warning tone for Update, destructive for anything that tears state down. */
	tone?: "default" | "warning" | "destructive";
}

/** One swappable / installable option inside a layer's submenu. */
export interface LayerOption {
	/** Ticked: the current selection in a `swap` layer, running in a `toggle` one. */
	active?: boolean;
	/** Shown while `select()` is in flight; defaults to the layer's mode wording. */
	busyLabel?: string;
	/** Right-aligned caption — version, "running", a size, whatever fits. */
	detail?: string | null;
	disabled?: boolean;
	/** Why it is disabled (e.g. "not supported on macOS") — shown as the detail. */
	disabledReason?: string | null;
	label: string;
	/** Stable key: the catalog/engine/backend name. */
	name: string;
	/** Picking this option (swap to it, or install it when `available`). */
	select: () => Promise<void> | void;
	/** Optional uninstall for an installed option; omitted → no uninstall. */
	uninstall?: () => Promise<void> | void;
}

/**
 * How the installed list behaves — this is the ONE place a layer declares its
 * backend semantics, and it must match Core:
 *
 *   `swap`   — mutually exclusive. Exactly one option is active; picking another
 *              moves the layer onto it (Chat, sandbox backend, Audio, Voice Recognition).
 *   `toggle` — independent. Every option runs (or not) on its own; the tick means
 *              "running", and picking one starts/stops just that engine. The
 *              run-alongside engines (speech / image / embeddings) are this — they
 *              have no "current selection" to swap between.
 */
export type LayerSelectionMode = "swap" | "toggle";

export interface NodeLayerMenuProps {
	actions?: LayerAction[];
	/** Options the node does NOT have yet — picking one installs it. */
	available?: LayerOption[];
	/** Sub-caption under the submenu header: "Running · 2.1 GB", "Stopped". */
	caption?: string | null;
	/** Extra rows appended to the submenu (e.g. a nested voice picker). */
	children?: ReactNode;
	/** What the trigger row shows on the right: the current selection's name. */
	currentLabel: string;
	icon?: IconSvgElement;
	/** Options already on the node — picking one swaps the layer onto it. */
	installed?: LayerOption[];
	/** The layer's name, shown on the trigger row: "Chat", "Core". */
	label: string;
	running?: LayerRunState;
	/** Semantics of `installed` — see {@link LayerSelectionMode}. Default `swap`. */
	selectionMode?: LayerSelectionMode;
	/** Trigger-row right-hand caption. Defaults to `currentLabel` when it differs
	 *  from `label` (a singleton layer like "Core" names itself, so it passes a
	 *  live detail — "2.1 GB · 4%" — instead of repeating its own name). */
	trailing?: string | null;
	/** Version of the CURRENT selection, badged on the trigger + header. */
	version?: string | null;
}
