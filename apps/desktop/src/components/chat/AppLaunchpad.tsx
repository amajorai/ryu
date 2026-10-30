// apps/desktop/src/components/chat/AppLaunchpad.tsx
//
// The app row on the empty chat start page: up to six apps the user can actually
// open, as quiet icon tiles under the composer. It is OFF by default (D5); the
// composer's "+" menu turns it on ("Apps on start page", see
// launchpad-preference.ts), and every app stays reachable from the sidebar.
//
// Two decisions are load-bearing.
//
// WHAT IS LISTED. The source is `usePluginContributions().companions` — the
// full-page surfaces of ENABLED apps, already enabled-filtered server-side —
// narrowed further to navigable UI companions. It is deliberately NOT the apps catalog: most
// feature apps are install-on-demand, and a sidecar-only app (`@ryu/social`) has no UI
// at all, so gridding the catalog would paint a dozen tiles that do nothing when
// clicked. If it has a tile here, it opens. Same list, same order, same launch
// call as the sidebar's Apps section — this is a second door onto that surface,
// not a second definition of it.
//
// WHY THE GRID IS SPLIT OUT. {@link AppLaunchpadGrid} takes its items as a prop
// and is exported, so `e2e/harness/app-launchpad-story.tsx` can mount the real
// component in real Chromium. The deliverable here is a laid-out row — a
// rendered-geometry fact a type-check cannot see — and the hooks the wrapper
// uses need the app's whole node/provider tree, which a story cannot supply.
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import type { CardDither } from "@ryu/marketplace/catalog/types";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useMemo } from "react";
import { StandaloneAppContextMenuItems } from "@/src/components/apps/standalone-app-menu.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { useStandaloneApps } from "@/src/hooks/useStandaloneApps.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import { useChatLaunchpadEnabled } from "./launchpad-preference.ts";

/** One row, at most six tiles: enough to reach the apps used most, short enough
 *  that the composer above it stays the centre of the page. */
const MAX_TILES = 6;

/** One tile. Everything the shared {@link AppIcon} needs to paint an app exactly
 *  as the sidebar and the Store paint it, plus the label and the launch id. */
export interface LaunchpadItem {
	/** Owning app id for the standalone host action. */
	appId?: string;
	/** Persisted icon-bytes key (`<id>@<version>`), so tiles paint offline. */
	cacheKey?: string | null;
	dither?: CardDither | null;
	iconBackground?: string | null;
	/** Icon-primitive id: the companion's own glyph, else the app's manifest art. */
	iconId?: string | null;
	/** Manifest-declared inset and letterbox treatment for icon art. */
	iconPadding?: string | null;
	iconUrl?: string | null;
	/** The companion id — what {@link pluginCompanionPath} routes to. */
	id: string;
	label: string;
	/** Generative-tile seed. ALWAYS the owning PLUGIN id, so an app that appears
	 *  in both the sidebar and here tiles identically in both. */
	seedId: string;
	standaloneInstalled?: boolean;
	version?: string;
}

export interface AppLaunchpadGridProps {
	className?: string;
	items: LaunchpadItem[];
	onInstallStandalone?: (item: LaunchpadItem) => void;
	/** `newTab` is true for a middle-click, matching the sidebar's Apps rows. */
	onOpen: (item: LaunchpadItem, newTab: boolean) => void;
	onOpenStandalone?: (item: LaunchpadItem) => void;
	onRemoveStandalone?: (item: LaunchpadItem) => void;
}

/**
 * The presentational row. Renders nothing for an empty list, so the start page
 * never grows a stray strip under the composer for a user whose apps are all off.
 */
export function AppLaunchpadGrid({
	className,
	items,
	onOpen,
	onInstallStandalone,
	onOpenStandalone,
	onRemoveStandalone,
}: AppLaunchpadGridProps) {
	if (items.length === 0) {
		return null;
	}
	return (
		<div
			className={cn(
				"mt-4 flex w-full flex-wrap justify-center gap-1",
				className
			)}
			data-testid="launchpad-scroller"
		>
			{items.slice(0, MAX_TILES).map((item) => (
				<ContextMenu key={item.id}>
					<ContextMenuTrigger>
						<button
							className="group flex w-20 flex-col items-center gap-1.5 rounded-xl px-1 py-2 transition-colors duration-150 hover:bg-muted hover:duration-0"
							onAuxClick={(e) => {
								if (e.button === 1) {
									e.preventDefault();
									onOpen(item, true);
								}
							}}
							onClick={() => onOpen(item, false)}
							title={item.label}
							type="button"
						>
							{/* Identical resolution order and seed to the sidebar's Apps
							    rows and the Store's cards, so one app tiles the same way
							    wherever it is seen. */}
							<AppIcon
								cacheKey={item.cacheKey}
								className="size-10"
								dither={item.dither}
								iconBackground={item.iconBackground}
								iconId={item.iconId}
								iconPadding={item.iconPadding}
								iconUrl={item.iconUrl}
								name={item.label}
								seedId={item.seedId}
								size={20}
							/>
							<span className="w-full truncate text-center text-muted-foreground text-xs group-hover:text-foreground">
								{item.label}
							</span>
						</button>
					</ContextMenuTrigger>
					<ContextMenuContent>
						<ContextMenuItem onClick={() => onOpen(item, false)}>
							Open
						</ContextMenuItem>
						<StandaloneAppContextMenuItems
							enabled
							hasCompanion={Boolean(item.appId)}
							installed={item.standaloneInstalled ?? false}
							onInstall={
								onInstallStandalone
									? () => onInstallStandalone(item)
									: undefined
							}
							onOpen={
								onOpenStandalone ? () => onOpenStandalone(item) : undefined
							}
							onRemove={
								onRemoveStandalone ? () => onRemoveStandalone(item) : undefined
							}
						/>
					</ContextMenuContent>
				</ContextMenu>
			))}
		</div>
	);
}

export interface AppLaunchpadProps {
	className?: string;
}

/** Wires the row to the live contribution list and to `openTab`; renders
 *  nothing until the user turns the row on from the composer's "+" menu. */
export function AppLaunchpad({ className }: AppLaunchpadProps) {
	const enabled = useChatLaunchpadEnabled();
	return enabled ? <EnabledAppLaunchpad className={className} /> : null;
}

function EnabledAppLaunchpad({ className }: AppLaunchpadProps) {
	const { companions } = usePluginContributions();
	const { apps } = useApps();
	const {
		install: installStandalone,
		installedAppIds,
		open: openStandalone,
		uninstall: uninstallStandalone,
	} = useStandaloneApps();
	const openTab = useTabSelector((state) => state.openTab);

	// The owning app of each companion, so a tile paints the app's real manifest
	// art. A companion contribution carries only its own optional `icon`; most
	// apps declare their icon on the MANIFEST, which is why a list keyed on the
	// contribution alone falls through to one repeated glyph.
	const appsById = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);

	const items = useMemo<LaunchpadItem[]>(
		() =>
			companions.filter(isNavigablePluginCompanion).map((c) => {
				const owner = c.pluginId ? appsById.get(c.pluginId) : undefined;
				const seedId = c.pluginId || c.id;
				return {
					cacheKey: iconCacheKey(
						seedId,
						owner?.installedVersion ?? owner?.version
					),
					dither: owner?.iconDither,
					iconBackground: owner?.iconBackground,
					iconId: c.icon ?? owner?.icon,
					iconPadding: owner?.iconPadding,
					iconUrl: owner?.iconUrl,
					id: c.id,
					label: c.label || c.name,
					seedId,
					appId: c.pluginId ?? undefined,
					standaloneInstalled: c.pluginId
						? installedAppIds.has(c.pluginId)
						: false,
					version: owner?.version ?? "unknown",
				};
			}),
		[companions, appsById, installedAppIds]
	);

	const handleOpen = useCallback(
		(item: LaunchpadItem, newTab: boolean) => {
			openTab(pluginCompanionPath(item.id), {
				title: item.label,
				forceNew: newTab,
			});
		},
		[openTab]
	);

	const handleInstallStandalone = useCallback(
		(item: LaunchpadItem) => {
			if (!item.appId) {
				return;
			}
			const target = {
				appId: item.appId,
				name: item.label,
				version: item.version ?? "unknown",
			};
			installStandalone(target)
				.then(() => openStandalone(target))
				.catch((error) => {
					toast.error("Couldn't install the standalone app", {
						description:
							error instanceof Error ? error.message : "Please try again.",
					});
				});
		},
		[installStandalone, openStandalone]
	);

	const handleOpenStandalone = useCallback(
		(item: LaunchpadItem) => {
			if (!item.appId) {
				return;
			}
			openStandalone({
				appId: item.appId,
				name: item.label,
				version: item.version ?? "unknown",
			}).catch((error) => {
				toast.error("Couldn't open the standalone app", {
					description:
						error instanceof Error ? error.message : "Please try again.",
				});
			});
		},
		[openStandalone]
	);

	const handleRemoveStandalone = useCallback(
		(item: LaunchpadItem) => {
			if (!item.appId) {
				return;
			}
			uninstallStandalone(item.appId).catch((error) => {
				toast.error("Couldn't remove the standalone app", {
					description:
						error instanceof Error ? error.message : "Please try again.",
				});
			});
		},
		[uninstallStandalone]
	);

	return (
		<AppLaunchpadGrid
			className={className}
			items={items}
			onInstallStandalone={handleInstallStandalone}
			onOpen={handleOpen}
			onOpenStandalone={handleOpenStandalone}
			onRemoveStandalone={handleRemoveStandalone}
		/>
	);
}

export default AppLaunchpad;
