import {
	type ComputerTerminal01Icon,
	Globe02Icon,
	Megaphone01Icon,
	MonitorDotFreeIcons,
	SmartPhone01Icon,
	UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { lazy, type ReactNode, Suspense } from "react";
import type { CoworkContextPanelProps } from "@/src/components/panels/CoworkContextPanel.tsx";
import {
	type DockTabKind,
	findDockPanel,
	nativeDockPanelKey,
} from "@/src/components/panels/dock-panels.ts";
import { pluginDockSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import type { PluginDockPanel } from "@/src/lib/api/plugins.ts";
import PluginCompanionPage from "@/src/pages/PluginCompanionPage.tsx";
import PluginViewPage from "@/src/pages/PluginViewPage.tsx";

// App panels load when their tab first renders, not with the shell.
const BrowserTabPanel = lazy(() =>
	import("./browser-panel.tsx").then((module) => ({
		default: module.BrowserTabPanel,
	}))
);
const SimulatorTabPanel = lazy(() =>
	import("./simulator-panel.tsx").then((module) => ({
		default: module.SimulatorTabPanel,
	}))
);
const UgcPanel = lazy(() =>
	import("@/src/components/panels/UgcPanel.tsx").then((module) => ({
		default: module.UgcPanel,
	}))
);
const CrmPanel = lazy(() =>
	import("@/src/components/panels/crm/CrmPanel.tsx").then((module) => ({
		default: module.CrmPanel,
	}))
);
const DesktopStreamPanel = lazy(() =>
	import("@/src/components/panels/DesktopStreamPanel.tsx").then((module) => ({
		default: module.DesktopStreamPanel,
	}))
);

// ── Panel content renderer ────────────────────────────────────────────────────

/** Chat-specific data for the Context (cowork) tab, threaded from ChatPage. */
export type CoworkData = CoworkContextPanelProps;

/** The subagent whose transcript the right panel is currently showing. */
export interface SubagentView {
	id: string;
	nonce: number;
}

// ── App-contributed dock panels ───────────────────────────────────────────────

/** A shell component registered for a `panel: "native"` contribution — the
 *  migration seam for a first-party app whose panel is hand-written React
 *  driving its sidecar over the ext-proxy. The COMPONENT stays here (it is shell
 *  code, not plugin code), while the tab's existence, title, icon and placement
 *  become the app's declaration: disabling the app removes the tab, with nothing
 *  hardcoded on this side beyond the registry key. */
interface NativeDockPanelDef {
	/** Bundled glyph, so a first-party panel's tab icon never depends on the
	 *  network (a contributed `icon` id is the fallback for panels not listed here). */
	icon: typeof ComputerTerminal01Icon;
	render: (ctx: { active: boolean; label: string }) => ReactNode;
}

/** Keyed `<plugin>/<id>` (see `nativeDockPanelKey`). These two entries are the
 *  Browser and Simulator tabs that used to be members of the shell's closed
 *  `TabKind` union; their components below are unchanged, so an enabled app
 *  renders exactly what it did before. */
export const NATIVE_DOCK_PANELS = new Map<string, NativeDockPanelDef>([
	[
		"@ryu/browser/browser",
		{
			icon: Globe02Icon,
			render: ({ active, label }) => (
				<BrowserTabPanel active={active} title={label} />
			),
		},
	],
	[
		"@ryu/simulator/simulator",
		{
			icon: SmartPhone01Icon,
			render: () => <SimulatorTabPanel />,
		},
	],
	[
		"@ryu/ugc/ugc",
		{
			icon: Megaphone01Icon,
			render: () => <UgcPanel />,
		},
	],
	[
		"@ryu/crm/crm",
		{
			icon: UserGroupIcon,
			render: () => <CrmPanel />,
		},
	],
	[
		"@ryu/desktop/desktop",
		{
			icon: MonitorDotFreeIcons,
			render: ({ active }) => <DesktopStreamPanel active={active} />,
		},
	],
]);

export function DockPanelPlaceholder({ text }: { text: string }) {
	return (
		<div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-xs">
			{text}
		</div>
	);
}

/**
 * Render one app-contributed dock panel. Every failure mode degrades to a
 * placeholder rather than throwing: the owning app was disabled (its
 * contributions leave the feed), the manifest names a `native` component this
 * build does not register, or the `panel` discriminant is newer than this shell.
 * That is the whole point of keeping `panel` an open string on the wire.
 */
export function PluginDockTabContent({
	active,
	dockPanels,
	label,
	tabKind,
}: {
	active: boolean;
	dockPanels: PluginDockPanel[];
	label: string;
	tabKind: DockTabKind;
}) {
	const panel = findDockPanel(dockPanels, tabKind);
	if (!panel) {
		return (
			<DockPanelPlaceholder text="This panel's app is no longer enabled." />
		);
	}
	const spec = pluginDockSpec(panel);
	const emptyText = spec?.emptyText;
	if (panel.panel === "native") {
		const def = NATIVE_DOCK_PANELS.get(nativeDockPanelKey(panel));
		if (!def) {
			return (
				<DockPanelPlaceholder
					text={emptyText ?? "This panel isn't available in this version."}
				/>
			);
		}
		return (
			<Suspense fallback={<div className="h-full" />}>
				{def.render({ active, label })}
			</Suspense>
		);
	}
	if (panel.panel === "companion" && spec?.companion) {
		// The app's own sandboxed surface, mounted through the same gated page the
		// companion route uses (no plugin code runs unless the runtime flag is on).
		return (
			<div className="h-full overflow-auto">
				<PluginCompanionPage companionId={spec.companion} />
			</div>
		);
	}
	if (panel.panel === "view" && spec?.view) {
		// One of the plugin's own declarative views, rendered with the host's
		// components by the same page the view route uses — the app returned DATA.
		return (
			<div className="h-full overflow-auto">
				<PluginViewPage pluginId={panel.plugin} viewId={spec.view} />
			</div>
		);
	}
	return (
		<DockPanelPlaceholder
			text={emptyText ?? "This panel isn't supported by this version of Ryu."}
		/>
	);
}
