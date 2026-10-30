"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { useLocalizedText } from "@ryu/i18n/react";
import { Separator } from "@ryu/ui/components/separator.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

function ItemGroup({
	className,
	spacing = "default",
	appearance = "default",
	variant = "default",
	...props
}: React.ComponentProps<"div"> & {
	spacing?: "default" | "flush";
	appearance?: "default" | "settings-group" | "hardware-summary";
	/**
	 * `flush` is the quiet list: no fill, no radius, rows separated by
	 * full-width `border-border` hairlines (none after the last row). It wins
	 * over any `appearance`, and replaces `ItemSeparator`s, which it hides.
	 */
	variant?: "default" | "flush";
}) {
	return (
		<div
			className={cn(
				"group/item-group flex w-full flex-col gap-4 has-data-[size=sm]:gap-2.5 has-data-[size=xs]:gap-2",
				spacing === "flush" && "gap-0",
				// iOS/macOS grouped table: a rounded card on `--grouped-card` (raised
				// to the card surface inside a `grouped-pane`), with inset hairlines —
				// they start where the row's text starts (past an icon tile) and stop
				// short of the trailing edge, never touching the card's sides.
				appearance === "settings-group" &&
					"rounded-xl bg-grouped-card shadow-none has-data-[size=sm]:gap-0 has-data-[size=xs]:gap-0 [&>[data-slot=item-separator]:has(+*_[data-slot=settings-icon-tile])]:ms-12 [&>[data-slot=item-separator]]:ms-3.5 [&>[data-slot=item-separator]]:me-3.5 [&>[data-slot=item-separator]]:w-auto!",
				appearance === "hardware-summary" &&
					"rounded-lg bg-muted/50 shadow-none",
				variant === "flush" &&
					"gap-0 rounded-none bg-transparent shadow-none has-data-[size=sm]:gap-0 has-data-[size=xs]:gap-0 [&>*:last-child]:border-b-0 [&>*:not(:last-child)]:border-b [&>*:not(:last-child)]:border-b-border [&>[data-slot=item-separator]]:hidden [&>[data-slot=item]]:rounded-none [&>[data-slot=item]]:border-x-0 [&>[data-slot=item]]:border-t-0",
				className
			)}
			data-slot="item-group"
			data-variant={variant === "flush" ? variant : undefined}
			role="list"
			{...props}
		/>
	);
}

function ItemSeparator({
	className,
	...props
}: React.ComponentProps<typeof Separator>) {
	return (
		<Separator
			className={cn("my-2", className)}
			data-slot="item-separator"
			orientation="horizontal"
			{...props}
		/>
	);
}

const itemVariants = cva(
	"group/item flex w-full flex-wrap items-center rounded-2xl border text-sm outline-none transition-colors duration-(--duration-fast) hover:duration-0 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring [a]:transition-colors [a]:hover:bg-muted",
	{
		variants: {
			variant: {
				default: "border-transparent",
				outline: "border-border",
				muted: "border-transparent bg-muted/50",
			},
			size: {
				default: "gap-3.5 px-4 py-3.5",
				sm: "gap-3.5 px-3.5 py-3",
				xs: "gap-2.5 in-data-[slot=dropdown-menu-content]:p-0 px-3 py-2.5",
			},
			purpose: {
				// 44px rows, as in Apple's Settings. A row placed straight in a
				// section (no `SettingsGroup`) still gets its own grouped card, so no
				// settings row floats card-less on the grouped background.
				//
				// Inside a `variant="flush"` group the row drops its card inset: a
				// 48px row with no side padding, set off only by the group hairline.
				"settings-row":
					"min-h-11 flex-col items-stretch justify-center gap-2 not-in-data-[slot=item-group]:rounded-xl rounded-none border-0 not-in-data-[slot=item-group]:bg-grouped-card px-3.5 py-2.5 group-data-[variant=flush]/item-group:min-h-12 group-data-[variant=flush]/item-group:px-0 group-data-[variant=flush]/item-group:py-3",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	}
);

function Item({
	className,
	purpose,
	variant = "default",
	size = "default",
	render,
	...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
	return useRender({
		defaultTagName: "div",
		props: mergeProps<"div">(
			{
				className: cn(itemVariants({ variant, size, purpose, className })),
			},
			props
		),
		render,
		state: {
			slot: "item",
			variant,
			size,
		},
	});
}

const itemMediaVariants = cva(
	"flex shrink-0 items-center justify-center gap-2 group-has-data-[slot=item-description]/item:translate-y-0.5 group-has-data-[slot=item-description]/item:self-start [&_svg]:pointer-events-none",
	{
		variants: {
			variant: {
				default: "bg-transparent",
				icon: "[&_svg:not([class*='size-'])]:size-4",
				image:
					"size-10 overflow-hidden rounded-xl group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 group-data-[size=xs]/item:rounded-lg [&_img]:size-full [&_img]:object-cover",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

function ItemMedia({
	className,
	variant = "default",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
	return (
		<div
			className={cn(itemMediaVariants({ variant, className }))}
			data-slot="item-media"
			data-variant={variant}
			{...props}
		/>
	);
}

function ItemContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex flex-1 flex-col gap-1 group-data-[size=xs]/item:gap-0.5 [&+[data-slot=item-content]]:flex-none",
				className
			)}
			data-slot="item-content"
			{...props}
		/>
	);
}

function ItemTitle({
	children,
	className,
	tone,
	typography,
	...props
}: React.ComponentProps<"div"> & {
	tone?: "destructive";
	typography?: "settings-label";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"line-clamp-1 flex w-fit items-center gap-2 font-medium text-sm leading-snug underline-offset-4",
				tone === "destructive" && "text-status-destructive",
				// Apple's Settings labels are regular weight; emphasis comes from
				// section headers and values, not from every row title.
				typography === "settings-label" && "font-normal text-sm",
				className
			)}
			data-slot="item-title"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function ItemDescription({
	children,
	className,
	...props
}: React.ComponentProps<"p">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<p
			className={cn(
				"line-clamp-2 text-left font-normal text-muted-foreground text-sm [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
				className
			)}
			data-slot="item-description"
			{...props}
		>
			{localizedChildren}
		</p>
	);
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex items-center gap-2", className)}
			data-slot="item-actions"
			{...props}
		/>
	);
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex basis-full items-center justify-between gap-2",
				className
			)}
			data-slot="item-header"
			{...props}
		/>
	);
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"flex basis-full items-center justify-between gap-2",
				className
			)}
			data-slot="item-footer"
			{...props}
		/>
	);
}

export {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemFooter,
	ItemGroup,
	ItemHeader,
	ItemMedia,
	ItemSeparator,
	ItemTitle,
};
