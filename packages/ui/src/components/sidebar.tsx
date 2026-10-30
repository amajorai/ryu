"use client";

import { SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ryu/ui/components/sheet.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { z } from "zod";
import {
	SidebarContext,
	type SidebarContextProps,
	useSidebar,
} from "./sidebar-context.tsx";

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

import {
	type ComponentProps,
	type CSSProperties,
	useCallback,
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
					// Snaps to its new width in one step; only the panel below animates.
					"relative w-(--sidebar-width) bg-transparent",
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
					// The panel slides and fades on transform and opacity only; its width
					// (icon collapse) snaps, so nothing animates layout.
					"fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width) transition-[translate,opacity] duration-(--duration-base) ease-move data-[side=right]:right-0 data-[side=left]:left-0 group-data-[collapsible=offcanvas]:pointer-events-none group-data-[collapsible=offcanvas]:opacity-0 data-[side=left]:group-data-[collapsible=offcanvas]:-translate-x-full data-[side=right]:group-data-[collapsible=offcanvas]:translate-x-full md:flex",
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
					className="relative flex size-full flex-col bg-sidebar group-data-[variant=floating]:rounded-3xl group-data-[variant=floating]:border group-data-[variant=floating]:border-background"
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
				"relative flex w-full flex-1 flex-col bg-background md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2 md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-2xl md:peer-data-[variant=inset]:shadow-sm",
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

export {
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSkeleton,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "./sidebar-menu.tsx";
export {
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupAction,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInput,
	SidebarSeparator,
} from "./sidebar-sections.tsx";
export {
	parseSidebarOpenPreference,
	readSidebarOpenPreference,
	Sidebar,
	SidebarInset,
	SidebarProvider,
	SidebarRail,
	SidebarTrigger,
	useSidebar,
};
