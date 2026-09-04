"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { I18nText, useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

const MOBILE_DRAWER_CONTENT_CLASSES =
	"max-sm:!inset-x-0 max-sm:!top-auto max-sm:!bottom-0 max-sm:!left-0 max-sm:!w-full max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-t-4xl max-sm:!rounded-b-none max-sm:!max-h-[calc(100dvh-0.5rem)] max-sm:!overflow-y-auto max-sm:data-open:slide-in-from-bottom-4 max-sm:data-closed:slide-out-to-bottom-4 max-sm:data-open:zoom-in-100 max-sm:data-closed:zoom-out-100";

const MOBILE_FULL_PAGE_CONTENT_CLASSES =
	"max-sm:!inset-0 max-sm:!top-0 max-sm:!bottom-auto max-sm:!left-0 max-sm:!h-dvh max-sm:!max-h-dvh max-sm:!w-screen max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-none max-sm:!overflow-hidden max-sm:data-open:fade-in-0 max-sm:data-closed:fade-out-0";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
	return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
	className,
	...props
}: DialogPrimitive.Backdrop.Props) {
	return (
		<DialogPrimitive.Backdrop
			className={cn(
				"ryu-dialog-overlay data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 isolate z-50 rounded-[var(--ryu-window-radius,0px)] duration-(--modal-open-dur) ease-(--modal-ease) data-closed:animate-out data-open:animate-in data-closed:duration-(--modal-close-dur)",
				className
			)}
			data-slot="dialog-overlay"
			{...props}
		/>
	);
}

function DialogContent({
	className,
	overlayClassName,
	children,
	mobileFullPage = false,
	showCloseButton = true,
	...props
}: DialogPrimitive.Popup.Props & {
	mobileFullPage?: boolean;
	showCloseButton?: boolean;
	overlayClassName?: string;
}) {
	return (
		<DialogPortal>
			<DialogOverlay className={overlayClassName} />
			<DialogPrimitive.Popup
				className={cn(
					"data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-4xl bg-popover/90 p-4 text-popover-foreground text-sm shadow-xl outline-none backdrop-blur-xl duration-(--modal-open-dur) ease-(--modal-ease) data-closed:animate-out data-open:animate-in data-closed:duration-(--modal-close-dur) sm:max-w-md",
					className,
					mobileFullPage
						? MOBILE_FULL_PAGE_CONTENT_CLASSES
						: MOBILE_DRAWER_CONTENT_CLASSES
				)}
				data-slot="dialog-content"
				{...props}
			>
				{mobileFullPage ? null : (
					<div
						aria-hidden="true"
						className="mx-auto mb-1 hidden h-1.5 w-16 shrink-0 rounded-full bg-muted max-sm:block"
					/>
				)}
				{children}
				{showCloseButton && (
					<DialogPrimitive.Close
						data-slot="dialog-close"
						render={
							<Button
								className="absolute top-4 right-4 bg-secondary"
								size="icon-sm"
								variant="ghost"
							/>
						}
					>
						<HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
						<span className="sr-only">Close</span>
					</DialogPrimitive.Close>
				)}
			</DialogPrimitive.Popup>
		</DialogPortal>
	);
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col gap-1.5", className)}
			data-slot="dialog-header"
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<"div"> & {
	showCloseButton?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				className
			)}
			data-slot="dialog-footer"
			{...props}
		>
			{children}
			{showCloseButton && (
				<DialogPrimitive.Close render={<Button variant="ghost" />}>
					<I18nText id="common.close" />
				</DialogPrimitive.Close>
			)}
		</div>
	);
}

function DialogTitle({
	children,
	className,
	...props
}: DialogPrimitive.Title.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<DialogPrimitive.Title
			className={cn("font-heading font-medium text-xl leading-none", className)}
			data-slot="dialog-title"
			{...props}
		>
			{localizedChildren}
		</DialogPrimitive.Title>
	);
}

function DialogDescription({
	children,
	className,
	...props
}: DialogPrimitive.Description.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<DialogPrimitive.Description
			className={cn(
				"text-muted-foreground text-sm *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
				className
			)}
			data-slot="dialog-description"
			{...props}
		>
			{localizedChildren}
		</DialogPrimitive.Description>
	);
}

export {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogOverlay,
	DialogPortal,
	DialogTitle,
	DialogTrigger,
};
