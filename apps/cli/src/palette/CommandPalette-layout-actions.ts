// CommandPalette layout + navigation builders - pane Layout actions and the
// merged NAV destinations (static list plus registered surfaces).

import { tf } from "../i18n/translate.ts";
import { listSurfaces } from "../workspace/router.ts";
import type { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import {
	NAV_DESTINATIONS,
	type PaletteAction,
} from "./CommandPalette-registry.ts";

// Merge the static NAV_DESTINATIONS with any registered surface path that is not
// already listed, so newly registered surfaces are reachable from the palette
// without editing this file.
const SIDE_REGIONS = [
	["right", "Right"],
	["bottom", "Bottom"],
] as const;

/** Pane layout actions, matching the Desktop palette's Layout group. */
export function layoutActions(
	workspace: ReturnType<typeof useWorkspace>,
	close: () => void
): PaletteAction[] {
	const run = (action: () => void) => () => {
		action();
		close();
	};
	const actions: PaletteAction[] = [];
	for (const [region, name] of SIDE_REGIONS) {
		if (workspace.focusedRegion !== region) {
			actions.push({
				id: `layout:move-${region}`,
				group: "Actions",
				label: tf("Move tab to {name}", { name }),
				run: run(() => workspace.moveActiveTo(region)),
			});
		}
		const hasTabs = workspace.state.groups.some(
			(group) => group.region === region && group.itemIds.length > 0
		);
		if (hasTabs) {
			const open = workspace.state.openRegions[region];
			actions.push({
				id: `layout:toggle-${region}`,
				group: "Actions",
				label: `${open ? "Hide" : "Show"} ${name}`,
				run: run(() =>
					open ? workspace.hideRegion(region) : workspace.showRegion(region)
				),
			});
		}
	}
	if (workspace.focusedRegion !== "center") {
		actions.push({
			id: "layout:move-center",
			group: "Actions",
			label: "Move tab to Center",
			run: run(() => workspace.moveActiveTo("center")),
		});
	}
	// Split / join Center is the "action:split" entry (Ctrl+Alt+S shortcut).
	actions.push({
		id: "layout:reset",
		group: "Actions",
		label: "Reset layout",
		run: run(workspace.resetLayout),
	});
	return actions;
}

export function buildNavDestinations(): { label: string; path: string }[] {
	const known = new Set(NAV_DESTINATIONS.map((dest) => dest.path));
	const extra: { label: string; path: string }[] = [];
	for (const surface of listSurfaces()) {
		const path = `/${surface.id}`;
		// Only fold in a surface whose id-path is one it actually owns; deep-link
		// aliases (e.g. store-models owns /models, not /store-models) are already
		// covered by the static NAV_DESTINATIONS and would otherwise 404.
		if (!known.has(path) && surface.match(path)) {
			extra.push({ label: surface.title, path });
		}
	}
	return [...NAV_DESTINATIONS, ...extra];
}
