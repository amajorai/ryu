"use client";

import { Badge } from "@ryu/ui/components/badge";
import { buttonVariants } from "@ryu/ui/components/button";
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
import { Link2 } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { type ProductCategory, productsByCategory } from "./data/products.tsx";
import {
	DOCS_URL,
	resourceCategories,
	resourcesByCategory,
} from "./data/resources.tsx";
import { solutionCategories, solutionsByCategory } from "./data/solutions.ts";
import { GitHubStars } from "./github-stars.tsx";
import { ProgressiveBlur } from "./progressive-blur.tsx";

interface HeaderLink {
	external?: boolean;
	label: string;
	to: string;
}

// Header stays minimal: the Products, Solutions, and Resources mega-menus are
// the primary nav. Docs, Marketplace, Compare, Pricing, Engines, Blog,
// Changelog, and Help now live inside the Resources dropdown (and the footer)
// to keep the top bar uncluttered, so the marketing header ships no extra
// flat links by default.
const MARKETING_LINKS: readonly HeaderLink[] = [];

// Public link to the open-source Core repository, surfaced next to the Resources
// menu so visitors can jump straight to the code.
const GITHUB_CORE_URL = "https://github.com/amajorai/ryu";

function ProductCategoryColumn({ category }: { category: ProductCategory }) {
	return (
		<div>
			<p className="mb-2 px-3 font-medium text-muted-foreground text-sm">
				{category}
			</p>
			<div>
				{productsByCategory(category).map((product) => (
					<MotionNavigationMenuLink
						className="px-3 py-1"
						key={product.slug}
						render={<Link href={`/products/${product.slug}`} />}
					>
						<span className="font-semibold text-foreground text-xl tracking-tight transition-colors hover:text-accent-foreground">
							{product.navLabel}
						</span>
					</MotionNavigationMenuLink>
				))}
			</div>
		</div>
	);
}

export default function Header({
	className,
	userMenu,
	orgSlot,
	links = MARKETING_LINKS,
	showCatalogMenus = true,
	homeHref = "/",
	githubStargazersCount,
	signedIn = false,
}: {
	className?: string;
	signedIn?: boolean;
	userMenu?: ReactNode;
	/**
	 * Vercel-style breadcrumb slot rendered immediately after the logo/badge,
	 * separated by a muted "/". Portal surfaces pass the org switcher here so it
	 * reads as `logo / [org ▾]`. Presentational only — the block owns the
	 * separator, the caller owns the control.
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
	/** Cached GitHub star count for the open-source repo (marketing header). */
	githubStargazersCount?: number | null;
}) {
	const pathname = usePathname();

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
									<MotionNavigationMenuTrigger
										className={cn(
											pathname.startsWith("/products") &&
												"text-accent-foreground"
										)}
									>
										Products
									</MotionNavigationMenuTrigger>
									<MotionNavigationMenuContent>
										<div className="grid w-[760px] grid-cols-2 gap-x-6 gap-y-7 p-2">
											<ProductCategoryColumn category="Build" />
											<ProductCategoryColumn category="Platform" />
											<div className="flex flex-col gap-y-5">
												<ProductCategoryColumn category="Developers" />
												<ProductCategoryColumn category="Ecosystem" />
											</div>
											<div className="row-span-2 row-start-2 self-start">
												<ProductCategoryColumn category="Surfaces" />
											</div>
										</div>
										<div className="mt-1 border-border/60 border-t px-3 pt-2.5">
											<MotionNavigationMenuLink
												className="px-3"
												render={<Link href="/products" />}
											>
												<span className="font-medium text-foreground text-sm">
													View all products →
												</span>
											</MotionNavigationMenuLink>
										</div>
									</MotionNavigationMenuContent>
								</MotionNavigationMenuItem>

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
														Sell & operate agents
													</p>
													<p className="truncate text-muted-foreground text-xs">
														Refer, build an agency, or host for clients
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

								<MotionNavigationMenuItem value="resources">
									<MotionNavigationMenuTrigger
										className={cn(
											(pathname.startsWith("/docs") ||
												pathname.startsWith("/marketplace") ||
												pathname.startsWith("/compare") ||
												pathname.startsWith("/pricing") ||
												pathname.startsWith("/engines") ||
												pathname.startsWith("/subscriptions") ||
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

					{signedIn ? null : (
						<a
							className={cn(
								buttonVariants({ variant: "ghost" }),
								"gap-2 rounded-4xl px-3 font-medium hover:bg-muted hover:text-foreground"
							)}
							href={GITHUB_CORE_URL}
							rel="noopener noreferrer"
							target="_blank"
						>
							Open Source
							{githubStargazersCount != null && githubStargazersCount > 0 ? (
								<GitHubStars stargazersCount={githubStargazersCount} />
							) : null}
						</a>
					)}

					{links.map(({ to, label, external }) => {
						const isActive = !external && pathname.startsWith(to);
						return (
							<a
								className={cn(
									buttonVariants({ variant: "ghost" }),
									"hover:bg-muted hover:text-foreground",
									isActive && "bg-muted"
								)}
								href={to}
								key={to}
								rel={external ? "noopener noreferrer" : undefined}
								target={external ? "_blank" : "_self"}
							>
								{label}
							</a>
						);
					})}
				</nav>

				<div className="hidden flex-1 items-center justify-end md:flex">
					{userMenu}
				</div>
			</div>
		</div>
	);
}
