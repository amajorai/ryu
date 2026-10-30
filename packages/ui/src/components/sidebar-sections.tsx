"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useLocalizedText } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps } from "react";

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
					"text-(length:--text-detail) flex h-7 shrink-0 items-center rounded-lg px-2 font-normal text-muted-foreground leading-(--text-detail--line-height) outline-hidden ring-sidebar-ring transition-opacity duration-(--duration-fast) focus-visible:ring-2 group-data-[collapsible=icon]:-mt-7 group-data-[collapsible=icon]:opacity-0 [&>svg]:size-4 [&>svg]:shrink-0",
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
					"absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-xl p-0 text-sidebar-foreground outline-hidden ring-sidebar-ring transition-transform after:absolute after:-inset-2 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 group-data-[collapsible=icon]:hidden md:after:hidden [&>svg]:size-4 [&>svg]:shrink-0",
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
};
