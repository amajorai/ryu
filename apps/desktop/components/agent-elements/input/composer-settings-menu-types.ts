import type { IconSvgElement } from "@hugeicons/react";
import type { ReactElement, ReactNode } from "react";

export interface ComposerSettingItem {
	description?: string | null;
	id: string;
	name: string;
	/** A short trailing tag on the row (e.g. "Free" on a Ryu Router model). */
	tag?: string | null;
}

/** A colour + icon applied to a setting item (see `ComposerSettingsSection.decorate`). */
export interface ItemDecoration {
	className: string;
	icon: IconSvgElement;
}

export interface ComposerSettingsSection {
	/** Overrides the trigger summary name (else the active item's name is used). */
	activeName?: string;
	ariaLabel: string;
	/**
	 * Optional per-item colour + icon (e.g. the approval section's CLI-style mode
	 * tones — accept-edits purple, plan green, bypass red, auto amber). Applied to
	 * both the submenu rows and the sub-trigger's active-value summary. Returning
	 * `undefined` for an item leaves it plain.
	 */
	decorate?: (item: ComposerSettingItem) => ItemDecoration | undefined;
	items: ComposerSettingItem[];
	key: string;
	/** Section header + the muted prefix in the trigger summary. */
	label: string;
	/**
	 * The section's options are still being probed (the per-agent ACP capability
	 * fetch is in flight). Keeps the section visible with a "Detecting…" spinner
	 * instead of silently hiding it while `items` is momentarily empty — so
	 * switching to an agent whose model/thinking pickers are still loading reads
	 * as loading, not missing.
	 */
	loading?: boolean;
	onChange: (id: string) => void;
	/**
	 * Custom body for the section (e.g. the agent picker's grouped/icon rows).
	 * When omitted, a plain checked-item list is rendered from `items`.
	 */
	renderContent?: (onSelect: (id: string) => void) => ReactNode;
	value: string | undefined;
	/**
	 * How the section's options are picked. `"list"` (the default) is the checked
	 * submenu; `"slider"` renders them inline as a stepped slider — one detent per
	 * item, in the order the source advertised them. Reserved for ORDERED scales
	 * (reasoning effort: off → low → … → max), never for unordered sets, and the
	 * detent count is always the live list's length rather than a fixed ladder, so
	 * a 3-level agent and a 5-level one each get their own.
	 */
	variant?: "list" | "slider";
}

export interface ComposerSettingsMenuProps {
	/** Anchor edge of the dropdown content. Defaults to `"start"`. */
	align?: "start" | "center" | "end";
	className?: string;
	/**
	 * Compact trigger: keep the agent name plus any icon-only settings and the
	 * effort meter, while model names and plain plugin values stay in the
	 * dropdown. Used in the composer's single-row compact mode where every
	 * visible token must earn its width.
	 */
	compact?: boolean;
	/**
	 * Extra content pinned to the bottom of the dropdown, below the setting
	 * sections (e.g. the subscription usage meters in the composer's compact
	 * mode, where they no longer fit as standalone toolbar chips). The wrapper
	 * self-hides when the node renders nothing, so passing a component that may
	 * return `null` (like `UsageBar`) never leaves an empty bordered strip.
	 */
	footer?: ReactNode | ((close: () => void) => ReactNode);
	/**
	 * A mark rendered at the START of the default trigger, before the summary —
	 * the active agent's engine logo or custom avatar image in compact mode. It
	 * must be a non-button node (a logo `<img>`/svg) so it nests safely inside
	 * the trigger `<button>`.
	 */
	leading?: ReactNode;
	/**
	 * Replaces the default sibling-submenu body (one `DropdownMenuSub` per
	 * section) with a caller-owned dropdown body — the universal picker's
	 * grouped `Ryu (providers nested) · External Agents` layout. The trigger
	 * summary still derives from `sections` (so `Ryu · Sonnet · Plan` stays
	 * glanceable); only the popover body changes. `close` is for navigation
	 * actions that leave the picker (configure credentials, create agent, …);
	 * setting picks (model / thinking / approval) stay open so the user can
	 * adjust several without re-opening. When omitted, the sections render as
	 * before.
	 */
	renderBody?: (close: () => void) => ReactNode;
	sections: ComposerSettingsSection[];
	/** Side the dropdown content opens toward. Defaults to `"top"` (composer). */
	side?: "top" | "bottom" | "left" | "right";
	/**
	 * A node rendered at the END of the default trigger, after the summary — the
	 * subscription usage meters in compact mode, sat beside the agent name. Like
	 * `leading`, it must render non-button content (the `UsageBar`'s tooltip
	 * triggers are `<span>`s) so it nests safely inside the trigger `<button>`.
	 */
	trailing?: ReactNode;
	/**
	 * A custom trigger element rendered in place of the default summary Button —
	 * e.g. the empty-state agent logo. It receives the dropdown's open/close
	 * wiring via base-ui's `render`, so a caller gets the EXACT same Agent ·
	 * Model · Thinking dropdown behind a different-looking trigger. When omitted,
	 * the default `Ryu · Sonnet · Plan` summary button is shown.
	 */
	trigger?: ReactElement;
}

export function activeItem(
	section: ComposerSettingsSection
): ComposerSettingItem | undefined {
	return (
		section.items.find((it) => it.id === section.value) ?? section.items[0]
	);
}

export function activeItemName(
	section: ComposerSettingsSection
): string | undefined {
	if (section.activeName) {
		return section.activeName;
	}
	return activeItem(section)?.name;
}
