import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// The data-driven half of the composer's plugin controls
// (`contributes.composer_controls[]`).
//
// The composer used to render exactly one contributed shape — a `toggle` row in
// the "+" menu — so an app that needed a mode picker, a live pill or a one-shot
// action had to be hand-written into the shell. The manifest vocabulary is richer
// than that (`toggle` | `select` | `chip` | `action`, each with `placement` and
// `order`), and this module is where an entry is validated, placed and ordered so
// the composer can render the whole vocabulary declaratively.
//
// Pure by design (no React, no fetch): the routing rules below decide which of
// the composer's THREE existing seams an entry reaches, and each is unit-tested.
//
//   - `toggle`                     → the "+" menu's plugin rows (`pluginControls`)
//   - `select` (placement "menu")  → a composer settings-menu section
//   - `chip` / `action` / `select` (placement "bar") → the composer toolbar
//
// Nothing here forks the composer: all three seams are props of the ONE InputBar
// slot, so every surface that mounts it inherits the controls.

import { contributionSourceRequest } from "@ryu/app-host/views";
import type {
	PluginComposerControl,
	PluginComposerControlOption,
} from "@/src/lib/api/plugins.ts";

/** The control types this build renders. An entry whose `type` is not one of
 *  these is SKIPPED (never rendered, never crashed on) — `type` is a bare string
 *  on the wire precisely so a newer control reaches an older shell intact. */
export const COMPOSER_CONTROL_TYPES = [
	"toggle",
	"select",
	"chip",
	"action",
] as const;

export type ComposerControlType = (typeof COMPOSER_CONTROL_TYPES)[number];

/** Where a control is drawn. `"menu"` is the manifest default. */
export type ComposerControlPlacement = "bar" | "menu";

/** A control narrowed to a `type` this build knows how to render. */
export type KnownComposerControl = Omit<PluginComposerControl, "type"> & {
	type: ComposerControlType;
};

/** Every control the composer can render, split by the seam it reaches. Each
 *  list is sorted by `order` (see {@link sortComposerControls}). */
export interface PartitionedComposerControls {
	/** `chip`, `action`, and bar-placed `select` — the composer toolbar. */
	bar: KnownComposerControl[];
	/** Menu-placed `select` — one composer settings-menu section each. */
	selects: KnownComposerControl[];
	/** `toggle` — the "+" menu rows. Unchanged from the original renderer. */
	toggles: KnownComposerControl[];
}

function isNonEmptyString(v: string | undefined): v is string {
	return isNativeText(v) && v.length > 0;
}

/**
 * Whether an entry is renderable: a known `type` plus the identity fields every
 * control needs. `flag` is required for EVERY type because `plugin_flags` is the
 * composer's only channel to the turn — a control the turn hook cannot observe
 * would do nothing — and `plugin` is required because it names the app that owns
 * the control (and, for an `action`, whose granted capability is dispatched).
 */
export function isKnownComposerControl(
	control: PluginComposerControl
): control is KnownComposerControl {
	const hasIdentity =
		COMPOSER_CONTROL_TYPES.some((type) => type === control.type) &&
		isNonEmptyString(control.id) &&
		isNonEmptyString(control.flag) &&
		isNonEmptyString(control.label) &&
		isNonEmptyString(control.plugin);
	if (!hasIdentity) {
		return false;
	}
	// These two types have no useful fallback when their wire contract is
	// incomplete: an action cannot dispatch without a capability, and a chip
	// cannot observe a live value without a Core-relative source. Reject them at
	// the contribution boundary instead of letting the composer render inert UI.
	if (control.type === "action") {
		return isNonEmptyString(control.capability);
	}
	if (control.type === "chip") {
		return contributionSourceRequest(control, control.source) !== null;
	}
	return true;
}

/**
 * Where a control is drawn. `placement` wins when it names a known slot;
 * otherwise the type's natural home applies — a `chip` is documented as "an
 * inline pill in the composer bar", an `action` is a button, and both read as
 * junk buried in a menu, while `toggle`/`select` belong in a menu.
 */
export function composerControlPlacement(
	control: KnownComposerControl
): ComposerControlPlacement {
	if (control.placement === "bar" || control.placement === "menu") {
		return control.placement;
	}
	return control.type === "chip" || control.type === "action" ? "bar" : "menu";
}

/** Controls carrying no explicit `order` sort after the ordered ones, then by
 *  label — stable regardless of the order Core happened to concatenate plugins in. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

/** Sort by `order`, then label, then id. Returns a new array (never mutates the
 *  query-cached contributions payload). */
export function sortComposerControls<
	T extends { id: string; label: string; order?: number },
>(controls: T[]): T[] {
	return [...controls].sort((a, b) => {
		const byOrder = (a.order ?? UNORDERED) - (b.order ?? UNORDERED);
		if (byOrder !== 0) {
			return byOrder;
		}
		const byLabel = a.label.localeCompare(b.label);
		return byLabel === 0 ? a.id.localeCompare(b.id) : byLabel;
	});
}

/**
 * Split the contributed controls across the composer's seams, dropping anything
 * unrenderable. A `toggle` always lands in the "+" menu regardless of
 * `placement`: that is the only seam the shared `GoalPlusButton` exposes for
 * toggle rows, and it is the shape in use today — the existing path is preserved
 * byte-for-byte.
 */
export function partitionComposerControls(
	controls: PluginComposerControl[]
): PartitionedComposerControls {
	const known = controls.filter(isKnownComposerControl);
	const toggles = known.filter((c) => c.type === "toggle");
	const rest = known.filter((c) => c.type !== "toggle");
	const bar = rest.filter((c) => composerControlPlacement(c) === "bar");
	const selects = rest.filter(
		(c) => c.type === "select" && composerControlPlacement(c) === "menu"
	);
	return {
		toggles: sortComposerControls(toggles),
		selects: sortComposerControls(selects),
		bar: sortComposerControls(bar),
	};
}

/**
 * Key prefix for the `ComposerSettingsSection` a menu-placed `select` becomes.
 *
 * It is a real discriminator, not cosmetic: the composer's trigger summary is
 * derived from the same section list that feeds the picker body, and a section
 * carrying this prefix is deliberately EXCLUDED from that summary — an app's mode
 * picker belongs in the popover, not spelled out as a permanent extra segment on
 * every composer. Both halves read it from here so they cannot drift.
 */
export const COMPOSER_PLUGIN_SECTION_PREFIX = "plugin:";

/** The settings-menu section key for one contributed control. */
export function composerPluginSectionKey(control: {
	id: string;
	plugin: string;
}): string {
	return `${COMPOSER_PLUGIN_SECTION_PREFIX}${control.plugin}:${control.id}`;
}

/** True when a settings-menu section came from a plugin's `composer_controls`. */
export function isComposerPluginSectionKey(key: string): boolean {
	return key.startsWith(COMPOSER_PLUGIN_SECTION_PREFIX);
}

/** A `select`'s renderable options, dropping malformed entries (an option with
 *  no `value` cannot be chosen; one with no `label` cannot be read). */
export function composerSelectOptions(
	control: KnownComposerControl
): PluginComposerControlOption[] {
	return (control.options ?? []).filter(
		(o) => isNonEmptyString(o?.value) && isNonEmptyString(o?.label)
	);
}

/**
 * The value a `select` currently holds: the user's pick, else the manifest
 * `default`, else the first option — so a select is never "empty" and the turn
 * always sees a meaningful mode. Returns undefined when the control offers no
 * usable option at all (nothing to pick, so nothing is rendered).
 */
export function composerSelectValue(
	control: KnownComposerControl,
	values: Record<string, string>
): string | undefined {
	const options = composerSelectOptions(control);
	const chosen = values[control.flag];
	if (chosen && options.some((o) => o.value === chosen)) {
		return chosen;
	}
	if (control.default && options.some((o) => o.value === control.default)) {
		return control.default;
	}
	return options[0]?.value;
}
