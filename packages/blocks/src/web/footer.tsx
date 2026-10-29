"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { Heart } from "lucide-react";
import type { ReactNode } from "react";
import { BackToTop } from "./back-to-top.tsx";
import { DOCS_URL } from "./data/resources.tsx";
import FooterBuildInfo from "./footer-build-info.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

const footerContainerClass = "w-full px-6 md:px-10 lg:px-16";
const legalLinkClass =
	"inline-flex min-h-10 items-center transition-colors hover:text-foreground sm:min-h-0";

// Cache Components requires client prerenders to be deterministic.
const COPYRIGHT_YEAR = 2026;

interface FooterLink {
	external?: boolean;
	href: string;
	label: string;
}

/* Link columns follow the header's product taxonomy. Each href appears once;
 * Contact stays in the legal row below. Products lists released products only
 * (early-access ones stay reachable from /products); Platform leads with the
 * infrastructure and ends with the managed services. */
export const FOOTER_COLUMNS: readonly {
	links: readonly FooterLink[];
	title: string;
}[] = [
	{
		title: "Products",
		links: [
			{ href: "/products/desktop", label: "Ryu Desktop" },
			{ href: "/bot", label: "Bot" },
			{ href: "/agent", label: "Agent" },
			{ href: "/marketplace", label: "Marketplace" },
			{ href: "/products", label: "All products" },
		],
	},
	{
		title: "Platform",
		links: [
			{ href: "/products/core", label: "Ryu Core" },
			{ href: "/products/gateway", label: "Ryu Gateway" },
			{ href: "/products/cloud", label: "Ryu Cloud" },
			{
				href: "/products/agents-as-a-service",
				label: "Agents as a Service",
			},
			{ href: "/products/red-team", label: "Red Teaming" },
		],
	},
	{
		title: "Resources",
		links: [
			{ href: DOCS_URL, label: "Docs", external: true },
			{ href: "/academy", label: "Academy" },
			{ href: "/guides", label: "Guides" },
			{ href: "/changelog", label: "Changelog" },
			{ href: "/help", label: "Help Center" },
			{ href: "/platform#infra", label: "Self-hosted" },
		],
	},
	{
		title: "Company",
		links: [
			{ href: "/enterprise", label: "Enterprise" },
			{ href: "/security", label: "Security" },
			{ href: "/partners", label: "Partners" },
			{ href: "/blog", label: "Blog" },
		],
	},
	{
		title: "Get started",
		links: [
			{ href: "/download", label: "Download" },
			{ href: "/pricing", label: "Pricing" },
			{ href: "/compare", label: "Compare" },
			{ href: "/subscriptions", label: "Bring your subscription" },
			{ href: "/login", label: "Sign in" },
		],
	},
];

const PRODUCT_PAGE_HREF = /^\/products\/([^/?#]+)$/u;
const NO_HIDDEN_PRODUCTS: readonly string[] = [];

/**
 * `FOOTER_COLUMNS` without the product pages in `hiddenProductIds` (the host's
 * closed or unlaunched product slugs, the list the header hides). A column
 * left empty is dropped; the shared column data is never edited.
 */
export function footerColumnsFor(hiddenProductIds: readonly string[] = []) {
	const hidden = new Set(hiddenProductIds);
	return FOOTER_COLUMNS.flatMap((column) => {
		const links = column.links.filter(
			(link) => !hidden.has(PRODUCT_PAGE_HREF.exec(link.href)?.[1] ?? "")
		);
		return links.length > 0 ? [{ ...column, links }] : [];
	});
}

function LocalizedFooterCopy({ value }: { value: string }) {
	return <>{useLocalizedText(value, { literal: true })}</>;
}

export default function Footer({
	cookieSettings,
	githubStargazersCount,
	hiddenProductIds = NO_HIDDEN_PRODUCTS,
	languagePicker,
	soundToggle,
}: {
	cookieSettings?: ReactNode;
	githubStargazersCount?: number | null;
	/** Product slugs the host has not rolled out; their links are left out. */
	hiddenProductIds?: readonly string[];
	languagePicker?: ReactNode;
	soundToggle?: ReactNode;
}) {
	const localizedHeroTitle = useLocalizedText(
		"Run agents with the tools and rules they need.",
		{ literal: true }
	);
	return (
		<footer className="pt-8 pb-16 md:pt-16">
			{/* Full-bleed shell: the link columns spread across the whole viewport. */}
			<div className={footerContainerClass}>
				{/* Positioning line, then the link columns */}
				<div className="mb-12 grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
					<div className="hidden lg:block">
						{/* A tagline, not a heading. The column titles below are h3, one
						    step under the page's h2 sections; they were h4 under this
						    line, which is hidden below lg, so mobile skipped a level. */}
						<p className="max-w-sm text-balance font-medium text-2xl">
							{localizedHeroTitle}
						</p>
					</div>

					<nav
						aria-label="Footer"
						className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3 lg:grid-cols-5"
					>
						{footerColumnsFor(hiddenProductIds).map((column) => (
							<div key={column.title}>
								<h3 className="mb-4 font-medium">
									<LocalizedFooterCopy value={column.title} />
								</h3>
								<div className="space-y-0">
									{column.links.map((link) => (
										<a
											className="block py-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground md:py-1.5"
											href={link.href}
											key={link.href}
											rel={link.external ? "noopener noreferrer" : undefined}
											target={link.external ? "_blank" : undefined}
										>
											<LocalizedFooterCopy value={link.label} />
										</a>
									))}
								</div>
							</div>
						))}
					</nav>
				</div>

				{/* Bottom bar: two balanced rows instead of a stacked left column.
				    Row 1: legal links | display controls. Row 2: company | build + credit. */}
				<div className="mt-16 flex flex-col gap-6 text-muted-foreground text-sm md:mt-24">
					<div className="flex flex-col-reverse items-start justify-between gap-4 sm:flex-row sm:items-center">
						<nav
							aria-label="Legal"
							className="flex flex-wrap items-center gap-x-6 gap-y-2"
						>
							<a className={legalLinkClass} href="/privacy">
								<LocalizedFooterCopy value="Privacy" />
							</a>
							<a className={legalLinkClass} href="/terms">
								<LocalizedFooterCopy value="Terms" />
							</a>
							<a className={legalLinkClass} href="/dpa">
								<LocalizedFooterCopy value="DPA" />
							</a>
							<a className={legalLinkClass} href="/contact">
								<LocalizedFooterCopy value="Contact" />
							</a>
							{cookieSettings}
						</nav>
						{/* The theme, sound and back-to-top buttons are outlined circles; the language
						    trigger sizes to its label so the chevron sits beside it. */}
						<div className="flex items-center gap-2 [&>button]:size-10 [&>button]:rounded-full [&>button]:border [&>button]:border-border sm:[&>button]:size-8 [&_[data-slot=select-trigger]]:w-auto [&_[data-slot=select-trigger]]:gap-1.5 [&_[data-slot=select-trigger]]:border [&_[data-slot=select-trigger]]:border-border">
							{languagePicker}
							{soundToggle}
							<ThemeToggle />
							<BackToTop />
						</div>
					</div>

					<div className="flex flex-col items-start justify-between gap-3 text-xs sm:flex-row sm:items-center">
						<p itemScope itemType="https://schema.org/Organization">
							© {COPYRIGHT_YEAR} <span itemProp="name">A Major Pte. Ltd.</span>
							<span className="hidden md:inline">
								{" "}
								· <span itemProp="location">Singapore</span> · UEN{" "}
								<span itemProp="taxID">202616096G</span>
							</span>
							<meta content="2026-04-12" itemProp="foundingDate" />
							<meta content="https://amajor.ai" itemProp="url" />
							<meta
								content="A Major is a Singapore-based software agency specialising in web design, software development, and digital solutions for businesses."
								itemProp="description"
							/>
						</p>
						<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
							{/* Below sm the GitHub and release links get a 40px tap target. */}
							<div className="max-sm:[&_a[aria-label]]:min-w-10 max-sm:[&_a[aria-label]]:justify-center max-sm:[&_a]:inline-flex max-sm:[&_a]:min-h-10 max-sm:[&_a]:items-center">
								<FooterBuildInfo
									githubStargazersCount={githubStargazersCount}
								/>
							</div>
							<span className="inline-flex items-center gap-1">
								<LocalizedFooterCopy value="Designed with" />
								<Heart
									aria-label="love"
									className="size-3 fill-red-400 text-red-400 dark:fill-red-400/90 dark:text-red-400/90"
									role="img"
								/>
								<LocalizedFooterCopy value="& powered by Ryu" />
							</span>
						</div>
					</div>
				</div>
			</div>
		</footer>
	);
}
