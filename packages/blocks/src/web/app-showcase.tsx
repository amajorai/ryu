import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowLeft, ArrowUpRight, Check } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { FeaturedAppsCount, OfficialAppLabel } from "./app-showcase-labels.tsx";
import {
	DashboardsMockup,
	SitesMockup,
	SlidesMockup,
	VideoStudioMockup,
} from "./app-showcase-mockups.tsx";
import {
	CalendarMockup,
	CanvasMockup,
	SpacesMockup,
} from "./app-showcase-workspace-mockups.tsx";
import {
	type AppShowcase,
	type AppShowcaseFeature,
	type AppShowcaseVisualKey,
	appShowcases,
} from "./data/app-showcase.tsx";

const VISUALS = {
	calendar: CalendarMockup,
	canvas: CanvasMockup,
	dashboards: DashboardsMockup,
	sites: () => <SitesMockup />,
	slides: SlidesMockup,
	spaces: SpacesMockup,
	"video-studio": VideoStudioMockup,
} satisfies Record<AppShowcaseVisualKey, () => ReactNode>;

export function AppShowcaseVisual({
	app,
	compact = false,
}: {
	app: AppShowcase;
	compact?: boolean;
}) {
	const Visual = VISUALS[app.visual];
	return app.visual === "sites" ? (
		<SitesMockup compact={compact} />
	) : (
		<Visual />
	);
}

/* -------------------------------------------------------------------------- */
/* Public gallery and detail compositions                                     */
/* -------------------------------------------------------------------------- */

export function AppShowcaseCard({ app }: { app: AppShowcase }) {
	return (
		<Link
			className="group block min-w-0 rounded-2xl outline-offset-8 focus-visible:outline-2 focus-visible:outline-ring"
			data-app-showcase-card={app.slug}
			data-testid={`app-showcase-card-${app.slug}`}
			href={
				/* SAFETY: AppShowcase.slug is the closed AppShowcaseVisualKey union from the canonical authored catalog; /products/apps/[slug]/page.tsx owns these constructed nonliteral app routes. */ `/products/apps/${app.slug}` as Route
			}
		>
			<div
				aria-hidden="true"
				className="flex min-h-[19rem] items-center overflow-hidden rounded-2xl border border-border border-dashed bg-muted/20 p-2 transition-colors duration-200 group-hover:border-foreground/35 group-hover:bg-muted/35 sm:p-3"
				data-product-visual
			>
				<AppShowcaseVisual app={app} compact />
			</div>
			<div className="mt-5 flex items-start justify-between gap-4">
				<div className="min-w-0">
					<div className="type-compact mb-2 flex flex-wrap items-center gap-2 font-mono text-muted-foreground">
						<span>{app.category}</span>
						<span aria-hidden="true">·</span>
						<span>{app.surfaceLabel}</span>
					</div>
					<h2 className="font-heading font-medium text-2xl tracking-tight group-hover:underline group-hover:underline-offset-4">
						{app.name}
					</h2>
					<p className="mt-2 max-w-sm text-muted-foreground text-sm leading-relaxed">
						{app.shortDescription}
					</p>
				</div>
				<ArrowUpRight
					aria-hidden="true"
					className="mt-1 size-5 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
				/>
			</div>
		</Link>
	);
}

export function AppShowcaseGallery({
	apps = appShowcases,
}: {
	/**
	 * The showcases to list. Defaults to every showcase; the web page passes
	 * only those whose app rollout is open.
	 */
	apps?: readonly AppShowcase[];
} = {}) {
	return (
		<div
			className="bg-background text-foreground"
			data-testid="app-showcase-page"
		>
			<section className="container mx-auto px-4 pt-24 pb-16 md:pt-32 md:pb-20">
				<div className="max-w-3xl">
					<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
						RYU APPS / OFFICIAL SURFACES
					</p>
					<h1 className="mt-5 max-w-3xl font-heading font-medium text-4xl tracking-tighter md:text-6xl">
						Workspaces for the work agents make.
					</h1>
					<p className="mt-6 max-w-2xl text-lg text-muted-foreground leading-relaxed">
						Each Ryu app gives a kind of work a place to land — a site to
						publish, a board to watch, a timeline to finish, or a source of
						context to keep close.
					</p>
					<div className="mt-8 flex flex-wrap items-center gap-3">
						<Link
							className={cn(buttonVariants({ size: "lg", variant: "mono" }))}
							href="/download"
						>
							Get Ryu
						</Link>
						<Link
							className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
							href="/marketplace/apps"
						>
							Browse the marketplace
						</Link>
					</div>
				</div>
			</section>

			<section className="container mx-auto px-4 pb-24 md:pb-32">
				<div className="mb-12 flex flex-wrap items-end justify-between gap-4">
					<div>
						<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
							BUILT BY RYU
						</p>
						<h2 className="mt-3 font-heading font-medium text-3xl tracking-tight md:text-4xl">
							Choose a surface for the job.
						</h2>
					</div>
					<p className="type-caption font-mono text-muted-foreground">
						<FeaturedAppsCount count={apps.length} />
					</p>
				</div>
				<div
					className="grid grid-cols-1 gap-x-8 gap-y-16 md:grid-cols-2 xl:grid-cols-3"
					data-testid="app-showcase-grid"
				>
					{apps.map((app) => (
						<AppShowcaseCard app={app} key={app.slug} />
					))}
				</div>
			</section>
		</div>
	);
}

function FeatureRow({ feature }: { feature: AppShowcaseFeature }) {
	return (
		<li className="py-5">
			<div className="flex items-start gap-3">
				<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<Check aria-hidden="true" className="size-3" />
				</span>
				<div>
					<h3 className="font-medium text-base">{feature.title}</h3>
					<p className="mt-1.5 max-w-xl text-muted-foreground text-sm leading-relaxed">
						{feature.description}
					</p>
				</div>
			</div>
		</li>
	);
}

function RelatedAppLink({ app }: { app: AppShowcase }) {
	return (
		<Link
			className="group flex items-center justify-between gap-4 py-3 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
			href={
				/* SAFETY: AppShowcase.slug is the closed AppShowcaseVisualKey union from the canonical authored catalog; /products/apps/[slug]/page.tsx owns these constructed nonliteral app routes. */ `/products/apps/${app.slug}` as Route
			}
		>
			<span>
				<span className="block font-heading font-medium text-lg group-hover:underline group-hover:underline-offset-4">
					{app.name}
				</span>
				<span className="mt-1 block text-muted-foreground text-sm">
					{app.tagline}
				</span>
			</span>
			<ArrowUpRight
				aria-hidden="true"
				className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"
			/>
		</Link>
	);
}

export function AppShowcaseDetail({
	app,
	docsHref,
	relatedApps,
}: {
	app: AppShowcase;
	docsHref: string;
	relatedApps: readonly AppShowcase[];
}) {
	const Icon = app.icon;
	return (
		<div
			className="bg-background text-foreground"
			data-testid={`app-showcase-detail-${app.slug}`}
		>
			<section className="container mx-auto px-4 pt-20 pb-16 md:pt-28 md:pb-24">
				<Link
					className="inline-flex items-center gap-2 text-muted-foreground text-sm hover:text-foreground"
					href="/products/apps"
				>
					<ArrowLeft aria-hidden="true" className="size-4" />
					All Ryu Apps
				</Link>
				<div className="mt-10 grid items-center gap-12 lg:grid-cols-[0.78fr_1.22fr] lg:gap-16">
					<div className="min-w-0">
						<div className="type-compact flex flex-wrap items-center gap-2 font-mono text-muted-foreground">
							<span className="flex size-7 items-center justify-center rounded-lg bg-muted text-foreground">
								<Icon
									aria-hidden="true"
									className="size-4"
									strokeWidth={1.75}
								/>
							</span>
							<span>{app.category}</span>
							<span aria-hidden="true">·</span>
							<span>{app.surfaceLabel}</span>
						</div>
						<h1 className="mt-6 font-heading font-medium text-5xl tracking-tighter md:text-7xl">
							{app.name}
						</h1>
						<p className="mt-5 max-w-xl font-heading text-2xl leading-tight tracking-tight md:text-3xl">
							{app.tagline}
						</p>
						<p className="mt-5 max-w-xl text-base text-muted-foreground leading-relaxed">
							{app.shortDescription}
						</p>
						<div className="mt-8 flex flex-wrap items-center gap-3">
							<Link
								className={cn(buttonVariants({ size: "lg", variant: "mono" }))}
								href="/download"
							>
								Get Ryu
							</Link>
							<a
								className={cn(buttonVariants({ size: "lg", variant: "ghost" }))}
								href={docsHref}
								rel="noopener noreferrer"
								target="_blank"
							>
								Read the docs
							</a>
						</div>
						<p className="type-compact mt-5 font-mono text-muted-foreground">
							<OfficialAppLabel manifestId={app.manifestId} />
						</p>
					</div>
					<div
						aria-hidden="true"
						className="flex min-h-[20rem] items-center overflow-hidden rounded-2xl border border-border border-dashed bg-muted/20 p-2 sm:p-3"
						data-product-visual
					>
						<AppShowcaseVisual app={app} />
					</div>
				</div>
			</section>

			<section className="container mx-auto px-4 pb-20 md:pb-28">
				<div className="grid gap-10 lg:grid-cols-[0.72fr_1.28fr] lg:gap-20">
					<div>
						<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
							INSIDE {app.name.toUpperCase()}
						</p>
						<h2 className="mt-4 max-w-md font-heading font-medium text-3xl tracking-tight md:text-4xl">
							A focused surface for this part of the work.
						</h2>
					</div>
					<ul>
						{app.features.map((feature) => (
							<FeatureRow feature={feature} key={feature.title} />
						))}
					</ul>
				</div>
			</section>

			<section className="container mx-auto px-4 pb-24 md:pb-32">
				<div className="grid gap-10 md:grid-cols-[0.72fr_1.28fr] md:gap-20">
					<div>
						<p className="type-caption font-mono text-muted-foreground tracking-(--tracking-table-label)">
							KEEP EXPLORING
						</p>
						<h2 className="mt-3 font-heading font-medium text-2xl tracking-tight">
							More places to put Ryu to work.
						</h2>
					</div>
					<div>
						{relatedApps.map((relatedApp) => (
							<RelatedAppLink app={relatedApp} key={relatedApp.slug} />
						))}
					</div>
				</div>
			</section>
		</div>
	);
}
