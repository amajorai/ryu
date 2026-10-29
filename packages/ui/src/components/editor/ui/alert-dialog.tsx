"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import {
	AlertDialog,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogPortal,
	AlertDialogTrigger,
} from "@ryu/ui/components/alert-dialog.tsx";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";

import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

// The root, trigger, portal, and header/footer/media layout slots are the
// app-wide alert dialog's own. This editor copy keeps only the parts that
// differ: its overlay and content (fixed `duration-100` motion, logical
// `start-1/2` centering), unlocalized title and description, and the
// action/cancel slots backed by the editor Button.

const MOBILE_DRAWER_CONTENT_CLASSES =
	"max-sm:!inset-x-0 max-sm:!top-auto max-sm:!bottom-0 max-sm:!start-0 max-sm:!w-full max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-t-4xl max-sm:!corner-t-squircle max-sm:!rounded-b-none max-sm:!max-h-[calc(100dvh-0.5rem)] max-sm:!overflow-y-auto max-sm:data-open:slide-in-from-bottom-4 max-sm:data-closed:slide-out-to-bottom-4 max-sm:data-open:zoom-in-100 max-sm:data-closed:zoom-out-100";

function AlertDialogOverlay({
	className,
	...props
}: AlertDialogPrimitive.Backdrop.Props) {
	return (
		<AlertDialogPrimitive.Backdrop
			className={cn(
				"ryu-dialog-overlay data-open:fade-in-0 data-closed:fade-out-0 corner-squircle fixed inset-0 isolate z-50 rounded-[var(--ryu-window-radius,0px)] duration-100 data-closed:animate-out data-open:animate-in",
				className
			)}
			data-slot="alert-dialog-overlay"
			{...props}
		/>
	);
}

function AlertDialogContent({
	className,
	children,
	size = "default",
	...props
}: AlertDialogPrimitive.Popup.Props & {
	size?: "default" | "sm";
}) {
	const direction = useDirection();
	return (
		<AlertDialogPortal>
			<AlertDialogOverlay />
			<AlertDialogPrimitive.Popup
				className={cn(
					"group/alert-dialog-content data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 corner-squircle fixed start-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 rounded-4xl bg-popover/90 p-4 text-popover-foreground shadow-xl outline-none backdrop-blur-xl duration-100 data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-closed:animate-out data-open:animate-in data-[size=default]:sm:max-w-md rtl:translate-x-1/2",
					className,
					MOBILE_DRAWER_CONTENT_CLASSES
				)}
				data-size={size}
				data-slot="alert-dialog-content"
				{...props}
				dir={direction}
			>
				<div
					aria-hidden="true"
					className="mx-auto mb-1 hidden h-1.5 w-16 shrink-0 rounded-full bg-muted max-sm:block"
				/>
				{children}
			</AlertDialogPrimitive.Popup>
		</AlertDialogPortal>
	);
}

function AlertDialogTitle({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
	return (
		<AlertDialogPrimitive.Title
			className={cn(
				"font-medium text-lg sm:group-data-[size=default]/alert-dialog-content:group-has-data-[slot=alert-dialog-media]/alert-dialog-content:col-start-2",
				className
			)}
			data-slot="alert-dialog-title"
			{...props}
		/>
	);
}

function AlertDialogDescription({
	className,
	...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
	return (
		<AlertDialogPrimitive.Description
			className={cn(
				"text-balance text-muted-foreground text-sm md:text-pretty *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
				className
			)}
			data-slot="alert-dialog-description"
			{...props}
		/>
	);
}

function AlertDialogAction({
	className,
	...props
}: React.ComponentProps<typeof Button>) {
	return (
		<Button
			className={cn(className)}
			data-slot="alert-dialog-action"
			{...props}
		/>
	);
}

function AlertDialogCancel({
	className,
	variant = "outline",
	size = "default",
	...props
}: AlertDialogPrimitive.Close.Props &
	Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
	return (
		<AlertDialogPrimitive.Close
			className={cn(className)}
			data-slot="alert-dialog-cancel"
			render={<Button size={size} variant={variant} />}
			{...props}
		/>
	);
}

export {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogMedia,
	AlertDialogOverlay,
	AlertDialogPortal,
	AlertDialogTitle,
	AlertDialogTrigger,
};
