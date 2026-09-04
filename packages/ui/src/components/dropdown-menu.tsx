"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { renderDropdownPopup } from "@ryu/ui/components/dropdown-menu-motion.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
	return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
	return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
	children,
	...props
}: MenuPrimitive.Trigger.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props}>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
		</MenuPrimitive.Trigger>
	);
}

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	className,
	withBackdrop = true,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<
		MenuPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	> & {
		/** Render the shared full-window backdrop for a top-level menu. */
		withBackdrop?: boolean;
	}) {
	return (
		<MenuPrimitive.Portal>
			{withBackdrop && (
				<MenuPrimitive.Backdrop
					className="ryu-popup-overlay"
					data-slot="dropdown-menu-overlay"
				/>
			)}
			<MenuPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				className="isolate z-50 outline-none"
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					className={cn(
						"relative z-50 max-h-[var(--available-height)] w-[var(--anchor-width)] min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden rounded-3xl border border-border/50 bg-muted/90 text-popover-foreground outline-none backdrop-blur-2xl backdrop-saturate-150 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-closed:overflow-hidden **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
						className
					)}
					data-slot="dropdown-menu-content"
					{...props}
					render={renderDropdownPopup}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
	children,
	className,
	inset,
	...props
}: MenuPrimitive.GroupLabel.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.GroupLabel
			className={cn(
				"px-2 py-1.5 text-muted-foreground text-xs data-inset:pl-9.5",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-label"
			{...props}
		>
			{localizedChildren}
		</MenuPrimitive.GroupLabel>
	);
}

function DropdownMenuItem({
	children,
	className,
	inset,
	variant = "default",
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean;
	variant?: "default" | "destructive";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.Item
			className={cn(
				"group/dropdown-menu-item relative flex cursor-default select-none items-center gap-1.5 rounded-2xl px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:pl-9.5 data-[variant=destructive]:text-destructive data-disabled:opacity-50 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 data-[variant=destructive]:*:[svg]:text-destructive",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-item"
			data-variant={variant}
			{...props}
		>
			{localizedChildren}
		</MenuPrimitive.Item>
	);
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
	return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.SubmenuTrigger
			className={cn(
				"flex cursor-default select-none items-center gap-1.5 rounded-2xl px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-open:bg-accent data-popup-open:bg-accent data-inset:pl-9.5 data-open:text-accent-foreground data-popup-open:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-sub-trigger"
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
			<HugeiconsIcon
				className="ml-auto"
				icon={ArrowRight01Icon}
				strokeWidth={2}
			/>
		</MenuPrimitive.SubmenuTrigger>
	);
}

function DropdownMenuSubContent({
	align = "start",
	alignOffset = -3,
	side = "right",
	sideOffset = 0,
	className,
	...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
	return (
		<DropdownMenuContent
			align={align}
			alignOffset={alignOffset}
			className={cn(
				"relative w-auto min-w-36 rounded-3xl border border-border/50 bg-muted/90 text-popover-foreground backdrop-blur-2xl backdrop-saturate-150 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
				className
			)}
			data-slot="dropdown-menu-sub-content"
			side={side}
			sideOffset={sideOffset}
			{...props}
			withBackdrop={false}
		/>
	);
}

function DropdownMenuCheckboxItem({
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
				"relative flex cursor-default select-none items-center gap-1.5 rounded-2xl py-1 pr-8 pl-2 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:pl-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-checkbox-item"
			{...props}
		>
			<span
				className="pointer-events-none absolute right-2 flex items-center justify-center"
				data-slot="dropdown-menu-checkbox-item-indicator"
			>
				<MenuPrimitive.CheckboxItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</MenuPrimitive.CheckboxItemIndicator>
			</span>
			{localizedChildren}
		</MenuPrimitive.CheckboxItem>
	);
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
	return (
		<MenuPrimitive.RadioGroup
			data-slot="dropdown-menu-radio-group"
			{...props}
		/>
	);
}

function DropdownMenuRadioItem({
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
				"relative flex cursor-default select-none items-center gap-1.5 rounded-2xl py-1 pr-8 pl-2 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:pl-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="dropdown-menu-radio-item"
			{...props}
		>
			<span
				className="pointer-events-none absolute right-2 flex items-center justify-center"
				data-slot="dropdown-menu-radio-item-indicator"
			>
				<MenuPrimitive.RadioItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</MenuPrimitive.RadioItemIndicator>
			</span>
			{localizedChildren}
		</MenuPrimitive.RadioItem>
	);
}

function DropdownMenuSeparator({
	className,
	...props
}: MenuPrimitive.Separator.Props) {
	return (
		<MenuPrimitive.Separator
			className={cn("mx-2 my-1 h-px bg-border/50", className)}
			data-slot="dropdown-menu-separator"
			{...props}
		/>
	);
}

function DropdownMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ml-auto text-muted-foreground text-xs tracking-widest group-focus/dropdown-menu-item:text-accent-foreground",
				className
			)}
			data-slot="dropdown-menu-shortcut"
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};
