import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function MessageGroup({
	className,
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & { spacing?: "default" | "relaxed" }) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-2",
				spacing === "relaxed" && "gap-3",
				className
			)}
			data-slot="message-group"
			{...props}
		/>
	);
}

function Message({
	className,
	align = "start",
	...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
	return (
		<div
			className={cn(
				"group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse",
				className
			)}
			data-align={align}
			data-slot="message"
			{...props}
		/>
	);
}

function MessageAvatar({
	className,
	variant = "default",
	...props
}: React.ComponentProps<"div"> & {
	variant?: "default" | "primary" | "transparent";
}) {
	return (
		<div
			className={cn(
				"flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted group-has-data-[slot=message-footer]/message:-translate-y-8",
				variant === "primary" && "bg-primary/10 text-primary text-xs",
				variant === "transparent" && "bg-transparent",
				className
			)}
			data-slot="message-avatar"
			{...props}
		/>
	);
}

function MessageContent({
	className,
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & { spacing?: "default" | "compact" }) {
	return (
		<div
			className={cn(
				"wrap-break-word flex w-full min-w-0 flex-col gap-2.5 group-data-[align=end]/message:*:data-slot:self-end",
				spacing === "compact" && "gap-1.5",
				className
			)}
			data-slot="message-content"
			{...props}
		/>
	);
}

function MessageHeader({
	className,
	inset = "default",
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & {
	inset?: "default" | "none";
	spacing?: "default" | "relaxed";
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 max-w-full items-center px-3.5 font-medium text-muted-foreground text-xs group-has-data-[variant=ghost]/message:px-0",
				inset === "none" && "px-0",
				spacing === "relaxed" && "gap-2",
				className
			)}
			data-slot="message-header"
			{...props}
		/>
	);
}

function MessageFooter({
	className,
	inset = "default",
	spacing = "default",
	...props
}: React.ComponentProps<"div"> & {
	inset?: "default" | "none";
	spacing?: "default" | "relaxed";
}) {
	return (
		<div
			className={cn(
				"flex min-w-0 max-w-full items-center px-3.5 font-medium text-muted-foreground text-xs group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end",
				inset === "none" && "px-0",
				spacing === "relaxed" && "gap-3",
				className
			)}
			data-slot="message-footer"
			{...props}
		/>
	);
}

export {
	Message,
	MessageAvatar,
	MessageContent,
	MessageFooter,
	MessageGroup,
	MessageHeader,
};
