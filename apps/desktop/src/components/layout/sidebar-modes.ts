// apps/desktop/src/components/layout/sidebar-modes.ts
//
// The sidebar's MODE VOCABULARY — the arrangements the left sidebar can be in —
// and the resolution of a stored mode key against the ones currently on offer.
//
// This is the third axis of the sidebar, and the one that was closed until now.
// `sidebar-sections.ts` answers "what sections exist" and is deliberately half
// open (a closed built-in list plus `plugin:<pluginId>:<sectionId>` keys from
// `contributes.sidebar_sections`). Chrome buttons answer "what nav rows exist",
// same shape. Neither could answer "how is the sidebar ARRANGED": the three
// arrangements were a closed union inside `useSidebarMode`, so an app could add a
// section to the list but could not propose the posture that features it — which
// is exactly what a bot-mode plugin (Grok's, Nous' Hermes Bot Mode) is.
//
// `contributes.sidebar_modes` is that seam, and the built-in modes are expressed
// as descriptors in the SAME shape rather than special-cased in the renderer, for
// the reason `StoreTabContribution` gives about its retired `view` field: the
// flagship example of "an app can own this" must not be the one entry no app can
// reproduce. `agent` below is an ordinary built-in Bot mode descriptor; anything it can do, a
// contributed mode can do.
//
// What a mode deliberately CANNOT do: draw anything. It names sections, and each
// section already declares how its own rows look (`SidebarSectionSpec.rowStyle`).
// That split is what keeps a mode grant-free — the worst a hostile mode can do is
// offer an unwanted tab list, one menu row away from being switched off.

import {
	DEFAULT_SECTION_ORDER,
	type SectionKey,
} from "@/src/components/layout/sidebar-sections.ts";
import type { PluginSidebarMode } from "@/src/lib/api/plugins.ts";

/**
 * How a mode lays the sidebar out.
 *
 * - `stacked` — every visible section as its own collapsible group, all at once.
 * - `strip` — the section labels become a horizontal tab strip and exactly one
 *   section's list shows below it.
 *
 * The built-in Agents view uses `stacked` with a named subset so its direct
 * threads can sit below each bot. Contributed modes currently resolve to `strip`
 * and therefore keep their named sections as a compact one-at-a-time selector.
 */
export type SidebarModeLayout = "stacked" | "strip";

/** One arrangement the sidebar can be in — built-in or contributed. */
export interface SidebarModeDescriptor {
	/** Which section the mode opens on. Absent = the first of `sections`. */
	defaultSection?: SectionKey;
	/** One-line description shown where the mode is offered. */
	description?: string;
	/** Glyph id for a contributed mode (built-ins draw no glyph in the menu). */
	icon?: string;
	/** The stored key: `sections` / `tabbed` / `agent`, or `plugin:<id>:<modeId>`. */
	key: string;
	layout: SidebarModeLayout;
	/** The owning plugin id, for a contributed mode. */
	plugin?: string;
	/** The sections offered as tabs, in display order. `null` = "every visible
	 *  section", which is what the two shell-wide modes mean. */
	sections: SectionKey[] | null;
	title: string;
}

/** The two sections shown by the built-in Bot/Agents view, in display order.
 *  Direct threads live under their owning agent; the chat list keeps group and
 *  otherwise-unassigned conversations reachable below the roster. */
export const AGENT_MODE_SECTIONS: SectionKey[] = ["agents", "chats"];

/**
 * The shell's own modes, in the order they are offered.
 *
 * `agent` is opinionated on purpose — Agents comes first, direct threads live
 * beneath each bot, and other chats remain below the roster — and that opinion
 * is expressed with the same fields a contributed mode gets
 * (`sections`, `defaultSection`), not with a branch in the renderer.
 */
export const BUILTIN_SIDEBAR_MODES: SidebarModeDescriptor[] = [
	{
		key: "sections",
		title: "Sections",
		layout: "stacked",
		sections: null,
	},
	{
		key: "tabbed",
		title: "Tabbed sidebar",
		layout: "strip",
		sections: null,
	},
	{
		// Keep the key stable for existing localStorage values and older builds.
		key: "agent",
		title: "Agents view",
		description:
			"Show agents with their direct threads inline, with other chats below.",
		layout: "stacked",
		sections: AGENT_MODE_SECTIONS,
		defaultSection: "agents",
	},
];

/** The default arrangement — the built-in Bot mode. */
export const DEFAULT_SIDEBAR_MODE_DESCRIPTOR =
	BUILTIN_SIDEBAR_MODES.find((mode) => mode.key === "agent") ??
	(BUILTIN_SIDEBAR_MODES[0] as SidebarModeDescriptor);

/**
 * Resolve the display order for a mode's named sections.
 *
 * Bot mode keeps its declared Agents → Chats order even when the user has
 * customized the global sidebar order. Other modes continue to follow that
 * global order, preserving the existing customization behavior.
 */
export function orderedSidebarModeSections(
	mode: Pick<SidebarModeDescriptor, "key" | "sections">,
	effectiveOrder: readonly SectionKey[]
): SectionKey[] {
	if (!mode.sections || mode.key === "agent") {
		return [...(mode.sections ?? effectiveOrder)];
	}
	return [...mode.sections].sort((a, b) => {
		const ai = effectiveOrder.indexOf(a);
		const bi = effectiveOrder.indexOf(b);
		return (
			(ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
			(bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
		);
	});
}

const BUILTIN_SECTION_KEYS = new Set<string>(DEFAULT_SECTION_ORDER);

/**
 * Map the contributions feed onto descriptors, dropping section names that do not
 * resolve against the sections this shell actually has.
 *
 * A name is kept when it is one of the shell's own built-in section keys or a
 * `plugin:` key present in `available` (the contributed sections currently
 * mounted). Anything else is dropped — an app may legitimately name a section
 * belonging to a sibling app the user has not installed, and losing one tab is a
 * better answer than losing the mode or, worse, offering a tab that renders
 * nothing.
 *
 * A mode left with no resolvable section is dropped entirely: it would present as
 * a mode whose every arrangement is "blank".
 */
export function contributedSidebarModes(
	modes: readonly PluginSidebarMode[],
	available: readonly SectionKey[]
): SidebarModeDescriptor[] {
	const availableDynamic = new Set<string>(available);
	const resolves = (name: string): boolean =>
		BUILTIN_SECTION_KEYS.has(name) || availableDynamic.has(name);
	return [...modes]
		.sort(
			(a, b) =>
				(a.order ?? Number.MAX_SAFE_INTEGER) -
				(b.order ?? Number.MAX_SAFE_INTEGER)
		)
		.map((mode) => {
			const sections = (mode.sections ?? []).filter(resolves) as SectionKey[];
			const declaredDefault = mode.default_section;
			return {
				key: `plugin:${mode.plugin}:${mode.id}`,
				title: mode.title,
				description: mode.description,
				icon: mode.icon,
				plugin: mode.plugin,
				layout: "strip" as const,
				sections,
				defaultSection:
					declaredDefault && sections.includes(declaredDefault as SectionKey)
						? (declaredDefault as SectionKey)
						: undefined,
			};
		})
		.filter((mode) => mode.sections.length > 0);
}

/**
 * Resolve the stored mode key against the modes on offer.
 *
 * The stored key is localStorage; the contributed half of the list is a network
 * feed. So "the stored mode is not in the list" has two meanings, and treating
 * them alike is how a sidebar ends up either blank or flashing:
 *
 * - **The feed has not answered yet** (`contributionsSettled === false`): a
 *   contributed mode is merely unknown, not gone. Falling back would flash the
 *   full section list on every cold start, and rendering its strip with no tabs
 *   would leave the sidebar blank — so this returns the built-in Bot mode and
 *   swaps to the real mode the moment the feed lands.
 * - **The feed answered and the mode is not in it** (the app was disabled or
 *   uninstalled): the mode is gone. The same built-in Bot mode fallback applies,
 *   but the caller can act on `stale` to clear the stored key so this stops being
 *   re-evaluated every render.
 */
export function resolveSidebarMode(
	stored: string,
	modes: readonly SidebarModeDescriptor[],
	contributionsSettled: boolean
): { mode: SidebarModeDescriptor; stale: boolean } {
	const found = modes.find((m) => m.key === stored);
	if (found) {
		return { mode: found, stale: false };
	}
	return {
		mode: DEFAULT_SIDEBAR_MODE_DESCRIPTOR,
		// Only a settled feed can call a stored mode gone. Before that it is pending,
		// and clearing it would silently un-choose a mode the user did pick.
		stale: contributionsSettled,
	};
}
