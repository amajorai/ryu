"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, type CSSProperties, useState } from "react";
import { z } from "zod";
import { useSidebar } from "./sidebar-context.tsx";

const sidebarTooltipTextSchema = z.string();

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
	"peer/menu-button group/menu-button flex w-full items-center gap-2 overflow-hidden rounded-lg px-3 py-2 text-left text-sm outline-hidden ring-sidebar-ring transition-colors duration-(--duration-fast) hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:duration-0 focus-visible:ring-2 active:bg-[color-mix(in_oklch,var(--sidebar-accent),var(--sidebar-foreground)_8%)] active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 group-has-data-[sidebar=menu-action]/menu-item:pr-8 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-sidebar-accent data-active:font-medium data-active:text-sidebar-accent-foreground data-open:hover:bg-sidebar-accent data-open:hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0",
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
					"absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-xl p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 peer-hover/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden peer-data-[size=default]/menu-button:top-2 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
					showOnHover &&
						"transition-[opacity,transform] duration-(--duration-fast) group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 group-hover/menu-item:duration-0 aria-expanded:opacity-100 peer-data-active/menu-button:text-sidebar-accent-foreground md:opacity-0",
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
				"pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-xl px-1 font-medium text-sidebar-foreground text-xs tabular-nums peer-hover/menu-button:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden peer-data-[size=default]/menu-button:top-1.5 peer-data-[size=lg]/menu-button:top-2.5 peer-data-[size=sm]/menu-button:top-1 peer-data-active/menu-button:text-sidebar-accent-foreground",
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
			className={cn("flex h-8 items-center gap-2 rounded-xl px-2", className)}
			data-sidebar="menu-skeleton"
			data-slot="sidebar-menu-skeleton"
			{...props}
		>
			{showIcon && (
				<Skeleton
					className="size-4 rounded-xl"
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
					"flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-xl px-3 text-sidebar-foreground outline-hidden ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-[color-mix(in_oklch,var(--sidebar-accent),var(--sidebar-foreground)_8%)] active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:bg-sidebar-accent data-[size=md]:text-sm data-[size=sm]:text-xs data-active:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground",
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
	SidebarMenu,
	SidebarMenuAction,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSkeleton,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
};
