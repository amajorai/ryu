import { GridViewIcon, Robot01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/command.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type MouseEvent as ReactMouseEvent, useEffect, useState } from "react";
import {
	ALL_CATEGORIES,
	APP_LAUNCHER_LABEL,
	appForWindow,
	type OsApp,
	OsAppIcon,
	type OsWindow,
	osAppCategories,
	osAppCategory,
} from "./OsDesktopSurface.apps.tsx";

export const LAUNCHER_GLASS =
	"border border-white/20 bg-os-launcher-glass shadow-(--shadow-os-launcher-glass) backdrop-blur-2xl backdrop-saturate-(--backdrop-saturate-os-launcher)";

/**
 * Full-screen launcher in the macOS 27 style: Mission Control's spread of open
 * windows across the top, then a glass search field, category tabs and a big
 * icon grid over the blurred desktop. Still a cmdk list, so typing filters and
 * arrow keys move between Apps and windows.
 */
export function AppLauncherDialog({
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
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={GridViewIcon}
							/>
							{APP_LAUNCHER_LABEL}
						</span>
						{shortcut ? (
							<Kbd className="hidden bg-white/10 text-white/70 sm:inline-flex">
								{shortcut}
							</Kbd>
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
															size={20}
														/>
													) : (
														<HugeiconsIcon
															aria-hidden="true"
															className="mt-4 size-8"
															icon={Robot01Icon}
														/>
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
