"use client";

import {
	useLiteralMessages,
	useLocalizedText,
	useRichLiteralMessages,
} from "@ryu/i18n/react";
import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { ChevronDown, Heart } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { BackToTop } from "./back-to-top.tsx";
import { COMPANY } from "./data/company.ts";
import { DOCS_URL, docsHref } from "./data/resources.tsx";
import FooterBuildInfo from "./footer-build-info.tsx";
import {
	FOOTER_COMMUNITY_LINKS,
	FOOTER_DOCS_HOME,
	FOOTER_LEGAL_LINKS,
	FOOTER_START_LINKS,
	FOOTER_TAGLINE,
	type FooterColumn,
	type FooterLink,
	footerColumnsFor,
} from "./footer-links.ts";
import { ThemeToggle } from "./theme-toggle.tsx";

// Kept importable from the component module, where hosts and tests found it.
export {
	FOOTER_COLUMNS,
	type FooterColumn,
	type FooterLink,
	footerColumnsFor,
} from "./footer-links.ts";

const footerContainerClass = "w-full px-6 md:px-10 lg:px-16";
const legalLinkClass =
	"inline-flex min-h-10 items-center transition-colors hover:text-foreground sm:min-h-0";
const columnLinkClass =
	"block py-2.5 text-muted-foreground text-sm transition-colors hover:text-foreground md:py-1.5";
const communityLinkClass =
	"inline-flex min-h-10 items-center text-muted-foreground text-sm underline-offset-4 transition-colors hover:text-foreground hover:underline sm:min-h-0";

// Cache Components requires client prerenders to be deterministic.
const COPYRIGHT_YEAR = 2026;

const NO_HIDDEN_PRODUCTS: readonly string[] = [];

/** The marketing site's href for a footer link; docs links go to the docs site. */
export function footerHref(link: FooterLink): string {
	if (link.kind === "docs") {
		return link.href === FOOTER_DOCS_HOME ? DOCS_URL : docsHref(link.href);
	}
	return link.href;
}

function LocalizedFooterCopy({ value }: { value: string }) {
	return <>{useLocalizedText(value, { literal: true })}</>;
}

/** "Designed with ♥ & powered by Ryu" as one sentence, so translators can move the heart. */
function FooterCredit() {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	return (
		<span className="inline-flex items-center gap-1">
			{tlRich(
				"Designed with <heart></heart> & powered by Ryu",
				{},
				{
					heart: () => (
						<Heart
							aria-label={tl("love")}
							className="size-3 fill-red-400 text-red-400 dark:fill-red-400/90 dark:text-red-400/90"
							role="img"
						/>
					),
				}
			)}
		</span>
	);
}

/** One footer link. Docs and external links open in a new tab. */
function FooterAnchor({
	className,
	link,
}: {
	className: string;
	link: FooterLink;
}) {
	const tl = useLiteralMessages();
	const opensNewTab = link.kind === "docs" || link.kind === "external";
	return (
		<a
			aria-label={link.ariaLabel ? tl(link.ariaLabel) : undefined}
			className={className}
			href={footerHref(link)}
			rel={opensNewTab ? "noopener noreferrer" : undefined}
			target={opensNewTab ? "_blank" : undefined}
		>
			<LocalizedFooterCopy value={link.label} />
		</a>
	);
}

/** The positioning line, the community links and the calls to action. */
function FooterLead() {
	const tl = useLiteralMessages();
	const [primary, ...secondary] = FOOTER_START_LINKS;
	return (
		<div
			className="grid gap-8 border-border border-b pb-10 md:pb-12 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end lg:gap-16"
			data-testid="footer-lead"
		>
			<div className="flex flex-col gap-5">
				{/* A tagline, not a heading: the column titles below are h3, one
				    step under the page's h2 sections. */}
				<p className="max-w-md text-balance font-heading font-medium text-2xl md:text-3xl">
					<LocalizedFooterCopy value={FOOTER_TAGLINE} />
				</p>
				<nav aria-label={tl("Community")}>
					<ul className="flex flex-wrap items-center gap-x-5 gap-y-1">
						{FOOTER_COMMUNITY_LINKS.map((link) => (
							<li key={link.href}>
								<FooterAnchor className={communityLinkClass} link={link} />
							</li>
						))}
					</ul>
				</nav>
			</div>
			<nav aria-label={tl("Get started")}>
				<ul className="flex flex-wrap items-center gap-2 lg:justify-end">
					{primary ? (
						<li>
							<FooterAnchor
								className={cn(
									buttonVariants({ variant: "mono" }),
									"max-sm:h-10 max-sm:px-4"
								)}
								link={primary}
							/>
						</li>
					) : null}
					{secondary.map((link) => (
						<li key={link.href}>
							<FooterAnchor
								className={cn(
									buttonVariants({ variant: "outline" }),
									"max-sm:h-10 max-sm:px-4"
								)}
								link={link}
							/>
						</li>
					))}
				</ul>
			</nav>
		</div>
	);
}

/**
 * A column's link list: collapsed below md unless its disclosure is open, and
 * always shown from md up, where every column is visible at once.
 */
export function footerColumnListClass(open: boolean): string {
	return cn(open ? "pb-4" : "hidden", "md:block md:pb-0");
}

/**
 * One column. Below md the title is a disclosure button, so a phone shows six
 * short rows instead of a 47-link scroll; from md up it is a plain heading.
 * The links stay in the markup either way.
 */
function FooterColumnSection({ column }: { column: FooterColumn }) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	return (
		<div
			className="max-md:border-border max-md:border-b"
			data-footer-column={column.title}
		>
			<h3 className="font-medium md:mb-4">
				<button
					aria-controls={listId}
					aria-expanded={open}
					className="flex min-h-11 w-full items-center justify-between gap-4 text-start md:hidden"
					onClick={() => setOpen((value) => !value)}
					type="button"
				>
					<LocalizedFooterCopy value={column.title} />
					<ChevronDown
						aria-hidden="true"
						className={cn(
							"size-4 text-muted-foreground transition-transform",
							open && "rotate-180"
						)}
					/>
				</button>
				<span className="max-md:hidden">
					<LocalizedFooterCopy value={column.title} />
				</span>
			</h3>
			<ul className={footerColumnListClass(open)} id={listId}>
				{column.links.map((link) => (
					<li key={link.href}>
						<FooterAnchor className={columnLinkClass} link={link} />
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Six link columns. One disclosure row each on phones, three across from md,
 * and one row of six from xl, where each column is wide enough that labels
 * stay on one line.
 */
function FooterColumns({
	hiddenProductIds,
}: {
	hiddenProductIds: readonly string[];
}) {
	const tl = useLiteralMessages();
	return (
		<nav
			aria-label={tl("Footer")}
			className="grid grid-cols-1 py-8 md:grid-cols-3 md:gap-x-8 md:gap-y-10 md:py-16 xl:grid-cols-6"
		>
			{footerColumnsFor(hiddenProductIds).map((column) => (
				<FooterColumnSection column={column} key={column.title} />
			))}
		</nav>
	);
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
	const tl = useLiteralMessages();
	return (
		<footer className="pt-8 pb-16 md:pt-16">
			{/* Full-bleed shell: the link columns spread across the whole viewport. */}
			<div className={footerContainerClass}>
				<FooterLead />
				<FooterColumns hiddenProductIds={hiddenProductIds} />

				{/* Bottom bar: two balanced rows instead of a stacked left column.
				    Row 1: legal links | display controls. Row 2: company | build + credit. */}
				<div className="flex flex-col gap-6 border-border border-t pt-8 text-muted-foreground text-sm">
					<div className="flex flex-col-reverse items-start justify-between gap-4 sm:flex-row sm:items-center">
						<nav
							aria-label={tl("Legal")}
							className="flex flex-wrap items-center gap-x-6 gap-y-2"
						>
							{FOOTER_LEGAL_LINKS.map((link) => (
								<FooterAnchor
									className={legalLinkClass}
									key={link.href}
									link={link}
								/>
							))}
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
							© {COPYRIGHT_YEAR}{" "}
							<span itemProp="name">{COMPANY.legalName}</span>
							<span className="hidden md:inline">
								{" "}
								· <span itemProp="location">{COMPANY.country}</span> · UEN{" "}
								<span itemProp="taxID">{COMPANY.uen}</span>
							</span>
							<meta content={COMPANY.foundingDate} itemProp="foundingDate" />
							<meta content={COMPANY.url} itemProp="url" />
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
							<FooterCredit />
						</div>
					</div>
				</div>
			</div>
		</footer>
	);
}
