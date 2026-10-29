"use client";

import { SearchIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerTitle,
} from "@ryu/ui/components/drawer.tsx";
import {
	InputGroup,
	InputGroupAddon,
} from "@ryu/ui/components/input-group.tsx";
import { useIsMobile } from "@ryu/ui/hooks/use-mobile.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Command as CommandPrimitive } from "cmdk";
import type * as React from "react";
import { useState } from "react";
import { z } from "zod";
import {
	nextCommandVariantLatch,
	resolveCommandVariant,
} from "./command-variant.ts";

const commandHeadingSchema = z.string();

function Command({
	className,
	appearance = "default",
	...props
}: React.ComponentProps<typeof CommandPrimitive> & {
	appearance?: "default" | "os-launcher";
}) {
	return (
		<CommandPrimitive
			className={cn(
				"corner-squircle flex size-full flex-col overflow-hidden rounded-4xl p-1 text-popover-foreground",
				appearance === "os-launcher" &&
					"rounded-none! bg-transparent p-0 text-white",
				className
			)}
			data-slot="command"
			{...props}
		/>
	);
}

/**
 * Command palette shell. On desktop (and for the `os-launcher` appearance) it
 * renders a centered Dialog; on phones it renders a bottom Drawer.
 *
 * In the Drawer branch, `open`, `defaultOpen`, `onOpenChange`, `modal` and
 * `className` (merged onto the drawer content) are forwarded. `layout`,
 * `showCloseButton` and the remaining Dialog root props are desktop-only:
 * the drawer is dismissed by dragging and is already full-width.
 *
 * The Dialog/Drawer choice is latched while the palette is open, so rotating
 * a phone or resizing past the breakpoint does not remount the palette and
 * lose its search query.
 */
function CommandDialog({
	title = "Command Palette",
	description = "Search for a command to run…",
	children,
	className,
	appearance = "default",
	layout = "default",
	showCloseButton = false,
	open,
	defaultOpen,
	onOpenChange,
	modal,
	...props
}: Omit<React.ComponentProps<typeof Dialog>, "children" | "onOpenChange"> & {
	onOpenChange?: (open: boolean) => void;
	title?: string;
	description?: string;
	className?: string;
	appearance?: "default" | "os-launcher";
	layout?: "default" | "expanded";
	showCloseButton?: boolean;
	children: React.ReactNode;
}) {
	const isMobile = useIsMobile();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(
		defaultOpen ?? false
	);
	const isOpen = open ?? uncontrolledOpen;
	const [latch, setLatch] = useState(() => ({
		mobile: isMobile,
		open: isOpen,
	}));
	const nextLatch = nextCommandVariantLatch(latch, isOpen, isMobile);
	if (nextLatch !== latch) {
		setLatch(nextLatch);
	}
	const showDrawer = resolveCommandVariant(latch, isOpen, isMobile);
	const handleOpenChange = (nextOpen: boolean) => {
		if (open === undefined) {
			setUncontrolledOpen(nextOpen);
		}
		onOpenChange?.(nextOpen);
	};
	// Like Credenza: phones get a draggable bottom drawer instead of a centered
	// dialog. The OS launcher is already full-screen, so it keeps the dialog.
	if (showDrawer && appearance !== "os-launcher") {
		return (
			<Drawer
				// Spread only the set props so `exactOptionalPropertyTypes` consumers
				// type-check. Base UI's "trap-focus" keeps focus inside, so it stays modal.
				{...(defaultOpen === undefined ? {} : { defaultOpen })}
				{...(modal === undefined ? {} : { modal: modal !== false })}
				{...(open === undefined ? {} : { open })}
				onOpenChange={handleOpenChange}
			>
				<DrawerContent className={cn("p-2 pt-0", className)}>
					<DrawerTitle className="sr-only">{title}</DrawerTitle>
					<DrawerDescription className="sr-only">
						{description}
					</DrawerDescription>
					{children}
				</DrawerContent>
			</Drawer>
		);
	}
	return (
		<Dialog
			defaultOpen={defaultOpen}
			modal={modal}
			onOpenChange={handleOpenChange}
			open={open}
			{...props}
		>
			<DialogHeader className="sr-only">
				<DialogTitle>{title}</DialogTitle>
				<DialogDescription>{description}</DialogDescription>
			</DialogHeader>
			<DialogContent
				className={cn(
					"!corner-squircle top-1/3 translate-y-0 animate-none! overflow-hidden rounded-4xl! p-0 duration-0",
					layout === "expanded" && "top-[14%] overflow-visible sm:max-w-4xl",
					appearance === "os-launcher" &&
						"inset-0! top-0! left-0! h-full! w-full! max-w-none! translate-x-0! translate-y-0! rounded-none! border-0! bg-white/5! p-0 text-white ring-0! backdrop-blur-3xl backdrop-saturate-150 sm:max-w-none!",
					className
				)}
				overlayClassName="animate-none! duration-0"
				showCloseButton={showCloseButton}
			>
				{children}
			</DialogContent>
		</Dialog>
	);
}

function CommandInput({
	className,
	appearance = "default",
	...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
	appearance?: "default" | "os-launcher";
}) {
	const localizedPlaceholder = useLocalizedString(props.placeholder);
	return (
		<div data-slot="command-input-wrapper">
			<InputGroup className="sticky top-0 z-20 h-9 border-0 border-b bg-transparent! shadow-none! backdrop-blur supports-backdrop-filter:bg-transparent!">
				<CommandPrimitive.Input
					className={cn(
						"w-full bg-transparent! text-sm shadow-none! outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
						appearance === "os-launcher" &&
							"text-white placeholder:text-white/55",
						className
					)}
					data-slot="command-input"
					{...props}
					placeholder={localizedPlaceholder}
				/>
				<InputGroupAddon>
					<HugeiconsIcon
						className="size-4 shrink-0 opacity-50"
						icon={SearchIcon}
						strokeWidth={2}
					/>
				</InputGroupAddon>
			</InputGroup>
		</div>
	);
}

function CommandList({
	className,
	appearance = "default",
	...props
}: React.ComponentProps<typeof CommandPrimitive.List> & {
	appearance?: "default" | "os-launcher";
}) {
	return (
		<CommandPrimitive.List
			className={cn(
				"scroll-fade no-scrollbar max-h-72 scroll-py-1 overflow-y-auto overflow-x-hidden outline-none",
				appearance === "os-launcher" &&
					"overflow-visible! max-h-none! p-0 [mask-image:none]! [&>div]:flex [&>div]:flex-col [&>div]:items-center",
				className
			)}
			data-slot="command-list"
			{...props}
		/>
	);
}

function CommandEmpty({
	className,
	appearance = "default",
	children,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Empty> & {
	appearance?: "default" | "os-launcher";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<CommandPrimitive.Empty
			className={cn(
				"py-4 text-center text-sm",
				appearance === "os-launcher" && "py-16 text-white/70",
				className
			)}
			data-slot="command-empty"
			{...props}
		>
			{localizedChildren}
		</CommandPrimitive.Empty>
	);
}

/**
 * Loading state for a `CommandList`. cmdk renders it as a labelled
 * `role="progressbar"` and hides its children from assistive tech, so pass
 * skeleton rows as children and name the state with `label`.
 */
function CommandLoading({
	className,
	label = "Loading",
	...props
}: React.ComponentProps<typeof CommandPrimitive.Loading>) {
	const localizedLabel = useLocalizedString(label);
	return (
		<CommandPrimitive.Loading
			className={className}
			data-slot="command-loading"
			label={localizedLabel ?? label}
			{...props}
		/>
	);
}

function CommandGroup({
	className,
	appearance = "default",
	heading,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Group> & {
	appearance?: "default" | "os-launcher";
}) {
	const parsedHeading = commandHeadingSchema.safeParse(heading);
	const localizedHeading = useLocalizedString(
		parsedHeading.success ? parsedHeading.data : undefined
	);
	return (
		<CommandPrimitive.Group
			className={cn(
				"overflow-hidden p-1 text-foreground **:[[cmdk-group-heading]]:px-1.5 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground **:[[cmdk-group-heading]]:text-xs",
				"**:[[cmdk-group-heading]]:sticky **:[[cmdk-group-heading]]:top-0 **:[[cmdk-group-heading]]:z-10 **:[[cmdk-group-heading]]:bg-transparent! **:[[cmdk-group-heading]]:backdrop-blur",
				appearance === "os-launcher" && "p-0 **:[[cmdk-group-heading]]:sr-only",
				className
			)}
			data-slot="command-group"
			{...props}
			heading={parsedHeading.success ? localizedHeading : heading}
		/>
	);
}

function CommandSeparator({
	className,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
	return (
		<CommandPrimitive.Separator
			className={cn("mx-2 my-1 h-px bg-border/50", className)}
			data-slot="command-separator"
			{...props}
		/>
	);
}

function CommandItem({
	appearance,
	className,
	children,
	...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
	appearance?:
		| "default"
		| "provider-row"
		| "os-window-preview"
		| "os-application";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<CommandPrimitive.Item
			className={cn(
				"group/command-item in-data-[slot=dialog-content]:corner-squircle corner-squircle relative flex cursor-default select-none items-center gap-1.5 in-data-[slot=dialog-content]:rounded-3xl in-data-[slot=drawer-content]:rounded-3xl rounded-2xl px-1.5 py-1 font-medium text-sm outline-hidden data-[disabled=true]:pointer-events-none data-selected:bg-accent data-selected:text-foreground data-[disabled=true]:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 data-selected:*:[svg]:text-foreground",
				appearance === "provider-row" && "rounded-lg px-3 py-3",
				appearance === "os-window-preview" &&
					"flex-col items-stretch gap-2 rounded-2xl bg-transparent p-0 text-white data-selected:bg-transparent [&>svg:last-child]:hidden",
				appearance === "os-application" &&
					"flex-col justify-start gap-2 rounded-2xl bg-transparent px-1 py-2 text-center text-white data-selected:bg-white/10 [&>svg:last-child]:hidden",
				className
			)}
			data-slot="command-item"
			{...props}
		>
			{localizedChildren}
			<HugeiconsIcon
				className="ms-auto opacity-0 group-has-data-[slot=command-shortcut]/command-item:hidden group-data-[checked=true]/command-item:opacity-100"
				icon={Tick02Icon}
				strokeWidth={2}
			/>
		</CommandPrimitive.Item>
	);
}

function CommandShortcut({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ms-auto text-muted-foreground text-xs tracking-widest group-data-selected/command-item:text-foreground",
				className
			)}
			data-slot="command-shortcut"
			{...props}
		/>
	);
}

export {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandLoading,
	CommandSeparator,
	CommandShortcut,
};
