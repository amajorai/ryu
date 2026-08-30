"use client";

import { Badge } from "@ryu/ui/components/badge";
import { buttonVariants } from "@ryu/ui/components/button";
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
	MotionNavigationMenuContent,
	MotionNavigationMenuItem,
	MotionNavigationMenuLink,
	MotionNavigationMenuList,
	MotionNavigationMenuTrigger,
} from "@ryu/ui/components/motion-navigation-menu";
import { cn } from "@ryu/ui/lib/utils";
import { Menu } from "lucide-react";
// import { Link2 } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PRODUCT_REALMS } from "./data/product-realms.ts";
import {
	DOCS_URL,
	resourceCategories,
	resourcesByCategory,
} from "./data/resources.tsx";
// import { solutionCategories, solutionsByCategory } from "./data/solutions.ts";
import { ProgressiveBlur } from "./progressive-blur.tsx";

interface HeaderLink {
	external?: boolean;
	label: string;
	to: string;
}

// Header stays minimal: the Products menu shows Ryu's mental model — workspaces
// and standalone services on top, with the open platform and infrastructure
// underneath. Solutions and Resources remain separate; Marketplace is the one
// flat link for discovering everything an agent can run.
const MARKETING_LINKS: readonly HeaderLink[] = [
	{ to: "/marketplace", label: "Marketplace" },
];

const SURFACE_LINKS = [
	...PRODUCT_REALMS.filter((realm) =>
		["os", "bot", "console", "box", "mail", "notify", "hire"].includes(realm.id)
	).map(({ href, shortLabel }) => ({ href, label: shortLabel })),
	{ href: "/marketplace/apps", label: "Apps" },
];

const PLATFORM_LINKS = [
	...PRODUCT_REALMS.filter((realm) => realm.id === "gateway").map(
		({ href, shortLabel }) => ({ href, label: shortLabel })
	),
	{
		href: "/products/sdk",
		label: "SDKs",
	},
	{
		href: "/products/core",
		label: "Core",
	},
] as const;

const INFRA_LINKS = [
	{
		href: "/platform#infra",
		label: "Cloud",
	},
	{
		href: "/platform#infra",
		label: "Self-hosted",
	},
] as const;

function ProductLinkGroup({
	links,
	title,
}: {
	links: readonly { href: string; label: string }[];
	title: string;
}) {
	return (
		<div>
			<p className="mb-2 px-3 font-medium text-muted-foreground text-sm">
				{title}
			</p>
			<div>
				{links.map((product) => (
					<MotionNavigationMenuLink
						className="px-3 py-1"
						key={product.label}
						render={<Link href={product.href as Route} />}
					>
						<span className="font-semibold text-foreground text-xl tracking-tight transition-colors hover:text-accent-foreground">
							{product.label}
						</span>
					</MotionNavigationMenuLink>
				))}
			</div>
		</div>
	);
}

function PrimaryProductLinks() {
	return (
		<div>
			<div className="grid w-[760px] grid-cols-3 gap-x-6 gap-y-7 p-2">
				<ProductLinkGroup links={SURFACE_LINKS} title="Products" />
				<ProductLinkGroup links={PLATFORM_LINKS} title="Platform" />
				<ProductLinkGroup links={INFRA_LINKS} title="Infrastructure" />
			</div>
			<div className="mt-1 border-border/60 border-t px-3 pt-2.5">
				<MotionNavigationMenuLink
					className="px-3"
					render={<Link href="/platform" />}
				>
					<span className="font-medium text-foreground text-sm">
						Explore the platform →
					</span>
				</MotionNavigationMenuLink>
			</div>
		</div>
	);
}

function ProductsMenu({ pathname }: { pathname: string }) {
	return (
		<>
			<MotionNavigationMenuTrigger
				className={cn(
					(pathname.startsWith("/products") ||
						pathname === "/bot" ||
						pathname === "/console" ||
						pathname === "/build" ||
						pathname === "/platform" ||
						pathname.startsWith("/marketplace/apps")) &&
						"bg-muted"
				)}
			>
				Products
			</MotionNavigationMenuTrigger>
			<MotionNavigationMenuContent>
				<PrimaryProductLinks />
			</MotionNavigationMenuContent>
		</>
	);
}

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
							buttonVariants({ size: "sm", variant: "ghost" }),
							"text-foreground hover:bg-muted hover:text-foreground",
							active && "bg-muted text-foreground"
						);
				if (link.external) {
					return (
						<a
							className={className}
							href={link.to}
							key={link.to}
							rel="noopener noreferrer"
							target="_blank"
						>
							{link.label}
						</a>
					);
				}
				return (
					<Link
						aria-current={active ? "page" : undefined}
						className={className}
						href={link.to as Route}
						key={link.to}
					>
						{link.label}
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
	if (links.length === 0) {
		return null;
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label="Open workspace navigation"
				className={cn(
					buttonVariants({ size: "icon-sm", variant: "ghost" }),
					"md:hidden"
				)}
			>
				<Menu aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="min-w-52 p-1"
				withBackdrop={false}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Workspace</DropdownMenuLabel>
					{links.map((link) => {
						const active = isHeaderLinkActive(pathname, link);
						return (
							<DropdownMenuItem
								className={cn(active && "bg-foreground/10")}
								key={link.to}
								render={
									link.external ? (
										<a
											href={link.to}
											rel="noopener noreferrer"
											target="_blank"
										/>
									) : (
										<Link href={link.to as Route} />
									)
								}
							>
								{link.label}
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export default function Header({
	className,
	userMenu,
	orgSlot,
	links = MARKETING_LINKS,
	showCatalogMenus = true,
	homeHref = "/",
	signedIn = false,
	variant = "marketing",
}: {
	className?: string;
	signedIn?: boolean;
	variant?: "marketing" | "portal";
	userMenu?: ReactNode;
	/**
	 * Workspace context rendered immediately after the logo/badge. Portal surfaces
	 * pass the organization switcher here so the current workspace stays visible
	 * while people move between the primary routes.
	 */
	orgSlot?: ReactNode;
	/** Nav links to render. Defaults to the marketing links. */
	links?: readonly HeaderLink[];
	/**
	 * Whether to render the marketing Products/Solutions mega-menus. Portal
	 * surfaces pass `false` so the header shows only the provided `links`. The
	 * signed-in Dashboard shortcut now lives in the user menu dropdown.
	 */
	showCatalogMenus?: boolean;
	/** Where the logo links to. Marketing → "/", portal → "/dashboard". */
	homeHref?: string;
}) {
	const pathname = usePathname();

	if (variant === "portal") {
		return (
			<div className={cn("relative", className)}>
				<div className="border-border/70 border-b bg-background/85 backdrop-blur-xl">
					<div className="mx-auto w-full max-w-7xl">
						<div className="flex min-h-14 items-center gap-3 px-4 sm:gap-4 sm:px-6">
							<Link
								className="group flex shrink-0 items-center gap-2"
								href={homeHref as Route}
							>
								<Logo
									className="text-foreground"
									size="26px"
									variant="outline-static"
								/>
								<span className="font-heading font-medium text-base tracking-tight">
									ryu
								</span>
								<Badge
									className="hidden rounded-full text-[10px] sm:inline-flex"
									variant="secondary"
								>
									Preview
								</Badge>
							</Link>
							{orgSlot ? (
								<div className="min-w-0 border-border/70 border-l pl-3 sm:pl-4">
									{orgSlot}
								</div>
							) : null}

							<div className="ml-auto flex items-center gap-1.5">
								<div className="flex items-center gap-1.5">{userMenu}</div>
							</div>
						</div>
						{links.length > 0 ? (
							<div className="flex min-h-12 items-center px-4 sm:px-6">
								<nav
									aria-label="Workspace navigation"
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
		<div className={`relative ${className ?? ""}`}>
			{/* Progressive blur background */}
			<ProgressiveBlur
				blurAmount="12px"
				className="absolute inset-0 z-0"
				height="100px"
				position="top"
				useThemeBackground
			/>

			<div className="relative z-10 flex flex-row items-center justify-between p-4 px-10">
				<div className="flex flex-1 items-center gap-3">
					<Link className="flex items-center gap-4" href={homeHref as Route}>
						<Logo size="28px" variant="outline" />
						<Badge className="rounded-bl-lg" variant="secondary">
							Research Preview
						</Badge>
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

				<nav className="hidden items-center font-medium md:flex">
					{showCatalogMenus && (
						<MotionNavigationMenu viewportClassName="shadow-none">
							<MotionNavigationMenuList>
								<MotionNavigationMenuItem value="products">
									<ProductsMenu pathname={pathname} />
								</MotionNavigationMenuItem>

								{/* Solutions menu paused until the product hierarchy is settled. */}
								{/*
								<MotionNavigationMenuItem value="solutions">
									<MotionNavigationMenuTrigger
										className={cn(
											pathname.startsWith("/for") && "text-accent-foreground"
										)}
									>
										Solutions
									</MotionNavigationMenuTrigger>
									<MotionNavigationMenuContent>
										<div className="grid w-[820px] grid-cols-3 gap-x-6 gap-y-7 p-2">
											{solutionCategories.map((category) => (
												<div key={category}>
													<p className="mb-2 px-3 font-medium text-muted-foreground text-sm">
														{category}
													</p>
													<div>
														{solutionsByCategory(category).map((solution) => (
															<MotionNavigationMenuLink
																className="px-3 py-1"
																key={solution.slug}
																render={
																	<Link
																		href={`/for/${solution.slug}` as Route}
																	/>
																}
															>
																<span className="font-semibold text-foreground text-xl tracking-tight transition-colors hover:text-accent-foreground">
																	{solution.navLabel}
																</span>
															</MotionNavigationMenuLink>
														))}
													</div>
												</div>
											))}
										</div>
										<div className="mt-1 space-y-1 border-border/60 border-t px-3 pt-2.5">
											<MotionNavigationMenuLink
												className="flex-row items-center gap-2.5 rounded-lg bg-muted/50 px-3 py-2.5"
												render={<Link href={"/for/agent-operators" as Route} />}
											>
												<Link2
													className="size-4 shrink-0 text-foreground/70"
													strokeWidth={1.5}
												/>
												<div className="min-w-0">
													<p className="font-medium text-foreground text-sm">
														Run AI for clients
													</p>
													<p className="truncate text-muted-foreground text-xs">
														Help teams make AI safe and repeatable
													</p>
												</div>
											</MotionNavigationMenuLink>
											<MotionNavigationMenuLink
												className="px-3"
												render={<Link href="/for" />}
											>
												<span className="font-medium text-foreground text-sm">
													View all roles →
												</span>
											</MotionNavigationMenuLink>
										</div>
									</MotionNavigationMenuContent>
								</MotionNavigationMenuItem>
								*/}

								<MotionNavigationMenuItem value="resources">
									<MotionNavigationMenuTrigger
										className={cn(
											(pathname.startsWith("/docs") ||
												pathname.startsWith("/academy") ||
												pathname.startsWith("/certifications") ||
												pathname.startsWith("/marketplace") ||
												pathname.startsWith("/compare") ||
												pathname.startsWith("/pricing") ||
												pathname.startsWith("/subscriptions") ||
												pathname.startsWith("/community") ||
												pathname.startsWith("/blog") ||
												pathname.startsWith("/changelog") ||
												pathname.startsWith("/help")) &&
												"text-accent-foreground"
										)}
									>
										Resources
									</MotionNavigationMenuTrigger>
									<MotionNavigationMenuContent>
										<div className="grid w-[820px] grid-cols-3 gap-x-6 gap-y-7 p-2">
											{resourceCategories.map((category) => (
												<div key={category}>
													<p className="mb-2 px-3 font-medium text-muted-foreground text-sm">
														{category}
													</p>
													<div>
														{resourcesByCategory(category).map((resource) => (
															<MotionNavigationMenuLink
																className="px-3 py-1"
																key={resource.href}
																render={
																	<Link
																		href={resource.href as Route}
																		rel={
																			resource.external
																				? "noopener noreferrer"
																				: undefined
																		}
																		target={
																			resource.external ? "_blank" : undefined
																		}
																	/>
																}
															>
																<span className="font-semibold text-foreground text-xl tracking-tight transition-colors hover:text-accent-foreground">
																	{resource.label}
																</span>
															</MotionNavigationMenuLink>
														))}
													</div>
												</div>
											))}
										</div>
										<div className="mt-1 border-border/60 border-t px-3 pt-2.5">
											<MotionNavigationMenuLink
												className="px-3"
												render={
													<Link
														href={DOCS_URL as Route}
														rel="noopener noreferrer"
														target="_blank"
													/>
												}
											>
												<span className="font-medium text-foreground text-sm">
													Read the docs →
												</span>
											</MotionNavigationMenuLink>
										</div>
									</MotionNavigationMenuContent>
								</MotionNavigationMenuItem>
							</MotionNavigationMenuList>
						</MotionNavigationMenu>
					)}

					<HeaderLinkList links={links} pathname={pathname} />
				</nav>

				<div className="hidden flex-1 items-center justify-end md:flex">
					{userMenu}
				</div>
			</div>
		</div>
	);
}
