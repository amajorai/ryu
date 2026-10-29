"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";

function Empty({
	className,
	spacing = "default",
	appearance = "default",
	inset = "default",
	purpose = "default",
	...props
}: React.ComponentProps<"div"> & {
	spacing?: "default" | "compact" | "comfortable" | "snug" | "spacious";
	appearance?: "default" | "bordered" | "standalone";
	purpose?: "default" | "recovery" | "terminal" | "calendar";
	inset?: "default" | "compact" | "dense";
}) {
	return (
		<div
			className={cn(
				"flex w-full min-w-0 flex-1 flex-col items-center justify-center gap-4 text-balance rounded-2xl border-dashed p-12 text-center",
				spacing === "compact" && "py-8",
				appearance === "bordered" && "border border-dashed py-12",
				inset === "compact" && "p-8",
				inset === "dense" && "p-6",
				spacing === "comfortable" && "py-10",
				spacing === "snug" && "py-6",
				spacing === "spacious" && "py-16",
				appearance === "standalone" && "bg-background",
				purpose === "recovery" && "gap-3 p-8",
				purpose === "terminal" && "gap-5 p-8",
				purpose === "calendar" && "pb-24",
				className
			)}
			data-slot="empty"
			{...props}
		/>
	);
}

function EmptyHeader({
	className,
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & { spacing?: "default" | "relaxed" }) {
	return (
		<div
			className={cn(
				"flex max-w-sm flex-col items-center gap-2",
				spacing === "relaxed" && "gap-3",
				className
			)}
			data-slot="empty-header"
			{...props}
		/>
	);
}

const emptyMediaVariants = cva(
	"mb-2 flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		variants: {
			variant: {
				default: "bg-transparent",
				icon: "flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground [&_svg:not([class*='size-'])]:size-5",
			},
			tone: { default: "", destructive: "text-status-destructive" },
		},
		defaultVariants: {
			variant: "default",
		},
	}
);

function EmptyMedia({
	className,
	variant = "default",
	tone = "default",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof emptyMediaVariants>) {
	return (
		<div
			className={cn(emptyMediaVariants({ variant, tone, className }))}
			data-slot="empty-icon"
			data-variant={variant}
			{...props}
		/>
	);
}

function EmptyTitle({
	children,
	className,
	...props
}: React.ComponentProps<"div">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"font-heading font-medium text-lg tracking-tight",
				className
			)}
			data-slot="empty-title"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function EmptyDescription({
	children,
	className,
	...props
}: React.ComponentProps<"p">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"text-muted-foreground text-sm/relaxed [&>a:hover]:text-primary [&>a]:underline [&>a]:underline-offset-4",
				className
			)}
			data-slot="empty-description"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function EmptyContent({
	className,
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & { spacing?: "default" | "compact" }) {
	return (
		<div
			className={cn(
				"flex w-full min-w-0 max-w-sm flex-col items-center gap-4 text-balance text-sm",
				spacing === "compact" && "gap-2",
				className
			)}
			data-slot="empty-content"
			{...props}
		/>
	);
}

export {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
};
