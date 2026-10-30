import { File01Icon } from "@hugeicons/core-free-icons";
import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { useCallback, useMemo, useState } from "react";
import {
	dockPanelsFor,
	findDockPanel,
	isPluginTabKind,
	isRouteTabKind,
	routeTabPath,
} from "@/src/components/panels/dock-panels.ts";
import { useAppShellPath } from "@/src/contributions/app-shell-routes.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import {
	MISSION_CONTROL_BUTTON_ID,
	MISSION_CONTROL_PLUGIN_ID,
} from "@/src/lib/api/mission-control.ts";
import type { SubagentView } from "./native-dock-panels.tsx";
import type { TabIconSpec } from "./panel-tab-bar.tsx";
import { tabTypeIcon } from "./panel-tab-bar.tsx";
import type { TabKind } from "./tab-model.ts";
import {
	BOTTOM_TAB_TYPES,
	BUILTIN_TAB_ICONS,
	contributedTabType,
	NATIVE_SHELL_TAB_KINDS,
	RIGHT_TAB_TYPES,
	routeAppIcon,
} from "./tab-model.ts";

/**
 * What each dock's "+" menu offers (built-ins plus enabled apps' contributed
 * panels) and the icon an open tab wears in the strip.
 */
export function useDockTabTypes({
	agentActivityAvailable,
	canUseNativeShell,
}: {
	agentActivityAvailable: boolean;
	canUseNativeShell: boolean;
}) {
	// The enabled apps' contributed dock panels. Core only serves ENABLED plugins'
	// contributions, so this feed IS the set of app tabs that should be offered:
	// disabling an app removes its tab from both the "+" menu and the launchpad
	// with no shell change. An already-open tab is deliberately left alone (it
	// renders an "app no longer enabled" placeholder instead) — the contributions
	// read is best-effort, so a momentarily unreachable node must not destroy the
	// user's open tabs.
	const { dock_panels: dockPanels } = usePluginContributions();
	// Installed apps, for resolving the icon of an app opened as a PAGE tab
	// (`/plugin/<id>`) — see `routeAppIcon`.
	const { apps } = useApps();
	const bottomTabTypes = useMemo(
		() => [
			...(canUseNativeShell ? BOTTOM_TAB_TYPES : []),
			...dockPanelsFor(dockPanels, "bottom").map(contributedTabType),
		],
		[canUseNativeShell, dockPanels]
	);
	// The Mission Control panel is shell infrastructure (it needs the per-chat
	// `cowork` prop, so it can never be a contributed `dock_panels` entry — see
	// `isPinnableDockTabKind`), but the FEATURE belongs to the not-pre-installed
	// `@ryu/mission-control` app: the digest it renders comes from that app's
	// sidecar. Offering the tab when no enabled app claims the app's shell path
	// gave a "+" menu row whose only outcome was an empty panel. Resolving the
	// same path the app's PAGE half mounts at keeps both halves on one fact.
	const missionPath = useAppShellPath(
		MISSION_CONTROL_PLUGIN_ID,
		MISSION_CONTROL_BUTTON_ID
	);
	// The session Box screen is offered while the Box rollout is on (the default).
	const boxScreensEnabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const rightTabTypes = useMemo(
		() => [
			// Only the OFFERING is gated. `BUILTIN_TAB_ICONS.mission` and the
			// renderer stay unconditional so an already-open tab survives a
			// contributions blip, exactly like the contributed-panel path.
			...RIGHT_TAB_TYPES.filter(
				(type) =>
					(canUseNativeShell || !NATIVE_SHELL_TAB_KINDS.has(type.kind)) &&
					(type.kind !== "mission" || missionPath !== null) &&
					(type.kind !== "agent-activity" || agentActivityAvailable) &&
					(type.kind !== "box-screen" || boxScreensEnabled)
			),
			...dockPanelsFor(dockPanels, "right").map(contributedTabType),
		],
		[
			agentActivityAvailable,
			boxScreensEnabled,
			canUseNativeShell,
			dockPanels,
			missionPath,
		]
	);
	// The subagent currently pinned to the right panel's subagent tab (if any).
	// DECLARED ABOVE `iconForKind`: that callback's dep array reads it at render
	// time, so leaving it below would be a TDZ ReferenceError, not a stale value.
	const [subagentView, setSubagentView] = useState<SubagentView | null>(null);
	// Icon for an OPEN tab (the strip), which may be a kind absent from either
	// add-menu — a programmatic panel, or a contributed one whose app just left.
	const iconForKind = useCallback(
		(kind: TabKind): TabIconSpec => {
			if (kind === "unavailable") {
				return {};
			}
			// The subagent tab hosts ONE subagent, so it wears that subagent's own
			// avatar — the same glyph the pinned summary's row and the transcript
			// header show — instead of a generic robot every subagent shares. The
			// dep below is what re-renders the strip when the tab is re-pointed at
			// another subagent (the tab is reused by kind, never stacked).
			if (kind === "subagent" && subagentView) {
				return { seed: subagentView.id };
			}
			if (isPluginTabKind(kind)) {
				const panel = findDockPanel(dockPanels, kind);
				return panel ? tabTypeIcon(contributedTabType(panel)) : {};
			}
			if (isRouteTabKind(kind)) {
				// An app opened as a PAGE (`/plugin/<id>`, registered per enabled
				// companion in Layout) is still that app, so it wears the app's own
				// icon. Only contributed dock PANELS resolved theirs before, so the
				// same app showed its mark when docked and a generic page glyph when
				// opened as a tab — the tab strip and the sidebar's vertical tabs both
				// read this, so both were affected.
				const appIcon = routeAppIcon(routeTabPath(kind), apps);
				return appIcon ? { iconId: appIcon } : { glyph: File01Icon };
			}
			return { glyph: BUILTIN_TAB_ICONS[kind] };
		},
		[apps, dockPanels, subagentView]
	);
	return {
		bottomTabTypes,
		dockPanels,
		iconForKind,
		rightTabTypes,
		setSubagentView,
		subagentView,
	};
}
