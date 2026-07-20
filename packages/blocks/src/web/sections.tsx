import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { isDownloadCtaLink } from "./download-cta.ts";
import { DownloadMenu } from "./download-menu.tsx";
import { landingSurfaceCardFlexXlClass } from "./landing-card-tones.ts";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle } from "./section-title.tsx";

export interface CtaLink {
	external?: boolean;
	href: string;
	label: string;
}

function Cta({
	cta,
	variant = "default",
	size,
}: {
	cta: CtaLink;
	variant?: "default" | "outline" | "ghost";
	size?: "lg";
}) {
	if (isDownloadCtaLink(cta)) {
		return (
			<DownloadMenu
				label="Download"
				size={size === "lg" ? "lg" : "default"}
				variant={variant}
			/>
		);
	}
	const props = cta.external
		? { rel: "noopener noreferrer", target: "_blank" as const }
		: {};
	return (
		<Link
			className={cn(buttonVariants({ variant, size }))}
			href={cta.href as Route}
			{...props}
		>
			{cta.label}
		</Link>
	);
}

/* ------------------------------------------------------------------ */
/* Product hero                                                        */
/* ------------------------------------------------------------------ */

export function ProductHero({
	title,
	subtitle,
	primaryCta,
	secondaryCta,
	visual,
}: {
	eyebrow: string;
	title: string;
	subtitle: string;
	primaryCta: CtaLink;
	secondaryCta?: CtaLink;
	visual: ReactNode;
}) {
	return (
		<section className="container mx-auto px-4 pt-16 pb-12 md:pt-24">
			<div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2">
				<div className="space-y-6">
					<h1 className="text-balance font-medium text-4xl text-foreground leading-[1.1] tracking-tight md:text-5xl">
						{title}
					</h1>
					<p className="max-w-md text-balance text-muted-foreground md:text-lg">
						{subtitle}
					</p>
					<div className="flex flex-col gap-3 sm:flex-row">
						<Cta cta={primaryCta} />
						{secondaryCta ? <Cta cta={secondaryCta} variant="ghost" /> : null}
					</div>
				</div>
				<Reveal className="lg:pl-4">{visual}</Reveal>
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Section heading                                                     */
/* ------------------------------------------------------------------ */

export const sectionSubtitleClass = landingSubheadlineClass;

export function SectionHeading({
	title,
	subtitle,
	align = "left",
	className,
}: {
	eyebrow?: string;
	title: string;
	subtitle?: string;
	align?: "left" | "center";
	className?: string;
}) {
	return (
		<div
			className={cn(
				"mb-10 max-w-2xl",
				align === "center" && "mx-auto text-center",
				className
			)}
		>
			<SectionTitle title={title} />
			{subtitle ? <p className={sectionSubtitleClass}>{subtitle}</p> : null}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Highlights strip (value props)                                      */
/* ------------------------------------------------------------------ */

export interface Highlight {
	description: string;
	title: string;
}

export function Highlights({ items }: { items: Highlight[] }) {
	return (
		<section className="container mx-auto px-4">
			<div className="mx-auto max-w-6xl border-border border-t pt-10">
				<div className="grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
					{items.map((item, i) => (
						<Reveal delay={(i % 4) * 0.06} key={item.title}>
							<div>
								<h3 className="font-medium text-foreground">{item.title}</h3>
								<p className="mt-1.5 text-muted-foreground text-sm leading-relaxed">
									{item.description}
								</p>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}

/* ------------------------------------------------------------------ */
/* Bento grid                                                          */
/* ------------------------------------------------------------------ */

export interface BentoItem {
	action?: ReactNode;
	description: string;
	icon?: LucideIcon;
	/** col-span / row-span tailwind classes to shape the bento */
	span?: string;
	title: string;
	visual?: ReactNode;
}

export function BentoGrid({ items }: { items: BentoItem[] }) {
	return (
		<div className="grid auto-rows-[minmax(0,1fr)] grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
			{items.map((item, i) => (
				<Reveal
					className={cn("min-h-52", item.span)}
					delay={(i % 3) * 0.08}
					key={item.title}
				>
					<BentoCard item={item} />
				</Reveal>
			))}
		</div>
	);
}

export function BentoCard({ item }: { item: BentoItem }) {
	const Icon = item.icon;
	return (
		<div className={landingSurfaceCardFlexXlClass}>
			<div className="min-h-0 flex-1">
				{item.visual ??
					(Icon ? (
						<Icon className="size-5 text-foreground" strokeWidth={1.75} />
					) : null)}
			</div>
			<div>
				<h3 className="mb-1 font-semibold text-base text-foreground">
					{item.title}
				</h3>
				<p className="text-muted-foreground text-sm leading-relaxed">
					{item.description}
				</p>
				{item.action ? <div className="mt-3">{item.action}</div> : null}
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Alternating feature split                                           */
/* ------------------------------------------------------------------ */

export interface FeatureSplit {
	bullets?: string[];
	cta?: CtaLink;
	description: string;
	eyebrow?: string;
	/** place visual on the left for odd rows */
	flip?: boolean;
	title: string;
	visual: ReactNode;
}

export function FeatureSplitRow({ feature }: { feature: FeatureSplit }) {
	return (
		<div className="grid items-center gap-10 lg:grid-cols-2">
			<Reveal className={cn(feature.flip && "lg:order-2")}>
				<div className="space-y-5">
					<h3 className="font-medium text-2xl text-foreground tracking-tight md:text-3xl">
						{feature.title}
					</h3>
					<p className="text-muted-foreground md:text-lg">
						{feature.description}
					</p>
					{feature.bullets ? (
						<ul className="space-y-2.5">
							{feature.bullets.map((b) => (
								<li
									className="flex items-start gap-2.5 text-foreground/80 text-sm"
									key={b}
								>
									<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-foreground/40" />
									{b}
								</li>
							))}
						</ul>
					) : null}
					{feature.cta ? (
						<div className="pt-2">
							<Cta cta={feature.cta} variant="outline" />
						</div>
					) : null}
				</div>
			</Reveal>
			<Reveal className={cn(feature.flip && "lg:order-1")} delay={0.1}>
				{feature.visual}
			</Reveal>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/* Product CTA                                                         */
/* ------------------------------------------------------------------ */

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
		<section className="container mx-auto px-4 py-24">
			<div className="mx-auto max-w-2xl text-center">
				<SectionTitle className="mx-auto" title={title} />
				<p className={cn(landingSubheadlineClass, "mx-auto mt-4 max-w-md")}>
					{subtitle}
				</p>
				<div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
					<Cta cta={primaryCta} />
					{secondaryCta ? <Cta cta={secondaryCta} variant="ghost" /> : null}
				</div>
				{note ? (
					<p className="mt-4 text-muted-foreground/60 text-xs">{note}</p>
				) : null}
			</div>
		</section>
	);
}

export type { SectionTitleSize } from "./section-title.tsx";
// biome-ignore lint/performance/noBarrelFile: re-export for web app product sections
export { SectionTitle, sectionTitleClass } from "./section-title.tsx";
