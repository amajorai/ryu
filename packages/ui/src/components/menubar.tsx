"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Menubar({
	className,
	appearance = "default",
	...props
}: MenubarPrimitive.Props & { appearance?: "default" | "os-desktop" }) {
	return (
		<MenubarPrimitive
			className={cn(
				"flex h-9 items-center rounded-3xl p-1",
				appearance === "os-desktop" &&
					"rounded-none bg-transparent p-0 text-white/75",
				className
			)}
			data-slot="menubar"
			{...props}
		/>
	);
}

function MenubarMenu({ ...props }: React.ComponentProps<typeof DropdownMenu>) {
	return <DropdownMenu data-slot="menubar-menu" {...props} />;
}

function MenubarGroup({
	...props
}: React.ComponentProps<typeof DropdownMenuGroup>) {
	return <DropdownMenuGroup data-slot="menubar-group" {...props} />;
}

function MenubarPortal({
	...props
}: React.ComponentProps<typeof DropdownMenuPortal>) {
	return <DropdownMenuPortal data-slot="menubar-portal" {...props} />;
}

function MenubarTrigger({
	className,
	appearance = "default",
	...props
}: React.ComponentProps<typeof DropdownMenuTrigger> & {
	appearance?: "default" | "os-desktop";
}) {
	return (
		<DropdownMenuTrigger
			className={cn(
				"flex select-none items-center rounded-lg px-2 py-0.75 font-medium text-sm outline-hidden hover:bg-muted aria-expanded:bg-muted",
				appearance === "os-desktop" &&
					"bg-transparent text-white/70 hover:bg-transparent hover:text-white aria-expanded:bg-transparent aria-expanded:text-white",
				className
			)}
			data-slot="menubar-trigger"
			{...props}
		/>
	);
}

function MenubarContent({
	className,
	align = "start",
	alignOffset = -4,
	sideOffset = 8,
	...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
	return (
		<DropdownMenuContent
			align={align}
			alignOffset={alignOffset}
			className={cn(
				"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 relative min-w-48 animate-none! rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-popover) duration-100 data-open:animate-in **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
				className
			)}
			data-slot="menubar-content"
			sideOffset={sideOffset}
			{...props}
		/>
	);
}

function MenubarItem({
	className,
	inset,
	variant = "default",
	...props
}: React.ComponentProps<typeof DropdownMenuItem>) {
	return (
		<DropdownMenuItem
			className={cn(
				"group/menubar-item gap-1.5 rounded-lg px-2 py-1 font-medium text-sm focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:ps-9.5 data-[variant=destructive]:text-status-destructive data-disabled:opacity-50 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-status-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-status-destructive!",
				className
			)}
			data-inset={inset}
			data-slot="menubar-item"
			data-variant={variant}
			{...props}
		/>
	);
}

function MenubarCheckboxItem({
	className,
	children,
	checked,
	inset,
	...props
}: MenuPrimitive.CheckboxItem.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.CheckboxItem
			checked={checked}
			className={cn(
				"relative flex cursor-default select-none items-center gap-1.5 rounded-lg py-1 ps-9.5 pe-2 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="menubar-checkbox-item"
			{...props}
		>
			<span className="pointer-events-none absolute start-3 flex size-4 items-center justify-center [&_svg:not([class*='size-'])]:size-4">
				<MenuPrimitive.CheckboxItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{localizedChildren}
		</MenuPrimitive.CheckboxItem>
	);
}

function MenubarRadioGroup({
	...props
}: React.ComponentProps<typeof DropdownMenuRadioGroup>) {
	return <DropdownMenuRadioGroup data-slot="menubar-radio-group" {...props} />;
}

function MenubarRadioItem({
	className,
	children,
	inset,
	...props
}: MenuPrimitive.RadioItem.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.RadioItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-1.5 rounded-lg py-1 ps-9.5 pe-2 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="menubar-radio-item"
			{...props}
		>
			<span className="pointer-events-none absolute start-3 flex size-4 items-center justify-center [&_svg:not([class*='size-'])]:size-4">
				<MenuPrimitive.RadioItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{localizedChildren}
		</MenuPrimitive.RadioItem>
	);
}

function MenubarLabel({
	className,
	inset,
	...props
}: React.ComponentProps<typeof DropdownMenuLabel> & {
	inset?: boolean;
}) {
	return (
		<DropdownMenuLabel
			className={cn(
				"px-2 py-1.5 text-muted-foreground text-xs data-inset:ps-9.5",
				className
			)}
			data-inset={inset}
			data-slot="menubar-label"
			{...props}
		/>
	);
}

function MenubarSeparator({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuSeparator>) {
	return (
		<DropdownMenuSeparator
			className={cn("mx-2 my-1 h-px bg-border/50", className)}
			data-slot="menubar-separator"
			{...props}
		/>
	);
}

function MenubarShortcut({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuShortcut>) {
	return (
		<DropdownMenuShortcut
			className={cn(
				"ms-auto text-muted-foreground text-xs tracking-widest group-focus/menubar-item:text-accent-foreground",
				className
			)}
			data-slot="menubar-shortcut"
			{...props}
		/>
	);
}

function MenubarSub({
	...props
}: React.ComponentProps<typeof DropdownMenuSub>) {
	return <DropdownMenuSub data-slot="menubar-sub" {...props} />;
}

function MenubarSubTrigger({
	className,
	inset,
	...props
}: React.ComponentProps<typeof DropdownMenuSubTrigger> & {
	inset?: boolean;
}) {
	return (
		<DropdownMenuSubTrigger
			className={cn(
				"gap-1.5 rounded-lg px-2 py-1 font-medium text-sm focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-inset:ps-9.5 data-open:text-accent-foreground [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			data-inset={inset}
			data-slot="menubar-sub-trigger"
			{...props}
		/>
	);
}

function MenubarSubContent({
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuSubContent>) {
	return (
		<DropdownMenuSubContent
			className={cn(
				"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 relative min-w-32 animate-none! rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-popover) duration-100 data-closed:animate-out data-open:animate-in **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
				className
			)}
			data-slot="menubar-sub-content"
			{...props}
		/>
	);
}

export {
	Menubar,
	MenubarCheckboxItem,
	MenubarContent,
	MenubarGroup,
	MenubarItem,
	MenubarLabel,
	MenubarMenu,
	MenubarPortal,
	MenubarRadioGroup,
	MenubarRadioItem,
	MenubarSeparator,
	MenubarShortcut,
	MenubarSub,
	MenubarSubContent,
	MenubarSubTrigger,
	MenubarTrigger,
};
