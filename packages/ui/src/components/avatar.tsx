"use client";

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Avatar({
	className,
	appearance,
	framing = "default",
	size = "default",
	...props
}: AvatarPrimitive.Root.Props & {
	size?: "default" | "xs" | "sm" | "lg";
	framing?: "default" | "profile-overlap";
	appearance?: "message-reader";
}) {
	return (
		<AvatarPrimitive.Root
			className={cn(
				"group/avatar relative flex size-8 shrink-0 select-none rounded-full before:absolute before:inset-0 before:rounded-full before:border before:border-border before:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 data-[size=xs]:size-3.5 dark:before:mix-blend-lighten",
				framing === "profile-overlap" && "ring-4 ring-card",
				appearance === "message-reader" && "size-5 ring-2 ring-background",
				className
			)}
			data-size={size}
			data-slot="avatar"
			{...props}
		/>
	);
}

function AvatarImage({
	className,
	src,
	...props
}: AvatarPrimitive.Image.Props) {
	return (
		<AvatarPrimitive.Image
			className={cn(
				"aspect-square size-full rounded-full object-cover",
				className
			)}
			data-slot="avatar-image"
			{...props}
			src={safeMediaUrl(src) ?? undefined}
		/>
	);
}

function AvatarFallback({
	className,
	typography,
	appearance = "default",
	...props
}: AvatarPrimitive.Fallback.Props & {
	appearance?: "default" | "artwork" | "primary";
	typography?: "tiny" | "large";
}) {
	return (
		<AvatarPrimitive.Fallback
			className={cn(
				"group-data-[size=xs]/avatar:type-tiny flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground text-sm group-data-[size=sm]/avatar:text-xs group-data-[size=xs]/avatar:leading-[inherit]",
				appearance === "artwork" && "bg-transparent p-0",
				typography === "tiny" && "type-tiny",
				typography === "large" && "text-lg",
				appearance === "primary" && "bg-primary text-primary-foreground",
				className
			)}
			data-slot="avatar-fallback"
			{...props}
		/>
	);
}

function AvatarBadge({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"absolute right-0 bottom-0 inline-flex select-none items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background",
				"group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
				"group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
				"group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
				className
			)}
			data-slot="avatar-badge"
			{...props}
		/>
	);
}

function AvatarGroup({
	className,
	spacing,
	...props
}: React.ComponentProps<"div"> & {
	spacing?: "message-readers" | "agent-recipients";
}) {
	return (
		<div
			className={cn(
				"group/avatar-group flex -space-x-2 has-data-[size=sm]:-space-x-1.5",
				spacing === "message-readers" && "-space-x-1",
				spacing === "agent-recipients" && "-space-x-1",
				className
			)}
			data-slot="avatar-group"
			{...props}
		/>
	);
}

function AvatarGroupCount({
	className,
	purpose,
	...props
}: React.ComponentProps<"div"> & { purpose?: "message-readers" }) {
	return (
		<div
			className={cn(
				"relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground text-sm group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
				purpose === "message-readers" && "type-micro size-5",
				className
			)}
			data-slot="avatar-group-count"
			{...props}
		/>
	);
}

export {
	Avatar,
	AvatarBadge,
	AvatarFallback,
	AvatarGroup,
	AvatarGroupCount,
	AvatarImage,
};
