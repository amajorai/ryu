// apps/desktop/src/hooks/useSidebarModes.ts
//
// The sidebar arrangements currently on offer: the shell's own, plus any an
// enabled app contributes via `contributes.sidebar_modes`.
//
// A hook rather than a helper each surface calls with its own inputs, because two
// surfaces offer the list — the sidebar's own context menu and the Appearance tab
// — and they must offer the SAME one. The section-resolution rule
// (`contributedSidebarModes` drops names this shell has no section for, and drops
// a mode left with none) is the part that would drift: a settings page listing a
// mode the sidebar refuses to enter is worse than not listing it.

import { useMemo } from "react";
import {
	BUILTIN_SIDEBAR_MODES,
	contributedSidebarModes,
	type SidebarModeDescriptor,
} from "@/src/components/layout/sidebar-modes.ts";
import type { SectionKey } from "@/src/components/layout/sidebar-sections.ts";
import {
	usePluginContributions,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";

export interface SidebarModesResult {
	modes: SidebarModeDescriptor[];
	/** Whether Core ANSWERED — not whether it returned anything, and not merely
	 *  whether the fetch finished. `resolveSidebarMode` needs the difference to tell
	 *  a mode that is not-fetched-yet from one whose app is gone. */
	settled: boolean;
}

export function useSidebarModes(): SidebarModesResult {
	const { sidebar_sections: sections, sidebar_modes: modes } =
		usePluginContributions();
	// `isSuccess`, deliberately NOT `isFetched`: this query is `retry: false`, so a
	// down node, an unreachable remote or an older Core without the endpoint all
	// finish the fetch with an error and an EMPTY payload. Under `isFetched` that
	// reads as "every contributed mode is gone" and the caller would clear the
	// user's chosen mode on a transient outage — permanently, since the write
	// lands in localStorage. A failed fetch means we do not know, which is the
	// unsettled case.
	const { isSuccess } = usePluginContributionsQuery();
	const sectionKeys = useMemo<SectionKey[]>(
		() => sections.map((s): SectionKey => `plugin:${s.plugin}:${s.id}`),
		[sections]
	);
	return {
		modes: useMemo(
			() => [
				...BUILTIN_SIDEBAR_MODES,
				...contributedSidebarModes(modes, sectionKeys),
			],
			[modes, sectionKeys]
		),
		settled: isSuccess,
	};
}
