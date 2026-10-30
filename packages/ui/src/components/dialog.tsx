"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { I18nText, useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { cancelToastDismissal } from "@ryu/ui/lib/toast-press.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";
import { usePortalContainer } from "./portal-container.tsx";

const dialogHeaderPurpose = {
	"license-browser": "border-border/60 border-b px-6 py-5 pr-14",
	"package-install": "border-border/60 border-b px-6 py-5",
	"project-settings": "space-y-1.5 border-b px-6 py-4",
	"cloud-settings": "pe-8",
	"records-panel": "border-b px-6 py-5",
	"quick-preview": "pr-10",
	"workflow-fork": "px-2 pt-1",
	"agent-editor": "border-border/60 border-b px-6 py-4",
	"marketplace-guide": "gap-2 pr-8",
	"agent-conversation": "items-center border-border/60 border-b px-4 py-3",
};

const dialogFooterPurpose = {
	"announcement-actions":
		"flex-col-reverse justify-between gap-3 sm:flex-row sm:items-center",
	"package-actions": "px-0 pt-1",
	"package-list-actions": "px-0",
	"panel-actions": "border-t px-6 py-4",
	"cloud-actions": "border-t pt-4",
	"agent-editor": "border-border/60 border-t px-4 py-3",
	"agent-conversation":
		"items-center justify-center border-border/60 border-t px-4 py-3 sm:justify-center",
};

const dialogTitleTypography = {
	"wrapped-label": "break-words leading-tight",
	code: "font-mono",
	explanation: "text-xl leading-7",
	"conversation-share": "pr-8 text-lg",
	"compact-preview": "text-base",
	"marketplace-guide": "font-medium text-2xl tracking-tight sm:text-3xl",
};

const MOBILE_DRAWER_CONTENT_CLASSES =
	"max-sm:!inset-x-0 max-sm:!top-auto max-sm:!bottom-0 max-sm:!start-0 max-sm:!w-full max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-t-4xl max-sm:!rounded-b-none max-sm:!max-h-[calc(100dvh-0.5rem)] max-sm:!overflow-y-auto max-sm:data-open:slide-in-from-bottom-4 max-sm:data-closed:slide-out-to-bottom-4 max-sm:data-open:zoom-in-100 max-sm:data-closed:zoom-out-100";

const MOBILE_FULL_PAGE_CONTENT_CLASSES =
	"max-sm:!inset-0 max-sm:!top-0 max-sm:!bottom-auto max-sm:!start-0 max-sm:!h-dvh max-sm:!max-h-dvh max-sm:!w-screen max-sm:!max-w-none max-sm:!translate-x-0 max-sm:!translate-y-0 max-sm:!rounded-none max-sm:!overflow-hidden max-sm:data-open:fade-in-0 max-sm:data-closed:fade-out-0";

function Dialog({ onOpenChange, ...props }: DialogPrimitive.Root.Props) {
	return (
		<DialogPrimitive.Root
			data-slot="dialog"
			onOpenChange={(open, details) => {
				if (!cancelToastDismissal(open, details)) {
					onOpenChange?.(open, details);
				}
			}}
			{...props}
		/>
	);
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
	return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
	return (
		<DialogPrimitive.Portal
			container={usePortalContainer()}
			data-slot="dialog-portal"
			{...props}
		/>
	);
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
				// `transition-none`: the durations below exist for the enter/exit
				// keyframes. Without a property list they would also apply to the
				// default `transition-property: all`, so a hover-driven change such
				// as `scrollbar-color` starts a transition on the closing dialog;
				// when hover changes again that transition aborts and Base UI never
				// finishes closing, leaving an inert dialog over the app.
				"ryu-dialog-overlay data-open:fade-in-0 data-closed:fade-out-0 fixed inset-0 isolate z-50 rounded-[var(--ryu-window-radius,0px)] transition-none duration-(--modal-open-dur) ease-(--modal-ease) data-closed:animate-out data-open:animate-in data-closed:duration-(--modal-close-dur)",
				className
			)}
			data-slot="dialog-overlay"
			{...props}
		/>
	);
}

const dialogContentAppearance = {
	default: "",
	// The settings frame (desktop settings, GatewayDialog): a fixed 880 x 640
	// sheet that shrinks with the window, full screen on mobile.
	"gateway-settings":
		"!w-[min(880px,calc(100vw-48px))] !max-w-none max-md:!w-screen max-md:!max-w-none [&>[data-slot=dialog-close]]:!top-5 [&>[data-slot=dialog-close]]:!right-5 h-[min(640px,calc(100vh-48px))] gap-0 overflow-hidden rounded-2xl p-0 max-md:h-[100dvh] max-md:rounded-none",
	"marketplace-guide":
		"max-h-[min(90vh,42rem)] max-w-xl overflow-y-auto p-0 sm:max-w-xl",
	"license-browser":
		"!w-[min(70rem,calc(100vw-2rem))] !max-w-none flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0",
	// The settings frame's loading stand-in: same footprint, so nothing jumps.
	"deferred-settings":
		"!w-[min(880px,calc(100vw-48px))] !max-w-none max-md:!w-screen max-md:!max-w-none h-[min(640px,calc(100vh-48px))] rounded-2xl max-md:h-[100dvh] max-md:rounded-none",
	announcement:
		"max-h-[min(90vh,48rem)] max-w-2xl overflow-y-auto p-0 sm:max-w-2xl",
	"media-lightbox":
		"z-[81] flex w-fit max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden bg-black p-0 sm:max-w-[calc(100vw-6rem)]",
	"image-editor":
		"!top-0 !left-0 !h-dvh !w-screen !max-w-none !translate-x-0 !translate-y-0 gap-0 overflow-hidden rounded-none border-0 p-0",
	"package-install": "max-h-[88vh] overflow-hidden p-0 sm:max-w-xl",
	"marketplace-detail":
		"max-h-[88vh] w-[min(45rem,94vw)] max-w-[min(45rem,94vw)] overflow-hidden p-0 sm:max-w-[min(45rem,94vw)]",
	"project-settings":
		"flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl",
	"worktree-handoff": "gap-5 px-6 py-7 sm:max-w-[31.5rem]",
	"workspace-required": "gap-5 px-5 py-6 sm:max-w-[30rem]",
	"conversation-share":
		"max-h-[min(760px,calc(100vh-2rem))] max-w-xl overflow-hidden p-0 sm:max-w-xl",
	"quick-preview": "max-w-xl gap-3 p-3 sm:p-4",
	"git-history":
		"max-h-[min(760px,calc(100vh-2rem))] max-w-2xl overflow-hidden p-0 sm:max-w-2xl",
	"workflow-fork": "gap-4 px-4 py-7 sm:max-w-[31.5rem]",
	sketch:
		"!flex h-[min(760px,calc(100dvh-2rem))] max-w-[min(760px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0",
	"continue-on-node": "gap-5 sm:max-w-[36rem]",
	"agent-editor":
		"flex h-[min(90vh,760px)] max-w-4xl flex-col gap-0 overflow-hidden p-0",
	"auto-routing": "max-h-[85vh] gap-0 overflow-y-auto sm:max-w-lg",
	"agent-conversation":
		"flex max-h-[min(40rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg",
	// No overflow clip: a sent card flies up and off the table, past the popup edge.
	"card-table":
		"!w-[min(64rem,calc(100vw-2rem))] !max-w-none flex h-[min(44rem,calc(100dvh-2rem))] flex-col gap-0 p-0",
} as const;

const dialogContentOverlayAppearance = {
	default: "",
	"gateway-settings": "",
	"marketplace-guide": "bg-black/55 backdrop-blur-sm",
	"license-browser": "",
	"deferred-settings": "",
	announcement: "bg-black/55 backdrop-blur-sm",
	"media-lightbox": "z-[80]",
	"image-editor": "",
	"package-install": "",
	"marketplace-detail": "",
	"project-settings": "",
	"worktree-handoff": "",
	"workspace-required": "",
	"conversation-share": "",
	"quick-preview": "",
	"git-history": "",
	"workflow-fork": "",
	sketch: "",
	"continue-on-node": "",
	"agent-editor": "",
	"auto-routing": "",
	"agent-conversation": "",
	"card-table": "",
} as const;

function DialogContent({
	className,
	overlayClassName,
	spacing = "default",
	appearance = "default",
	children,
	mobileFullPage = false,
	showCloseButton = true,
	...props
}: DialogPrimitive.Popup.Props & {
	appearance?: keyof typeof dialogContentAppearance;
	spacing?: "default" | "flush";
	mobileFullPage?: boolean;
	showCloseButton?: boolean;
	overlayClassName?: string;
}) {
	const direction = useDirection();
	return (
		<DialogPortal>
			<DialogOverlay
				className={cn(
					dialogContentOverlayAppearance[appearance],
					overlayClassName
				)}
			/>
			<DialogPrimitive.Popup
				className={cn(
					// `transition-none`: see DialogOverlay — the durations are for the
					// enter/exit keyframes only.
					"data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-4xl bg-popover/90 p-4 text-popover-foreground text-sm shadow-xl outline-none backdrop-blur-xl transition-none duration-(--modal-open-dur) ease-(--modal-ease) data-closed:animate-out data-open:animate-in data-closed:duration-(--modal-close-dur) sm:max-w-md",
					dialogContentAppearance[appearance],
					spacing === "flush" && "p-0",
					className,
					mobileFullPage
						? MOBILE_FULL_PAGE_CONTENT_CLASSES
						: MOBILE_DRAWER_CONTENT_CLASSES
				)}
				data-slot="dialog-content"
				{...props}
				dir={direction}
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
								className="absolute end-4 top-4 bg-secondary"
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

function DialogHeader({
	className,
	purpose = "default",
	...props
}: React.ComponentProps<"div"> & {
	purpose?: "default" | keyof typeof dialogHeaderPurpose;
}) {
	return (
		<div
			className={cn(
				"flex flex-col gap-1.5",
				purpose !== "default" && dialogHeaderPurpose[purpose],
				className
			)}
			data-slot="dialog-header"
			{...props}
		/>
	);
}

function DialogFooter({
	className,
	purpose = "default",
	showCloseButton = false,
	children,
	...props
}: React.ComponentProps<"div"> & {
	purpose?: "default" | keyof typeof dialogFooterPurpose;
	showCloseButton?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
				purpose !== "default" && dialogFooterPurpose[purpose],
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
	layout = "default",
	typography = "default",
	...props
}: DialogPrimitive.Title.Props & {
	layout?: "default" | "inline";
	typography?: "default" | keyof typeof dialogTitleTypography;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<DialogPrimitive.Title
			className={cn(
				"font-heading font-medium text-xl leading-none",
				layout === "inline" && "flex items-center gap-2",
				typography !== "default" && dialogTitleTypography[typography],
				className
			)}
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
	typography = "default",
	...props
}: DialogPrimitive.Description.Props & {
	typography?: "default" | "marketplace-guide";
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<DialogPrimitive.Description
			className={cn(
				"text-muted-foreground text-sm *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
				typography === "marketplace-guide" && "max-w-xl text-sm leading-6",
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
