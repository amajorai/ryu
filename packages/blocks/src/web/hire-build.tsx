import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Blocks, Check, UserRoundSearch } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { DOWNLOAD_CTA_HREF } from "./download-cta.ts";
import { DownloadMenu } from "./download-menu.tsx";
import type { LandingCardTone } from "./landing-card-tones.ts";
import {
	LANDING_CARD_TONES,
	landingCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionHeading } from "./sections.tsx";

const DEMO_HREF = "https://cal.com/jiaweing/ryu-demo";

interface PathCard {
	bullets: string[];
	ctaExternal?: boolean;
	ctaHref: string;
	ctaLabel: string;
	description: string;
	icon: LucideIcon;
	secondaryCtaExternal?: boolean;
	secondaryCtaHref?: string;
	secondaryCtaLabel?: string;
	title: string;
	tone: LandingCardTone;
}

const PATHS: PathCard[] = [
	{
		icon: UserRoundSearch,
		tone: "orange",
		title: "Hire",
		description:
			"Pre-made agents for people who don't want to wire tools, tune prompts, or hunt API keys. Pick a role, install, and go.",
		bullets: [
			"Ready-made agents for sales, support, ops, and more",
			"One-click install from the agents catalog",
			"Budgets, permissions, and governance already in place",
			"White-glove build available if you want us to do it",
		],
		ctaHref: "/for",
		ctaLabel: "Browse pre-made agents",
		secondaryCtaHref: DEMO_HREF,
		secondaryCtaExternal: true,
		secondaryCtaLabel: "Get it built for you",
	},
	{
		icon: Blocks,
		tone: "purple",
		title: "Build",
		description:
			"Compose your own agent for your exact workflow. Every slot—model, tools, memory, policy—is swappable. Nothing locked in.",
		bullets: [
			"Build agents like Pokémon cards with swappable slots",
			"Custom tools, MCP, skills, and memory per agent",
			"Git-native workspace, workflows, and parallel runs",
			"SDK and open core when you want to go deeper",
		],
		ctaHref: DOWNLOAD_CTA_HREF,
		ctaLabel: "Download",
		secondaryCtaHref: "/products/agents",
		secondaryCtaLabel: "How building works",
	},
];

function PathCardBlock({ card }: { card: PathCard }) {
	const Icon = card.icon;
	const tone = LANDING_CARD_TONES[card.tone];
	const secondaryProps = card.secondaryCtaExternal
		? { rel: "noopener noreferrer" as const, target: "_blank" as const }
		: {};

	return (
		<div className={cn("flex flex-col", landingCardSurfaceClass(card.tone))}>
			<Icon className={cn("size-5", tone.title)} strokeWidth={1.75} />
			<h3
				className={cn("mt-6 font-medium text-3xl tracking-tight", tone.title)}
			>
				{card.title}
			</h3>
			<p className={cn("mt-3 leading-relaxed", tone.body)}>
				{card.description}
			</p>
			<ul className="mt-6 space-y-3">
				{card.bullets.map((point) => (
					<li className="flex items-start gap-3" key={point}>
						<Check className={cn("mt-0.5 size-4 shrink-0", tone.marker)} />
						<span className={cn("text-sm leading-relaxed", tone.bullet)}>
							{point}
						</span>
					</li>
				))}
			</ul>
			<div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
				{card.ctaHref === DOWNLOAD_CTA_HREF ? (
					<DownloadMenu
						className={cn("inline-flex items-center gap-1.5", tone.cta)}
						variant="outline"
					/>
				) : (
					<Link
						className={cn(
							buttonVariants({ variant: "outline" }),
							"inline-flex items-center gap-1.5",
							tone.cta
						)}
						href={card.ctaHref as Route}
					>
						{card.ctaLabel}
						<ArrowRight className="size-4" />
					</Link>
				)}
				{card.secondaryCtaHref && card.secondaryCtaLabel ? (
					<Link
						className={cn(
							buttonVariants({ variant: "ghost" }),
							"inline-flex",
							tone.ctaSecondary
						)}
						href={card.secondaryCtaHref as Route}
						{...secondaryProps}
					>
						{card.secondaryCtaLabel}
					</Link>
				) : null}
			</div>
		</div>
	);
}

export default function HireBuild() {
	return (
		<section className="container mx-auto px-4">
			<div className="mx-auto max-w-6xl">
				<SectionHeading
					subtitle="Start with a ready-made agent, or customize every part for your workflow."
					title="Hire or build"
				/>
				<div className="grid gap-6 md:grid-cols-2">
					{PATHS.map((card, i) => (
						<Reveal delay={i * 0.08} key={card.title}>
							<PathCardBlock card={card} />
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
