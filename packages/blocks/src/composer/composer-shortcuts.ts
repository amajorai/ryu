import { type Chord, chordMatches, normalizeChord } from "@ryu/hotkeys/chord";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "./composer-settings-menu.tsx";
import { isFullAccessEquivalent } from "./full-access-warning.tsx";

const NON_CYCLABLE_AGENT_IDS = new Set(["__create_agent__"]);

/** Stable action ids shared with the desktop hotkey registry + Core keybindings. */
// SAFETY: This authored literal inventory defines the exact action-id union and
// iteration order. Const captures those catalog literals, not decoded input.
export const COMPOSER_SHORTCUT_IDS = [
	"composer.cycle-agent",
	"composer.cycle-mode",
	"composer.cycle-model",
	"composer.cycle-thinking",
] as const;

export type ComposerShortcutId = (typeof COMPOSER_SHORTCUT_IDS)[number];

/** Default chords — focus-scoped (fire only inside the composer input). */
export const COMPOSER_SHORTCUT_DEFAULTS = {
	"composer.cycle-agent": "Tab",
	"composer.cycle-mode": "Shift+Tab",
	"composer.cycle-model": "Shift+M",
	"composer.cycle-thinking": "Shift+T",
} satisfies Record<ComposerShortcutId, Chord>;

/** Effective bindings for the four composer cycle actions (`null` = unbound). */
interface AuthoredComposerShortcutBindings {
	"composer.cycle-agent": Chord | null;
	"composer.cycle-mode": Chord | null;
	"composer.cycle-model": Chord | null;
	"composer.cycle-thinking": Chord | null;
}

export type ComposerShortcutBindings = AuthoredComposerShortcutBindings;

export interface ComposerShortcutEvent {
	altKey: boolean;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
	nativeEvent?: { isComposing?: boolean };
	preventDefault?: () => void;
	shiftKey: boolean;
}

/** Merge saved overrides with composer defaults (absent key → default). */
export function resolveComposerShortcutBindings(
	overrides: Partial<Record<string, Chord | null>> = {}
): ComposerShortcutBindings {
	const bindings: Partial<ComposerShortcutBindings> = {};
	for (const id of COMPOSER_SHORTCUT_IDS) {
		if (Object.hasOwn(overrides, id)) {
			const override = overrides[id];
			bindings[id] = override ? normalizeChord(override) : null;
		} else {
			bindings[id] = normalizeChord(COMPOSER_SHORTCUT_DEFAULTS[id]);
		}
	}
	// SAFETY: The canonical four-id inventory above is exhaustive for this
	// mapped type. Each loop iteration assigns its key on both branches, using
	// the native normalizeChord result or null; construction is now complete.
	return bindings as ComposerShortcutBindings;
}

/** Pick the four composer bindings out of a full hotkey id → chord map. */
export function composerBindingsFromMap(
	bindings: ReadonlyMap<string, Chord | null>
): ComposerShortcutBindings {
	const overrides: Partial<ComposerShortcutBindings> = {};
	for (const id of COMPOSER_SHORTCUT_IDS) {
		if (bindings.has(id)) {
			overrides[id] = bindings.get(id) ?? null;
		}
	}
	return resolveComposerShortcutBindings(overrides);
}

function currentIndex(section: ComposerSettingsSection): number {
	const selected = section.value ?? section.items[0]?.id;
	const index = section.items.findIndex((item) => item.id === selected);
	return index >= 0 ? index : 0;
}

function cycleSection(
	section: ComposerSettingsSection | undefined,
	filterItem: (
		item: ComposerSettingItem,
		section: ComposerSettingsSection
	) => boolean = () => true
): boolean {
	if (!section) {
		return false;
	}
	const items = section.items.filter((item) => filterItem(item, section));
	const selected = section.value ?? section.items[currentIndex(section)]?.id;
	const selectedIndex = items.findIndex((item) => item.id === selected);
	const selectedIsFilteredOut =
		selectedIndex < 0 && section.items.some((item) => item.id === selected);
	// Leaving a filtered-out value (e.g. full access) needs only one remaining
	// item to step to; cycling among allowed items needs at least two.
	if (items.length < (selectedIsFilteredOut ? 1 : 2)) {
		return false;
	}
	const nextIndex = selectedIndex >= 0 ? selectedIndex + 1 : 0;
	const nextItem = items[nextIndex % items.length];
	if (!nextItem) {
		return false;
	}
	section.onChange(nextItem.id);
	return true;
}

/**
 * A keyboard cycle never lands on a Full Access–equivalent item: the settings
 * menu routes those picks through the confirmation dialog, which a shortcut
 * cannot show. Full access stays reachable from the menu. When the current
 * value is itself full access it drops out of the list, so the next press steps
 * down to the first non-full-access item, even when that is the only one left.
 */
function isCyclableWithoutConfirmation(
	item: ComposerSettingItem,
	section: ComposerSettingsSection
): boolean {
	return !isFullAccessEquivalent(item, section.label);
}

function findSection(
	sections: ComposerSettingsSection[],
	predicate: (section: ComposerSettingsSection) => boolean
): ComposerSettingsSection | undefined {
	return sections.find(
		(section) => section.items.length > 0 && predicate(section)
	);
}

function isThinkingSection(section: ComposerSettingsSection): boolean {
	const haystack = `${section.key} ${section.label} ${section.ariaLabel}`
		.toLowerCase()
		.trim();
	return ["thinking", "reasoning", "reason", "thought", "effort"].some((word) =>
		haystack.includes(word)
	);
}

function isApprovalSection(section: ComposerSettingsSection): boolean {
	if (section.key === "approval") {
		return true;
	}
	const haystack = `${section.key} ${section.label} ${section.ariaLabel}`
		.toLowerCase()
		.trim();
	if (section.label.trim().toLowerCase() === "mode") {
		return true;
	}
	return ["approval", "permission", "sandbox", "access"].some((word) =>
		haystack.includes(word)
	);
}

function firstExtraConfigSection(
	sections: ComposerSettingsSection[]
): ComposerSettingsSection | undefined {
	return findSection(
		sections,
		(section) =>
			section.key !== "agent" &&
			section.key !== "model" &&
			!isApprovalSection(section)
	);
}

function runComposerShortcut(
	id: ComposerShortcutId,
	sections: ComposerSettingsSection[]
): boolean {
	switch (id) {
		case "composer.cycle-agent":
			return cycleSection(
				findSection(sections, (section) => section.key === "agent"),
				({ id: itemId }) => {
					if (NON_CYCLABLE_AGENT_IDS.has(itemId)) {
						return false;
					}
					return !itemId.startsWith("team:");
				}
			);
		case "composer.cycle-mode":
			return cycleSection(
				findSection(sections, isApprovalSection),
				isCyclableWithoutConfirmation
			);
		case "composer.cycle-model":
			return cycleSection(
				findSection(sections, (section) => section.key === "model")
			);
		case "composer.cycle-thinking":
			return cycleSection(
				findSection(sections, isThinkingSection) ??
					firstExtraConfigSection(sections),
				isCyclableWithoutConfirmation
			);
		default:
			return false;
	}
}

/**
 * Cycle agent / mode / model / thinking pickers from a keyboard event.
 * Returns true when handled. Bindings default to Tab / Shift+Tab / Shift+M /
 * Shift+T; pass resolved overrides from Settings → Keyboard shortcuts.
 */
export function handleComposerSettingsShortcut(
	event: ComposerShortcutEvent,
	sections: ComposerSettingsSection[],
	bindings: ComposerShortcutBindings = resolveComposerShortcutBindings()
): boolean {
	if (event.nativeEvent?.isComposing) {
		return false;
	}

	for (const id of COMPOSER_SHORTCUT_IDS) {
		const chord = bindings[id];
		if (!chord) {
			continue;
		}
		if (!chordMatches(chord, event)) {
			continue;
		}
		const handled = runComposerShortcut(id, sections);
		if (handled) {
			event.preventDefault?.();
		}
		return handled;
	}

	return false;
}
