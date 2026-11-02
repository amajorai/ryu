"use client";

// The browser half of the post-download guide: the arrow that points at the
// browser's download control, a small generic mock of that toolbar, and the
// keyboard shortcut that opens the downloads list. Generic shapes only: no
// browser logos, so nothing here claims to be a screenshot.

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	ArrowLeft,
	ArrowRight,
	CircleUser,
	Download,
	EllipsisVertical,
	FileDown,
	Folder,
	Menu,
	RotateCw,
} from "lucide-react";
import { createPortal } from "react-dom";
import styles from "./download-guide.module.css";
import type { BrowserDownloadHint } from "./download-guide.ts";
import type { DownloadOS } from "./download-platform.ts";

// Kept importable from here for the guide panel.
export { ShortcutKeys, shortcutKeys } from "./download-guide-shortcut.tsx";

/**
 * Pinned to the viewport's top-right corner, over the backdrop: the browser's
 * download control sits just above it. Decorative; the dialog says the same
 * thing in words. Portalled to the body, because a header with a backdrop
 * filter would otherwise become its containing block. Shown only from `xl`
 * up, where it clears the dialog (`sm:max-w-5xl`, centred) instead of
 * covering its header.
 */
export function DownloadCornerPointer({ name }: { name: string }) {
	const tl = useLiteralMessages();
	if (typeof document === "undefined") {
		return null;
	}
	return createPortal(
		<div
			aria-hidden="true"
			className="pointer-events-none fixed top-2 right-8 z-[51] hidden flex-col items-end gap-1 text-foreground xl:flex 2xl:right-24"
			data-testid="download-guide-pointer"
		>
			<div className="relative size-16">
				<span
					className={cn(
						"absolute top-0 right-0 size-6 rounded-full bg-foreground/50",
						styles.ring
					)}
				/>
				<svg
					aria-hidden="true"
					className={cn(
						"absolute inset-0 size-16 drop-shadow-lg",
						styles.nudge
					)}
					fill="none"
					viewBox="0 0 64 64"
				>
					<path
						d="M10 58 C 16 36, 30 20, 54 10"
						stroke="currentColor"
						strokeLinecap="round"
						strokeWidth="4"
					/>
					<path
						d="M40 8 L 56 9 L 50 24"
						stroke="currentColor"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth="4"
					/>
				</svg>
			</div>
			<p className="max-w-56 rounded-2xl border border-border/70 bg-popover px-3 py-2 text-right text-popover-foreground text-sm leading-snug shadow-lg">
				<span className="block font-medium">Your download is up here</span>
				<span className="block text-muted-foreground text-xs">
					{tl("In the {browser} toolbar", { browser: name })}
				</span>
			</p>
		</div>,
		document.body
	);
}

function WindowControls({ os }: { os: DownloadOS }) {
	if (os === "macos") {
		return (
			<div className="flex items-center gap-1.5">
				<span className="size-2.5 rounded-full bg-[#ff5f57]" />
				<span className="size-2.5 rounded-full bg-[#febc2e]" />
				<span className="size-2.5 rounded-full bg-[#28c840]" />
			</div>
		);
	}
	return (
		<div className="flex items-center gap-2.5 text-muted-foreground/70">
			<span className="h-px w-2.5 bg-current" />
			<span className="size-2.5 rounded-[2px] border border-current" />
			<span className="font-medium text-[10px] leading-none">✕</span>
		</div>
	);
}

/**
 * A generic browser window, tab strip and toolbar, with the download control
 * highlighted and its panel open on the file. The "other" browser gets a
 * Downloads folder instead, since there is no toolbar to point at.
 */
export function BrowserToolbarMock({
	fileName,
	hint,
	os,
}: {
	fileName: string;
	hint: BrowserDownloadHint;
	os: DownloadOS;
}) {
	if (!hint.pointsTopRight) {
		return <DownloadsFolderMock fileName={fileName} />;
	}
	const firefox = hint.browser === "firefox";
	return (
		<div
			aria-hidden="true"
			className="relative w-full select-none overflow-hidden rounded-2xl border border-border/70 bg-muted/40 shadow-sm"
			data-browser={hint.browser}
			data-testid="download-guide-toolbar"
			// A picture of browser chrome, kept left to right like the browser
			// itself: the download control stays at the top-right corner.
			dir="ltr"
		>
			<div className="flex h-8 items-center gap-3 border-border/60 border-b bg-muted/60 px-3">
				{os === "macos" ? <WindowControls os={os} /> : null}
				<div className="flex h-6 w-32 items-center gap-2 self-end rounded-t-lg bg-background px-2.5">
					<span className="size-2.5 rounded-sm bg-primary/70" />
					<span className="h-1.5 w-14 rounded-full bg-muted-foreground/30" />
				</div>
				<div className="flex-1" />
				{os === "macos" ? null : <WindowControls os={os} />}
			</div>
			<div className="flex h-10 items-center gap-2 bg-background px-3 text-muted-foreground/70">
				<ArrowLeft className="size-3.5" />
				<ArrowRight className="size-3.5" />
				<RotateCw className="size-3.5" />
				<div className="mx-1 flex h-6 flex-1 items-center rounded-full bg-muted px-3">
					<span className="h-1.5 w-24 rounded-full bg-muted-foreground/25" />
				</div>
				<span className="relative flex size-7 items-center justify-center rounded-full bg-primary/12 text-primary ring-2 ring-primary/60">
					<span
						className={cn(
							"absolute inset-0 rounded-full bg-primary/30",
							styles.ring
						)}
					/>
					<Download className="relative size-3.5" strokeWidth={2.5} />
				</span>
				{hint.browser === "safari" ? null : <CircleUser className="size-3.5" />}
				{firefox ? (
					<Menu className="size-3.5" />
				) : (
					<EllipsisVertical className="size-3.5" />
				)}
			</div>
			<div className="flex justify-end bg-background px-3 pb-3">
				<div className="w-60 max-w-full rounded-xl border border-border/70 bg-popover p-2.5 text-popover-foreground shadow-lg">
					<div className="flex items-center gap-2.5">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
							<FileDown className="size-4" />
						</span>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-xs">{fileName}</p>
							<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
								<div
									className={cn(
										"h-full rounded-full bg-primary",
										styles.progress
									)}
								/>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

function DownloadsFolderMock({ fileName }: { fileName: string }) {
	return (
		<div
			aria-hidden="true"
			className="flex w-full select-none items-center gap-4 rounded-2xl border border-border/70 bg-muted/40 p-4"
			data-testid="download-guide-folder"
		>
			<span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
				<Folder className="size-6" />
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-muted-foreground text-xs">Downloads</p>
				<p className="truncate font-medium text-sm">{fileName}</p>
			</div>
		</div>
	);
}
