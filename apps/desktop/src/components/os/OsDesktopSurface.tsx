import AppIcon from "@ryu/marketplace/catalog/chrome/app-icon";
import { iconCacheKey } from "@ryu/marketplace/catalog/icon-cache";
import type { CardDither } from "@ryu/marketplace/catalog/types";
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
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	ArrowRight,
	Bot,
	LayoutGrid,
	Maximize2,
	Minimize2,
	Minus,
	Shuffle,
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
import { SidebarBrandBadge } from "@/src/components/layout/SidebarBrandBadge.tsx";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";

type OsAppAction = "app-launcher" | "open-window";

const APP_LAUNCHER_ID = "app-launcher";
const APP_LAUNCHER_LABEL = "App Launcher";

export interface OsApp {
	action?: OsAppAction;
	cacheKey?: string | null;
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

export interface OsWallpaper {
	id: string;
	label: string;
	set: string;
	url: string;
}

/** Curated Unsplash image sets for the OS backdrop. URLs are remote by design;
 * the solid color and gradient underneath remain the offline fallback. */
export const OS_WALLPAPERS: readonly OsWallpaper[] = [
	{
		id: "alpine-blue",
		label: "Alpine blue",
		set: "Open air",
		url: "https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=2400&q=85",
	},
	{
		id: "misty-valley",
		label: "Misty valley",
		set: "Open air",
		url: "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=2400&q=85",
	},
	{
		id: "deep-forest",
		label: "Deep forest",
		set: "Quiet places",
		url: "https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=2400&q=85",
	},
	{
		id: "golden-trees",
		label: "Golden trees",
		set: "Quiet places",
		url: "https://images.unsplash.com/photo-1470252649378-9c29740c9fa8?auto=format&fit=crop&w=2400&q=85",
	},
	{
		id: "night-ridge",
		label: "Night ridge",
		set: "After hours",
		url: "https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=2400&q=85",
	},
	{
		id: "still-water",
		label: "Still water",
		set: "After hours",
		url: "https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=2400&q=85",
	},
];

function randomWallpaper(
	wallpapers: readonly OsWallpaper[],
	currentId?: string
): OsWallpaper {
	const choices = wallpapers.filter((wallpaper) => wallpaper.id !== currentId);
	const pool = choices.length > 0 ? choices : wallpapers;
	return pool[Math.floor(Math.random() * pool.length)] ?? OS_WALLPAPERS[0];
}

/** The first-party surfaces that make the Ryu OS dock useful on first launch. */
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
		id: "mission-control",
		label: "Mission Control",
		manifestId: "@ryu/mission-control",
		path: "/mission-control",
	},
	{
		description: "Ask an agent and keep the conversation live.",
		iconId: "chat-01",
		id: "chat",
		label: "Chat",
		path: "/chat",
	},
	{
		description: "Organize knowledge, files, and working context.",
		iconId: "delivery-secure-01",
		id: "spaces",
		label: "Spaces",
		manifestId: "@ryu/spaces",
		path: "/library/space",
	},
	{
		description: "Browse and test the tools Ryu can call.",
		iconId: "wrench-01",
		id: "tools",
		label: "Tools",
		path: "/tools",
	},
	{
		description: "Keep reusable agent instructions close at hand.",
		iconId: "sparkles",
		id: "skills",
		label: "Skills",
		manifestId: "@ryu/skills",
		path: "/skills",
	},
	{
		description: "Install and manage Ryu Apps and capabilities.",
		iconId: "package-01",
		id: "apps",
		label: "Apps",
		path: "/store/apps",
	},
	{
		description: "Review outcomes and decide what happens next.",
		iconId: "checkmark-badge-03",
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
		cacheKey: record.installed
			? iconCacheKey(record.id, record.installedVersion ?? record.version)
			: null,
		iconBackground: record.iconBackground,
		iconDither: record.iconDither,
		iconId: record.companion?.icon ?? record.icon ?? app.iconId,
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
	size = 18,
}: {
	app: OsApp;
	className?: string;
	size?: number;
}) {
	return (
		<AppIcon
			cacheKey={app.cacheKey}
			className={cn("overflow-hidden text-white", className)}
			dither={app.iconDither}
			iconBackground={app.iconBackground}
			iconId={app.iconId}
			iconPadding={app.iconPadding}
			iconUrl={app.iconUrl}
			name={app.label}
			seedId={app.id}
			seedPlate
			size={size}
		/>
	);
}

function AppLauncherDialog({
	onActivateWindow,
	onOpenApp,
	onOpenChange,
	open,
	apps,
	windows,
}: {
	apps: readonly OsApp[];
	onActivateWindow: (id: string) => void;
	onOpenApp: (app: OsApp) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	windows: OsWindow[];
}) {
	const appItems = apps.filter((app) => app.action !== "app-launcher");
	const appPathSet = new Set(
		apps.filter((app) => app.path).map((app) => app.path)
	);

	return (
		<CommandDialog
			className="top-[8%]! max-w-3xl! p-0 sm:top-[8%]!"
			description="Open a current Ryu App or return to a live workspace window."
			onOpenChange={onOpenChange}
			open={open}
			title={APP_LAUNCHER_LABEL}
		>
			<Command
				className="rounded-4xl! bg-transparent p-0"
				data-testid="app-launcher-dialog"
			>
				<header className="border-border border-b px-5 pt-5 pb-4">
					<div className="flex items-center gap-3">
						<span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/70 text-primary">
							<LayoutGrid aria-hidden="true" className="size-5" />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block font-medium text-sm">
								{APP_LAUNCHER_LABEL}
							</span>
							<span className="mt-0.5 block truncate text-muted-foreground text-xs">
								Current Apps and live workspace windows
							</span>
						</span>
						<kbd className="hidden rounded-lg border border-border bg-muted px-2 py-1 font-medium text-[10px] text-muted-foreground sm:inline-flex">
							⌘K
						</kbd>
					</div>
					<div className="mt-4 rounded-2xl bg-muted/50 px-2">
						<CommandInput
							autoFocus
							className="text-foreground placeholder:text-muted-foreground"
							placeholder="Search current Apps and windows…"
						/>
					</div>
				</header>
				<CommandList className="max-h-[min(70vh,40rem)] p-3 sm:p-4">
					<CommandEmpty className="py-12 text-muted-foreground">
						No Apps or windows match that search.
					</CommandEmpty>
					<CommandGroup
						className="p-0 **:[[cmdk-group-heading]]:px-1 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground"
						heading="Current Apps"
					>
						<div
							className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
							data-testid="app-launcher-app-grid"
						>
							{appItems.map((app) => {
								const open = app.path ? appPathSet.has(app.path) : false;
								return (
									<CommandItem
										className="group/app-launcher min-h-28 flex-col justify-center gap-2 rounded-2xl bg-muted/30 px-2 py-3 text-center text-foreground/80 transition-colors hover:bg-muted/70 data-selected:bg-accent data-selected:text-foreground [&>svg:last-child]:hidden"
										data-open={open ? "true" : "false"}
										data-testid={`app-launcher-app-${app.id}`}
										key={app.id}
										onSelect={() => onOpenApp(app)}
										title={app.description}
										value={`${app.label} ${app.description}`}
									>
										<span className="relative">
											<OsAppIcon
												app={app}
												className="size-16 rounded-[1.15rem] shadow-xl transition-transform group-active/app-launcher:scale-95"
												size={28}
											/>
											<span
												aria-hidden="true"
												className={cn(
													"absolute -bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full",
													open ? "bg-success" : "bg-transparent"
												)}
											/>
										</span>
										<span className="w-full truncate font-medium text-xs">
											{app.label}
										</span>
									</CommandItem>
								);
							})}
						</div>
					</CommandGroup>
					{windows.length > 0 ? (
						<CommandGroup
							className="mt-3 p-0 **:[[cmdk-group-heading]]:px-1 **:[[cmdk-group-heading]]:py-2 **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground"
							heading="Open windows"
						>
							<div
								className="grid gap-2 sm:grid-cols-2"
								data-testid="app-launcher-window-grid"
							>
								{windows.map((item) => {
									const app = appForWindow(item.path, apps);
									return (
										<CommandItem
											className="min-h-16 justify-start rounded-2xl bg-muted/30 px-3 py-3 text-left text-foreground/80 transition-colors hover:bg-muted/70 data-selected:bg-accent data-selected:text-foreground [&>svg:last-child]:hidden"
											data-testid={`app-launcher-window-${item.id}`}
											key={item.id}
											onSelect={() => {
												onActivateWindow(item.id);
												onOpenChange(false);
											}}
											value={`${item.title} ${item.path}`}
										>
											{app ? (
												<OsAppIcon
													app={app}
													className="size-10 shrink-0 rounded-xl"
													size={20}
												/>
											) : (
												<span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground">
													<Bot aria-hidden="true" className="size-4" />
												</span>
											)}
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium text-sm">
													{item.title}
												</span>
												<span className="mt-0.5 block truncate text-muted-foreground text-xs">
													{app?.label ?? item.path}
												</span>
											</span>
											<span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[10px] text-muted-foreground">
												Open
											</span>
										</CommandItem>
									);
								})}
							</div>
						</CommandGroup>
					) : null}
				</CommandList>
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
				"absolute flex min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/15 bg-background/90 text-foreground shadow-[0_24px_80px_-28px_rgba(0,0,0,0.85)] backdrop-blur-xl",
				frameClassName,
				isVisible ? "z-20 flex" : "z-10 hidden"
			)}
			data-active={active ? "true" : "false"}
			data-maximized={maximized ? "true" : "false"}
			data-minimized={minimized ? "true" : "false"}
			data-testid={`os-window-${window.id}`}
			onMouseDown={onActivate}
		>
			<header className="relative flex h-11 shrink-0 items-center border-border/70 border-b bg-muted/45 px-2">
				<span className="pointer-events-none absolute inset-x-20 truncate text-center font-medium text-muted-foreground text-xs">
					{window.title}
				</span>
				<div className="ml-auto flex items-center gap-0.5">
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
	windows,
}: OsDesktopSurfaceProps) {
	const [appLauncherOpen, setAppLauncherOpen] = useState(false);
	const [minimizedWindowIds, setMinimizedWindowIds] = useState<Set<string>>(
		() => new Set()
	);
	const [wallpaper, setWallpaper] = useState(() =>
		randomWallpaper(OS_WALLPAPERS)
	);
	const [wallpaperSet, setWallpaperSet] = useState("all");
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
	const wallpaperSets = useMemo(
		() => ["all", ...new Set(OS_WALLPAPERS.map((item) => item.set))],
		[]
	);
	const shuffleWallpaper = () => {
		const pool =
			wallpaperSet === "all"
				? OS_WALLPAPERS
				: OS_WALLPAPERS.filter((item) => item.set === wallpaperSet);
		setWallpaper((current) => randomWallpaper(pool, current.id));
	};
	const selectWallpaperSet = (nextSet: string) => {
		setWallpaperSet(nextSet);
		const pool =
			nextSet === "all"
				? OS_WALLPAPERS
				: OS_WALLPAPERS.filter((item) => item.set === nextSet);
		setWallpaper(randomWallpaper(pool));
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

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setAppLauncherOpen((open) => !open);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div
			className="relative flex size-full min-h-0 flex-col overflow-hidden bg-[#121126] text-white"
			data-testid="ryu-os-desktop"
		>
			<div
				className="pointer-events-none absolute inset-0 overflow-hidden bg-[#121126]"
				data-wallpaper-id={wallpaper.id}
			>
				<img
					alt=""
					aria-hidden="true"
					className="size-full object-cover"
					decoding="async"
					loading="eager"
					src={wallpaper.url}
				/>
				<div
					aria-hidden="true"
					className="absolute inset-0 bg-gradient-to-br from-[#121126]/35 via-transparent to-[#121126]/5"
				/>
			</div>
			<div
				className="relative z-30 flex h-14 shrink-0 items-center gap-3 bg-transparent px-3 sm:px-5"
				data-tauri-drag-region
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
					className="hidden rounded-none bg-transparent p-0 text-white/75 sm:flex"
					data-tauri-drag-region={false}
					data-testid="ryu-os-menubar"
				>
					<MenubarMenu>
						<MenubarTrigger className="bg-transparent text-white/70 hover:bg-transparent hover:text-white aria-expanded:bg-transparent aria-expanded:text-white">
							Ryu OS
						</MenubarTrigger>
						<MenubarContent className="min-w-56" withBackdrop={false}>
							<MenubarGroup>
								<MenubarLabel>Ryu OS</MenubarLabel>
								<MenubarItem
									data-testid="app-launcher-menu-item"
									onClick={() => setAppLauncherOpen(true)}
								>
									<LayoutGrid aria-hidden="true" />
									{APP_LAUNCHER_LABEL}
									<MenubarShortcut>⌘K</MenubarShortcut>
								</MenubarItem>
							</MenubarGroup>
						</MenubarContent>
					</MenubarMenu>
					<MenubarMenu>
						<MenubarTrigger className="bg-transparent text-white/70 hover:bg-transparent hover:text-white aria-expanded:bg-transparent aria-expanded:text-white">
							Window
						</MenubarTrigger>
						<MenubarContent className="min-w-64" withBackdrop={false}>
							<MenubarGroup>
								<MenubarItem
									data-testid="app-launcher-trigger"
									onClick={() => setAppLauncherOpen(true)}
								>
									<LayoutGrid aria-hidden="true" />
									{APP_LAUNCHER_LABEL}
									<MenubarShortcut>⌘K</MenubarShortcut>
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
						<MenubarTrigger className="bg-transparent text-white/70 hover:bg-transparent hover:text-white aria-expanded:bg-transparent aria-expanded:text-white">
							View
						</MenubarTrigger>
						<MenubarContent className="min-w-52" withBackdrop={false}>
							<MenubarGroup>
								<MenubarLabel>Wallpaper sets</MenubarLabel>
							</MenubarGroup>
							<MenubarRadioGroup
								data-testid="os-wallpaper-set"
								onValueChange={(value) => {
									if (value) {
										selectWallpaperSet(value);
									}
								}}
								value={wallpaperSet}
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
					className="ml-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1.5 text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 sm:ml-0"
					data-testid="os-wallpaper-shuffle"
					onClick={shuffleWallpaper}
					title={`Shuffle wallpaper · ${wallpaper.label}`}
					type="button"
				>
					<Shuffle aria-hidden="true" className="size-3.5" />
					<span className="hidden max-w-28 truncate text-[10px] sm:inline">
						{wallpaper.label}
					</span>
				</button>
				<div className="hidden items-center gap-2 text-white/45 text-xs md:flex">
					<span className="size-1.5 rounded-full bg-success" />
					Ready
				</div>
			</div>

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
				{windows.length === 0 ? (
					<div className="absolute inset-0 flex items-center justify-center p-6 pb-28">
						<div className="max-w-md text-center">
							<div className="mx-auto flex size-16 items-center justify-center rounded-[1.5rem] border border-white/15 bg-white/10 shadow-2xl backdrop-blur">
								<Bot aria-hidden="true" className="size-7 text-white/80" />
							</div>
							<p className="mt-6 font-medium text-3xl tracking-[-0.04em]">
								Welcome to Ryu OS
							</p>
							<p className="mt-3 text-sm text-white/55 leading-relaxed">
								Open an App from the dock, or press ⌘K to find a live window and
								keep your workspace moving.
							</p>
							<button
								className="mt-6 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 font-medium text-[#121126] text-sm transition-colors hover:bg-white/90"
								onClick={() => setAppLauncherOpen(true)}
								type="button"
							>
								Open {APP_LAUNCHER_LABEL}
								<ArrowRight aria-hidden="true" className="size-4" />
							</button>
						</div>
					</div>
				) : null}
			</div>

			<div
				className="absolute bottom-3 left-1/2 z-30 max-w-[calc(100%-1.25rem)] -translate-x-1/2 sm:bottom-4"
				data-testid="ryu-os-dock"
			>
				<Dock
					className="items-end py-1.5"
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
									className="text-white/65 hover:text-white"
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
								>
									<DockLabel>{app.label}</DockLabel>
									<DockIcon>
										<OsAppIcon
											app={app}
											className="size-full rounded-[0.7rem] shadow-lg"
											size={18}
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
						companion.hasUi !== false &&
						!OS_APPS.some((app) => app.id === companion.id)
				)
				.map((companion) => {
					const owner = appsById.get(companion.pluginId);
					return {
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
		/>
	);
}
