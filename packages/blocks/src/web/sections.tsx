import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { isDownloadCtaLink } from "./download-cta.ts";
import { DownloadMenu } from "./download-menu.tsx";
import { landingVisualFrameClass } from "./landing-card-tones.ts";
import {
	landingCtaRowClass,
	landingSectionClass,
	landingSubheadlineBodyClass,
	landingSubheadlineClass,
} from "./landing-typography.ts";
import { nextLinkHref } from "./next-link-href.ts";
import { ProductHeroFrame } from "./product-landing-layouts.tsx";
import { SectionTitle } from "./section-title.tsx";
import { type NumberedStep, StepList } from "./step-list.tsx";

export interface CtaLink {
	external?: boolean;
	href: string;
	label: string;
}

function externalLinkProps(cta: CtaLink) {
	return cta.external
		? { rel: "noopener noreferrer", target: "_blank" as const }
		: {};
}

/**
 * Secondary CTAs are outline buttons. The theme border token is too faint on a
 * plain background to read as a button, so the outline is redrawn from the
 * foreground colour. Overriding `--border` keeps the `border-border` class,
 * which public-pages.css relies on to leave outline buttons their border.
 */
export const outlineCtaClass =
	"[--border:color-mix(in_oklch,var(--foreground)_16%,transparent)] dark:[--border:color-mix(in_oklch,var(--foreground)_22%,transparent)]";

export function Cta({
	cta,
	variant = "mono",
	size,
}: {
	cta: CtaLink;
	variant?: "default" | "mono" | "outline";
	size?: "lg";
}) {
	if (isDownloadCtaLink(cta)) {
		return (
			<DownloadMenu
				className={variant === "outline" ? outlineCtaClass : undefined}
				label="Download"
				size={size === "lg" ? "lg" : "default"}
				variant={variant}
			/>
		);
	}
	return (
		<Link
			className={cn(
				buttonVariants({ variant, size }),
				// Match the DownloadMenu pill so paired CTAs share one silhouette.
				"corner-round rounded-full",
				variant === "outline" && outlineCtaClass
			)}
			href={nextLinkHref(cta.href)}
			{...externalLinkProps(cta)}
		>
			{cta.label}
		</Link>
	);
}

/** Inline "Label →" link: the only call to action a feature row may carry. */
export function TextLink({ cta }: { cta: CtaLink }) {
	return (
		<Link
			className="mt-4 inline-flex min-h-10 items-center font-medium text-foreground text-sm underline-offset-4 hover:underline"
			href={nextLinkHref(cta.href)}
			{...externalLinkProps(cta)}
		>
			{cta.label}&nbsp;<span aria-hidden="true">→</span>
		</Link>
	);
}

const itemTitleClass = "font-heading font-medium text-base text-foreground";
const itemDescriptionClass =
	"text-muted-foreground text-[15px] leading-relaxed";

/* ------------------------------------------------------------------ */
/* Product hero                                                        */
/* ------------------------------------------------------------------ */

export function ProductHero({
	background,
	eyebrow,
	title,
	subtitle,
	primaryCta,
	secondaryCta,
	visual,
}: {
	/** An animated backdrop: the hero becomes a full-viewport stage. */
	background?: ReactNode;
	eyebrow: string;
	title: string;
	subtitle: string;
	primaryCta: CtaLink;
	secondaryCta?: CtaLink;
	/** Optional: without a visual the hero is a single text column. */
	visual?: ReactNode;
}) {
	return (
		<ProductHeroFrame
			actions={
				<>
					<Cta cta={primaryCta} size="lg" />
					{secondaryCta ? (
						<Cta cta={secondaryCta} size="lg" variant="outline" />
					) : null}
				</>
			}
			background={background}
			eyebrow={eyebrow}
			subtitle={subtitle}
			title={title}
			visual={visual}
		/>
	);
}

/* ------------------------------------------------------------------ */
/* Section heading                                                     */
/* ------------------------------------------------------------------ */

export const sectionSubtitleClass = landingSubheadlineClass;

const BOTTOM_MARGIN_CLASS = /(?:^|\s|:)-?mb-/;

/**
 * Heading-to-content spacing. A caller's own bottom margin replaces the whole
 * responsive default; tailwind-merge alone would keep `md:mb-20` beside `mb-4`.
 */
function sectionHeadingMarginClass(className: string | undefined) {
	return className && BOTTOM_MARGIN_CLASS.test(className)
		? undefined
		: "mb-16 md:mb-20";
}

export function SectionHeading({
	title,
	subtitle,
	className,
}: {
	title: string;
	subtitle?: string;
	className?: string;
	/**
	 * Kept for backward compatibility. Every heading stacks (title, then an optional
	 * lede below it), so "split" renders the same as "stack".
	 */
	layout?: "stack" | "split";
}) {
	return (
		<div
			className={cn(
				"max-w-2xl",
				sectionHeadingMarginClass(className),
				className
			)}
		>
			<SectionTitle title={title} />
			{subtitle ? <p className={sectionSubtitleClass}>{subtitle}</p> : null}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Highlights (value props)                                            */
/* ------------------------------------------------------------------ */

export interface Highlight {
	description: string;
	/** @deprecated Highlights no longer render icons. Ignored. */
	icon?: LucideIcon;
	title: string;
}

/**
 * Two highlights stay a half-width pair instead of leaving a third column empty;
 * four take a 2x2 grid so no item wraps to four lines beside two-line neighbours.
 */
function highlightColumnsClass(count: number): string | null {
	if (count === 4) {
		return null;
	}
	if (count < 3) {
		return "max-w-3xl";
	}
	return "lg:grid-cols-3";
}

export function Highlights({
	items,
	title,
}: {
	items: Highlight[];
	/** Optional section heading; without one the strip is labelled "Key points". */
	title?: string;
}) {
	return (
		<section
			aria-label={title ? undefined : "Key points"}
			className={landingSectionClass}
			data-testid="product-highlights"
		>
			{title ? <SectionHeading title={title} /> : null}
			<div
				className={cn(
					"grid gap-x-12 gap-y-12 sm:grid-cols-2 md:gap-y-14",
					highlightColumnsClass(items.length)
				)}
			>
				{items.map((item) => (
					<div key={item.title}>
						<h3 className={itemTitleClass}>{item.title}</h3>
						<p className={cn("mt-2", itemDescriptionClass)}>
							{item.description}
						</p>
					</div>
				))}
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Capabilities list                                                   */
/* ------------------------------------------------------------------ */

export interface BentoItem {
	/** Optional "Label →" link under the description. */
	cta?: CtaLink;
	description: string;
	title: string;
	/** A drawing above the title, usually a `BentoFigure`. */
	visual?: ReactNode;
}

/**
 * Columns follow the item count so no row ends with an orphan cell: one item is a
 * single column, 2 and 4 a 2-column grid, multiples of 3 a 3-column grid, 5 a 3 + 2
 * split on a 6-column track, 8 two rows of four and 7 a 4 + 3 split.
 */
function bentoColumnsClass(count: number): string | null {
	if (count <= 1) {
		return "max-w-2xl sm:grid-cols-1";
	}
	if (count === 5) {
		return "lg:grid-cols-6";
	}
	if (count === 7 || count === 8) {
		return "lg:grid-cols-4";
	}
	return count % 3 === 0 ? "lg:grid-cols-3" : null;
}

/** Per-item span for the counts whose last row would otherwise leave a gap. */
function bentoItemSpanClass(count: number, index: number): string | undefined {
	if (count === 5) {
		return index < 3 ? "lg:col-span-2" : "lg:col-span-3";
	}
	if (count === 7 && index === count - 1) {
		return "lg:col-span-2";
	}
	return;
}

export function BentoGrid({ items }: { items: BentoItem[] }) {
	return (
		<ul
			className={cn(
				"grid gap-x-12 gap-y-12 sm:grid-cols-2 md:gap-y-14",
				bentoColumnsClass(items.length)
			)}
			data-product-bento-layout="list"
		>
			{items.map((item, index) => (
				<li
					className={bentoItemSpanClass(items.length, index)}
					key={item.title}
				>
					{item.visual ? (
						<div className="mb-6" data-bento-visual="">
							{item.visual}
						</div>
					) : null}
					<h3 className={itemTitleClass}>{item.title}</h3>
					<p className={cn("mt-2", itemDescriptionClass)}>{item.description}</p>
					{item.cta ? <TextLink cta={item.cta} /> : null}
				</li>
			))}
		</ul>
	);
}

/* ------------------------------------------------------------------ */
/* Numbered steps                                                      */
/* ------------------------------------------------------------------ */

export function NumberedSteps({ steps }: { steps: NumberedStep[] }) {
	return (
		<ol className="grid gap-8 md:grid-cols-3">
			{steps.map((step, index) => (
				<li key={step.title}>
					<span className="text-muted-foreground text-sm tabular-nums">
						{String(index + 1).padStart(2, "0")}
					</span>
					<h3 className={cn("mt-3", itemTitleClass)}>{step.title}</h3>
					<p className={cn("mt-2", itemDescriptionClass)}>{step.description}</p>
				</li>
			))}
		</ol>
	);
}

/**
 * Two-column "title left, steps right" section used by hub pages whose
 * catalogue is empty (/perks, /challenges, /stories).
 */
export function StepListSection({
	title,
	steps,
	children,
}: {
	title: string;
	steps: readonly NumberedStep[];
	children?: ReactNode;
}) {
	return (
		<section
			className={cn(
				landingSectionClass,
				"grid gap-x-10 pt-0 md:pt-0 lg:grid-cols-3 lg:pt-0"
			)}
		>
			<SectionHeading className="lg:col-span-1" title={title} />
			<div className="lg:col-span-2">
				<StepList steps={steps} />
				{children}
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Alternating feature row                                             */
/* ------------------------------------------------------------------ */

export interface FeatureSplit {
	bullets?: string[];
	cta?: CtaLink;
	description: string;
	title: string;
	/** Optional: without a visual the row is text only, with no empty column. */
	visual?: ReactNode;
}

export function FeatureSplitRow({
	feature,
	index = 0,
	headingLevel: Heading = "h3",
}: {
	feature: FeatureSplit;
	/** Position in the list; odd rows put the visual on the left at lg. */
	index?: number;
	headingLevel?: "h2" | "h3";
}) {
	const hasVisual = Boolean(feature.visual);
	const visualFirst = hasVisual && index % 2 === 1;
	const copy = (
		<>
			<Heading className="text-balance font-heading font-medium text-3xl text-foreground leading-[1.1] tracking-[-0.03em] md:text-4xl">
				{feature.title}
			</Heading>
			<p className={landingSubheadlineClass}>{feature.description}</p>
			{feature.bullets?.length ? (
				<ul className="mt-6 space-y-2.5">
					{feature.bullets.map((bullet) => (
						<li
							className="flex items-start gap-2.5 text-foreground/80 text-sm"
							key={bullet}
						>
							<span
								aria-hidden="true"
								className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/40"
							/>
							{bullet}
						</li>
					))}
				</ul>
			) : null}
			{feature.cta ? <TextLink cta={feature.cta} /> : null}
		</>
	);
	if (!hasVisual) {
		return <div className="min-w-0 max-w-2xl">{copy}</div>;
	}
	return (
		<div
			className={cn(
				"grid items-center gap-10 lg:items-center lg:gap-16",
				visualFirst
					? "lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]"
					: "lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"
			)}
		>
			<div className={cn("min-w-0", visualFirst && "lg:order-2")}>{copy}</div>
			{/* The mock repeats the row's claim in picture form; the heading and
			    description already say it, so screen readers skip the mock text. */}
			<div
				aria-hidden="true"
				className={cn(
					landingVisualFrameClass,
					"flex min-w-0 items-center justify-center [&>*]:w-full [&>[data-minimal-card]]:bg-transparent",
					visualFirst && "lg:order-1"
				)}
				data-product-visual
			>
				{feature.visual}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Closing CTA                                                         */
/* ------------------------------------------------------------------ */

/**
 * One closing layout on every page: the title on the left, the pills centred on it on
 * the right. The subtitle sits directly under the title, so on phones it never trails
 * the stacked pills; an optional note follows the row as a small caption.
 */
export function ProductCta({
	title,
	subtitle,
	primaryCta,
	secondaryCta,
	note,
}: {
	title: string;
	subtitle: string;
	primaryCta: CtaLink;
	secondaryCta?: CtaLink;
	note?: string;
}) {
	return (
		<section
			className={landingSectionClass}
			data-closing-cta=""
			data-testid="product-cta"
		>
			<div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
				<div className="min-w-0 max-w-2xl">
					<SectionTitle title={title} />
					{subtitle ? (
						<p className={cn(landingSubheadlineBodyClass, "mt-4")}>
							{subtitle}
						</p>
					) : null}
				</div>
				<div className={cn("shrink-0", landingCtaRowClass)}>
					<Cta cta={primaryCta} size="lg" />
					{secondaryCta ? (
						<Cta cta={secondaryCta} size="lg" variant="outline" />
					) : null}
				</div>
			</div>
			{note ? (
				<p className="mt-6 text-muted-foreground text-sm">{note}</p>
			) : null}
		</section>
	);
}

export type { SectionTitleSize } from "./section-title.tsx";
export { SectionTitle, sectionTitleClass } from "./section-title.tsx";
export type { NumberedStep } from "./step-list.tsx";
export { StepList } from "./step-list.tsx";
