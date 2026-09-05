import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import {
	landingSurfaceCardFlexClass,
	landingSurfaceCardFlexXlClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import type { BentoItem } from "./sections.tsx";

export type ProductHeroLayout =
	| "editorial"
	| "framed"
	| "rail"
	| "reverse"
	| "slab"
	| "split"
	| "stacked"
	| "visual-first";

export type ProductBentoLayout =
	| "columns"
	| "compact"
	| "featured"
	| "grid"
	| "list"
	| "mosaic"
	| "rows"
	| "split";

export interface ProductLandingStyle {
	bento: ProductBentoLayout;
	hero: ProductHeroLayout;
}

/**
 * The catalog keeps the same Ryu visual language, but never the same
 * composition twice. A product's visual mockup remains the subject; this map
 * only decides how its story is arranged around that subject.
 */
export const PRODUCT_LANDING_STYLES: Record<string, ProductLandingStyle> = {
	"agents-as-a-service": { bento: "split", hero: "slab" },
	agents: { bento: "columns", hero: "split" },
	bot: { bento: "grid", hero: "slab" },
	box: { bento: "columns", hero: "framed" },
	"chrome-extension": { bento: "compact", hero: "slab" },
	cli: { bento: "list", hero: "editorial" },
	cloud: { bento: "mosaic", hero: "stacked" },
	connections: { bento: "compact", hero: "reverse" },
	console: { bento: "featured", hero: "reverse" },
	core: { bento: "featured", hero: "split" },
	devices: { bento: "list", hero: "stacked" },
	desktop: { bento: "grid", hero: "framed" },
	extensions: { bento: "split", hero: "editorial" },
	gateway: { bento: "rows", hero: "reverse" },
	hire: { bento: "grid", hero: "visual-first" },
	island: { bento: "rows", hero: "visual-first" },
	marketplace: { bento: "mosaic", hero: "slab" },
	mcp: { bento: "compact", hero: "rail" },
	mail: { bento: "featured", hero: "rail" },
	mobile: { bento: "featured", hero: "editorial" },
	notify: { bento: "columns", hero: "stacked" },
	os: { bento: "compact", hero: "framed" },
	"red-team": { bento: "list", hero: "rail" },
	sdk: { bento: "columns", hero: "editorial" },
	skills: { bento: "grid", hero: "stacked" },
	workflows: { bento: "mosaic", hero: "rail" },
};

const DEFAULT_STYLE: ProductLandingStyle = { bento: "grid", hero: "split" };

export function getProductLandingStyle(slug: string): ProductLandingStyle {
	return PRODUCT_LANDING_STYLES[slug] ?? DEFAULT_STYLE;
}

function HeroCopy({
	actions,
	centered = false,
	className,
	subtitle,
	title,
}: {
	actions: ReactNode;
	centered?: boolean;
	className?: string;
	subtitle: string;
	title: string;
}) {
	return (
		<div
			className={cn(
				"max-w-xl space-y-6",
				centered && "mx-auto text-center",
				className
			)}
		>
			<h1 className="text-balance font-medium text-4xl text-foreground leading-[1.1] tracking-tight md:text-5xl">
				{title}
			</h1>
			<p
				className={cn(
					"max-w-md text-balance text-muted-foreground md:text-lg",
					centered && "mx-auto"
				)}
			>
				{subtitle}
			</p>
			<div
				className={cn(
					"flex flex-col gap-3 sm:flex-row",
					centered && "sm:justify-center"
				)}
			>
				{actions}
			</div>
		</div>
	);
}

function HeroVisual({
	className,
	frameClassName,
	visual,
}: {
	className?: string;
	frameClassName?: string;
	visual: ReactNode;
}) {
	return (
		<Reveal className={cn("min-w-0", className)}>
			<div className={cn("min-w-0", frameClassName)}>{visual}</div>
		</Reveal>
	);
}

export function ProductHeroFrame({
	actions,
	landingStyle,
	subtitle,
	title,
	visual,
}: {
	actions: ReactNode;
	landingStyle: ProductLandingStyle;
	subtitle: string;
	title: string;
	visual: ReactNode;
}) {
	const content = (() => {
		switch (landingStyle.hero) {
			case "reverse":
				return (
					<div className="container mx-auto px-4 pt-16 pb-12 md:pt-24">
						<div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
							<HeroVisual
								className="lg:order-1"
								frameClassName="rounded-2xl border border-border/70 bg-card p-4"
								visual={visual}
							/>
							<HeroCopy
								actions={actions}
								className="lg:order-2"
								subtitle={subtitle}
								title={title}
							/>
						</div>
					</div>
				);
			case "stacked":
				return (
					<div className="container mx-auto px-4 pt-16 pb-16 text-center md:pt-24">
						<HeroCopy
							actions={actions}
							centered
							subtitle={subtitle}
							title={title}
						/>
						<HeroVisual
							className="mx-auto mt-12 max-w-5xl"
							frameClassName="rounded-2xl bg-muted/30 p-5 md:p-7"
							visual={visual}
						/>
					</div>
				);
			case "framed":
				return (
					<div className="container mx-auto px-4 pt-10 pb-12 md:pt-16">
						<div className="mx-auto max-w-6xl rounded-2xl border border-border/70 bg-muted/20 p-6 md:p-10">
							<div className="grid items-center gap-10 lg:grid-cols-[0.85fr_1.15fr] lg:gap-16">
								<HeroCopy actions={actions} subtitle={subtitle} title={title} />
								<HeroVisual
									frameClassName="rounded-xl border border-border bg-card p-3"
									visual={visual}
								/>
							</div>
						</div>
					</div>
				);
			case "rail":
				return (
					<div className="container mx-auto px-4 pt-14 pb-12 md:pt-24">
						<div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,0.78fr)_minmax(0,1.22fr)] lg:gap-20">
							<div className="border-border border-t-2 pt-6">
								<HeroCopy actions={actions} subtitle={subtitle} title={title} />
							</div>
							<HeroVisual
								frameClassName="rounded-2xl bg-muted/30 p-4"
								visual={visual}
							/>
						</div>
					</div>
				);
			case "slab":
				return (
					<div className="container mx-auto px-4 pt-16 pb-12 md:pt-24">
						<div className="mx-auto max-w-6xl border-border border-b pb-10">
							<HeroCopy
								actions={actions}
								className="max-w-2xl"
								subtitle={subtitle}
								title={title}
							/>
						</div>
						<HeroVisual
							className="mx-auto mt-10 max-w-5xl"
							frameClassName="rounded-2xl bg-muted/30 p-5 md:p-7"
							visual={visual}
						/>
					</div>
				);
			case "visual-first":
				return (
					<div className="container mx-auto px-4 pt-12 pb-16 md:pt-20">
						<HeroVisual
							className="mx-auto max-w-5xl"
							frameClassName="rounded-2xl border border-border/70 bg-card p-4 md:p-6"
							visual={visual}
						/>
						<div className="mx-auto mt-10 max-w-2xl border-border border-t pt-8 text-center">
							<HeroCopy
								actions={actions}
								centered
								subtitle={subtitle}
								title={title}
							/>
						</div>
					</div>
				);
			case "editorial":
				return (
					<div className="container mx-auto px-4 pt-14 pb-12 md:pt-24">
						<div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)] lg:gap-16">
							<HeroCopy
								actions={actions}
								className="border-border border-l pl-6 md:pl-8"
								subtitle={subtitle}
								title={title}
							/>
							<HeroVisual
								frameClassName="rounded-xl border border-border bg-card p-3"
								visual={visual}
							/>
						</div>
					</div>
				);
			default:
				return (
					<div className="container mx-auto px-4 pt-16 pb-12 md:pt-24">
						<div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2">
							<HeroCopy actions={actions} subtitle={subtitle} title={title} />
							<HeroVisual
								className="lg:pl-4"
								frameClassName="rounded-2xl bg-muted/30 p-4"
								visual={visual}
							/>
						</div>
					</div>
				);
		}
	})();

	return (
		<section data-product-hero-layout={landingStyle.hero}>{content}</section>
	);
}

type ProductBentoCardVariant =
	| "compact"
	| "feature"
	| "line"
	| "panel"
	| "system";

function ProductBentoCard({
	className,
	compact = false,
	featured = false,
	gridClassName,
	horizontal = false,
	item,
	variant = "system",
}: {
	className?: string;
	compact?: boolean;
	featured?: boolean;
	gridClassName?: string;
	horizontal?: boolean;
	item: BentoItem;
	variant?: ProductBentoCardVariant;
}) {
	const Icon = item.icon;
	const cardClass = cn(
		variant === "compact" && landingSurfaceCardFlexClass,
		variant === "feature" &&
			"flex h-full flex-col justify-between gap-6 rounded-2xl bg-muted/50 p-5 md:p-6",
		variant === "line" &&
			"flex h-full flex-col justify-between gap-5 border-border border-y bg-transparent py-6",
		variant === "panel" &&
			"flex h-full flex-col justify-between gap-5 rounded-2xl border border-border/70 bg-card p-5",
		variant === "system" && landingSurfaceCardFlexXlClass,
		featured && "min-h-64",
		compact && "min-h-44",
		horizontal &&
			"grid items-center gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:gap-10",
		className
	);

	return (
		<Reveal className={cn("min-w-0", item.span, gridClassName)} delay={0.04}>
			<div className={cardClass}>
				<div className={cn("min-h-0", horizontal ? "md:order-1" : "flex-1")}>
					{item.visual ??
						(Icon ? (
							<Icon
								aria-hidden="true"
								className="size-5 text-foreground"
								strokeWidth={1.75}
							/>
						) : null)}
				</div>
				<div className={cn(horizontal && "md:order-2")}>
					<h3 className="mb-1 font-medium text-base text-foreground">
						{item.title}
					</h3>
					<p className="text-muted-foreground text-sm leading-relaxed">
						{item.description}
					</p>
					{item.action ? <div className="mt-3">{item.action}</div> : null}
				</div>
			</div>
		</Reveal>
	);
}

const MOSAIC_SPANS = [
	"md:col-span-7 md:row-span-2",
	"md:col-span-5",
	"md:col-span-5",
	"md:col-span-7",
	"md:col-span-4",
	"md:col-span-8",
];

export function ProductBentoFrame({
	items,
	landingStyle,
}: {
	items: BentoItem[];
	landingStyle: ProductLandingStyle;
}) {
	const content = (() => {
		switch (landingStyle.bento) {
			case "featured":
				return (
					<div className="grid gap-3 md:auto-rows-[minmax(0,1fr)] md:grid-cols-3">
						{items.map((item, index) => (
							<ProductBentoCard
								featured={index === 0}
								gridClassName={
									index === 0 ? "md:col-span-2 md:row-span-2" : undefined
								}
								item={item}
								key={item.title}
								variant={index === 0 ? "feature" : "system"}
							/>
						))}
					</div>
				);
			case "rows":
				return (
					<div className="divide-y divide-border border-border border-y">
						{items.map((item) => (
							<ProductBentoCard
								horizontal
								item={item}
								key={item.title}
								variant="line"
							/>
						))}
					</div>
				);
			case "mosaic":
				return (
					<div className="grid gap-3 md:auto-rows-[minmax(10rem,auto)] md:grid-cols-12">
						{items.map((item, index) => (
							<ProductBentoCard
								gridClassName={MOSAIC_SPANS[index % MOSAIC_SPANS.length]}
								item={item}
								key={item.title}
								variant={index === 0 ? "feature" : "system"}
							/>
						))}
					</div>
				);
			case "columns":
				return (
					<div className="grid gap-3 lg:grid-cols-[0.8fr_1.2fr]">
						<div className="grid gap-3">
							{items
								.filter((_, index) => index % 2 === 0)
								.map((item) => (
									<ProductBentoCard
										item={item}
										key={item.title}
										variant="feature"
									/>
								))}
						</div>
						<div className="grid gap-3 lg:pt-14">
							{items
								.filter((_, index) => index % 2 === 1)
								.map((item) => (
									<ProductBentoCard
										item={item}
										key={item.title}
										variant="system"
									/>
								))}
						</div>
					</div>
				);
			case "compact":
				return (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						{items.map((item) => (
							<ProductBentoCard
								compact
								item={item}
								key={item.title}
								variant="compact"
							/>
						))}
					</div>
				);
			case "split":
				return (
					<div className="grid gap-3 lg:grid-cols-2">
						{items.map((item, index) => (
							<ProductBentoCard
								featured={index === 0}
								gridClassName={index === 0 ? "lg:row-span-2" : undefined}
								item={item}
								key={item.title}
								variant={index === 0 ? "feature" : "system"}
							/>
						))}
					</div>
				);
			case "list":
				return (
					<div className="grid gap-3 md:grid-cols-2">
						{items.map((item) => (
							<ProductBentoCard item={item} key={item.title} variant="panel" />
						))}
					</div>
				);
			default:
				return (
					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
						{items.map((item) => (
							<ProductBentoCard item={item} key={item.title} variant="system" />
						))}
					</div>
				);
		}
	})();

	return <div data-product-bento-layout={landingStyle.bento}>{content}</div>;
}
