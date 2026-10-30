import { TabsSubtle, TabsSubtleItem } from "@ryu/ui/components/tabs-subtle.tsx";
import type { useTabLayout } from "@/src/hooks/useTabLayout.ts";
import {
	orderedSidebarModeSections,
	type SidebarModeDescriptor,
} from "./sidebar-modes.ts";
import { SECTION_TAB_ICONS } from "./sidebar-panel-state.tsx";
import type { SectionKey } from "./sidebar-sections.ts";

/** The section selectors shown in "tabbed" mode — a single horizontal strip of
 *  tabs (TabsSubtle, "active label" mode: the selected tab shows its label, the
 *  rest collapse to their icon). The strip overflows to the right on a
 *  horizontal scroll when the sections don't fit, rather than wrapping. Clicking
 *  a tab reveals just that section's list below; labels follow the same
 *  (optionally customized) names as the stacked "sections" mode. */
export function TabbedSectionNav({
	activeKey,
	keys,
	labels,
	onSelect,
}: {
	activeKey: SectionKey | null;
	keys: SectionKey[];
	labels: Record<string, string>;
	onSelect: (key: SectionKey) => void;
}) {
	if (keys.length === 0) {
		return null;
	}
	// Map the active section key to its index; default to the first tab so the
	// pill always has an anchor even before a selection lands.
	const selectedIndex = Math.max(0, activeKey ? keys.indexOf(activeKey) : 0);
	return (
		<div className="px-2 pt-1 pb-0.5">
			<TabsSubtle
				activeLabel
				aria-label="Sidebar sections"
				onSelect={(index) => {
					const key = keys[index];
					if (key) {
						onSelect(key);
					}
				}}
				selectedIndex={selectedIndex}
			>
				{keys.map((key, index) => (
					<TabsSubtleItem
						icon={
							Object.entries(SECTION_TAB_ICONS).find(
								([sectionKey]) => sectionKey === key
							)?.[1]
						}
						index={index}
						key={key}
						label={labels[key]}
					/>
				))}
			</TabsSubtle>
		</div>
	);
}

/** Which sections the tabbed strip (and the stacked jump-list) offers, and
 *  which one is selected, for the active sidebar mode. */
export function resolveTabbedSections({
	activeMode,
	activeTabbedSection,
	hiddenSections,
	renderOrder,
	sectionLabels,
	tabLayout,
}: {
	activeMode: SidebarModeDescriptor;
	activeTabbedSection: SectionKey | null;
	hiddenSections: Set<string>;
	renderOrder: SectionKey[];
	sectionLabels: Record<string, string>;
	tabLayout: ReturnType<typeof useTabLayout>;
}) {
	// The section keys offered by the tabbed bar: every visible section, minus the
	// Tabs section when it would render nothing (horizontal tab layout owns tabs).
	const visibleTabbedKeys = renderOrder.filter(
		(key) =>
			!(hiddenSections.has(key) || (key === "tabs" && tabLayout !== "vertical"))
	);
	// A mode that NAMES sections narrows the strip to exactly those. Most modes
	// follow the user's own section order (so someone who dragged Chats above
	// Agents keeps that reading order); built-in Bot mode intentionally keeps its
	// declared Agents → Chats order. `hiddenSections` is deliberately NOT
	// applied to them: picking a mode is a more specific instruction than a
	// section hidden back when the sidebar listed fifteen of them.
	const tabbedKeys = activeMode.sections
		? orderedSidebarModeSections(activeMode, renderOrder)
		: visibleTabbedKeys;
	// Keep the remembered section pointed at a real, visible section. A mode's
	// declared `defaultSection` wins over "the first section" — Bot mode declares
	// Agents as both its first section and its default, so the roster is primary.
	const defaultTabbedKey =
		activeMode.defaultSection && tabbedKeys.includes(activeMode.defaultSection)
			? activeMode.defaultSection
			: (tabbedKeys[0] ?? null);
	const activeTabbedKey =
		activeTabbedSection && tabbedKeys.includes(activeTabbedSection)
			? activeTabbedSection
			: defaultTabbedKey;

	// The peek jump-list only makes sense in a stacked mode, where every visible
	// section is rendered (and thus has a scroll anchor). Under a tab strip only one
	// section exists at a time, so there's nothing to jump between. Agents view is
	// deliberately a single focused roster surface too; its direct threads are
	// already nested in the bot rows rather than behind another selector.
	const sectionNavItems =
		activeMode.layout === "stacked" && activeMode.key !== "agent"
			? visibleTabbedKeys.map((key) => ({
					key,
					label: sectionLabels[key] ?? key,
				}))
			: [];
	return { activeTabbedKey, sectionNavItems, tabbedKeys };
}
