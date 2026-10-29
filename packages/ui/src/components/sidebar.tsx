"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ryu/ui/components/sheet.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import { z } from "zod";

const sidebarStateUpdaterSchema = z.custom<(current: boolean) => boolean>(
	(value) => {
		try {
			Function.prototype.toString.call(value);
			return true;
		} catch {
			return false;
		}
	}
);
const sidebarTooltipTextSchema = z.string();

import {
	type ComponentProps,
	type CSSProperties,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

const SIDEBAR_COOKIE_NAME = "sidebar_state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

function parseSidebarOpenPreference(cookieHeader: string): boolean | undefined {
	for (const cookie of cookieHeader.split(";")) {
		const separatorIndex = cookie.indexOf("=");
		if (separatorIndex < 0) {
			continue;
		}
		const name = cookie.slice(0, separatorIndex).trim();
		if (name !== SIDEBAR_COOKIE_NAME) {
			continue;
		}
		const value = cookie.slice(separatorIndex + 1).trim();
		if (value === "true") {
			return true;
		}
		if (value === "false") {
			return false;
		}
		return undefined;
	}
	return undefined;
}

function readSidebarOpenPreference(cookieHeader?: string): boolean {
	if (cookieHeader !== undefined) {
		return parseSidebarOpenPreference(cookieHeader) ?? true;
	}
	try {
		return parseSidebarOpenPreference(document.cookie) ?? true;
	} catch {
		return true;
	}
}

interface SidebarContextProps {
	isMobile: boolean;
	open: boolean;
	openMobile: boolean;
	setOpen: (open: boolean) => void;
	setOpenMobile: (open: boolean) => void;
	state: "expanded" | "collapsed";
	toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextProps | null>(null);

function useSidebar() {
	const context = useContext(SidebarContext);
	if (!context) {
		throw new Error("useSidebar must be used within a SidebarProvider.");
	}

	return context;
}

function SidebarProvider({
	defaultOpen = true,
	open: openProp,
	onOpenChange: setOpenProp,
	className,
	appearance,
	style,
	children,
	...props
}: ComponentProps<"div"> & {
	defaultOpen?: boolean;
	appearance?: "settings-frame";
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const isMobile = useIsMobile();
	const [openMobile, setOpenMobile] = useState(false);

	// This is the internal state of the sidebar.
	// We use openProp and setOpenProp for control from outside the component.
	const [_open, _setOpen] = useState(defaultOpen);
	const open = openProp ?? _open;
	const setOpen = useCallback(
		(value: boolean | ((value: boolean) => boolean)) => {
			const updater = sidebarStateUpdaterSchema.safeParse(value);
			const openState = updater.success
				? updater.data(open)
				: z.boolean().parse(value);
			if (setOpenProp) {
				setOpenProp(openState);
			} else {
				_setOpen(openState);
			}

			// This sets the cookie to keep the sidebar state.
			const secure =
				globalThis.window !== undefined && window.location.protocol === "https:"
					? "; Secure"
					: "";
			document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
		},
		[setOpenProp, open]
	);

	// Helper to toggle the sidebar.
	const toggleSidebar = useCallback(() => {
		return isMobile ? setOpenMobile((open) => !open) : setOpen((open) => !open);
	}, [isMobile, setOpen]);

	// Adds a keyboard shortcut to toggle the sidebar.
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
				(event.metaKey || event.ctrlKey)
			) {
				event.preventDefault();
				toggleSidebar();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [toggleSidebar]);

	// We add a state so that we can do data-state="expanded" or "collapsed".
	// This makes it easier to style the sidebar with Tailwind classes.
	const state = open ? "expanded" : "collapsed";

	const contextValue = useMemo<SidebarContextProps>(
		() => ({
			state,
			open,
			setOpen,
			isMobile,
			openMobile,
			setOpenMobile,
			toggleSidebar,
		}),
		[state, open, setOpen, isMobile, openMobile, toggleSidebar]
	);

	return (
		<SidebarContext.Provider value={contextValue}>
			<div
				className={cn(
					"group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
					appearance === "settings-frame" && "rounded-lg bg-sidebar",
					className
				)}
				data-slot="sidebar-wrapper"
				style={
					// SAFETY: React accepts string CSS custom properties; remaining style is typed CSSProperties.
					{
						"--sidebar-width": SIDEBAR_WIDTH,
						"--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
						...style,
					} as CSSProperties
				}
				{...props}
			>
				{children}
			</div>
		</SidebarContext.Provider>
	);
}

function Sidebar({
	side = "left",
	variant = "sidebar",
	collapsible = "offcanvas",
	className,
	appearance,
	children,
	dir,
	...props
}: ComponentProps<"div"> & {
	appearance?: "showcase-frame" | "settings-navigation";
	side?: "left" | "right";
	variant?: "sidebar" | "floating" | "inset";
	collapsible?: "offcanvas" | "icon" | "none";
}) {
	const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

	if (collapsible === "none") {
		return (
			<div
				className={cn(
					"flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground",
					appearance === "showcase-frame" && "bg-transparent p-2",
					appearance === "settings-navigation" && "rounded-xl",
					className
				)}
				data-slot="sidebar"
				{...props}
			>
				{children}
			</div>
		);
	}

	if (isMobile) {
		return (
			<Sheet onOpenChange={setOpenMobile} open={openMobile} {...props}>
				<SheetContent
					className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
					data-mobile="true"
					data-sidebar="sidebar"
					data-slot="sidebar"
					dir={dir}
					side={side}
					style={
						// SAFETY: React forwards this string CSS custom property to its native style declaration.
						{
							"--sidebar-width": SIDEBAR_WIDTH_MOBILE,
						} as CSSProperties
					}
				>
					<SheetHeader className="sr-only">
						<SheetTitle>Sidebar</SheetTitle>
						<SheetDescription>Displays the mobile sidebar.</SheetDescription>
					</SheetHeader>
					<div className="flex h-full w-full flex-col">{children}</div>
				</SheetContent>
			</Sheet>
		);
	}

	return (
		<div
			className="group peer hidden text-sidebar-foreground md:block"
			data-collapsible={state === "collapsed" ? collapsible : ""}
			data-side={side}
			data-slot="sidebar"
			data-state={state}
			data-variant={variant}
		>
			{/* This is what handles the sidebar gap on desktop */}
			<div
				className={cn(
					"relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
					"group-data-[collapsible=offcanvas]:w-0",
					"group-data-[side=right]:rotate-180",
					variant === "floating" || variant === "inset"
						? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]"
						: "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
				)}
				data-slot="sidebar-gap"
			/>
			<div
				className={cn(
					"fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,right,width] duration-200 ease-linear data-[side=right]:right-0 data-[side=left]:left-0 data-[side=right]:group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width)*-1)] data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] md:flex",
					// Adjust the padding for floating and inset variants.
					variant === "floating" || variant === "inset"
						? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]"
						: "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
					appearance === "showcase-frame" && "bg-transparent p-2",
					appearance === "settings-navigation" && "rounded-xl",
					className
				)}
				data-side={side}
				data-slot="sidebar-container"
				{...props}
			>
				<div
					className="group-data-[variant=floating]:corner-squircle relative flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-3xl group-data-[variant=floating]:border group-data-[variant=floating]:border-background"
					data-sidebar="sidebar"
					data-slot="sidebar-inner"
				>
					{children}
				</div>
			</div>
		</div>
	);
}

function SidebarTrigger({
	className,
	framing,
	onClick,
	...props
}: ComponentProps<typeof Button> & { framing?: "storyboard-floating" }) {
	const { toggleSidebar } = useSidebar();
	const localizedLabel = useLocalizedString(
		props["aria-label"] ?? "Toggle Sidebar"
	);

	return (
		<Button
			className={cn(
				framing === "storyboard-floating" && "bg-background/80 backdrop-blur",
				className
			)}
			data-sidebar="trigger"
			data-slot="sidebar-trigger"
			onClick={(event) => {
				onClick?.(event);
				toggleSidebar();
			}}
			size="icon-sm"
			variant="ghost"
			{...props}
			aria-label={localizedLabel}
		>
			<HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
			<span className="sr-only">{localizedLabel}</span>
		</Button>
	);
}

function SidebarRail({
	"aria-label": ariaLabel,
	className,
	...props
}: ComponentProps<"button">) {
	const { toggleSidebar } = useSidebar();
	const localizedLabel = useLocalizedString(ariaLabel ?? "Toggle Sidebar");

	return (
		<button
			className={cn(
				"absolute inset-y-0 z-20 hidden w-4 transition-[translate,background-color] ease-linear after:absolute after:inset-y-0 after:start-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2",
				"in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize",
				"[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
				"group-data-[collapsible=offcanvas]:translate-x-0 hover:group-data-[collapsible=offcanvas]:bg-sidebar group-data-[collapsible=offcanvas]:after:left-full",
				"[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
				"[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
				className
			)}
			data-sidebar="rail"
			data-slot="sidebar-rail"
			onClick={toggleSidebar}
			tabIndex={-1}
			{...props}
			aria-label={localizedLabel}
			title={localizedLabel}
		/>
	);
}

function SidebarInset({
	className,
	motion,
	appearance,
	...props
}: ComponentProps<"main"> & {
	motion?: "assistant-dock";
	appearance?: "os-canvas";
}) {
	return (
		<main
			className={cn(
				"md:peer-data-[variant=inset]:corner-squircle relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-2xl md:peer-data-[variant=inset]:shadow-sm",
				motion === "assistant-dock" &&
					"transition-[padding] duration-300 ease-out",
				appearance === "os-canvas" &&
					"rounded-none border-0 bg-transparent shadow-none",
				className
			)}
			data-slot="sidebar-inset"
			{...props}
		/>
	);
}

function SidebarInput({ className, ...props }: ComponentProps<typeof Input>) {
	return (
		<Input
			className={cn("h-8 w-full bg-input/50 shadow-none", className)}
			data-sidebar="input"
			data-slot="sidebar-input"
			{...props}
		/>
	);
}

function SidebarHeader({
	className,
	spacing = "default",
	...props
}: ComponentProps<"div"> & {
	spacing?: "default" | "flush" | "relaxed" | "showcase";
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-2 p-2 [--radius:var(--radius-xl)]",
				spacing === "flush" && "pt-0 pb-0",
				spacing === "relaxed" && "gap-3",
				spacing === "showcase" && "pt-3 pb-0",
				className
			)}
			data-sidebar="header"
			data-slot="sidebar-header"
			{...props}
		/>
	);
}

function SidebarFooter({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col gap-2 p-2", className)}
			data-sidebar="footer"
			data-slot="sidebar-footer"
			{...props}
		/>
	);
}

function SidebarSeparator({
	className,
	...props
}: ComponentProps<typeof Separator>) {
	return (
		<Separator
			className={cn("mx-2 w-auto bg-sidebar-border", className)}
			data-sidebar="separator"
			data-slot="sidebar-separator"
			{...props}
		/>
	);
}

function SidebarContent({
	className,
	spacing = "default",
	...props
}: ComponentProps<"div"> & {
	spacing?: "default" | "compact" | "settings-mobile" | "flush";
}) {
	return (
		<div
			className={cn(
				"scroll-fade no-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-auto [--radius:var(--radius-xl)] group-data-[collapsible=icon]:overflow-hidden",
				spacing === "compact" && "pt-2",
				spacing === "settings-mobile" && "pt-10 pb-2",
				spacing === "flush" && "gap-0",
				className
			)}
			data-sidebar="content"
			data-slot="sidebar-content"
			{...props}
		/>
	);
}

function SidebarGroup({
	className,
	spacing = "default",
	dragging = false,
	...props
}: ComponentProps<"div"> & {
	spacing?: "default" | "compact";
	dragging?: boolean;
}) {
	return (
		<div
			className={cn(
				"relative flex w-full min-w-0 flex-col p-2",
				spacing === "compact" && "py-1",
				dragging && "opacity-50",
				className
			)}
			data-sidebar="group"
			data-slot="sidebar-group"
			{...props}
		/>
	);
}

function SidebarGroupLabel({
	appearance = "default",
	children,
	className,
	render,
	...props
}: useRender.ComponentProps<"div"> &
	ComponentProps<"div"> & {
		appearance?: "default" | "collapsible-section";
	}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(
					"corner-squircle flex h-8 shrink-0 items-center rounded-xl px-3 font-medium text-sidebar-foreground/70 text-xs outline-hidden ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0 [&>svg]:size-4 [&>svg]:shrink-0",
					appearance === "collapsible-section" &&
						"gap-2 text-sidebar-foreground text-sm",
					className
				),
			},
			{ ...props, children: localizedChildren }
		),
		render,
		state: {
			slot: "sidebar-group-label",
			sidebar: "group-label",
		},
	});
}

function SidebarGroupAction({
	className,
	render,
	...props
}: useRender.ComponentProps<"button"> & ComponentProps<"button">) {
	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				className: cn(
					"corner-squircle absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-xl p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 group-data-[collapsible=icon]:hidden md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
					className
				),
			},
			props
		),
		render,
		state: {
			slot: "sidebar-group-action",
			sidebar: "group-action",
		},
	});
}

function SidebarGroupContent({
	className,
	layout = "default",
	...props
}: ComponentProps<"div"> & { layout?: "default" | "navigation-stack" }) {
	return (
		<div
			className={cn(
				"w-full text-sm",
				layout === "navigation-stack" && "flex flex-col gap-1",
				className
			)}
			data-sidebar="group-content"
			data-slot="sidebar-group-content"
			{...props}
		/>
	);
}

function SidebarMenu({
	className,
	nestedIndent = false,
	spacing = "default",
	...props
}: ComponentProps<"ul"> & {
	nestedIndent?: boolean;
	spacing?: "default" | "menubar";
}) {
	return (
		<ul
			className={cn(
				"flex w-full min-w-0 flex-col gap-0.5",
				nestedIndent && "pl-5",
				spacing === "menubar" && "gap-1 max-[360px]:gap-0.5",
				className
			)}
			data-sidebar="menu"
			data-slot="sidebar-menu"
			{...props}
		/>
	);
}

function SidebarMenuItem({
	className,
	dragging = false,
	...props
}: ComponentProps<"li"> & { dragging?: boolean }) {
	return (
		<li
			className={cn(
				"group/menu-item relative",
				dragging && "opacity-50",
				className
			)}
			data-sidebar="menu-item"
			data-slot="sidebar-menu-item"
			{...props}
		/>
	);
}

const sidebarMenuButtonVariants = cva(
	"peer/menu-button group/menu-button corner-squircle flex w-full items-center gap-2 overflow-hidden rounded-lg px-3 py-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-[color-mix(in_oklch,var(--sidebar-accent),var(--sidebar-foreground)_8%)] active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
				outline:
					"bg-background shadow-[0_0_0_1px_var(--sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--sidebar-accent)]",
			},
			corners: {
				default: "",
				rounded: "rounded-md",
			},
			size: {
				default: "h-9 text-sm",
				sm: "h-8 text-xs",
				compact: "h-8",
				lg: "h-14 px-3 text-sm group-data-[collapsible=icon]:p-0!",
			},
			purpose: {
				"showcase-thread": "gap-2 text-xs",
				"user-account":
					"aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground",
				"settings-search": "py-1.5",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

function SidebarMenuButton({
	children,
	render,
	isActive = false,
	variant = "default",
	size = "default",
	corners = "default",
	tooltip,
	className,
	purpose,
	...props
}: useRender.ComponentProps<"button"> &
	ComponentProps<"button"> & {
		isActive?: boolean;
		tooltip?: string | ComponentProps<typeof TooltipContent>;
	} & VariantProps<typeof sidebarMenuButtonVariants>) {
	const { isMobile, state } = useSidebar();
	const localizedChildren = useLocalizedText(children, { literal: true });
	const localizedAriaLabel = useLocalizedString(props["aria-label"]);
	const localizedTitle = useLocalizedString(props.title);
	const comp = useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				className: cn(
					sidebarMenuButtonVariants({ variant, size, corners, purpose }),
					className
				),
			},
			{
				...props,
				"aria-label": localizedAriaLabel,
				children: localizedChildren,
				title: localizedTitle,
			}
		),
		render: tooltip ? <TooltipTrigger render={render} /> : render,
		state: {
			slot: "sidebar-menu-button",
			sidebar: "menu-button",
			size,
			active: isActive,
		},
	});

	if (!tooltip) {
		return comp;
	}

	const tooltipText = sidebarTooltipTextSchema.safeParse(tooltip);
	if (tooltipText.success) {
		tooltip = {
			children: tooltipText.data,
		};
	} else {
		tooltip = z
			.custom<ComponentProps<typeof TooltipContent>>(
				(value) => z.record(z.string(), z.unknown()).safeParse(value).success
			)
			.parse(tooltip);
	}

	return (
		<Tooltip>
			{comp}
			<TooltipContent
				align="center"
				hidden={state !== "collapsed" || isMobile}
				side="right"
				{...tooltip}
			/>
		</Tooltip>
	);
}

function SidebarMenuAction({
	className,
	render,
	showOnHover = false,
	...props
}: useRender.ComponentProps<"button"> &
	ComponentProps<"button"> & {
		showOnHover?: boolean;
	}) {
	return useRender({
		defaultTagName: "button",
		props: mergeProps<"button">(
			{
				className: cn(
					"corner-squircle absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-xl p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden peer-data-[size=default]/menu-button:top-2 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
					showOnHover &&
						"group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 aria-expanded:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground md:opacity-0",
					className
				),
			},
			props
		),
		render,
		state: {
			slot: "sidebar-menu-action",
			sidebar: "menu-action",
		},
	});
}

function SidebarMenuBadge({
	appearance = "default",
	className,
	...props
}: ComponentProps<"div"> & { appearance?: "default" | "pending" }) {
	return (
		<div
			className={cn(
				"corner-squircle pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-xl px-1 font-medium text-sidebar-foreground text-xs tabular-nums peer-hover/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground",
				appearance === "pending" &&
					"type-compact bg-muted text-muted-foreground",
				className
			)}
			data-sidebar="menu-badge"
			data-slot="sidebar-menu-badge"
			{...props}
		/>
	);
}

function SidebarMenuSkeleton({
	className,
	showIcon = false,
	...props
}: ComponentProps<"div"> & {
	showIcon?: boolean;
}) {
	// Random width between 50 to 90%.
	const [width] = useState(() => {
		return `${Math.floor(Math.random() * 40) + 50}%`;
	});

	return (
		<div
			className={cn(
				"corner-squircle flex h-8 items-center gap-2 rounded-xl px-2",
				className
			)}
			data-sidebar="menu-skeleton"
			data-slot="sidebar-menu-skeleton"
			{...props}
		>
			{showIcon && (
				<Skeleton
					className="corner-squircle size-4 rounded-xl"
					data-sidebar="menu-skeleton-icon"
				/>
			)}
			<Skeleton
				className="h-4 max-w-(--skeleton-width) flex-1"
				data-sidebar="menu-skeleton-text"
				style={
					// SAFETY: React forwards this generated string CSS custom property to the skeleton width utility.
					{
						"--skeleton-width": width,
					} as CSSProperties
				}
			/>
		</div>
	);
}

function SidebarMenuSub({ className, ...props }: ComponentProps<"ul">) {
	return (
		<ul
			className={cn(
				"mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-sidebar-border border-l px-2.5 py-0.5 group-data-[collapsible=icon]:hidden",
				className
			)}
			data-sidebar="menu-sub"
			data-slot="sidebar-menu-sub"
			{...props}
		/>
	);
}

function SidebarMenuSubItem({ className, ...props }: ComponentProps<"li">) {
	return (
		<li
			className={cn("group/menu-sub-item relative", className)}
			data-sidebar="menu-sub-item"
			data-slot="sidebar-menu-sub-item"
			{...props}
		/>
	);
}

function SidebarMenuSubButton({
	render,
	size = "md",
	isActive = false,
	className,
	...props
}: useRender.ComponentProps<"a"> &
	ComponentProps<"a"> & {
		size?: "sm" | "md";
		isActive?: boolean;
	}) {
	return useRender({
		defaultTagName: "a",
		props: mergeProps<"a">(
			{
				className: cn(
					"corner-squircle flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-xl px-3 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-[color-mix(in_oklch,var(--sidebar-accent),var(--sidebar-foreground)_8%)] active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-sidebar-accent data-[size=md]:text-sm data-[size=sm]:text-xs data-active:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
					className
				),
			},
			props
		),
		render,
		state: {
			slot: "sidebar-menu-sub-button",
			sidebar: "menu-sub-button",
			size,
			active: isActive,
		},
	});
}

export {
	parseSidebarOpenPreference,
	readSidebarOpenPreference,
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarInset,
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSkeleton,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
	SidebarProvider,
	SidebarRail,
	SidebarSeparator,
	SidebarTrigger,
	useSidebar,
};
