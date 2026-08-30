"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	BookOpen,
	ChevronUp,
	Download,
	Home,
	Package,
	Target,
	X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { PRODUCT_REALMS } from "./data/product-realms.ts";
import {
	DOCS_URL,
	resourceCategories,
	resourcesByCategory,
} from "./data/resources.tsx";
import { solutionCategories, solutionsByCategory } from "./data/solutions.ts";
import { ProgressiveBlur } from "./progressive-blur.tsx";

// The mobile bottom nav mirrors the desktop header's primary navigation:
// Products, Solutions, and Resources are the same mega-menu groups (fed from the
// same data files), but tapping them opens a bottom sheet instead of a hover
// dropdown. Marketplace/Book a demo/Sign in stay in the header, while Open Source
// stays in the footer — the bottom bar only carries destinations a visitor reaches
// for every page.
const RESOURCE_ACTIVE_PREFIXES = [
	"/docs",
	"/academy",
	"/certifications",
	"/marketplace",
	"/compare",
	"/pricing",
	"/subscriptions",
	"/community",
	"/blog",
	"/changelog",
	"/help",
];

const PRODUCT_SHEET = [
	{
		title: "Products",
		links: [
			...PRODUCT_REALMS.filter((realm) =>
				["os", "bot", "console", "box", "mail", "notify", "hire"].includes(
					realm.id
				)
			).map(({ label, href }) => ({ label, href, external: false })),
			{
				label: "Ryu Apps",
				href: "/marketplace/apps",
				external: false,
			},
		],
	},
	{
		title: "Platform",
		links: [
			...PRODUCT_REALMS.filter((realm) => realm.id === "gateway").map(
				({ label, href }) => ({ label, href, external: false })
			),
			{ label: "SDKs", href: "/products/sdk", external: false },
			{ label: "Core", href: "/products/core", external: false },
		],
	},
	{
		title: "Infrastructure",
		links: [
			{ label: "Ryu Cloud", href: "/platform#infra", external: false },
			{ label: "Self-hosted", href: "/platform#infra", external: false },
		],
	},
] as const;

const SOLUTION_SHEET = solutionCategories.map((category) => ({
	title: category,
	links: solutionsByCategory(category).map((solution) => ({
		label: solution.navLabel,
		href: `/for/${solution.slug}`,
		external: false,
	})),
}));

const RESOURCE_SHEET = resourceCategories.map((category) => ({
	title: category,
	links: resourcesByCategory(category).map((resource) => ({
		label: resource.label,
		href: resource.href,
		external: resource.external ?? false,
	})),
}));

const SHEET_TITLES = {
	products: "Products",
	solutions: "Solutions",
	resources: "Resources",
} as const;

const SHEET_FOOTERS = {
	products: {
		label: "Explore all products →",
		href: "/products",
		external: false,
	},
	solutions: { label: "View all roles →", href: "/for", external: false },
	resources: { label: "Read the docs →", href: DOCS_URL, external: true },
} as const;

type SheetKey = keyof typeof SHEET_TITLES;
type TabKey = "home" | SheetKey | "download";

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableElements(root: HTMLElement): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

interface MobileNavProps {
	className?: string;
}

function isTabActive(key: TabKey, pathname: string): boolean {
	switch (key) {
		case "home":
			return pathname === "/";
		case "products":
			return (
				pathname === "/bot" ||
				pathname === "/console" ||
				pathname === "/build" ||
				pathname === "/platform" ||
				pathname.startsWith("/marketplace/apps")
			);
		case "solutions":
			return pathname.startsWith("/for");
		case "resources":
			return RESOURCE_ACTIVE_PREFIXES.some((prefix) =>
				pathname.startsWith(prefix)
			);
		case "download":
			return pathname.startsWith("/download");
	}
}

function SheetLink({
	external = false,
	href,
	label,
	onClose,
	primary = false,
}: {
	external?: boolean;
	href: string;
	label: string;
	onClose: () => void;
	primary?: boolean;
}) {
	const className = cn(
		"block rounded-lg px-1.5 py-1.5 text-sm transition-colors",
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
				rel="noopener noreferrer"
				target="_blank"
			>
				{label}
			</a>
		);
	}
	return (
		<Link className={className} href={href as Route} onClick={onClose}>
			{label}
		</Link>
	);
}

function Sheet({
	dialogRef,
	kind,
	onClose,
}: {
	dialogRef: RefObject<HTMLDivElement | null>;
	kind: SheetKey;
	onClose: () => void;
}) {
	const groups =
		kind === "products"
			? PRODUCT_SHEET
			: kind === "solutions"
				? SOLUTION_SHEET
				: RESOURCE_SHEET;
	const footer = SHEET_FOOTERS[kind];
	return (
		<div
			aria-labelledby={`${kind}-mobile-nav-title`}
			aria-modal="true"
			className="border-border/60 border-b bg-background px-4 pt-3 pb-2 shadow-2xl"
			id="mobile-nav-sheet"
			ref={dialogRef}
			role="dialog"
			tabIndex={-1}
		>
			<div className="mb-2 flex items-center justify-between">
				<p className="font-semibold text-lg" id={`${kind}-mobile-nav-title`}>
					{SHEET_TITLES[kind]}
				</p>
				<button
					aria-label={`Close ${SHEET_TITLES[kind]} menu`}
					className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={onClose}
					type="button"
				>
					<X className="size-4" />
				</button>
			</div>
			<div className="max-h-[60vh] overflow-y-auto pr-1">
				{groups.map((group) => (
					<div className="mb-3" key={group.title}>
						<p className="mb-1 px-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
							{group.title}
						</p>
						<div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
							{group.links.map((link) => (
								<SheetLink
									external={link.external}
									href={link.href}
									key={`${link.href}-${link.label}`}
									label={link.label}
									onClose={onClose}
								/>
							))}
						</div>
					</div>
				))}
			</div>
			<div className="mt-1 border-border/60 border-t pt-2 pb-1">
				<SheetLink
					external={footer.external}
					href={footer.href}
					label={footer.label}
					onClose={onClose}
					primary
				/>
			</div>
		</div>
	);
}

export function MobileNav({ className }: MobileNavProps) {
	const pathname = usePathname();
	const [open, setOpen] = useState<SheetKey | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const wasOpen = useRef(false);

	// A navigation closes any open sheet — the destination is already chosen.
	useEffect(() => {
		setOpen(null);
	}, [pathname]);

	// Move focus into the sheet when it opens, and back to the button that opened
	// it when it closes. This keeps keyboard users in the same navigation context
	// instead of leaving focus behind the scrim.
	useEffect(() => {
		if (open) {
			wasOpen.current = true;
			const first = dialogRef.current
				? focusableElements(dialogRef.current)[0]
				: undefined;
			first?.focus();
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

	const tabClass = (active: boolean) =>
		cn(
			"relative flex w-full flex-col items-center justify-center gap-1 rounded-lg py-2 transition-colors",
			active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
		);

	return (
		<div
			className={cn("fixed right-0 bottom-0 left-0 z-50 md:hidden", className)}
		>
			<AnimatePresence>
				{open ? (
					<motion.button
						animate={{ opacity: 1 }}
						aria-label="Close menu"
						className="fixed inset-0 z-30 bg-black/40"
						exit={{ opacity: 0 }}
						initial={{ opacity: 0 }}
						key="backdrop"
						onClick={() => setOpen(null)}
						type="button"
					/>
				) : null}
				{open ? (
					<motion.div
						animate={{ opacity: 1, y: 0 }}
						className="absolute right-0 bottom-full left-0 z-50"
						exit={{ opacity: 0, y: 24 }}
						initial={{ opacity: 0, y: 24 }}
						key="sheet"
						transition={{ duration: 0.2, ease: "easeOut" }}
					>
						<Sheet
							dialogRef={dialogRef}
							kind={open}
							onClose={() => setOpen(null)}
						/>
					</motion.div>
				) : null}
			</AnimatePresence>

			<div className="relative h-20">
				<ProgressiveBlur
					blurAmount="24px"
					height="80px"
					position="bottom"
					useThemeBackground
				/>
				<nav
					aria-label="Mobile navigation"
					className="relative z-40 grid h-full grid-cols-5 items-center"
				>
					<Link className={tabClass(isTabActive("home", pathname))} href="/">
						<Home className="size-5" />
						<span className="text-xs">Home</span>
					</Link>

					{(
						[
							{ key: "products", icon: Package },
							{ key: "solutions", icon: Target },
							{ key: "resources", icon: BookOpen },
						] as const
					).map(({ key, icon: Icon }) => {
						const isOpen = open === key;
						return (
							<button
								aria-controls="mobile-nav-sheet"
								aria-expanded={isOpen}
								className={tabClass(isOpen || isTabActive(key, pathname))}
								key={key}
								onClick={(event) => {
									triggerRef.current = event.currentTarget;
									toggle(key);
								}}
								type="button"
							>
								<Icon className="size-5" />
								<span className="text-xs">{SHEET_TITLES[key]}</span>
								<ChevronUp
									className={cn(
										"absolute bottom-1 size-3 transition-transform",
										isOpen ? "rotate-180" : ""
									)}
								/>
							</button>
						);
					})}

					<Link
						className={cn(
							tabClass(isTabActive("download", pathname)),
							"relative"
						)}
						href="/download"
					>
						<span className="flex h-8 w-14 items-center justify-center rounded-full bg-foreground text-background">
							<Download className="size-5" />
						</span>
						<span className="text-xs">Download</span>
					</Link>
				</nav>
			</div>
		</div>
	);
}

export default MobileNav;
