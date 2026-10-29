import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import { useOptionalReport } from "@ryu/marketplace/report";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import { useMemo } from "react";
import { StandaloneAppContextMenuItems } from "@/src/components/apps/standalone-app-menu.tsx";
import { OpenInNewWindowContextMenuItem } from "@/src/components/layout/OpenInNewWindowMenuItem.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { useStandaloneApps } from "@/src/hooks/useStandaloneApps.ts";
import { type AppInfo, isCoreAppTier } from "@/src/lib/api/plugins.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import { openEntityInNewWindow } from "@/src/lib/window-routing.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";
import { type PinnedAppItem, PinnedAppStage } from "./pinned-app-stage.tsx";
import { SectionLoadError } from "./sidebar-agents-section.tsx";
import {
	SectionAddButton,
	type SectionProps,
	SidebarSection,
} from "./sidebar-section.tsx";
import { SectionPagingControls } from "./sidebar-section-overflow.tsx";
import {
	NAMED_SORT_ACCESSORS,
	sortItems,
	usePaged,
} from "./sidebar-sort-paging.ts";

/** Plugins list in the sidebar — the user's installed apps/plugins. Rows and the
 *  "+" open the Plugins store page. Hidden by default. */
export function PluginsSection({
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps) {
	const openTab = useTabSelector((state) => state.openTab);
	const { apps, loading, error, reload } = useApps();
	const {
		install: installStandalone,
		installedAppIds,
		open: openStandalone,
		uninstall: uninstallStandalone,
	} = useStandaloneApps();
	const installed = useMemo(() => apps.filter((a) => a.installed), [apps]);
	const paged = usePaged(
		sortItems(installed, sort, NAMED_SORT_ACCESSORS),
		pageSize
	);

	const openPlugins = (forceNew = false) =>
		openTab("/apps", { title: "Plugins", forceNew });

	const openPluginsInNewWindow = () =>
		void openEntityInNewWindow({ path: "/apps", title: "Plugins" });

	const emptyMessage = loading ? "Loading…" : "No plugins installed";

	const renderPluginRows = (list: typeof installed) =>
		list.map((app) => (
			<SidebarMenuItem key={app.id}>
				<ContextMenu>
					<ContextMenuTrigger>
						{/* sidebar row combines nested controls with drag/middle-click */}
						<div
							className="group/row flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									openPlugins(true);
								}
							}}
							onClick={() => openPlugins()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									openPlugins();
								}
							}}
							role="button"
							tabIndex={0}
						>
							{/* The app's real icon square, identical to the Store's — the
							    manifest icon over its dither/flat background, falling back to
							    the generative tile seeded by plugin id. Previously this took
							    only `companion.icon` and painted it flat, so an app whose
							    icon lives on the manifest (most of them) fell through to one
							    repeated puzzle glyph. `companion.icon` stays as the first
							    choice: a companion that registers its own icon is being
							    specific about this surface. */}
							<AppIcon
								cacheKey={iconCacheKey(
									app.id,
									app.installedVersion ?? app.version
								)}
								className="size-5"
								corners="compact"
								dither={app.iconDither}
								iconBackground={app.iconBackground ?? undefined}
								iconId={app.companion?.icon ?? app.icon}
								iconPadding={app.iconPadding}
								iconUrl={app.iconUrl}
								name={app.name}
								seedId={app.id}
								size={12}
							/>
							<OverflowTooltip
								className="min-w-0 flex-1 truncate text-sm"
								text={app.name}
							/>
							{/* The SAME status glyphs the Store's catalog rows wear, so a
							    plugin reads identically wherever you meet it. This row used to
							    say "disabled" with a bare 1.5px grey dot: no tooltip, no
							    accessible name, and nothing at all for built-in — a mark you
							    could only learn by elimination. */}
							{app.builtIn ? <StatusBadge kind="builtin" /> : null}
							{app.enabled ? null : (
								<StatusBadge kind="unavailable" label="Disabled" />
							)}
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => openPlugins(true)}>
							<HugeiconsIcon
								className="mr-2 size-4"
								icon={ArrowUpRight01Icon}
							/>
							Open in new tab
						</ContextMenuItem>
						<OpenInNewWindowContextMenuItem onClick={openPluginsInNewWindow} />
						<StandaloneAppContextMenuItems
							enabled={app.enabled}
							hasCompanion={app.runnables.some(
								(runnable) => runnable.kind === "companion"
							)}
							installed={installedAppIds.has(app.id)}
							onInstall={() => {
								const target = {
									appId: app.id,
									name: app.name,
									version: app.version,
								};
								installStandalone(target)
									.then(() => openStandalone(target))
									.catch((error) => {
										toast.error("Couldn't install the standalone app", {
											description:
												error instanceof Error
													? error.message
													: "Please try again.",
										});
									});
							}}
							onOpen={() => {
								openStandalone({
									appId: app.id,
									name: app.name,
									version: app.version,
								}).catch((error) => {
									toast.error("Couldn't open the standalone app", {
										description:
											error instanceof Error
												? error.message
												: "Please try again.",
									});
								});
							}}
							onRemove={() => {
								uninstallStandalone(app.id).catch((error) => {
									toast.error("Couldn't remove the standalone app", {
										description:
											error instanceof Error
												? error.message
												: "Please try again.",
									});
								});
							}}
						/>
					</ContextMenuContent>
				</ContextMenu>
			</SidebarMenuItem>
		));

	return (
		<SidebarSection
			action={
				<SectionAddButton onClick={() => openPlugins()} title="Add plugin" />
			}
			collapsed={collapsed}
			dnd={dnd}
			label="Plugins"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="plugins"
			sort={sort}
		>
			{error && installed.length === 0 && (
				<SectionLoadError
					message="Couldn't load your plugins."
					onRetry={() => {
						reload().catch(() => undefined);
					}}
				/>
			)}
			{!error && installed.length === 0 && (
				<p className="px-2 py-2 text-muted-foreground text-xs">
					{emptyMessage}
				</p>
			)}
			{installed.length > 0 && (
				<>
					<SidebarMenu>{renderPluginRows(paged.visible)}</SidebarMenu>
					<SectionPagingControls
						overflow={{
							getSearchText: (app) => app.name ?? "",
							items: paged.items,
							label: "plugins",
							renderList: (list) => (
								<SidebarMenu>{renderPluginRows(list)}</SidebarMenu>
							),
						}}
						paged={paged}
					/>
				</>
			)}
		</SidebarSection>
	);
}

/** Apps shelf in the sidebar. Core-tier Apps get one visual tile each; their
 * internal views are not flattened into the host's top-button list. Community
 * plugins stay in the Plugins section and retain their generic contributions. */
export function AppsSection({
	apps,
	collapsed,
	dnd,
	menu,
	onToggleCollapsed,
	pageSize,
	sort,
}: SectionProps & { apps: AppInfo[] }) {
	const openTab = useTabSelector((state) => state.openTab);
	const { companions, sidebar_buttons: sidebarButtons } =
		usePluginContributions();
	const {
		install: installStandalone,
		installedAppIds,
		open: openStandalone,
		uninstall: uninstallStandalone,
	} = useStandaloneApps();
	const report = useOptionalReport();
	const appItems = useMemo<PinnedAppItem[]>(() => {
		const coreAppIds = new Set(
			apps.filter((app) => isCoreAppTier(app.tier)).map((app) => app.id)
		);
		const companionByApp = new Map<string, (typeof companions)[number]>();
		for (const companion of companions) {
			if (
				companion.pluginId &&
				isNavigablePluginCompanion(companion) &&
				!companionByApp.has(companion.pluginId)
			) {
				companionByApp.set(companion.pluginId, companion);
			}
		}

		const entryByApp = new Map<string, { order: number; target: string }>();
		for (const button of [...sidebarButtons]
			.filter((candidate) => coreAppIds.has(candidate.plugin))
			.sort(
				(a, b) =>
					(a.order ?? Number.MAX_SAFE_INTEGER) -
					(b.order ?? Number.MAX_SAFE_INTEGER)
			)) {
			if (!entryByApp.has(button.plugin)) {
				entryByApp.set(button.plugin, {
					order: button.order ?? Number.MAX_SAFE_INTEGER,
					target: button.target,
				});
			}
		}

		return apps
			.filter((app) => isCoreAppTier(app.tier) && app.installed && app.enabled)
			.sort(
				(a, b) =>
					(entryByApp.get(a.id)?.order ?? Number.MAX_SAFE_INTEGER) -
					(entryByApp.get(b.id)?.order ?? Number.MAX_SAFE_INTEGER)
			)
			.flatMap((app) => {
				const companion = companionByApp.get(app.id);
				const entry = entryByApp.get(app.id);
				const target = companion
					? pluginCompanionPath(companion.id)
					: entry?.target;
				if (!target) {
					return [];
				}
				return [
					{
						cacheKey: iconCacheKey(app.id, app.installedVersion ?? app.version),
						dither: app.iconDither,
						iconBackground: app.iconBackground,
						iconId: companion?.icon ?? app.companion?.icon ?? app.icon,
						iconPadding: app.iconPadding,
						iconUrl: app.iconUrl,
						id: app.id,
						label: app.name,
						seedId: app.id,
						standaloneInstalled: installedAppIds.has(app.id),
						target,
					},
				];
			});
	}, [apps, companions, installedAppIds, sidebarButtons]);

	if (appItems.length === 0) {
		return null;
	}

	const handleOpen = (app: PinnedAppItem, newTab: boolean) => {
		openTab(app.target, { title: app.label, forceNew: newTab });
	};
	const handleOpenNewWindow = (app: PinnedAppItem) => {
		void openEntityInNewWindow({ path: app.target, title: app.label });
	};
	const handleReport = (app: PinnedAppItem) => {
		report?.open({
			id: app.id,
			kind: "plugin",
			itemName: app.label,
			source: "installed",
		});
	};
	const standaloneTarget = (app: PinnedAppItem) => ({
		appId: app.id,
		name: app.label,
		version:
			apps.find((candidate) => candidate.id === app.id)?.version ?? "unknown",
	});
	const handleInstallStandalone = (app: PinnedAppItem) => {
		const target = standaloneTarget(app);
		installStandalone(target)
			.then(() => openStandalone(target))
			.catch((error) => {
				toast.error("Couldn't install the standalone app", {
					description:
						error instanceof Error ? error.message : "Please try again.",
				});
			});
	};
	const handleOpenStandalone = (app: PinnedAppItem) => {
		openStandalone(standaloneTarget(app)).catch((error) => {
			toast.error("Couldn't open the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		});
	};
	const handleRemoveStandalone = (app: PinnedAppItem) => {
		uninstallStandalone(app.id).catch((error) => {
			toast.error("Couldn't remove the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		});
	};

	return (
		<SidebarSection
			collapsed={collapsed}
			dnd={dnd}
			label="Apps"
			menu={menu}
			onToggleCollapsed={onToggleCollapsed}
			pageSize={pageSize}
			sectionKey="companions"
			sort={sort}
		>
			<PinnedAppStage
				apps={appItems}
				onInstallStandalone={handleInstallStandalone}
				onOpen={handleOpen}
				onOpenNewWindow={handleOpenNewWindow}
				onOpenStandalone={handleOpenStandalone}
				onRemoveStandalone={handleRemoveStandalone}
				onReport={report ? handleReport : undefined}
			/>
		</SidebarSection>
	);
}
