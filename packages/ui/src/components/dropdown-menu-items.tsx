"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComponentProps } from "react";
import { useDropdownMenuContext } from "./dropdown-menu-context.ts";

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
	return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuLabel({
	children,
	className,
	inset,
	variant = "default",
	layout = "default",
	...props
}: MenuPrimitive.GroupLabel.Props & {
	inset?: boolean;
	variant?: "default" | "worktree-heading";
	layout?: "default" | "icon";
}) {
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.GroupLabel
			className={cn(
				"px-2 py-1.5 text-muted-foreground text-xs data-inset:ps-9.5",
				isMobile && "px-4 py-2 text-sm",
				variant === "worktree-heading" && "px-2 pt-1 pb-1 text-sm",
				layout === "icon" && "flex items-center gap-1.5",
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
	spacing = "default",
	density = "default",
	tone = "default",
	active = false,
	layout = "default",
	purpose = "default",
	selected = false,
	...props
}: MenuPrimitive.Item.Props & {
	inset?: boolean;
	spacing?: "default" | "tight" | "comfortable" | "spacious";
	density?: "default" | "compact";
	tone?: "default" | "muted" | "foreground" | "destructive";
	active?: boolean;
	layout?: "default" | "detail-stack";
	variant?: "default" | "destructive";
	purpose?:
		| "default"
		| "composer-model"
		| "app-version"
		| "interface-level"
		| "layer-action"
		| "provider-heading"
		| "node-choice";
	selected?: boolean;
}) {
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.Item
			className={cn(
				"group/dropdown-menu-item relative flex w-full cursor-default select-none items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-[variant=destructive]:text-status-destructive data-disabled:opacity-50 data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-status-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 data-[variant=destructive]:*:[svg]:text-status-destructive",
				isMobile &&
					"min-h-[44px] px-4 py-2.5 text-base [&_svg:not([class*='size-'])]:size-5",
				active && "bg-foreground/10",
				spacing === "tight" && "gap-0.5",
				spacing === "comfortable" && "gap-2",
				spacing === "spacious" && "gap-2.5",
				density === "compact" && "text-xs",
				tone === "muted" && "text-muted-foreground",
				tone === "foreground" && "text-foreground",
				layout === "detail-stack" && "flex flex-col items-start gap-1",
				purpose === "composer-model" && [
					"h-auto w-full items-center justify-start gap-1.5 rounded-lg px-1.5 py-1 text-left font-medium text-sm",
					"flex-col items-start gap-0.5",
				],
				purpose === "app-version" && "py-1.5",
				purpose === "interface-level" && "py-2",
				purpose === "layer-action" && "py-1",
				purpose === "provider-heading" &&
					"type-compact rounded-md px-1 py-0 text-muted-foreground/50",
				purpose === "node-choice" &&
					"items-start gap-2 rounded-lg px-2.5 py-2.5",
				tone === "destructive" && "text-status-destructive",
				selected && "bg-accent",
				className
			)}
			data-cuelume-toggle=""
			data-inset={inset}
			data-slot="dropdown-menu-item"
			data-variant={variant}
			{...props}
		>
			{localizedChildren}
		</MenuPrimitive.Item>
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
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.CheckboxItem
			checked={checked}
			className={cn(
				"relative flex cursor-default select-none items-center gap-1.5 rounded-lg py-1 ps-2 pe-8 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				isMobile &&
					"min-h-[44px] py-2.5 ps-4 text-base [&_svg:not([class*='size-'])]:size-5",
				className
			)}
			closeOnClick={isMobile}
			data-inset={inset}
			data-slot="dropdown-menu-checkbox-item"
			{...props}
		>
			<span
				className="pointer-events-none absolute end-2 flex items-center justify-center"
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
	const { isMobile } = useDropdownMenuContext();
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.RadioItem
			className={cn(
				"relative flex cursor-default select-none items-center gap-1.5 rounded-lg py-1 ps-2 pe-8 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-disabled:pointer-events-none data-inset:ps-9.5 data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				isMobile &&
					"min-h-[44px] py-2.5 ps-4 text-base [&_svg:not([class*='size-'])]:size-5",
				className
			)}
			closeOnClick={isMobile}
			data-inset={inset}
			data-slot="dropdown-menu-radio-item"
			{...props}
		>
			<span
				className="pointer-events-none absolute end-2 flex items-center justify-center"
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

function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"ms-auto text-muted-foreground text-xs tracking-widest group-focus/dropdown-menu-item:text-accent-foreground",
				className
			)}
			data-slot="dropdown-menu-shortcut"
			{...props}
		/>
	);
}

export {
	DropdownMenuCheckboxItem,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
};
