import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	NavigationMenu,
	NavigationMenuContent,
	NavigationMenuItem,
	NavigationMenuList,
	NavigationMenuTrigger,
} from "@ryu/ui/components/navigation-menu.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	initPopupOverlayBlur,
	POPUP_OVERLAY_BLUR_STORAGE_KEY,
	setPopupOverlayBlur,
	usePopupOverlayBlur,
} from "@ryu/ui/hooks/use-popup-overlay-blur.ts";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

localStorage.removeItem(POPUP_OVERLAY_BLUR_STORAGE_KEY);
initPopupOverlayBlur();

const SURFACE_CLASS =
	"rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm backdrop-blur-sm";

function Surface({
	children,
	description,
	title,
}: {
	children: React.ReactNode;
	description: string;
	title: string;
}) {
	return (
		<section className={SURFACE_CLASS}>
			<p className="font-semibold text-sm">{title}</p>
			<p className="mt-1 text-muted-foreground text-xs leading-5">
				{description}
			</p>
			<div className="mt-4 flex min-h-24 items-center justify-center">
				{children}
			</div>
		</section>
	);
}

function Story() {
	const enabled = usePopupOverlayBlur();

	useEffect(() => {
		document.body.dataset.harnessReady = "1";
	}, []);

	return (
		<main className="relative min-h-screen overflow-hidden bg-background p-8 text-foreground sm:p-12">
			<div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_15%_20%,color-mix(in_oklab,var(--primary)_32%,transparent),transparent_32%),radial-gradient(circle_at_85%_80%,color-mix(in_oklab,var(--chart-4)_30%,transparent),transparent_36%),linear-gradient(135deg,transparent_0%,color-mix(in_oklab,var(--muted)_70%,transparent)_48%,transparent_100%)]" />
			<div className="relative mx-auto flex max-w-5xl flex-col gap-6">
				<header className="flex flex-col gap-5 rounded-3xl border border-border/70 bg-background/75 p-6 shadow-sm backdrop-blur-sm sm:flex-row sm:items-start sm:justify-between">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
							Desktop appearance proof
						</p>
						<h1 className="mt-2 font-semibold text-3xl tracking-tight">
							Popup backdrop blur
						</h1>
						<p className="mt-2 max-w-2xl text-muted-foreground text-sm leading-6">
							The shared popup primitives dim and blur this page only when the
							appearance preference is enabled.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-3 rounded-2xl border border-border/70 bg-card/80 px-4 py-3 shadow-sm">
						<div>
							<label
								className="font-medium text-sm"
								htmlFor="popup-overlay-blur"
							>
								Blur popup backgrounds
							</label>
							<p className="mt-0.5 text-muted-foreground text-xs">
								{enabled ? "On" : "Off by default"}
							</p>
						</div>
						<Switch
							aria-label="Blur popup backgrounds"
							checked={enabled}
							id="popup-overlay-blur"
							onCheckedChange={setPopupOverlayBlur}
						/>
					</div>
				</header>

				<div className="grid gap-4 md:grid-cols-2">
					<Surface
						description="Top-level action menus receive one backdrop; nested submenus reuse it."
						title="Dropdown menu"
					>
						<DropdownMenu>
							<DropdownMenuTrigger
								data-testid="dropdown-trigger"
								variant="blurred-control"
							>
								Open dropdown
							</DropdownMenuTrigger>
							<DropdownMenuContent
								className="min-w-64"
								data-testid="dropdown-content"
							>
								<DropdownMenuItem>Open workspace</DropdownMenuItem>
								<DropdownMenuItem>Duplicate tab</DropdownMenuItem>
								<DropdownMenuItem>Close tab</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</Surface>

					<Surface
						description="Select lists use the same full-window treatment while preserving active-item focus."
						title="Select"
					>
						<Select defaultValue="work">
							<SelectTrigger
								appearance="glass-panel"
								aria-label="Select workspace"
								className="w-52"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="work">Ryu Work</SelectItem>
								<SelectItem value="code">Code</SelectItem>
								<SelectItem value="review">Review</SelectItem>
							</SelectContent>
						</Select>
					</Surface>

					<Surface
						description="Right-click surfaces use the same dismissal-aware backdrop as action menus."
						title="Context menu"
					>
						<ContextMenu>
							<ContextMenuTrigger
								render={
									<button
										className="rounded-xl border border-border/80 border-dashed bg-background/60 px-4 py-2 text-sm"
										data-testid="context-surface"
										type="button"
									>
										Right-click here
									</button>
								}
							/>
							<ContextMenuContent>
								<ContextMenuItem>Copy link</ContextMenuItem>
								<ContextMenuItem>Open in new tab</ContextMenuItem>
							</ContextMenuContent>
						</ContextMenu>
					</Surface>

					<Surface
						description="Popover-based pickers, including color and model controls, inherit the shared behavior."
						title="Popover"
					>
						<Popover>
							<PopoverTrigger
								render={
									<button
										className="rounded-xl border border-border/70 bg-background/70 px-4 py-2 text-sm"
										data-testid="popover-trigger"
										type="button"
									>
										Open popover
									</button>
								}
							/>
							<PopoverContent>
								<p className="font-medium">Popover content</p>
								<p className="text-muted-foreground text-xs">
									The page stays visible through the optional blur.
								</p>
							</PopoverContent>
						</Popover>
					</Surface>

					<Surface
						description="Navigation menus use the same opt-in layer for larger active menus."
						title="Navigation menu"
					>
						<NavigationMenu>
							<NavigationMenuList>
								<NavigationMenuItem>
									<NavigationMenuTrigger>Open navigation</NavigationMenuTrigger>
									<NavigationMenuContent>
										<div className="grid gap-1 p-3 text-sm">
											<a
												className="rounded-xl p-2 hover:bg-muted"
												href="#overview"
											>
												Overview
											</a>
											<a
												className="rounded-xl p-2 hover:bg-muted"
												href="#settings"
											>
												Settings
											</a>
										</div>
									</NavigationMenuContent>
								</NavigationMenuItem>
							</NavigationMenuList>
						</NavigationMenu>
					</Surface>
				</div>

				<p
					className="text-muted-foreground text-xs"
					data-testid="popup-overlay-state"
				>
					Popup overlay blur: {enabled ? "enabled" : "disabled"}
				</p>
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
