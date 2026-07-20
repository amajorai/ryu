"use client";

import { Select as SelectPrimitive } from "@base-ui/react/select";
import {
	ArrowDown01Icon,
	ArrowUp01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Input } from "@ryu/ui/components/input.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ChevronDown, Search } from "lucide-react";
import * as React from "react";

const Select = SelectPrimitive.Root;

// The active filter query for a searchable SelectContent, lowercased + trimmed.
// Default "" means "no filter", so every non-searchable Select is unaffected: an
// item only hides when a non-empty query fails to match its searchable text.
const SelectFilterContext = React.createContext("");

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
	return (
		<SelectPrimitive.Group
			className={cn("scroll-my-1 p-1", className)}
			data-slot="select-group"
			{...props}
		/>
	);
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
	return (
		<SelectPrimitive.Value
			className={cn("flex flex-1 text-left", className)}
			data-slot="select-value"
			{...props}
		/>
	);
}

function SelectTrigger({
	className,
	size = "default",
	children,
	...props
}: SelectPrimitive.Trigger.Props & {
	size?: "sm" | "default";
}) {
	return (
		<SelectPrimitive.Trigger
			className={cn(
				"flex w-fit items-center justify-between gap-1.5 whitespace-nowrap rounded-3xl border border-transparent bg-input/50 px-3 py-2 text-sm outline-none transition-[color,box-shadow,background-color] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-9 data-[size=sm]:h-8 data-placeholder:text-muted-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className
			)}
			data-size={size}
			data-slot="select-trigger"
			{...props}
		>
			{children}
			<SelectPrimitive.Icon
				render={
					<ChevronDown className="pointer-events-none size-4 text-muted-foreground" />
				}
			/>
		</SelectPrimitive.Trigger>
	);
}

function SelectContent({
	className,
	children,
	side = "bottom",
	sideOffset = 4,
	align = "center",
	alignOffset = 0,
	alignItemWithTrigger = true,
	searchable = false,
	searchPlaceholder = "Search…",
	...props
}: SelectPrimitive.Popup.Props &
	Pick<
		SelectPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
	> & {
		/** Render a sticky filter box atop the list. Off by default. */
		searchable?: boolean;
		searchPlaceholder?: string;
	}) {
	const [query, setQuery] = React.useState("");
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Positioner
				align={align}
				// A search box needs a plain scroll-from-top list, so trigger-alignment
				// (which anchors the active item to the trigger) is dropped when searchable.
				alignItemWithTrigger={searchable ? false : alignItemWithTrigger}
				alignOffset={alignOffset}
				className="isolate z-50"
				side={side}
				sideOffset={sideOffset}
			>
				<SelectPrimitive.Popup
					className={cn(
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 relative isolate z-50 max-h-[min(24rem,var(--available-height))] w-(--anchor-width) min-w-36 origin-(--transform-origin) animate-none! overflow-y-auto overflow-x-hidden rounded-3xl border border-border/50 bg-muted/90 text-popover-foreground backdrop-blur-2xl backdrop-saturate-150 duration-100 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-[align-trigger=true]:animate-none data-closed:animate-out data-open:animate-in **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
						className
					)}
					data-align-trigger={searchable ? false : alignItemWithTrigger}
					data-slot="select-content"
					{...props}
				>
					{searchable ? (
						<SelectSearch
							onQueryChange={setQuery}
							placeholder={searchPlaceholder}
							query={query}
						/>
					) : (
						<SelectScrollUpButton />
					)}
					<SelectFilterContext.Provider value={query.trim().toLowerCase()}>
						<SelectPrimitive.List>{children}</SelectPrimitive.List>
					</SelectFilterContext.Provider>
					<SelectScrollDownButton />
				</SelectPrimitive.Popup>
			</SelectPrimitive.Positioner>
		</SelectPrimitive.Portal>
	);
}

function SelectSearch({
	query,
	onQueryChange,
	placeholder,
}: {
	query: string;
	onQueryChange: (value: string) => void;
	placeholder: string;
}) {
	const ref = React.useRef<HTMLInputElement>(null);

	// The popup mounts fresh on each open, so this component's lifetime is one
	// open session: focus the box on open and reset the query when it closes.
	React.useEffect(() => {
		const id = requestAnimationFrame(() => ref.current?.focus());
		return () => {
			cancelAnimationFrame(id);
			onQueryChange("");
		};
	}, [onQueryChange]);

	return (
		<div className="sticky top-0 z-10 bg-muted/90 p-1 backdrop-blur-2xl">
			<div className="relative">
				<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					className="h-8 rounded-2xl border-transparent bg-input/50 pl-8 text-sm"
					onChange={(e) => onQueryChange(e.target.value)}
					// Keep letters/typing out of the Select's built-in typeahead, but let
					// Escape close and the arrow keys move focus into the list.
					onKeyDown={(e) => {
						if (
							e.key !== "Escape" &&
							e.key !== "ArrowDown" &&
							e.key !== "ArrowUp"
						) {
							e.stopPropagation();
						}
					}}
					placeholder={placeholder}
					ref={ref}
					spellCheck={false}
					value={query}
				/>
			</div>
		</div>
	);
}

function SelectLabel({
	className,
	...props
}: SelectPrimitive.GroupLabel.Props) {
	return (
		<SelectPrimitive.GroupLabel
			className={cn("px-1.5 py-1.5 text-muted-foreground text-xs", className)}
			data-slot="select-label"
			{...props}
		/>
	);
}

function SelectItem({
	className,
	children,
	textValue,
	...props
}: SelectPrimitive.Item.Props & {
	/** Text a searchable SelectContent filters on. Falls back to string children. */
	textValue?: string;
}) {
	const query = React.useContext(SelectFilterContext);
	// Only hide when there is an active query AND we have text to match against;
	// items with non-string children and no textValue stay visible (unfilterable).
	const haystack =
		textValue ?? (typeof children === "string" ? children : undefined);
	const hidden = Boolean(
		query && haystack && !haystack.toLowerCase().includes(query)
	);
	return (
		<SelectPrimitive.Item
			className={cn(
				"relative flex w-full cursor-default select-none items-center gap-1.5 rounded-2xl py-1 pr-8 pl-1.5 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
				hidden && "hidden",
				className
			)}
			data-slot="select-item"
			{...props}
		>
			<SelectPrimitive.ItemText className="flex flex-1 shrink-0 gap-2 whitespace-nowrap">
				{children}
			</SelectPrimitive.ItemText>
			<SelectPrimitive.ItemIndicator
				render={
					<span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
				}
			>
				<HugeiconsIcon
					className="pointer-events-none"
					icon={Tick02Icon}
					strokeWidth={2}
				/>
			</SelectPrimitive.ItemIndicator>
		</SelectPrimitive.Item>
	);
}

function SelectSeparator({
	className,
	...props
}: SelectPrimitive.Separator.Props) {
	return (
		<SelectPrimitive.Separator
			className={cn("pointer-events-none -mx-1 my-1 h-px bg-border", className)}
			data-slot="select-separator"
			{...props}
		/>
	);
}

function SelectScrollUpButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
	return (
		<SelectPrimitive.ScrollUpArrow
			className={cn(
				"top-0 z-10 flex w-full cursor-default items-center justify-center bg-muted/90 py-1 [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			data-slot="select-scroll-up-button"
			{...props}
		>
			<HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
		</SelectPrimitive.ScrollUpArrow>
	);
}

function SelectScrollDownButton({
	className,
	...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
	return (
		<SelectPrimitive.ScrollDownArrow
			className={cn(
				"bottom-0 z-10 flex w-full cursor-default items-center justify-center bg-muted/90 py-1 [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			data-slot="select-scroll-down-button"
			{...props}
		>
			<HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
		</SelectPrimitive.ScrollDownArrow>
	);
}

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
};
