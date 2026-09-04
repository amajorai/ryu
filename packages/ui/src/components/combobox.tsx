"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
	ArrowDown01Icon,
	Cancel01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ComponentPropsWithRef, useRef } from "react";
import {
	FadeOverflowText,
	FadeOverflowTextChildren,
} from "./fade-overflow-text.tsx";

const Combobox = ComboboxPrimitive.Root;

function ComboboxValue({
	className,
	...props
}: ComboboxPrimitive.Value.Props & { className?: string }) {
	return (
		<FadeOverflowText
			className={cn("min-w-0 flex-1", className)}
			data-slot="combobox-value"
		>
			<ComboboxPrimitive.Value {...props} />
		</FadeOverflowText>
	);
}

function ComboboxTrigger({
	className,
	children,
	...props
}: ComboboxPrimitive.Trigger.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ComboboxPrimitive.Trigger
			className={cn("min-w-0 [&_svg:not([class*='size-'])]:size-4", className)}
			data-slot="combobox-trigger"
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
			<HugeiconsIcon
				className="pointer-events-none size-4 text-muted-foreground"
				icon={ArrowDown01Icon}
				strokeWidth={2}
			/>
		</ComboboxPrimitive.Trigger>
	);
}

function ComboboxClear({ className, ...props }: ComboboxPrimitive.Clear.Props) {
	return (
		<ComboboxPrimitive.Clear
			className={cn(className)}
			data-slot="combobox-clear"
			render={<InputGroupButton size="icon-xs" variant="ghost" />}
			{...props}
		>
			<HugeiconsIcon
				className="pointer-events-none"
				icon={Cancel01Icon}
				strokeWidth={2}
			/>
		</ComboboxPrimitive.Clear>
	);
}

function ComboboxInput({
	className,
	children,
	disabled = false,
	showTrigger = true,
	showClear = false,
	...props
}: ComboboxPrimitive.Input.Props & {
	showTrigger?: boolean;
	showClear?: boolean;
}) {
	return (
		<InputGroup className={cn("w-auto", className)}>
			<ComboboxPrimitive.Input
				render={<InputGroupInput disabled={disabled} />}
				{...props}
			/>
			<InputGroupAddon align="inline-end">
				{showTrigger && (
					<InputGroupButton
						className="group-has-data-[slot=combobox-clear]/input-group:hidden data-pressed:bg-transparent"
						data-slot="input-group-button"
						disabled={disabled}
						render={<ComboboxTrigger />}
						size="icon-xs"
						variant="ghost"
					/>
				)}
				{showClear && <ComboboxClear disabled={disabled} />}
			</InputGroupAddon>
			{children}
		</InputGroup>
	);
}

/**
 * The popup — and any `ComboboxInput` inside it — is unmounted when the combobox
 * closes and mounted fresh on the next open. Tests that reopen and type must
 * wait for the NEW input rather than reusing a handle from the previous open:
 * driving the one on its way out filters a list that is about to disappear, and
 * the popup then shows the stale query's results with no error anywhere.
 */
function ComboboxContent({
	className,
	side = "bottom",
	sideOffset = 6,
	align = "start",
	alignOffset = 0,
	anchor,
	...props
}: ComboboxPrimitive.Popup.Props &
	Pick<
		ComboboxPrimitive.Positioner.Props,
		"side" | "align" | "sideOffset" | "alignOffset" | "anchor"
	>) {
	return (
		<ComboboxPrimitive.Portal>
			<ComboboxPrimitive.Backdrop
				className="ryu-popup-overlay"
				data-slot="combobox-overlay"
			/>
			<ComboboxPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className="isolate z-50"
				side={side}
				sideOffset={sideOffset}
			>
				<ComboboxPrimitive.Popup
					className={cn(
						"group/combobox-content data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 relative max-h-[var(--available-height)] w-[var(--anchor-width)] min-w-[calc(var(--anchor-width)+--spacing(7))] max-w-[var(--available-width)] origin-[var(--transform-origin)] animate-none! overflow-hidden rounded-3xl border border-border/50 bg-popover/70 text-popover-foreground backdrop-blur-2xl backdrop-saturate-150 duration-100 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-[chips=true]:min-w-[var(--anchor-width)] data-closed:animate-out data-open:animate-in **:data-[slot$=-item]:data-highlighted:bg-foreground/10 *:data-[slot=input-group]:h-8 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
						className
					)}
					data-chips={!!anchor}
					data-slot="combobox-content"
					{...props}
				/>
			</ComboboxPrimitive.Positioner>
		</ComboboxPrimitive.Portal>
	);
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
	return (
		<ComboboxPrimitive.List
			className={cn(
				"scroll-fade no-scrollbar max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
				className
			)}
			data-slot="combobox-list"
			{...props}
		/>
	);
}

function ComboboxItem({
	className,
	children,
	...props
}: ComboboxPrimitive.Item.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ComboboxPrimitive.Item
			className={cn(
				"relative flex w-full cursor-default select-none items-center gap-1.5 rounded-2xl py-1 pr-8 pl-1.5 font-medium text-sm outline-hidden data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-50 not-data-[variant=destructive]:data-highlighted:**:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-slot="combobox-item"
			{...props}
		>
			{localizedChildren}
			<ComboboxPrimitive.ItemIndicator
				render={
					<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
				}
			>
				<HugeiconsIcon
					className="pointer-events-none"
					icon={Tick02Icon}
					strokeWidth={2}
				/>
			</ComboboxPrimitive.ItemIndicator>
		</ComboboxPrimitive.Item>
	);
}

function ComboboxGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
	return (
		<ComboboxPrimitive.Group
			className={cn(className)}
			data-slot="combobox-group"
			{...props}
		/>
	);
}

function ComboboxLabel({
	className,
	children,
	...props
}: ComboboxPrimitive.GroupLabel.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ComboboxPrimitive.GroupLabel
			className={cn("px-1.5 py-1.5 text-muted-foreground text-xs", className)}
			data-slot="combobox-label"
			{...props}
		>
			{localizedChildren}
		</ComboboxPrimitive.GroupLabel>
	);
}

function ComboboxCollection({ ...props }: ComboboxPrimitive.Collection.Props) {
	return (
		<ComboboxPrimitive.Collection data-slot="combobox-collection" {...props} />
	);
}

function ComboboxEmpty({
	className,
	children,
	...props
}: ComboboxPrimitive.Empty.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ComboboxPrimitive.Empty
			className={cn(
				"hidden w-full justify-center py-2 text-center text-muted-foreground text-sm group-data-empty/combobox-content:flex",
				className
			)}
			data-slot="combobox-empty"
			{...props}
		>
			{localizedChildren}
		</ComboboxPrimitive.Empty>
	);
}

function ComboboxSeparator({
	className,
	...props
}: ComboboxPrimitive.Separator.Props) {
	return (
		<ComboboxPrimitive.Separator
			className={cn("mx-2 my-1 h-px bg-border", className)}
			data-slot="combobox-separator"
			{...props}
		/>
	);
}

function ComboboxChips({
	className,
	...props
}: ComponentPropsWithRef<typeof ComboboxPrimitive.Chips> &
	ComboboxPrimitive.Chips.Props) {
	return (
		<ComboboxPrimitive.Chips
			className={cn(
				"flex min-h-9 flex-wrap items-center gap-1.5 rounded-3xl border border-transparent bg-input/50 bg-clip-padding px-3 py-1.5 text-sm transition-[color,box-shadow,background-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-aria-invalid:border-destructive has-data-[slot=combobox-chip]:px-1.5 has-aria-invalid:ring-3 has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:border-destructive/50 dark:has-aria-invalid:ring-destructive/40",
				className
			)}
			data-slot="combobox-chips"
			{...props}
		/>
	);
}

function ComboboxChip({
	className,
	children,
	showRemove = true,
	...props
}: ComboboxPrimitive.Chip.Props & {
	showRemove?: boolean;
}) {
	return (
		<ComboboxPrimitive.Chip
			className={cn(
				"flex h-[calc(--spacing(5.5))] w-fit items-center justify-center gap-1 whitespace-nowrap rounded-3xl bg-input px-2 font-medium text-foreground text-xs has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-data-[slot=combobox-chip-remove]:pr-0 has-disabled:opacity-50 dark:bg-input/60",
				className
			)}
			data-slot="combobox-chip"
			{...props}
		>
			{children}
			{showRemove && (
				<ComboboxPrimitive.ChipRemove
					className="-ml-1 opacity-50 hover:opacity-100"
					data-slot="combobox-chip-remove"
					render={<Button size="icon-xs" variant="ghost" />}
				>
					<HugeiconsIcon
						className="pointer-events-none"
						icon={Cancel01Icon}
						strokeWidth={2}
					/>
				</ComboboxPrimitive.ChipRemove>
			)}
		</ComboboxPrimitive.Chip>
	);
}

function ComboboxChipsInput({
	className,
	...props
}: ComboboxPrimitive.Input.Props) {
	return (
		<ComboboxPrimitive.Input
			className={cn("min-w-16 flex-1 outline-none", className)}
			data-slot="combobox-chip-input"
			{...props}
		/>
	);
}

function useComboboxAnchor() {
	return useRef<HTMLDivElement | null>(null);
}

export {
	Combobox,
	ComboboxChip,
	ComboboxChips,
	ComboboxChipsInput,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
	ComboboxSeparator,
	ComboboxTrigger,
	ComboboxValue,
	useComboboxAnchor,
};
