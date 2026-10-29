import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Frame({
	className,
	padding = "default",
	...props
}: React.ComponentProps<"div"> & { padding?: "default" | "horizontal" }) {
	return (
		<div
			className={cn(
				"corner-squircle relative flex flex-col rounded-2xl bg-muted/72 p-1",
				"*:[[data-slot=frame-panel]+[data-slot=frame-panel]]:mt-1",
				padding === "horizontal" && "py-0",
				className
			)}
			data-slot="frame"
			{...props}
		/>
	);
}

function FramePanel({
	className,
	padding = "default",
	...props
}: React.ComponentProps<"div"> & { padding?: "default" | "none" }) {
	return (
		<div
			className={cn(
				"corner-squircle before:corner-squircle relative rounded-xl border bg-background bg-clip-padding p-5 shadow-xs/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
				padding === "none" && "p-0",
				className
			)}
			data-slot="frame-panel"
			{...props}
		/>
	);
}

function FrameHeader({ className, ...props }: React.ComponentProps<"header">) {
	return (
		<header
			className={cn("flex flex-col px-5 py-4", className)}
			data-slot="frame-panel-header"
			{...props}
		/>
	);
}

function FrameTitle({
	children,
	className,
	...props
}: React.ComponentProps<"div">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn("font-medium text-sm", className)}
			data-slot="frame-panel-title"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function FrameDescription({
	children,
	className,
	...props
}: React.ComponentProps<"div">) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<div
			className={cn("text-muted-foreground text-sm", className)}
			data-slot="frame-panel-description"
			{...props}
		>
			{localizedChildren}
		</div>
	);
}

function FrameFooter({ className, ...props }: React.ComponentProps<"footer">) {
	return (
		<footer
			className={cn("px-5 py-4", className)}
			data-slot="frame-panel-footer"
			{...props}
		/>
	);
}

export {
	Frame,
	FrameDescription,
	FrameFooter,
	FrameHeader,
	FramePanel,
	FrameTitle,
};
