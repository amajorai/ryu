import type { ComposerSettingsSection } from "./composer-settings-menu.tsx";

const NON_CYCLABLE_AGENT_IDS = new Set(["__create_agent__"]);

export interface ComposerShortcutEvent {
	altKey: boolean;
	ctrlKey: boolean;
	key: string;
	metaKey: boolean;
	nativeEvent?: { isComposing?: boolean };
	preventDefault?: () => void;
	shiftKey: boolean;
}

function currentIndex(section: ComposerSettingsSection): number {
	const selected = section.value ?? section.items[0]?.id;
	const index = section.items.findIndex((item) => item.id === selected);
	return index >= 0 ? index : 0;
}

function cycleSection(
	section: ComposerSettingsSection | undefined,
	filterItem: (id: string) => boolean = () => true
): boolean {
	if (!section) {
		return false;
	}
	const items = section.items.filter((item) => filterItem(item.id));
	if (items.length < 2) {
		return false;
	}
	const selected = section.value ?? section.items[currentIndex(section)]?.id;
	const selectedIndex = items.findIndex((item) => item.id === selected);
	const nextIndex = selectedIndex >= 0 ? selectedIndex + 1 : 0;
	section.onChange(items[nextIndex % items.length].id);
	return true;
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

/** Cycle agent / model / thinking pickers from a keyboard event. Returns true when handled. */
export function handleComposerSettingsShortcut(
	event: ComposerShortcutEvent,
	sections: ComposerSettingsSection[]
): boolean {
	if (
		event.altKey ||
		event.ctrlKey ||
		event.metaKey ||
		event.nativeEvent?.isComposing
	) {
		return false;
	}

	const key = event.key.toLowerCase();
	if (key === "tab" && !event.shiftKey) {
		const handled = cycleSection(
			findSection(sections, (section) => section.key === "agent"),
			(id) => {
				if (NON_CYCLABLE_AGENT_IDS.has(id)) {
					return false;
				}
				return !id.startsWith("team:");
			}
		);
		if (handled) {
			event.preventDefault?.();
		}
		return handled;
	}

	if (key === "tab" && event.shiftKey) {
		const handled = cycleSection(findSection(sections, isApprovalSection));
		if (handled) {
			event.preventDefault?.();
		}
		return handled;
	}

	if (key === "m" && event.shiftKey) {
		const handled = cycleSection(
			findSection(sections, (section) => section.key === "model")
		);
		if (handled) {
			event.preventDefault?.();
		}
		return handled;
	}

	if (key === "t" && event.shiftKey) {
		const handled = cycleSection(
			findSection(sections, isThinkingSection) ??
				firstExtraConfigSection(sections)
		);
		if (handled) {
			event.preventDefault?.();
		}
		return handled;
	}

	return false;
}
