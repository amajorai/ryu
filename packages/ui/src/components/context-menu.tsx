"use client";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";
import { usePortalContainer } from "./portal-container.tsx";

function ContextMenu({ ...props }: ContextMenuPrimitive.Root.Props) {
	return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuPortal({ ...props }: ContextMenuPrimitive.Portal.Props) {
	return (
		<ContextMenuPrimitive.Portal
			container={usePortalContainer()}
			data-slot="context-menu-portal"
			{...props}
		/>
	);
}

function ContextMenuTrigger({
	className,
	...props
}: ContextMenuPrimitive.Trigger.Props) {
	return (
		<ContextMenuPrimitive.Trigger
			className={cn("select-none", className)}
			data-slot="context-menu-trigger"
			{...props}
		/>
	);
}

function ContextMenuContent({
	className,
	align = "start",
	alignOffset = 4,
	side = "inline-end",
	sideOffset = 0,
	withBackdrop = true,
	...props
}: ContextMenuPrimitive.Popup.Props &
	Pick<
		ContextMenuPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	> & {
		/** Render the shared full-window backdrop for a top-level menu. */
		withBackdrop?: boolean;
	}) {
	const direction = useDirection();
	return (
		<ContextMenuPrimitive.Portal container={usePortalContainer()}>
			{withBackdrop && (
				<ContextMenuPrimitive.Backdrop
					className="ryu-popup-overlay"
					data-slot="context-menu-overlay"
				/>
			)}
			<ContextMenuPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				className="isolate z-50 outline-none"
				side={side}
				sideOffset={sideOffset}
			>
				<ContextMenuPrimitive.Popup
					className={cn(
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 corner-squircle before:corner-squircle relative z-50 max-h-[var(--available-height)] min-w-48 origin-[var(--transform-origin)] animate-none! overflow-y-auto overflow-x-hidden rounded-3xl border border-border/50 bg-popover/70 text-popover-foreground outline-none backdrop-blur-2xl backdrop-saturate-150 duration-0 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-closed:animate-out data-open:animate-in **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
						className
					)}
					data-slot="context-menu-content"
					{...props}
					dir={direction}
				/>
			</ContextMenuPrimitive.Positioner>
		</ContextMenuPrimitive.Portal>
	);
}

function ContextMenuGroup({ ...props }: ContextMenuPrimitive.Group.Props) {
	return (
		<ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
	);
}

function ContextMenuLabel({
	children,
	className,
	inset,
	...props
}: ContextMenuPrimitive.GroupLabel.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ContextMenuPrimitive.GroupLabel
			className={cn(
				"px-2 py-1.5 text-muted-foreground text-xs data-inset:ps-9.5",
				className
			)}
			data-inset={inset}
			data-slot="context-menu-label"
			{...props}
		>
			{localizedChildren}
		</ContextMenuPrimitive.GroupLabel>
	);
}

function ContextMenuItem({
	children,
	className,
	inset,
	variant = "default",
	...props
}: ContextMenuPrimitive.Item.Props & {
	inset?: boolean;
	variant?: "default" | "destructive";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ContextMenuPrimitive.Item
			className={cn(
				"group/context-menu-item corner-squircle relative flex cursor-default select-none items-center gap-1.5 rounded-2xl px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-[variant=destructive]:text-status-destructive data-disabled:opacity-50 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-status-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus:*:[svg]:text-accent-foreground data-[variant=destructive]:*:[svg]:text-status-destructive",
				className
			)}
			data-inset={inset}
			data-slot="context-menu-item"
			data-variant={variant}
			{...props}
		>
			{localizedChildren}
		</ContextMenuPrimitive.Item>
	);
}

function ContextMenuSub({ ...props }: ContextMenuPrimitive.SubmenuRoot.Props) {
	return (
		<ContextMenuPrimitive.SubmenuRoot data-slot="context-menu-sub" {...props} />
	);
}

function ContextMenuSubTrigger({
	className,
	inset,
	children,
	...props
}: ContextMenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ContextMenuPrimitive.SubmenuTrigger
			className={cn(
				"corner-squircle flex cursor-default select-none items-center gap-1.5 rounded-2xl px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-open:bg-accent data-inset:ps-9.5 data-open:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="context-menu-sub-trigger"
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
			<HugeiconsIcon
				className="ms-auto rtl:rotate-180"
				icon={ArrowRight01Icon}
				strokeWidth={2}
			/>
		</ContextMenuPrimitive.SubmenuTrigger>
	);
}

function ContextMenuSubContent({
	...props
}: React.ComponentProps<typeof ContextMenuContent>) {
	return (
		<ContextMenuContent
			className="before:corner-squircle relative animate-none! bg-popover/70 backdrop-blur-2xl backdrop-saturate-150 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!"
			data-slot="context-menu-sub-content"
			side="inline-end"
			{...props}
			withBackdrop={false}
		/>
	);
}

function ContextMenuCheckboxItem({
	className,
	children,
	checked,
	closeOnClick = true,
	inset,
	...props
}: ContextMenuPrimitive.CheckboxItem.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ContextMenuPrimitive.CheckboxItem
			checked={checked}
			className={cn(
				"corner-squircle relative flex cursor-default select-none items-center gap-1.5 rounded-2xl py-1 ps-2 pe-8 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			closeOnClick={closeOnClick}
			data-inset={inset}
			data-slot="context-menu-checkbox-item"
			{...props}
		>
			<span className="pointer-events-none absolute end-2">
				<ContextMenuPrimitive.CheckboxItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</ContextMenuPrimitive.CheckboxItemIndicator>
			</span>
			{localizedChildren}
		</ContextMenuPrimitive.CheckboxItem>
	);
}

function ContextMenuRadioGroup({
	...props
}: ContextMenuPrimitive.RadioGroup.Props) {
	return (
		<ContextMenuPrimitive.RadioGroup
			data-slot="context-menu-radio-group"
			{...props}
		/>
	);
}

function ContextMenuRadioItem({
	className,
	children,
	inset,
	...props
}: ContextMenuPrimitive.RadioItem.Props & {
	inset?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ContextMenuPrimitive.RadioItem
			className={cn(
				"corner-squircle relative flex cursor-default select-none items-center gap-1.5 rounded-2xl py-1 ps-2 pe-8 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-inset={inset}
			data-slot="context-menu-radio-item"
			{...props}
		>
			<span className="pointer-events-none absolute end-2">
				<ContextMenuPrimitive.RadioItemIndicator>
					<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
				</ContextMenuPrimitive.RadioItemIndicator>
			</span>
			{localizedChildren}
		</ContextMenuPrimitive.RadioItem>
	);
}

function ContextMenuSeparator({
	className,
	...props
}: ContextMenuPrimitive.Separator.Props) {
	return (
		<ContextMenuPrimitive.Separator
			className={cn("mx-2 my-1 h-px bg-border/50", className)}
			data-slot="context-menu-separator"
			{...props}
		/>
	);
}

function ContextMenuShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ms-auto text-muted-foreground text-xs tracking-widest group-focus/context-menu-item:text-accent-foreground",
				className
			)}
			data-slot="context-menu-shortcut"
			{...props}
		/>
	);
}

export {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuGroup,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuPortal,
	ContextMenuRadioGroup,
	ContextMenuRadioItem,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
};
