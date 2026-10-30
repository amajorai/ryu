import { useEffect, useMemo, useState } from "react";
import type { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import {
	DEFAULT_SIDEBAR_MODE,
	useSidebarMode,
} from "@/src/hooks/useSidebarMode.ts";
import { useSidebarModes } from "@/src/hooks/useSidebarModes.ts";
import { resolveSidebarMode } from "./sidebar-modes.ts";
import type { DynamicSectionKey, SectionKey } from "./sidebar-sections.ts";

type ContributedSections = ReturnType<
	typeof usePluginContributions
>["sidebar_sections"];

/** The sidebar mode the panel renders (built-in, contributed, or the Bot
 *  product's fixed one), its offered modes, and the tabbed-strip selection. */
export function useSidebarPanelMode({
	botProduct,
	contributedSections,
}: {
	botProduct: boolean;
	contributedSections: ContributedSections;
}) {
	// The stored mode KEY; the arrangement it names is resolved below against the
	// modes on offer (built-in + contributed) — see `layout/sidebar-modes.ts`.
	const [sidebarMode, setSidebarMode] = useSidebarMode();
	// Which section the tabbed bar currently reveals. Reconciled below against the
	// visible keys so it never points at a hidden/missing section.
	const [activeTabbedSection, setActiveTabbedSection] =
		useState<SectionKey | null>(null);
	// Changing mode drops the remembered tab. The reconciliation below only catches
	// a selection the new mode does NOT offer, and "chats" is offered by both — so
	// arriving in Bot mode from a Tabbed session parked on Chats would open on
	// Chats is offered by both modes, so arriving in Agents view from a full
	// sidebar must still land on the roster. Clearing lets each mode's own default
	// win.
	// reacting to the mode change itself, not to the setter.
	useEffect(() => {
		setActiveTabbedSection(null);
	}, [sidebarMode]);
	// The arrangements on offer, shared with the Appearance tab so the two surfaces
	// cannot disagree about which contributed modes are real.
	const { modes: sidebarModes, settled: contributionsSettled } =
		useSidebarModes();
	const dynamicSectionKeys = useMemo<SectionKey[]>(
		() =>
			[...contributedSections]
				.sort(
					(a, b) =>
						(a.order ?? Number.MAX_SAFE_INTEGER) -
						(b.order ?? Number.MAX_SAFE_INTEGER)
				)
				.map((s): DynamicSectionKey => `plugin:${s.plugin}:${s.id}`),
		[contributedSections]
	);
	const resolvedSidebarMode = resolveSidebarMode(
		sidebarMode,
		sidebarModes,
		contributionsSettled
	);
	const activeMode: import("./sidebar-modes.ts").SidebarModeDescriptor =
		botProduct
			? {
					defaultSection: "chats",
					description: "Bot conversations",
					key: "bot",
					layout: "stacked" as const,
					sections: ["chats"],
					title: "Bot",
				}
			: resolvedSidebarMode.mode;
	const modeIsStale = botProduct ? false : resolvedSidebarMode.stale;
	// A stored mode whose app is gone is cleared, not merely fallen back from —
	// otherwise every render re-resolves a key that will never resolve again, and
	// re-enabling the app silently teleports the user back into its mode weeks
	// later. Only ever runs once per disappearance (the write changes `sidebarMode`).
	useEffect(() => {
		if (modeIsStale) {
			setSidebarMode(DEFAULT_SIDEBAR_MODE);
		}
	}, [modeIsStale, setSidebarMode]);
	return {
		activeMode,
		activeTabbedSection,
		dynamicSectionKeys,
		setActiveTabbedSection,
		setSidebarMode,
		sidebarModes,
	};
}
