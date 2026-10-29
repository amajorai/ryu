"use client";

import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { badgeVariants } from "@ryu/ui/components/badge";
import { Button, buttonVariants } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Logo } from "@ryu/ui/components/logo";
import {
	MotionNavigationMenu,
	MotionNavigationMenuItem,
	MotionNavigationMenuList,
} from "@ryu/ui/components/motion-navigation-menu";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { DOCS_URL } from "./data/resources.tsx";
import {
	LocalizedHeaderCopy,
	ProductsMenu,
	ResourcesMenu,
} from "./header-catalog-menus.tsx";
import { nextLinkHref } from "./next-link-href.ts";
import { ProgressiveBlur } from "./progressive-blur.tsx";

interface HeaderLink {
	external?: boolean;
	label: string;
	/** Open an external link in this tab (the docs share this header's chrome). */
	sameTab?: boolean;
	to: string;
}

function externalLinkTarget(link: HeaderLink) {
	return link.sameTab
		? {}
		: { rel: "noopener noreferrer", target: "_blank" as const };
}

// Top bar: Products and Resources menus, then Enterprise and Docs.
// Marketplace lives inside the Products menu and Pricing inside Resources.
const MARKETING_LINKS: readonly HeaderLink[] = [
	{ to: "/enterprise", label: "Enterprise" },
	{ to: DOCS_URL, label: "Docs", external: true, sameTab: true },
];

const NO_HIDDEN_PRODUCTS: readonly string[] = [];

function isHeaderLinkActive(pathname: string, link: HeaderLink) {
	return (
		!link.external &&
		(pathname === link.to || pathname.startsWith(`${link.to}/`))
	);
}

function HeaderLinkList({
	links,
	pathname,
	portal = false,
}: {
	links: readonly HeaderLink[];
	pathname: string;
	portal?: boolean;
}) {
	return (
		<>
			{links.map((link) => {
				const active = isHeaderLinkActive(pathname, link);
				const className = portal
					? cn(
							"relative inline-flex h-12 shrink-0 items-center rounded-none px-3 font-medium text-sm transition-colors after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
							active
								? "text-foreground after:bg-foreground"
								: "text-muted-foreground hover:text-foreground"
						)
					: cn(
							// Same h-9/px-3 box as the menu triggers beside them.
							buttonVariants({
								radius: "pill",
								size: "default",
								variant: "ghost",
							}),
							"text-foreground hover:bg-muted hover:text-foreground",
							active && "bg-muted text-foreground"
						);
				if (link.external) {
					return (
						<a
							className={className}
							data-cuelume-hover="tick"
							href={link.to}
							key={link.to}
							{...externalLinkTarget(link)}
						>
							<LocalizedHeaderCopy value={link.label} />
						</a>
					);
				}
				return (
					<Link
						aria-current={active ? "page" : undefined}
						className={className}
						data-cuelume-hover="tick"
						href={nextLinkHref(link.to)}
						key={link.to}
					>
						<LocalizedHeaderCopy value={link.label} />
					</Link>
				);
			})}
		</>
	);
}

function PortalMobileNavigation({
	links,
	pathname,
}: {
	links: readonly HeaderLink[];
	pathname: string;
}) {
	const localizedNavigationLabel = useLocalizedString(
		"Open workspace navigation"
	);
	if (links.length === 0) {
		return null;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={localizedNavigationLabel}
				className="md:hidden"
				render={<Button size="icon-sm" variant="ghost" />}
			>
				<Menu aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="min-w-52"
				withBackdrop={false}
			>
				<div className="p-1">
					<DropdownMenuGroup>
						<DropdownMenuLabel>Workspace</DropdownMenuLabel>
						{links.map((link) => {
							const active = isHeaderLinkActive(pathname, link);
							return (
								<DropdownMenuItem
									active={active}
									key={link.to}
									render={
										link.external ? (
											<a href={link.to} {...externalLinkTarget(link)} />
										) : (
											<Link href={nextLinkHref(link.to)} />
										)
									}
								>
									{link.label}
								</DropdownMenuItem>
							);
						})}
					</DropdownMenuGroup>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default function Header({
	className,
	userMenu,
	mobileActions,
	orgSlot,
	portalUtilityMenu,
	portalContextNav,
	inverse = false,
	links = MARKETING_LINKS,
	showCatalogMenus = true,
	homeHref = "/",
	hiddenProductIds = NO_HIDDEN_PRODUCTS,
	// Account controls come from userMenu; signed-out portal pages show the brand link.
	signedIn = false,
	transparent = false,
	variant = "marketing",
}: {
	className?: string;
	signedIn?: boolean;
	/** Render the portal chrome with foreground/background roles inverted. */
	inverse?: boolean;
	variant?: "marketing" | "portal";
	userMenu?: ReactNode;
	/** Optional marketing actions shown beside the logo on narrow screens. */
	mobileActions?: ReactNode;
	/**
	 * Workspace context rendered after the account controls in the portal header.
	 * Portal surfaces pass the organization switcher here so the current workspace
	 * stays visible while people move between the primary routes.
	 */
	orgSlot?: ReactNode;
	/** Utility actions kept on the right side of the portal header. */
	portalUtilityMenu?: ReactNode;
	/** Contextual tabs rendered in the portal header instead of the global nav. */
	portalContextNav?: ReactNode;
	/** Nav links to render. Defaults to the marketing links. */
	links?: readonly HeaderLink[];
	/**
	 * Whether to render the marketing Products/Resources menus. Portal
	 * surfaces pass `false` so the header shows only the provided `links`. The
	 * signed-in Console shortcut now lives in the user menu dropdown.
	 */
	showCatalogMenus?: boolean;
	/** Where the home link goes. Signed-in portal surfaces omit the brand link. */
	homeHref?: string;
	/**
	 * Product realm ids the host has not rolled out (a standalone service whose
	 * rollout flag is off). They are dropped from the Products menu.
	 */
	hiddenProductIds?: readonly string[];
	/** Let a landing visual continue behind the marketing header. */
	transparent?: boolean;
}) {
	const pathname = usePathname();
	const localizedBackToConsole = useLocalizedString("Back to Console");
	const localizedConsole = useLocalizedText("Console", { literal: true });
	const localizedWorkspaceNavigation = useLocalizedString(
		"Workspace navigation"
	);
	const localizedResearchPreview = useLocalizedText("Research Preview", {
		literal: true,
	});
	const localizedHomeLabel = useLocalizedString("Ryu home");

	if (variant === "portal") {
		return (
			<div className={cn("relative", className)}>
				<div
					className={cn(
						"backdrop-blur-xl",
						inverse ? "bg-foreground text-background" : "bg-background/85"
					)}
				>
					<div className="mx-auto w-full max-w-7xl">
						<div className="flex min-h-14 items-center gap-2 px-4 sm:px-6">
							{signedIn ? null : (
								<Link
									aria-label="Ryu home"
									className="flex shrink-0 items-center"
									data-cuelume-hover="tick"
									href={nextLinkHref(homeHref)}
								>
									<Logo size="28px" variant="outline" />
								</Link>
							)}
							{userMenu ? (
								<div className="flex min-w-0 items-center gap-1.5">
									{userMenu}
								</div>
							) : null}
							{orgSlot ? (
								<div className="flex min-w-0 items-center gap-2">
									<span
										aria-hidden="true"
										className={cn(
											"select-none text-lg",
											inverse
												? "text-background/40"
												: "text-muted-foreground/40"
										)}
									>
										/
									</span>
									<div className="min-w-0">{orgSlot}</div>
								</div>
							) : null}
							{portalUtilityMenu ? (
								<div className="ml-auto flex items-center gap-1.5">
									{portalUtilityMenu}
								</div>
							) : null}
						</div>
						{portalContextNav ? (
							<div className="flex min-h-12 items-center gap-3 px-4 sm:px-6">
								<Link
									aria-label={localizedBackToConsole}
									className={cn(
										"inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
										inverse
											? "text-background/70 hover:bg-background/10 hover:text-background focus-visible:ring-background"
											: "text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring"
									)}
									data-cuelume-hover="tick"
									href="/console"
								>
									<ArrowLeft aria-hidden="true" className="size-4" />
									<span>{localizedConsole}</span>
								</Link>
								<div className="min-w-0 flex-1 overflow-x-auto">
									{portalContextNav}
								</div>
							</div>
						) : links.length > 0 ? (
							<div className="flex min-h-12 items-center px-4 sm:px-6">
								<nav
									aria-label={localizedWorkspaceNavigation}
									className="hidden items-center gap-0.5 md:flex"
								>
									<HeaderLinkList links={links} pathname={pathname} portal />
								</nav>
								<div className="ml-auto md:hidden">
									<PortalMobileNavigation links={links} pathname={pathname} />
								</div>
							</div>
						) : null}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn(className ? undefined : "relative", className)}
			data-transparent={transparent ? "true" : undefined}
		>
			<ProgressiveBlur
				backgroundColor={
					transparent
						? "color-mix(in oklab, var(--background) 38%, transparent)"
						: undefined
				}
				blurAmount="12px"
				className="absolute inset-0 z-0"
				height={transparent ? "176px" : "100px"}
				position="top"
			/>

			<div
				className={cn(
					"relative z-10 flex flex-row items-center justify-between gap-4 p-4 px-4 sm:px-6 lg:px-10",
					// Below md the bar sits over scrolling content; give it a tinted surface.
					// The transparent landing header keeps its own scrim.
					transparent
						? undefined
						: "max-md:bg-background/85 max-md:backdrop-blur-xl"
				)}
			>
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<Link
						className="-m-1.5 flex min-h-10 min-w-0 items-center gap-4 p-1.5"
						data-cuelume-hover="tick"
						href={nextLinkHref(homeHref)}
					>
						<Logo size="28px" variant="outline" />
						{/* The logo is decorative and the badge is hidden below lg, so the
						    link needs text of its own. Not aria-label: that would drop the
						    visible badge from the name (label in name). */}
						<span className="sr-only">{localizedHomeLabel}</span>
						<span
							className={cn(
								badgeVariants({ variant: "secondary" }),
								// Glass pill: a translucent fill and hairline over a backdrop blur,
								// so the hero sky shows through it.
								"hidden shrink-0 rounded-bl-lg border border-foreground/10 bg-foreground/[0.06] shadow-[inset_0_1px_0_--theme(--color-white/12%)] backdrop-blur-md backdrop-saturate-150 lg:inline-flex dark:bg-white/[0.08]"
							)}
							data-slot="badge"
						>
							{localizedResearchPreview}
						</span>
					</Link>
					{orgSlot ? (
						<div className="flex items-center gap-3">
							<span
								aria-hidden="true"
								className="select-none text-lg text-muted-foreground/40"
							>
								/
							</span>
							{orgSlot}
						</div>
					) : null}
				</div>

				<nav className="hidden shrink-0 items-center gap-1 font-medium md:flex">
					{showCatalogMenus && (
						<MotionNavigationMenu
							viewportAppearance="marketing"
							// A slightly raised panel in dark mode, so the menu reads as an
							// object above the page rather than a hole in it.
							viewportClassName="dark:bg-[oklch(0.17_0_0)]"
						>
							<MotionNavigationMenuList>
								<MotionNavigationMenuItem value="products">
									<ProductsMenu
										hiddenProductIds={hiddenProductIds}
										pathname={pathname}
									/>
								</MotionNavigationMenuItem>

								<MotionNavigationMenuItem value="resources">
									<ResourcesMenu pathname={pathname} />
								</MotionNavigationMenuItem>
							</MotionNavigationMenuList>
						</MotionNavigationMenu>
					)}

					<HeaderLinkList links={links} pathname={pathname} />
				</nav>

				{mobileActions ? (
					<div className="flex min-w-0 flex-1 items-center justify-end md:hidden [&>a]:min-h-10">
						{mobileActions}
					</div>
				) : null}
				<div className="hidden min-w-0 flex-1 items-center justify-end md:flex">
					{userMenu}
				</div>
			</div>
		</div>
	);
}
