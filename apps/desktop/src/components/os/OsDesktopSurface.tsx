import {
	type Chord,
	chordTokens,
	isMac,
	normalizeChord,
} from "@ryu/hotkeys/chord";
import {
	useOptionalHotkey,
	useOptionalHotkeyBinding,
} from "@ryu/hotkeys/react";
import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import type { CardDither } from "@ryu/marketplace/catalog/types";
import type { AppIconPresentation } from "@ryu/ui/components/app-icon-artwork.tsx";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/command.tsx";
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
import {
	Bot,
	LayoutGrid,
	Maximize2,
	Minimize2,
	Minus,
	Shuffle,
	SlidersHorizontal,
	X,
} from "lucide-react";
import {
	Fragment,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";
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
import { OsHome, OsHomeSettings } from "./OsHome.tsx";

type OsAppAction = "app-launcher" | "open-window";

const APP_LAUNCHER_ID = "app-launcher";
const APP_LAUNCHER_LABEL = "App Launcher";
/**
 * Ryu OS mounts no separate command palette (Layout leaves it out in OS mode),
 * so the App Launcher is the OS's search-everything surface and owns the
 * registry's palette action. Binding through @ryu/hotkeys keeps one dispatcher
 * and one owner per chord, and follows a rebind or clear in Keyboard Shortcuts.
 */
const APP_LAUNCHER_HOTKEY_ID = "command-palette.toggle";

/** The launcher chord as the platform writes it (`⌘K`, `Ctrl+K`). */
function launcherShortcutLabel(chord: Chord): string {
	const mac = isMac();
	return chordTokens(chord, mac).join(mac ? "" : "+");
}

/** The launcher chord in `aria-keyshortcuts` form, both platforms for `Mod`. */
function launcherAriaKeyShortcuts(chord: Chord): string {
	const tokens = normalizeChord(chord).split("+");
	const spell = (mod: string) =>
		tokens
			.map((token) => {
				if (token === "Mod") {
					return mod;
				}
				return token === "Ctrl" ? "Control" : token;
			})
			.join("+");
	return tokens.includes("Mod")
		? `${spell("Control")} ${spell("Meta")}`
		: spell("Control");
}

export interface OsApp {
	action?: OsAppAction;
	cacheKey?: string | null;
	/** Launcher tab this app is filed under. */
	category?: string | null;
	description: string;
	iconBackground?: string | null;
	iconDither?: CardDither | null;
	iconId?: string | null;
	iconPadding?: string | null;
	iconUrl?: string | null;
	id: string;
	label: string;
	manifestId?: string;
	path: string;
}

export interface OsAppRecord {
	category?: string | null;
	companion?: { icon: string | null } | null;
	icon: string | null;
	iconBackground: string | null;
	iconDither: CardDither | null;
	iconPadding: string | null;
	iconUrl: string | null;
	id: string;
	installed: boolean;
	installedVersion: string | null;
	version: string;
}

export interface OsWindow {
	content: ReactNode;
	id: string;
	path: string;
	title: string;
}

/** The first-party surfaces that make the OS dock useful on first launch. */
export const OS_APPS: readonly OsApp[] = [
	{
		action: "app-launcher",
		description: "Browse current Apps or jump between live workspace windows.",
		iconId: "dashboard-square-01",
		id: APP_LAUNCHER_ID,
		label: APP_LAUNCHER_LABEL,
		path: "/app-launcher",
	},
	{
		description: "Review what every chat did, and what is still open.",
		iconId: "radar-01",
		category: "Agents",
		id: "mission-control",
		label: "Mission Control",
		manifestId: "@ryu/mission-control",
		path: "/mission-control",
	},
	{
		description: "Ask an agent and keep the conversation live.",
		iconId: "chat-01",
		category: "Agents",
		id: "chat",
		label: "Chat",
		path: "/chat",
	},
	{
		description: "Organize knowledge, files, and working context.",
		iconId: "delivery-secure-01",
		category: "Knowledge",
		id: "spaces",
		label: "Spaces",
		manifestId: "@ryu/spaces",
		path: "/library/space",
	},
	{
		description: "Browse and test the tools Ryu can call.",
		iconId: "wrench-01",
		category: "Build",
		id: "tools",
		label: "Tools",
		path: "/tools",
	},
	{
		description: "Keep reusable agent instructions close at hand.",
		iconId: "potion",
		category: "Knowledge",
		id: "skills",
		label: "Skills",
		manifestId: "@ryu/skills",
		path: "/skills",
	},
	{
		description: "Install and manage Ryu Apps and capabilities.",
		iconId: "package-01",
		category: "Build",
		id: "apps",
		label: "Apps",
		path: "/store/apps",
	},
	{
		description: "Review outcomes and decide what happens next.",
		iconId: "pie-chart",
		category: "Agents",
		id: "review",
		label: "Review",
		path: "/review",
	},
];

export function resolveOsApp(
	app: OsApp,
	appRecords: readonly OsAppRecord[]
): OsApp {
	if (!app.manifestId) {
		return app;
	}
	const record = appRecords.find(
		(candidate) => candidate.id === app.manifestId
	);
	if (!record) {
		return app;
	}
	return {
		...app,
		category: app.category ?? record.category,
		cacheKey: record.installed
			? iconCacheKey(record.id, record.installedVersion ?? record.version)
			: null,
		iconBackground: record.iconBackground,
		iconDither: record.iconDither,
		iconId: record.icon ?? record.companion?.icon ?? app.iconId,
		iconPadding: record.iconPadding,
		iconUrl: record.iconUrl,
	};
}

function appForWindow(path: string, apps: readonly OsApp[]): OsApp | undefined {
	return apps.find((app) => path === app.path);
}

function OsAppIcon({
	app,
	className,
	presentation = "os-default",
	size = 18,
}: {
	app: OsApp;
	className?: string;
	presentation?: AppIconPresentation;
	size?: number;
}) {
	return (
		<AppIcon
			cacheKey={app.cacheKey}
			className={className}
			dither={app.iconDither}
			iconBackground={app.iconBackground}
			iconId={app.iconId}
			iconPadding={app.iconPadding}
			iconUrl={app.iconUrl}
			name={app.label}
			presentation={presentation}
			seedId={app.manifestId ?? app.id}
			seedPlate
			size={size}
		/>
	);
}

const OTHER_CATEGORY = "Apps";
const ALL_CATEGORIES = "All";

function titleCase(value: string): string {
	return value
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/** The launcher tab an app is filed under; uncategorized apps land in "Apps". */
export function osAppCategory(app: OsApp): string {
	const category = app.category?.trim();
	return category ? titleCase(category) : OTHER_CATEGORY;
}

/** Category tabs in first-seen order, so the shell's own groups lead. */
export function osAppCategories(apps: readonly OsApp[]): string[] {
	return [...new Set(apps.map(osAppCategory))];
}

const LAUNCHER_GLASS =
	"border border-white/20 bg-os-launcher-glass shadow-(--shadow-os-launcher-glass) backdrop-blur-2xl backdrop-saturate-(--backdrop-saturate-os-launcher)";

/**
 * Full-screen launcher in the macOS 27 style: Mission Control's spread of open
 * windows across the top, then a glass search field, category tabs and a big
 * icon grid over the blurred desktop. Still a cmdk list, so typing filters and
 * arrow keys move between Apps and windows.
 */
function AppLauncherDialog({
	onActivateWindow,
	onOpenApp,
	onOpenChange,
	open,
	apps,
	shortcut,
	windows,
}: {
	apps: readonly OsApp[];
	onActivateWindow: (id: string) => void;
	onOpenApp: (app: OsApp) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	/** The launcher's current chord for display, or null when unbound. */
	shortcut: string | null;
	windows: OsWindow[];
}) {
	const [search, setSearch] = useState("");
	const [category, setCategory] = useState(ALL_CATEGORIES);
	const appItems = apps.filter((app) => app.action !== "app-launcher");
	const categories = osAppCategories(appItems);
	const openPaths = new Set(windows.map((item) => item.path));
	// Like Spotlight's Apps view, typing searches every category at once.
	const searching = search.trim().length > 0;
	const activeCategory =
		searching || !categories.includes(category) ? ALL_CATEGORIES : category;
	const visibleApps =
		activeCategory === ALL_CATEGORIES
			? appItems
			: appItems.filter((app) => osAppCategory(app) === activeCategory);

	useEffect(() => {
		if (!open) {
			setSearch("");
			setCategory(ALL_CATEGORIES);
		}
	}, [open]);

	const closeOnBackdrop = (event: ReactMouseEvent) => {
		if (event.target === event.currentTarget) {
			onOpenChange(false);
		}
	};

	return (
		<CommandDialog
			appearance="os-launcher"
			description="Open a current Ryu App or return to a live workspace window."
			onOpenChange={onOpenChange}
			open={open}
			title={APP_LAUNCHER_LABEL}
		>
			<Command
				appearance="os-launcher"
				className="size-full"
				data-testid="app-launcher-dialog"
			>
				<div
					className="flex size-full min-h-0 flex-col items-center overflow-y-auto px-6 pt-6 pb-10"
					onClick={closeOnBackdrop}
					role="presentation"
				>
					<header className="flex w-full max-w-6xl items-center justify-between text-white/70 text-xs">
						<span className="flex items-center gap-2 font-medium">
							<LayoutGrid aria-hidden="true" className="size-3.5" />
							{APP_LAUNCHER_LABEL}
						</span>
						{shortcut ? (
							<kbd className="type-compact hidden rounded-md border border-white/20 bg-white/10 px-1.5 py-0.5 font-medium sm:inline-flex">
								{shortcut}
							</kbd>
						) : null}
					</header>

					{windows.length > 0 ? null : <div className="h-6" />}

					<CommandList
						appearance="os-launcher"
						className="mt-4 w-full max-w-6xl"
					>
						{windows.length > 0 ? (
							<CommandGroup
								appearance="os-launcher"
								className="w-full"
								heading="Open windows"
							>
								<div
									className="flex w-full justify-center gap-5 overflow-x-auto px-2 pt-2 pb-4"
									data-testid="app-launcher-window-grid"
								>
									{windows.map((item) => {
										const app = appForWindow(item.path, apps);
										return (
											<CommandItem
												appearance="os-window-preview"
												className="group/window w-52 shrink-0"
												data-testid={`app-launcher-window-${item.id}`}
												key={item.id}
												onSelect={() => {
													onActivateWindow(item.id);
													onOpenChange(false);
												}}
												value={`${item.title} ${item.path}`}
											>
												<span
													className={cn(
														"relative flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl transition-transform duration-200 group-hover/window:-translate-y-1 group-data-selected/window:-translate-y-1 group-data-selected/window:ring-2 group-data-selected/window:ring-white/80",
														LAUNCHER_GLASS
													)}
												>
													<span className="absolute inset-x-0 top-0 flex h-5 items-center gap-1 border-white/10 border-b bg-white/10 px-2">
														<span className="size-1.5 rounded-full bg-white/40" />
														<span className="size-1.5 rounded-full bg-white/40" />
														<span className="size-1.5 rounded-full bg-white/40" />
													</span>
													{app ? (
														<OsAppIcon
															app={app}
															className="mt-4 size-12"
															presentation="os-preview"
															size={22}
														/>
													) : (
														<Bot aria-hidden="true" className="mt-4 size-8" />
													)}
												</span>
												<span
													className="truncate text-center font-medium text-shadow-(--text-shadow-os-preview) text-white/90 text-xs"
													title={item.title}
												>
													{item.title}
												</span>
											</CommandItem>
										);
									})}
								</div>
							</CommandGroup>
						) : null}

						<div
							className={cn(
								"mt-2 flex h-10 w-full max-w-md items-center rounded-full px-2 **:data-[slot=command-input-wrapper]:border-0",
								LAUNCHER_GLASS
							)}
						>
							<CommandInput
								appearance="os-launcher"
								autoFocus
								onValueChange={setSearch}
								placeholder="Search Apps and windows"
								value={search}
							/>
						</div>

						{categories.length > 1 ? (
							<div
								aria-label="App categories"
								className={cn(
									"mt-4 flex max-w-full gap-1 overflow-x-auto rounded-full p-1",
									LAUNCHER_GLASS
								)}
								data-testid="app-launcher-categories"
								role="tablist"
							>
								{[ALL_CATEGORIES, ...categories].map((item) => {
									const selected = item === activeCategory;
									return (
										<button
											aria-selected={selected}
											className={cn(
												"shrink-0 rounded-full px-3.5 py-1 font-medium text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80",
												selected
													? "bg-white/85 text-black shadow"
													: "text-white/80 hover:bg-white/15"
											)}
											data-testid={`app-launcher-category-${item}`}
											key={item}
											onClick={() => {
												setCategory(item);
												setSearch("");
											}}
											role="tab"
											type="button"
										>
											{item}
										</button>
									);
								})}
							</div>
						) : null}

						<CommandEmpty appearance="os-launcher">
							No Apps or windows match that search.
						</CommandEmpty>
						<CommandGroup
							appearance="os-launcher"
							className="mt-8 w-full"
							heading="Current Apps"
						>
							<div
								className="mx-auto grid max-w-5xl grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7"
								data-testid="app-launcher-app-grid"
							>
								{visibleApps.map((app) => {
									const isOpen = app.path ? openPaths.has(app.path) : false;
									return (
										<CommandItem
											appearance="os-application"
											className="group/app-launcher"
											data-open={isOpen ? "true" : "false"}
											data-testid={`app-launcher-app-${app.id}`}
											key={app.id}
											onSelect={() => onOpenApp(app)}
											title={app.description}
											value={`${app.label} ${app.description} ${osAppCategory(app)}`}
										>
											<span className="relative">
												<OsAppIcon
													app={app}
													className="size-20 group-hover/app-launcher:scale-105 group-active/app-launcher:scale-95"
													presentation="os-launcher"
													size={34}
												/>
												<span
													aria-hidden="true"
													className={cn(
														"absolute -bottom-2 left-1/2 size-1 -translate-x-1/2 rounded-full",
														isOpen ? "bg-white/90" : "bg-transparent"
													)}
												/>
											</span>
											<span
												className="w-full truncate font-medium text-shadow-(--text-shadow-os-label) text-xs"
												title={app.label}
											>
												{app.label}
											</span>
										</CommandItem>
									);
								})}
							</div>
						</CommandGroup>
					</CommandList>
				</div>
			</Command>
		</CommandDialog>
	);
}

function OsWindowCard({
	active,
	minimized,
	onActivate,
	onClose,
	onMinimize,
	window,
}: {
	active: boolean;
	minimized: boolean;
	onActivate: () => void;
	onClose: () => void;
	onMinimize: () => void;
	window: OsWindow;
}) {
	const [maximized, setMaximized] = useState(false);
	const isVisible = active && !minimized;
	const frameClassName = maximized
		? "inset-3 bottom-5"
		: "inset-3 bottom-5 sm:top-8 sm:right-[14%] sm:bottom-24 sm:left-[14%]";
	const controlClassName =
		"flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
	const stopAnd = (action: () => void) => (event: ReactMouseEvent) => {
		event.stopPropagation();
		action();
	};

	return (
		<article
			className={cn(
				"absolute flex min-h-0 flex-col overflow-hidden rounded-(--radius-os-window) border border-white/15 bg-background/90 text-foreground shadow-(--shadow-os-window) backdrop-blur-xl",
				frameClassName,
				isVisible ? "z-20 flex" : "z-10 hidden"
			)}
			data-active={active ? "true" : "false"}
			data-maximized={maximized ? "true" : "false"}
			data-minimized={minimized ? "true" : "false"}
			data-testid={`os-window-${window.id}`}
			onMouseDown={onActivate}
		>
			<header className="relative z-10 flex h-11 shrink-0 items-center px-2">
				<ProgressiveBlur blurAmount="16px" height="68px" position="top" />
				<span
					className="pointer-events-none absolute inset-x-20 z-10 truncate text-center font-medium text-muted-foreground text-xs"
					title={window.title}
				>
					{window.title}
				</span>
				<div className="relative z-10 ml-auto flex items-center gap-0.5">
					<button
						aria-label={`Minimize ${window.title}`}
						className={controlClassName}
						data-testid={`os-window-${window.id}-minimize`}
						onClick={stopAnd(onMinimize)}
						type="button"
					>
						<Minus aria-hidden="true" className="size-3.5" />
					</button>
					<button
						aria-label={`${maximized ? "Restore" : "Maximize"} ${window.title}`}
						className={controlClassName}
						data-testid={`os-window-${window.id}-maximize`}
						onClick={stopAnd(() => setMaximized((value) => !value))}
						type="button"
					>
						{maximized ? (
							<Minimize2 aria-hidden="true" className="size-3.5" />
						) : (
							<Maximize2 aria-hidden="true" className="size-3.5" />
						)}
					</button>
					<button
						aria-label={`Close ${window.title}`}
						className={controlClassName}
						data-testid={`os-window-${window.id}-close`}
						onClick={stopAnd(onClose)}
						type="button"
					>
						<X aria-hidden="true" className="size-3.5" />
					</button>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-hidden">{window.content}</div>
		</article>
	);
}

export interface OsDesktopSurfaceProps {
	activeWindowId: string;
	appRecords?: readonly OsAppRecord[];
	canSwitchToConsole?: boolean;
	/** Enabled app companions from the live contributions feed. Shell-owned pages
	 * remain in {@link OS_APPS}; these entries keep the launcher current as apps add
	 * their own full-page surfaces. */
	contributedApps?: readonly OsApp[];
	/** Account, availability, notifications, and downloads in the OS menu bar. */
	menubarActions?: ReactNode;
	onActivateWindow: (id: string) => void;
	onCloseWindow: (id: string) => void;
	onOpenApp: (app: OsApp) => void;
	windows: OsWindow[];
}

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
					"relative z-30 flex h-14 shrink-0 items-center gap-3 bg-transparent px-3 max-[360px]:gap-2 max-[360px]:px-2 sm:px-5",
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
									<LayoutGrid aria-hidden="true" />
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
									<LayoutGrid aria-hidden="true" />
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
									<SlidersHorizontal aria-hidden="true" />
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
									<Shuffle aria-hidden="true" />
									Shuffle wallpaper
									<MenubarShortcut>⇧⌘R</MenubarShortcut>
								</MenubarItem>
							</MenubarGroup>
						</MenubarContent>
					</MenubarMenu>
				</Menubar>
				<span className="hidden text-white/45 text-xs sm:block">Workspace</span>
				<button
					aria-label={`Shuffle wallpaper · ${wallpaper.label}`}
					className="ml-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 max-[360px]:px-1.5 sm:ml-0"
					data-testid="os-wallpaper-shuffle"
					onClick={shuffleWallpaper}
					title={`Shuffle wallpaper · ${wallpaper.label}`}
					type="button"
				>
					<Shuffle aria-hidden="true" className="size-3.5" />
					<span
						className="type-compact hidden max-w-28 truncate sm:inline"
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
					<SlidersHorizontal aria-hidden="true" className="size-4" />
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
											? `Open ${APP_LAUNCHER_LABEL}`
											: `Open ${app.label}`
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
											size={24}
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
