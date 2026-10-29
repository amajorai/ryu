"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import type { RefObject } from "react";
import { useEffect } from "react";
import {
	focusableElements,
	productSheet,
	RESOURCE_SHEET,
	SHEET_FOOTERS,
	SHEET_TITLES,
	type SheetKey,
} from "./mobile-nav-sheet-data.ts";
import { nextLinkHref } from "./next-link-href.ts";

// The mobile nav's animated Products/Resources sheet and its scrim. MobileNav
// loads this module on the first open (or on intent to open), so pages that
// never open a sheet do not pay for it or for motion.

function SheetLink({
	external = false,
	href,
	label,
	onClose,
	primary = false,
	sameTab = false,
}: {
	external?: boolean;
	href: string;
	label: string;
	onClose: () => void;
	primary?: boolean;
	sameTab?: boolean;
}) {
	const className = cn(
		"flex min-h-11 items-center rounded-lg px-2 text-[15px] transition-colors",
		primary
			? "font-medium text-foreground hover:text-accent-foreground"
			: "text-muted-foreground hover:bg-muted hover:text-foreground"
	);
	if (external) {
		return (
			<a
				className={className}
				href={href}
				onClick={onClose}
				{...(sameTab
					? {}
					: { rel: "noopener noreferrer", target: "_blank" as const })}
			>
				{label}
			</a>
		);
	}
	return (
		<Link className={className} href={nextLinkHref(href)} onClick={onClose}>
			{label}
		</Link>
	);
}

function Sheet({
	dialogRef,
	hiddenProductIds,
	kind,
	onClose,
}: {
	dialogRef: RefObject<HTMLDivElement | null>;
	hiddenProductIds: readonly string[];
	kind: SheetKey;
	onClose: () => void;
}) {
	const tl = useLiteralMessages();
	const groups =
		kind === "products" ? productSheet(hiddenProductIds) : RESOURCE_SHEET;
	const footer = SHEET_FOOTERS[kind];

	// Move focus into the sheet when it opens or switches lists. MobileNav sends
	// it back to the tab that opened it when the sheet closes.
	useEffect(() => {
		if (!(kind && dialogRef.current)) {
			return;
		}
		focusableElements(dialogRef.current)[0]?.focus();
	}, [dialogRef, kind]);

	return (
		<div
			aria-labelledby={`${kind}-mobile-nav-title`}
			aria-modal="true"
			className="rounded-2xl border border-border/60 bg-background px-4 pt-3 pb-2 shadow-2xl"
			id="mobile-nav-sheet"
			ref={dialogRef}
			role="dialog"
			tabIndex={-1}
		>
			<div className="mb-2 flex items-center justify-between">
				<p className="font-medium text-lg" id={`${kind}-mobile-nav-title`}>
					{SHEET_TITLES[kind]}
				</p>
				<button
					aria-label={tl("Close {menuName} menu", {
						menuName: SHEET_TITLES[kind],
					})}
					className="grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<X className="size-4" />
				</button>
			</div>
			{/* The fade marks that the list scrolls; the bottom padding keeps the last
			    row clear of it when everything fits. */}
			<div className="max-h-[calc(100dvh-12rem)] overflow-y-auto pr-1 pb-4 [mask-image:linear-gradient(to_bottom,black_90%,transparent)]">
				{groups.map((group) => (
					<div
						className="mb-3"
						key={`${group.title ?? "top"}-${group.links[0]?.href ?? ""}`}
					>
						{group.title ? (
							<p className="mb-1 px-2 font-medium text-[13px] text-muted-foreground">
								{group.title}
							</p>
						) : null}
						<div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
							{group.links.map((link) => (
								<SheetLink
									external={link.external}
									href={link.href}
									key={`${link.href}-${link.label}`}
									label={link.label}
									onClose={onClose}
									sameTab={link.sameTab}
								/>
							))}
						</div>
					</div>
				))}
			</div>
			{footer ? (
				<div className="mt-2 pb-1">
					<SheetLink
						external={footer.external}
						href={footer.href}
						label={footer.label}
						onClose={onClose}
						primary
					/>
				</div>
			) : null}
		</div>
	);
}

export interface MobileNavSheetsProps {
	dialogRef: RefObject<HTMLDivElement | null>;
	hiddenProductIds: readonly string[];
	onClose: () => void;
	open: SheetKey | null;
}

/** The scrim and the open sheet, animated in and out. */
export default function MobileNavSheets({
	dialogRef,
	hiddenProductIds,
	onClose,
	open,
}: MobileNavSheetsProps) {
	return (
		<MotionConfig reducedMotion="user">
			<AnimatePresence>
				{open ? (
					<motion.button
						animate={{ opacity: 1 }}
						aria-label="Close menu"
						className="fixed inset-0 z-30 bg-black/40"
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key="backdrop"
						onClick={onClose}
						type="button"
					/>
				) : null}
				{open ? (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						className="absolute right-3 bottom-full left-3 z-50 mb-8"
						exit={{ opacity: 0, y: 24 }}
						initial={{ opacity: 0, y: 24 }}
						key="sheet"
						transition={{ duration: 0.2, ease: "easeOut" }}
					>
						<Sheet
							dialogRef={dialogRef}
							hiddenProductIds={hiddenProductIds}
							kind={open}
							onClose={onClose}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>
		</MotionConfig>
	);
}
