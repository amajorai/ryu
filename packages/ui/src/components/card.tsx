"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Card({
	appearance = "default",
	borderTone = "default",
	elevation = "default",
	inset = "default",
	layout = "default",
	interaction,
	motionEnabled = true,
	status = "default",
	className,
	size = "default",
	...props
}: React.ComponentProps<"div"> & {
	appearance?:
		| "default"
		| "glass"
		| "island"
		| "translucent"
		| "subtle"
		| "analytics"
		| "promotion"
		| "testimonial"
		| "usage-provider"
		| "dream-highlight"
		| "library"
		| "onboarding"
		| "onboarding-setup"
		| "onboarding-success"
		| "memory-source"
		| "publisher-health"
		| "dashboard-widget"
		| "database-row";
	interaction?: "drag" | "resize";
	motionEnabled?: boolean;
	size?: "default" | "sm";
	borderTone?: "default" | "transparent" | "included" | "subtle" | "muted";
	elevation?: "default" | "flat";
	inset?: "default" | "none" | "compact" | "comfortable" | "generous";
	layout?: "default" | "metric" | "breakdown" | "controls";
	status?: "default" | "empty" | "error";
}) {
	return (
		<div
			className={cn(
				"group/card corner-squircle *:[img:first-child]:corner-t-squircle *:[img:last-child]:corner-b-squircle flex flex-col gap-(--card-spacing) overflow-hidden bg-card py-(--card-spacing) text-card-foreground text-sm [--card-spacing:var(--card-pad,calc(var(--spacing)*4))] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:var(--card-pad-sm,calc(var(--spacing)*3))] *:[img:first-child]:rounded-t-4xl *:[img:last-child]:rounded-b-4xl",
				borderTone === "transparent" && "border-transparent",
				borderTone === "included" && "border-primary",
				borderTone === "subtle" && "border-border/60",
				borderTone === "muted" && "border-border/70",
				elevation === "flat" && "shadow-none",
				inset === "none" && "p-0",
				appearance === "promotion" && "border-primary/30 bg-primary/5",
				appearance !== "island" && "rounded-4xl",
				appearance === "translucent" && "bg-card/80",
				appearance === "analytics" &&
					"border border-border/60 bg-card/80 shadow-sm",
				appearance === "subtle" && "bg-muted/55",
				appearance === "library" &&
					"gap-0 py-0 transition-colors hover:bg-muted/40",
				appearance === "glass" &&
					"border-0 bg-transparent text-glass-content shadow-none ring-0",
				appearance === "island" &&
					"gap-0 rounded-inherit border-0 bg-transparent p-0 text-foreground shadow-none ring-0",
				appearance === "testimonial" &&
					"rounded-3xl border border-border/60 p-8 shadow-sm md:p-12",
				layout === "metric" && "gap-1",
				layout === "breakdown" && "gap-3",
				layout === "controls" && "gap-4",
				inset === "compact" && "p-4",
				inset === "comfortable" && "p-5",
				inset === "generous" && "p-6",
				appearance === "usage-provider" &&
					"border border-border/50 bg-background/40",
				appearance === "dream-highlight" && "border-primary/20 bg-primary/5",
				appearance === "onboarding" && "border",
				appearance === "onboarding-setup" && "border-0",
				appearance === "onboarding-success" && "border border-success/30",
				appearance === "memory-source" && "border bg-muted/20",
				appearance === "publisher-health" && "bg-muted/20",
				appearance === "dashboard-widget" &&
					"gap-0 rounded-2xl border-border/60 py-0 shadow-sm transition-[transform,box-shadow,opacity,ring-color] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:shadow-md",
				appearance === "dashboard-widget" &&
					motionEnabled &&
					interaction === "drag" &&
					"-translate-y-px scale-[1.015] shadow-xl ring-2 ring-primary/25",
				appearance === "dashboard-widget" &&
					motionEnabled &&
					interaction === "resize" &&
					"ring-2 ring-primary/25",
				appearance === "database-row" &&
					"gap-2 p-3 shadow-sm transition-shadow hover:shadow-md",
				appearance === "database-row" && interaction === "drag" && "opacity-50",
				status === "empty" && "p-8 text-muted-foreground text-sm",
				status === "error" &&
					"border-destructive p-4 text-sm text-status-destructive",
				className
			)}
			data-size={size}
			data-slot="card"
			{...props}
		/>
	);
}

function CardHeader({
	className,
	appearance = "default",
	spacing = "default",
	layout = "default",
	inset = "default",
	...props
}: React.ComponentProps<"div"> & {
	spacing?: "default" | "compact" | "metric" | "chart";
	layout?: "default" | "summary" | "library-row";
	appearance?: "default" | "dream-proposal" | "bot-entry" | "message-review";
	inset?: "default" | "compact" | "chart" | "summary" | "provider";
}) {
	return (
		<div
			className={cn(
				"group/card-header @container/card-header corner-t-squircle grid auto-rows-min items-start gap-1.5 rounded-t-4xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
				inset === "compact" && "p-4",
				inset === "chart" && "p-4 pb-2",
				inset === "summary" && "p-4 pb-3",
				inset === "provider" && "p-3 pb-2",
				spacing === "compact" && "pb-3",
				spacing === "metric" && "gap-2",
				spacing === "chart" && "gap-3",
				layout === "summary" &&
					"flex flex-row items-start justify-between gap-4",
				layout === "library-row" &&
					"flex flex-row items-center justify-between px-4 py-3",
				appearance === "bot-entry" && "items-center gap-4 text-center",
				appearance === "message-review" && "border-border/60 border-b py-4",
				appearance === "dream-proposal" &&
					"gap-3 border-border/60 border-b pb-4",
				className
			)}
			data-slot="card-header"
			{...props}
		/>
	);
}

function CardTitle({
	children,
	className,
	variant = "default",
	layout = "default",
	truncate = false,
	...props
}: React.ComponentProps<"div"> & {
	variant?:
		| "default"
		| "metric"
		| "metric-label"
		| "section"
		| "statistic"
		| "plan"
		| "subsection";
	layout?: "default" | "badge-row";
	truncate?: boolean;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"font-heading font-medium text-base",
				variant === "metric" && "text-3xl tabular-nums",
				variant === "plan" && "text-xl",
				variant === "subsection" && "text-lg",
				layout === "badge-row" && "flex items-center gap-2",
				variant === "statistic" && "font-medium text-2xl tabular-nums",
				variant === "section" && "text-sm",
				variant === "metric-label" && "text-muted-foreground text-xs",
				truncate && "truncate",
				className
			)}
			data-slot="card-title"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function CardDescription({
	children,
	className,
	layout = "default",
	...props
}: React.ComponentProps<"div"> & { layout?: "default" | "legend" }) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn(
				"text-muted-foreground text-sm",
				layout === "legend" && "flex items-center gap-2",
				className
			)}
			data-slot="card-description"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"col-start-2 row-span-2 row-start-1 self-start justify-self-end",
				className
			)}
			data-slot="card-action"
			{...props}
		/>
	);
}

function CardContent({
	className,
	topSpacing = "default",
	verticalInset = "default",
	separators = "default",
	typography,
	inset = "default",
	status = "default",
	layout = "default",
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & {
	spacing?:
		| "default"
		| "compact"
		| "relaxed"
		| "generous"
		| "comfortable"
		| "spacious";
	inset?:
		| "default"
		| "none"
		| "account-list"
		| "compact"
		| "chart"
		| "provider"
		| "comfortable"
		| "widget"
		| "bot-entry";
	status?: "default" | "error" | "loading" | "muted";
	typography?: "body";
	verticalInset?: "default" | "comfortable" | "generous";
	separators?: "default" | "rows";
	layout?:
		| "default"
		| "stack"
		| "spaced-stack"
		| "actions"
		| "summary-actions"
		| "dense-stack"
		| "analytics-grid"
		| "library-body"
		| "signal-grid"
		| "reflection-summary"
		| "memory-actions";
	topSpacing?: "default" | "flush" | "comfortable" | "generous";
}) {
	return (
		<div
			className={cn(
				"px-(--card-spacing)",
				verticalInset === "comfortable" && "py-5",
				verticalInset === "generous" && "py-6",
				separators === "rows" && "divide-y divide-border",
				layout === "stack" && "flex flex-col gap-3",
				layout === "summary-actions" &&
					"flex flex-wrap items-center justify-between gap-4",
				layout === "dense-stack" && "flex flex-col gap-2",
				layout === "analytics-grid" && "grid gap-3 sm:grid-cols-2",
				layout === "reflection-summary" &&
					"flex items-start justify-between gap-3",
				layout === "memory-actions" && "flex flex-wrap items-center gap-2",
				inset === "widget" && "p-3",
				inset === "bot-entry" && "flex justify-center px-6 pb-6",
				inset === "compact" && "p-4",
				inset === "chart" && "p-4 pt-2",
				inset === "provider" && "p-3 pt-0",
				inset === "comfortable" && "p-5",
				inset === "none" && "p-0",
				inset === "account-list" && "p-0 py-2",
				status === "error" && "py-8 text-muted-foreground text-sm",
				status === "loading" && "py-12",
				status === "muted" && "text-muted-foreground text-sm",
				typography === "body" && "text-sm",
				spacing === "comfortable" && "space-y-3",
				spacing === "spacious" && "space-y-6",
				layout === "actions" && "flex gap-2",
				layout === "library-body" && "flex flex-col gap-2 px-4 pb-3",
				layout === "signal-grid" && "grid gap-2",
				layout === "spaced-stack" && "flex flex-col gap-4",
				topSpacing === "flush" && "pt-0",
				topSpacing === "comfortable" && "pt-4",
				topSpacing === "generous" && "pt-5",
				spacing === "compact" && "space-y-2",
				spacing === "relaxed" && "space-y-4",
				spacing === "generous" && "space-y-5",
				className
			)}
			data-slot="card-content"
			{...props}
		/>
	);
}

function CardFooter({
	className,
	spacing = "default",
	appearance = "default",
	...props
}: React.ComponentProps<"div"> & {
	spacing?: "default" | "actions" | "choices";
	appearance?: "default" | "exchange-actions" | "onboarding-step" | "bot-entry";
}) {
	return (
		<div
			className={cn(
				"corner-b-squircle flex items-center rounded-b-4xl px-(--card-spacing) [.border-t]:pt-(--card-spacing)",
				spacing === "actions" && "gap-2",
				spacing === "choices" && "gap-3",
				appearance === "onboarding-step" && "border-t",
				appearance === "bot-entry" && "border-border/60 border-t px-6 py-4",
				appearance === "exchange-actions" &&
					"flex flex-wrap gap-3 border-border/50 border-t pt-4",
				className
			)}
			data-slot="card-footer"
			{...props}
		/>
	);
}

export {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
};
