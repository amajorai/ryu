"use client";

import { cn } from "@ryu/ui/lib/utils";
import { BookOpen, CircleUserRound, FileText, LayoutGrid } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, ReactNode } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { DOCS_URL } from "./data/resources.tsx";
import {
	isWithinPrefixes,
	PRODUCT_ACTIVE_PREFIXES,
	RESOURCE_ACTIVE_PREFIXES,
} from "./header-active-routes.ts";
import { MobileNavDownloadAction } from "./mobile-nav-download.tsx";
import type { MobileNavSheetsProps } from "./mobile-nav-sheet.tsx";
import {
	focusableElements,
	NO_HIDDEN_PRODUCTS,
	SHEET_TITLES,
	type SheetKey,
} from "./mobile-nav-sheet-data.ts";
import { ProgressiveBlur } from "./progressive-blur.tsx";
import "./mobile-nav.css";

export {
	PRODUCT_SHEET,
	RESOURCE_SHEET,
	type SheetGroup,
	type SheetLinkData,
} from "./mobile-nav-sheet-data.ts";

// The animated sheet (and motion with it) loads on the first open or on intent
// to open. A failed chunk load leaves the tabs inert instead of handing the
// rejection to the route's error boundary.
const MobileNavSheets = lazy<ComponentType<MobileNavSheetsProps>>(() =>
	import("./mobile-nav-sheet.tsx").catch(() => ({ default: NoSheets }))
);

function NoSheets() {
	return null;
}

// The mobile bottom nav mirrors the desktop header: Products and Resources are
// the same menu groups (fed from the same data files) opened as a sheet instead
// of a hover dropdown, Download is the header's primary CTA, and Account is the
// header's user menu. Docs is the header's Docs link and, like it, opens the
// docs site in this tab. Marketplace sits in the Products sheet, as it does in
// the desktop Products menu. Enterprise keeps its slot in the mobile top bar and
// the logo stays the way home, as on desktop. The bar is symmetric: two tabs,
// the raised Download action, two tabs.

type TabKey = SheetKey | "download";

interface MobileNavProps {
	/**
	 * The right-most tab. Hosts pass their account menu here, rendered with
	 * `mobileNavTabClassName` and `MobileNavTabBody` so it lines up with the
	 * other tabs. Without one, the tab is a plain sign-in link.
	 */
	account?: ReactNode;
	className?: string;
	/**
	 * Product realm ids the host has not rolled out (a standalone service whose
	 * rollout flag is off). They are dropped from the Products sheet.
	 */
	hiddenProductIds?: readonly string[];
}

// The routes the desktop header's Products and Resources triggers highlight
// for, from the list both headers share.
function isTabActive(key: TabKey, pathname: string): boolean {
	switch (key) {
		case "products":
			return isWithinPrefixes(pathname, PRODUCT_ACTIVE_PREFIXES);
		case "resources":
			return isWithinPrefixes(pathname, RESOURCE_ACTIVE_PREFIXES);
		case "download":
			return isWithinPrefixes(pathname, ["/download"]);
	}
}

/**
 * Shared tab metrics: every tab is the same column, with a 24px icon box and a
 * label on one baseline, so an avatar, an icon, and a menu trigger all line up.
 */
export function mobileNavTabClassName(active = false): string {
	return cn(
		"flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
		active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
	);
}

export function MobileNavTabBody({
	icon,
	label,
}: {
	icon: ReactNode;
	label: ReactNode;
}) {
	return (
		<>
			<span
				aria-hidden="true"
				className="flex size-6 items-center justify-center [&_svg]:size-5"
			>
				{icon}
			</span>
			<span className="font-medium text-xs leading-none">{label}</span>
		</>
	);
}

/** The account tab for a signed-out visitor. */
export function MobileNavSignInTab() {
	return (
		<Link className={mobileNavTabClassName()} href="/login">
			<MobileNavTabBody icon={<CircleUserRound />} label="Sign in" />
		</Link>
	);
}

export function MobileNav({
	account,
	className,
	hiddenProductIds = NO_HIDDEN_PRODUCTS,
}: MobileNavProps) {
	const pathname = usePathname();
	const [open, setOpen] = useState<SheetKey | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const wasOpen = useRef(false);
	// Whether the sheet module has been asked for: on the first open, or earlier
	// when a pointer or focus lands on a sheet tab.
	const [sheetsRequested, setSheetsRequested] = useState(false);
	const requestSheets = () => setSheetsRequested(true);

	// A navigation closes any open sheet — the destination is already chosen.
	useEffect(() => {
		setOpen(null);
	}, [pathname]);

	// The sheet moves focus into itself when it opens (it may still be loading
	// here); on close, focus goes back to the button that opened it. This keeps
	// keyboard users in the same navigation context instead of leaving focus
	// behind the scrim.
	useEffect(() => {
		if (open) {
			wasOpen.current = true;
			return;
		}
		if (wasOpen.current) {
			wasOpen.current = false;
			triggerRef.current?.focus();
		}
	}, [open]);

	// Treat the bottom sheet as a modal while open: Escape closes it and Tab
	// cycles only through controls in the current sheet.
	useEffect(() => {
		if (!open) {
			return;
		}
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(null);
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) {
				return;
			}
			const focusable = focusableElements(dialogRef.current);
			if (focusable.length === 0) {
				event.preventDefault();
				return;
			}
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			} else if (!dialogRef.current.contains(document.activeElement)) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open]);

	const toggle = (key: SheetKey) =>
		setOpen((current) => (current === key ? null : key));

	const sheetTab = (key: SheetKey, icon: ReactNode) => {
		const isOpen = open === key;
		return (
			<button
				aria-controls="mobile-nav-sheet"
				aria-expanded={isOpen}
				className={mobileNavTabClassName(isOpen || isTabActive(key, pathname))}
				onClick={(event) => {
					triggerRef.current = event.currentTarget;
					requestSheets();
					toggle(key);
				}}
				onFocus={requestSheets}
				onPointerEnter={requestSheets}
				onTouchStart={requestSheets}
				type="button"
			>
				<MobileNavTabBody icon={icon} label={SHEET_TITLES[key]} />
			</button>
		);
	};

	const downloadActive = isTabActive("download", pathname);

	return (
		<div
			className={cn("fixed right-0 bottom-0 left-0 z-50 md:hidden", className)}
			data-mobile-nav=""
			data-sheet-open={open ? "" : undefined}
		>
			{sheetsRequested ? (
				<Suspense fallback={null}>
					<MobileNavSheets
						dialogRef={dialogRef}
						hiddenProductIds={hiddenProductIds}
						onClose={() => setOpen(null)}
						open={open}
						pathname={pathname}
					/>
				</Suspense>
			) : null}

			{/* The bar has no surface of its own: the progressive blur behind it
			    fades the page out under the tabs instead of a solid band. */}
			<ProgressiveBlur
				blurAmount="24px"
				height="calc(8rem + env(safe-area-inset-bottom))"
				position="bottom"
			/>
			<nav
				aria-label="Mobile navigation"
				className="relative z-40 box-content grid h-16 grid-cols-5 items-stretch px-2 pb-[env(safe-area-inset-bottom)]"
			>
				{sheetTab("products", <LayoutGrid />)}
				{sheetTab("resources", <BookOpen />)}

				<div className="relative flex justify-center">
					<MobileNavDownloadAction
						active={downloadActive}
						onOpen={() => setOpen(null)}
					/>
				</div>

				{/* The docs share this site's chrome, so they open in this tab, like
				    the desktop header's Docs link. */}
				<a className={mobileNavTabClassName()} href={DOCS_URL}>
					<MobileNavTabBody icon={<FileText />} label="Docs" />
				</a>

				<div className="flex" data-testid="mobile-account-menu">
					{account ?? <MobileNavSignInTab />}
				</div>
			</nav>
		</div>
	);
}

export default MobileNav;
