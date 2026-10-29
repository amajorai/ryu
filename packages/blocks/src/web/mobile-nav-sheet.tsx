"use client";

import { Accordion } from "@base-ui/react/accordion";
import { useLiteralMessages, useLocalizedText } from "@ryu/i18n/react";
import { ChevronDown, X } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import { useEffect } from "react";
import {
	focusableElements,
	initialSheetGroup,
	productSheet,
	RESOURCE_SHEET,
	SHEET_FOOTERS,
	SHEET_TITLES,
	type SheetGroup,
	type SheetKey,
	type SheetLinkData,
} from "./mobile-nav-sheet-data.ts";
import { nextLinkHref } from "./next-link-href.ts";

// The mobile nav's animated Products/Resources sheet and its scrim. MobileNav
// loads this module on the first open (or on intent to open), so pages that
// never open a sheet do not pay for it or for motion.
//
// The sheet mirrors the desktop menus: one collapsible section per menu group,
// each item its name with a one-line summary under it, then the menu's footer
// links. Only one section is open at a time so the sheet stays short. It uses
// the Base UI accordion directly (not the @ryu/ui card-styled wrapper) so the
// lazily loaded sheet chunk stays small and the rows need no style overrides.

function LocalizedCopy({ value }: { value: string }) {
	return <>{useLocalizedText(value, { literal: true })}</>;
}

function SheetAnchor({
	children,
	className,
	link,
	onClose,
}: {
	children: ReactNode;
	className: string;
	link: SheetLinkData;
	onClose: () => void;
}) {
	if (link.external) {
		return (
			<a
				className={className}
				href={link.href}
				onClick={onClose}
				rel="noopener noreferrer"
				target="_blank"
			>
				{children}
			</a>
		);
	}
	return (
		<Link
			className={className}
			href={nextLinkHref(link.href)}
			onClick={onClose}
		>
			{children}
		</Link>
	);
}

function SheetItem({
	link,
	onClose,
}: {
	link: SheetLinkData;
	onClose: () => void;
}) {
	return (
		<SheetAnchor
			className="flex min-h-11 flex-col justify-center gap-0.5 rounded-xl px-2 py-2 text-foreground transition-colors hover:bg-muted"
			link={link}
			onClose={onClose}
		>
			<span className="font-medium text-[15px] leading-tight">
				<LocalizedCopy value={link.label} />
			</span>
			{link.description ? (
				<span className="block truncate text-[13px] text-muted-foreground leading-snug">
					<LocalizedCopy value={link.description} />
				</span>
			) : null}
		</SheetAnchor>
	);
}

function SheetSection({
	group,
	onClose,
}: {
	group: SheetGroup;
	onClose: () => void;
}) {
	return (
		<Accordion.Item data-sheet-group={group.title} value={group.title}>
			<Accordion.Header className="flex">
				<Accordion.Trigger className="group flex min-h-11 flex-1 items-center justify-between gap-4 rounded-xl px-2 text-left font-medium text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:text-foreground">
					<LocalizedCopy value={group.title} />
					<ChevronDown
						aria-hidden="true"
						className="size-4 shrink-0 transition-transform duration-200 group-aria-expanded:rotate-180 motion-reduce:transition-none"
					/>
				</Accordion.Trigger>
			</Accordion.Header>
			<Accordion.Panel
				className="h-(--accordion-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none"
				data-slot="accordion-content"
			>
				<ul className="flex flex-col pb-2">
					{group.links.map((link) => (
						<li key={`${link.href}-${link.label}`}>
							<SheetItem link={link} onClose={onClose} />
						</li>
					))}
				</ul>
			</Accordion.Panel>
		</Accordion.Item>
	);
}

function Sheet({
	dialogRef,
	hiddenProductIds,
	kind,
	onClose,
	pathname,
}: {
	dialogRef: RefObject<HTMLDivElement | null>;
	hiddenProductIds: readonly string[];
	kind: SheetKey;
	onClose: () => void;
	pathname: string;
}) {
	const tl = useLiteralMessages();
	const groups =
		kind === "products" ? productSheet(hiddenProductIds) : RESOURCE_SHEET;
	const footer = SHEET_FOOTERS[kind];
	const openGroup = initialSheetGroup(groups, pathname);

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
			className="rounded-2xl border border-border/60 bg-background px-3 pt-3 pb-2 shadow-2xl"
			id="mobile-nav-sheet"
			ref={dialogRef}
			role="dialog"
			tabIndex={-1}
		>
			<div className="mb-1 flex items-center justify-between pl-2">
				<p
					className="font-semibold text-xl tracking-tight"
					id={`${kind}-mobile-nav-title`}
				>
					<LocalizedCopy value={SHEET_TITLES[kind]} />
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
			<div className="max-h-[calc(100dvh-14rem)] overflow-y-auto pb-4 [mask-image:linear-gradient(to_bottom,black_90%,transparent)]">
				<Accordion.Root defaultValue={openGroup ? [openGroup] : []} key={kind}>
					{groups.map((group) => (
						<SheetSection group={group} key={group.title} onClose={onClose} />
					))}
				</Accordion.Root>
			</div>
			{footer.length > 0 ? (
				<div
					className="mt-1 flex flex-wrap gap-x-2 border-border/60 border-t pt-2 pb-1"
					data-testid="mobile-nav-sheet-footer"
				>
					{footer.map((link) => (
						<SheetAnchor
							className="flex min-h-11 items-center rounded-full px-2 font-medium text-foreground text-sm transition-colors hover:bg-muted"
							key={link.href}
							link={link}
							onClose={onClose}
						>
							<LocalizedCopy value={link.label} />
						</SheetAnchor>
					))}
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
	/** The current route, so the sheet opens on the section that holds it. */
	pathname: string;
}

/** The scrim and the open sheet, animated in and out. */
export default function MobileNavSheets({
	dialogRef,
	hiddenProductIds,
	onClose,
	open,
	pathname,
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
							pathname={pathname}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>
		</MotionConfig>
	);
}
