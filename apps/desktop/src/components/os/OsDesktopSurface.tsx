import {
	GridViewIcon,
	ShuffleIcon,
	SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isMac } from "@ryu/hotkeys/chord";
import {
	useOptionalHotkey,
	useOptionalHotkeyBinding,
} from "@ryu/hotkeys/react";
import { useLiteralMessages } from "@ryu/i18n/react";

import {
	Dock,
	DockIcon,
	DockItem,
	DockLabel,
} from "@ryu/ui/components/dock.tsx";
import {
	Menubar,
	MenubarContent,
	MenubarGroup,
	MenubarItem,
	MenubarLabel,
	MenubarMenu,
	MenubarRadioGroup,
	MenubarRadioItem,
	MenubarSeparator,
	MenubarShortcut,
	MenubarTrigger,
} from "@ryu/ui/components/menubar.tsx";
import { ProgressiveBlur } from "@ryu/ui/components/progressive-blur.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Fragment, useMemo, useState } from "react";
import { NavUser } from "@/src/components/layout/NavUser.tsx";
import { SidebarBrandBadge } from "@/src/components/layout/SidebarBrandBadge.tsx";
import { useAppSurface } from "@/src/contexts/app-surface-context.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import { isNavigablePluginCompanion } from "@/src/lib/plugin-companion-navigation.ts";
import {
	ALL_WALLPAPER_SETS,
	useWallpaper,
	WALLPAPER_SETS,
} from "@/src/lib/wallpaper.ts";
import { topBarInsets } from "@/src/lib/window-chrome-layout.ts";
import { WallpaperBackdrop } from "../wallpaper/WallpaperBackdrop.tsx";
import {
	APP_LAUNCHER_HOTKEY_ID,
	APP_LAUNCHER_LABEL,
	launcherAriaKeyShortcuts,
	launcherShortcutLabel,
	OS_APPS,
	type OsApp,
	OsAppIcon,
	type OsDesktopSurfaceProps,
	resolveOsApp,
} from "./OsDesktopSurface.apps.tsx";
import { AppLauncherDialog } from "./OsDesktopSurface.launcher.tsx";
import { OsWindowCard } from "./OsDesktopSurface.window-card.tsx";
import { OsHome, OsHomeSettings } from "./OsHome.tsx";

export type {
	OsApp,
	OsAppRecord,
	OsDesktopSurfaceProps,
	OsWindow,
} from "./OsDesktopSurface.apps.tsx";
export {
	OS_APPS,
	osAppCategories,
	osAppCategory,
	resolveOsApp,
} from "./OsDesktopSurface.apps.tsx";

export function OsDesktopSurface({
	activeWindowId,
	appRecords = [],
	canSwitchToConsole = true,
	contributedApps = [],
	onActivateWindow,
	onCloseWindow,
	onOpenApp,
	menubarActions,
	windows,
}: OsDesktopSurfaceProps) {
	const tl = useLiteralMessages();
	// The menu bar replaces the titlebar, so it clears the native window
	// controls itself (traffic lights left, caption buttons right).
	const { nativeWindowChrome } = useAppSurface();
	const barInsets = topBarInsets({ isMac: isMac(), nativeWindowChrome });
	const [appLauncherOpen, setAppLauncherOpen] = useState(false);
	const [customizationOpen, setCustomizationOpen] = useState(false);
	const [minimizedWindowIds, setMinimizedWindowIds] = useState<Set<string>>(
		() => new Set()
	);
	const {
		preference: wallpaperPreference,
		shuffle: shuffleWallpaper,
		update: updateWallpaper,
		wallpaper,
	} = useWallpaper();
	const osApps = useMemo(
		() =>
			[...OS_APPS, ...contributedApps].map((app) =>
				resolveOsApp(app, appRecords)
			),
		[appRecords, contributedApps]
	);
	const dockApps = useMemo(
		() => OS_APPS.map((app) => resolveOsApp(app, appRecords)),
		[appRecords]
	);
	const visibleWindows = useMemo(
		() => windows.filter((item) => !minimizedWindowIds.has(item.id)),
		[minimizedWindowIds, windows]
	);
	const activeWindow =
		visibleWindows.find((item) => item.id === activeWindowId) ??
		visibleWindows[0];
	const openPaths = useMemo(
		() => new Set(windows.map((item) => item.path)),
		[windows]
	);
	const wallpaperSets = [ALL_WALLPAPER_SETS, ...WALLPAPER_SETS];
	const shuffleLabel = tl("Shuffle wallpaper · {label}", {
		label: wallpaper.label,
	});
	const selectWallpaperSet = (nextSet: string) => {
		updateWallpaper({ mode: "random", set: nextSet });
	};
	const activateWindow = (id: string) => {
		setMinimizedWindowIds((current) => {
			if (!current.has(id)) {
				return current;
			}
			const next = new Set(current);
			next.delete(id);
			return next;
		});
		onActivateWindow(id);
	};
	const minimizeWindow = (id: string) => {
		const nextWindow = visibleWindows.find((item) => item.id !== id);
		setMinimizedWindowIds((current) => new Set(current).add(id));
		onActivateWindow(nextWindow?.id ?? "");
	};
	const openOsApp = (app: OsApp) => {
		const existingWindow = windows.find((item) => item.path === app.path);
		if (existingWindow) {
			activateWindow(existingWindow.id);
		}
		onOpenApp(app);
	};

	// The launcher answers the palette action through the app's one hotkey
	// dispatcher rather than its own window listener: a second listener on the
	// same window cannot be stopped by the dispatcher's stopPropagation, so one
	// chord would toggle two surfaces.
	useOptionalHotkey(APP_LAUNCHER_HOTKEY_ID, () =>
		setAppLauncherOpen((open) => !open)
	);
	const launcherChord = useOptionalHotkeyBinding(APP_LAUNCHER_HOTKEY_ID);
	const launcherShortcut = launcherChord
		? launcherShortcutLabel(launcherChord)
		: null;
	const launcherKeyShortcuts = launcherChord
		? launcherAriaKeyShortcuts(launcherChord)
		: undefined;

	return (
		<div
			className="relative flex size-full min-h-0 flex-col overflow-hidden bg-os-desktop text-white"
			data-testid="ryu-os-desktop"
		>
			<WallpaperBackdrop wallpaper={wallpaper} />
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 bg-gradient-to-br from-os-desktop/35 via-transparent to-os-desktop/5"
			/>
			<ProgressiveBlur
				backgroundColor="rgb(18 17 38 / 0.32)"
				blurAmount="12px"
				height="128px"
				position="top"
			/>
			<div
				className={cn(
					"relative z-30 flex h-12 shrink-0 items-center gap-3 bg-transparent px-3 max-[360px]:gap-2 max-[360px]:px-2 sm:px-5",
					barInsets
				)}
				data-tauri-drag-region
				data-testid="ryu-os-topbar"
				data-tray-anchor="menubar"
			>
				<div data-tauri-drag-region={false}>
					<SidebarBrandBadge
						canSwitchToConsole={canSwitchToConsole}
						canSwitchToOs
						className="px-0 py-0"
						compact
					/>
				</div>
				<div className="hidden h-5 w-px bg-white/15 sm:block" />
				<Menubar
					appearance="os-desktop"
					className="hidden sm:flex"
					data-tauri-drag-region={false}
					data-testid="ryu-os-menubar"
				>
					<MenubarMenu>
						<MenubarTrigger appearance="os-desktop">OS</MenubarTrigger>
						<MenubarContent className="min-w-56" withBackdrop={false}>
							<MenubarGroup>
								<MenubarLabel>OS</MenubarLabel>
								<MenubarItem
									aria-keyshortcuts={launcherKeyShortcuts}
									data-testid="app-launcher-menu-item"
									onClick={() => setAppLauncherOpen(true)}
								>
									<HugeiconsIcon aria-hidden="true" icon={GridViewIcon} />
									{APP_LAUNCHER_LABEL}
									{launcherShortcut ? (
										<MenubarShortcut>{launcherShortcut}</MenubarShortcut>
									) : null}
								</MenubarItem>
							</MenubarGroup>
						</MenubarContent>
					</MenubarMenu>
					<MenubarMenu>
						<MenubarTrigger appearance="os-desktop">Window</MenubarTrigger>
						<MenubarContent className="min-w-64" withBackdrop={false}>
							<MenubarGroup>
								<MenubarItem
									aria-keyshortcuts={launcherKeyShortcuts}
									data-testid="app-launcher-trigger"
									onClick={() => setAppLauncherOpen(true)}
								>
									<HugeiconsIcon aria-hidden="true" icon={GridViewIcon} />
									{APP_LAUNCHER_LABEL}
									{launcherShortcut ? (
										<MenubarShortcut>{launcherShortcut}</MenubarShortcut>
									) : null}
								</MenubarItem>
							</MenubarGroup>
							{windows.length > 0 ? (
								<>
									<MenubarSeparator />
									<MenubarGroup>
										<MenubarLabel>Open windows</MenubarLabel>
										{windows.map((item) => (
											<MenubarItem
												key={item.id}
												onClick={() => activateWindow(item.id)}
											>
												{item.title}
											</MenubarItem>
										))}
									</MenubarGroup>
								</>
							) : null}
						</MenubarContent>
					</MenubarMenu>
					<MenubarMenu>
						<MenubarTrigger appearance="os-desktop">View</MenubarTrigger>
						<MenubarContent className="min-w-52" withBackdrop={false}>
							<MenubarGroup>
								<MenubarItem onClick={() => setCustomizationOpen(true)}>
									<HugeiconsIcon
										aria-hidden="true"
										icon={SlidersHorizontalIcon}
									/>
									Customize desktop…
								</MenubarItem>
								<MenubarSeparator />
								<MenubarLabel>Wallpaper sets</MenubarLabel>
							</MenubarGroup>
							<MenubarRadioGroup
								data-testid="os-wallpaper-set"
								onValueChange={(value) => {
									if (value) {
										selectWallpaperSet(value);
									}
								}}
								value={
									wallpaperPreference.mode === "random"
										? wallpaperPreference.set
										: ""
								}
							>
								{wallpaperSets.map((set) => (
									<MenubarRadioItem key={set} value={set}>
										{set === "all" ? "All backdrops" : set}
									</MenubarRadioItem>
								))}
							</MenubarRadioGroup>
							<MenubarSeparator />
							<MenubarGroup>
								<MenubarItem onClick={shuffleWallpaper}>
									<HugeiconsIcon aria-hidden="true" icon={ShuffleIcon} />
									Shuffle wallpaper
									<MenubarShortcut>⇧⌘R</MenubarShortcut>
								</MenubarItem>
							</MenubarGroup>
						</MenubarContent>
					</MenubarMenu>
				</Menubar>
				<span className="hidden text-white/45 text-xs sm:block">Workspace</span>
				<button
					aria-label={shuffleLabel}
					className="ml-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 max-[360px]:px-1.5 sm:ml-0"
					data-testid="os-wallpaper-shuffle"
					onClick={shuffleWallpaper}
					title={shuffleLabel}
					type="button"
				>
					<HugeiconsIcon aria-hidden="true" icon={ShuffleIcon} size={14} />
					<span
						className="hidden max-w-28 truncate text-xs sm:inline"
						title={wallpaper.label}
					>
						{wallpaper.label}
					</span>
				</button>
				<button
					aria-label="Customize desktop"
					className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white/65 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
					onClick={() => setCustomizationOpen(true)}
					type="button"
				>
					<HugeiconsIcon
						aria-hidden="true"
						icon={SlidersHorizontalIcon}
						size={16}
					/>
				</button>
				<div
					className="ml-auto flex shrink-0 items-center"
					data-tauri-drag-region={false}
					data-testid="ryu-os-menubar-actions"
				>
					{menubarActions}
				</div>
			</div>

			<OsHomeSettings
				onOpenChange={setCustomizationOpen}
				open={customizationOpen}
			/>
			<div className="relative z-10 min-h-0 flex-1">
				{windows.map((item) => (
					<OsWindowCard
						active={item.id === activeWindow?.id}
						key={item.id}
						minimized={minimizedWindowIds.has(item.id)}
						onActivate={() => activateWindow(item.id)}
						onClose={() => onCloseWindow(item.id)}
						onMinimize={() => minimizeWindow(item.id)}
						window={item}
					/>
				))}
				<OsHome visible={visibleWindows.length === 0} />
			</div>

			<div
				className="absolute bottom-3 left-1/2 z-30 max-w-[calc(100%-1.25rem)] -translate-x-1/2 sm:bottom-4"
				data-testid="ryu-os-dock"
			>
				<Dock
					appearance="os-desktop"
					className="items-end"
					distance={140}
					magnification={72}
					panelHeight={58}
				>
					{dockApps.map((app, index) => {
						const open =
							app.action !== "app-launcher" && openPaths.has(app.path);
						return (
							<Fragment key={app.id}>
								{index === 1 ? (
									<span
										aria-hidden="true"
										className="mx-0.5 h-8 w-px shrink-0 bg-white/15"
									/>
								) : null}
								<DockItem
									aria-label={
										app.action === "app-launcher"
											? tl("Open {label}", { label: APP_LAUNCHER_LABEL })
											: tl("Open {label}", { label: app.label })
									}
									data-open={open ? "true" : "false"}
									data-testid={`os-dock-${app.id}`}
									onClick={() => {
										if (app.action === "app-launcher") {
											setAppLauncherOpen(true);
											return;
										}
										openOsApp(app);
									}}
									title={app.description}
									tone="inverse"
								>
									<DockLabel>{app.label}</DockLabel>
									<DockIcon scale={0.9}>
										<OsAppIcon
											app={app}
											className="size-full"
											presentation="os-dock"
											size={20}
										/>
									</DockIcon>
									<span
										aria-hidden="true"
										className={cn(
											"absolute -bottom-1 size-1 rounded-full bg-white/0",
											open && "bg-white/90"
										)}
									/>
									<span className="sr-only">{app.label}</span>
								</DockItem>
							</Fragment>
						);
					})}
				</Dock>
			</div>

			<AppLauncherDialog
				apps={osApps}
				onActivateWindow={activateWindow}
				onOpenApp={(app) => {
					openOsApp(app);
					setAppLauncherOpen(false);
				}}
				onOpenChange={setAppLauncherOpen}
				open={appLauncherOpen}
				shortcut={launcherShortcut}
				windows={windows}
			/>
		</div>
	);
}

/** Connect the pure OS surface to the authoritative installed-app manifest feed. */
export function OsDesktopSurfaceWithApps(props: OsDesktopSurfaceProps) {
	const { apps } = useApps();
	const { companions } = usePluginContributions();
	const appsById = useMemo(
		() => new Map(apps.map((app) => [app.id, app])),
		[apps]
	);
	const contributedApps = useMemo<OsApp[]>(
		() =>
			companions
				.filter(
					(companion) =>
						isNavigablePluginCompanion(companion) &&
						!OS_APPS.some((app) => app.id === companion.id)
				)
				.map((companion) => {
					const owner = appsById.get(companion.pluginId);
					return {
						category: owner?.category,
						description:
							owner?.tagline ??
							owner?.description ??
							"Open this App surface in a live workspace window.",
						iconId: companion.icon ?? owner?.companion?.icon ?? owner?.icon,
						id: companion.id,
						label: companion.label || companion.name,
						manifestId: companion.pluginId || undefined,
						path: pluginCompanionPath(companion.id),
					};
				}),
		[appsById, companions]
	);

	return (
		<OsDesktopSurface
			{...props}
			appRecords={apps}
			contributedApps={contributedApps}
			menubarActions={<NavUser presentation="menubar" />}
		/>
	);
}
