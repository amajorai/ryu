"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Table({
	className,
	size = "default",
	...props
}: React.ComponentProps<"table"> & { size?: "default" | "compact" }) {
	return (
		<div
			className="relative w-full overflow-x-auto"
			data-slot="table-container"
		>
			<table
				className={cn(
					"w-full caption-bottom in-data-[slot=frame]:border-separate in-data-[slot=frame]:border-spacing-0 text-sm",
					size === "compact" && "text-xs",
					className
				)}
				data-slot="table"
				{...props}
			/>
		</div>
	);
}

function TableHeader({
	className,
	appearance = "default",
	...props
}: React.ComponentProps<"thead"> & {
	appearance?: "default" | "record" | "widget";
}) {
	return (
		<thead
			className={cn(
				"[&_tr]:border-b in-data-[slot=frame]:**:[th]:h-9 in-data-[slot=frame]:*:[tr]:border-none in-data-[slot=frame]:*:[tr]:hover:bg-transparent",
				appearance === "record" && "bg-card",
				appearance === "widget" && "bg-muted/40 backdrop-blur-sm",
				className
			)}
			data-slot="table-header"
			{...props}
		/>
	);
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
	return (
		<tbody
			className={cn(
				"in-data-[slot=frame]:corner-squircle before:corner-squircle in-data-[slot=frame]:*:[tr]:first:*:[td]:first:corner-ss-squircle in-data-[slot=frame]:*:[tr]:last:*:[td]:last:corner-ee-squircle in-data-[slot=frame]:*:[tr]:first:*:[td]:last:corner-se-squircle in-data-[slot=frame]:*:[tr]:last:*:[td]:first:corner-es-squircle relative in-data-[slot=frame]:rounded-xl in-data-[slot=frame]:shadow-xs/5 before:pointer-events-none before:absolute before:inset-px not-in-data-[slot=frame]:before:hidden before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/8%)] [&_tr:last-child]:border-0 in-data-[slot=frame]:*:[tr]:border-0 in-data-[slot=frame]:*:[tr]:*:[td]:border-b in-data-[slot=frame]:*:[tr]:*:[td]:bg-background in-data-[slot=frame]:*:[tr]:*:[td]:bg-clip-padding in-data-[slot=frame]:*:[tr]:first:*:[td]:first:rounded-ss-xl in-data-[slot=frame]:*:[tr]:*:[td]:first:border-s in-data-[slot=frame]:*:[tr]:first:*:[td]:border-t in-data-[slot=frame]:*:[tr]:last:*:[td]:last:rounded-ee-xl in-data-[slot=frame]:*:[tr]:*:[td]:last:border-e in-data-[slot=frame]:*:[tr]:first:*:[td]:last:rounded-se-xl in-data-[slot=frame]:*:[tr]:last:*:[td]:first:rounded-es-xl in-data-[slot=frame]:*:[tr]:hover:*:[td]:bg-transparent in-data-[slot=frame]:*:[tr]:data-[state=selected]:*:[td]:bg-muted/72",
				className
			)}
			data-slot="table-body"
			{...props}
		/>
	);
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
	return (
		<tfoot
			className={cn(
				"border-t in-data-[slot=frame]:border-none bg-muted/50 in-data-[slot=frame]:bg-transparent font-medium [&>tr]:last:border-b-0 in-data-[slot=frame]:*:[tr]:hover:bg-transparent",
				className
			)}
			data-slot="table-footer"
			{...props}
		/>
	);
}

function TableRow({
	className,
	appearance = "default",
	...props
}: React.ComponentProps<"tr"> & { appearance?: "default" | "header" }) {
	return (
		<tr
			className={cn(
				"border-b transition-colors hover:bg-muted/50 in-data-[slot=frame]:hover:bg-transparent has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted in-data-[slot=frame]:data-[state=selected]:bg-transparent",
				appearance === "header" && "hover:bg-transparent",
				className
			)}
			data-slot="table-row"
			{...props}
		/>
	);
}

function TableHead({
	className,
	presentation = "default",
	inset = "default",
	size = "default",
	...props
}: React.ComponentProps<"th"> & {
	presentation?: "default" | "file-label" | "permission" | "widget-label";
	inset?: "default" | "wide" | "end";
	size?: "default" | "compact";
}) {
	return (
		<th
			className={cn(
				"h-12 whitespace-nowrap in-data-[slot=frame]:px-2.5 px-3 text-left align-middle font-medium in-data-[slot=frame]:text-muted-foreground text-foreground in-data-[slot=frame]:leading-none [&:has([role=checkbox])]:pr-0",
				presentation === "permission" && "bg-background",
				presentation === "widget-label" &&
					"type-caption font-medium text-muted-foreground uppercase tracking-wide",
				presentation === "file-label" &&
					"type-compact h-10 uppercase tracking-table-label",
				inset === "wide" && "px-6",
				inset === "end" && "pr-6",
				size === "compact" && "h-8 px-2 text-xs",
				className
			)}
			data-slot="table-head"
			{...props}
		/>
	);
}

function TableCell({
	className,
	presentation = "default",
	inset = "default",
	overflow = "default",
	spacing = "default",
	...props
}: React.ComponentProps<"td"> & {
	presentation?:
		| "default"
		| "metadata"
		| "numeric-metadata"
		| "numeric"
		| "monospace-numeric"
		| "muted"
		| "monospace"
		| "row-header"
		| "empty"
		| "record-empty"
		| "permission"
		| "usage-time"
		| "usage-organization"
		| "usage-model"
		| "usage-provider"
		| "usage-counter"
		| "usage-credit"
		| "usage-debit"
		| "usage-balance";
	overflow?: "default" | "truncate";
	inset?: "default" | "wide" | "end";
	spacing?: "default" | "compact";
}) {
	return (
		<td
			className={cn(
				"whitespace-nowrap in-data-[slot=frame]:p-2.5 p-3 align-middle in-data-[slot=frame]:leading-none in-data-[slot=frame]:first:p-[calc(--spacing(2.5)-1px)] in-data-[slot=frame]:last:p-[calc(--spacing(2.5)-1px)] [&:has([role=checkbox])]:pr-0",
				(presentation === "metadata" || presentation === "numeric-metadata") &&
					"text-muted-foreground text-xs",
				presentation === "numeric-metadata" && "font-mono",
				presentation === "monospace" && "font-mono text-xs",
				presentation === "numeric" && "tabular-nums",
				presentation === "monospace-numeric" && "font-mono tabular-nums",
				presentation === "muted" && "text-muted-foreground",
				presentation === "row-header" && "font-medium",
				overflow === "truncate" && "truncate",
				presentation === "empty" && "py-10 text-center text-muted-foreground",
				presentation === "record-empty" &&
					"py-10 text-center text-muted-foreground text-sm",
				presentation === "permission" &&
					"bg-background font-mono text-muted-foreground text-xs",
				inset === "wide" && "px-6",
				inset === "end" && "pr-6",
				spacing === "compact" && "p-2",
				presentation === "usage-time" &&
					"whitespace-nowrap text-muted-foreground text-xs",
				presentation === "usage-organization" &&
					"max-w-[14rem] truncate text-xs",
				presentation === "usage-model" && "max-w-[16rem] truncate text-xs",
				presentation === "usage-provider" && "text-xs",
				presentation === "usage-counter" && "text-right text-xs tabular-nums",
				presentation === "usage-credit" &&
					"text-right font-mono text-status-success tabular-nums",
				presentation === "usage-debit" && "text-right font-mono tabular-nums",
				presentation === "usage-balance" &&
					"text-right font-mono text-muted-foreground text-xs tabular-nums",
				className
			)}
			data-slot="table-cell"
			{...props}
		/>
	);
}

function TableCaption({
	className,
	...props
}: React.ComponentProps<"caption">) {
	return (
		<caption
			className={cn(
				"in-data-[slot=frame]:my-4 mt-4 text-muted-foreground text-sm",
				className
			)}
			data-slot="table-caption"
			{...props}
		/>
	);
}

export {
	Table,
	TableBody,
	TableCaption,
	TableCell,
	TableFooter,
	TableHead,
	TableHeader,
	TableRow,
};
