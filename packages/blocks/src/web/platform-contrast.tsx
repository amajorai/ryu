import { cn } from "@ryu/ui/lib/utils";
import { Check, Coins, Lock, X } from "lucide-react";
import Link from "next/link";
import {
	LANDING_CARD_TONES,
	landingCardSurfaceClass,
	landingMutedCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

const PLATFORM_PAIN = [
	"Lock you into their workspace, tools, and agent runtime",
	"Sell opaque credits with no clear dollar value",
	"Mark up usage so you never know what a message really costs",
	"Keep your data, workflows, and agents inside their ecosystem",
	"Make switching mean rebuilding everything from scratch",
	"Ship agents to sell more seats, not to run the stack you already have",
] as const;

const RYU_DIFFERENCE = [
	"Wrap any model, agent, tool, and subscription you already use",
	"Credits are US dollars — $25 in your wallet is $25 of usage",
	"See spend per message, per run, and per agent before it adds up",
	"Open core you can self-host; every default is swappable",
	"Orchestration above your stack, not a replacement for it",
	"Built to govern agents you choose, not to trap you in one vendor",
] as const;

const CREDIT_EXAMPLE = [
	{ label: "You add", value: "$25.00" },
	{ label: "Typical chat turn", value: "~$0.02" },
	{ label: "Budget cap per agent", value: "You set it" },
] as const;

function PlatformCard() {
	return (
		<div className={landingMutedCardSurfaceClass}>
			<Lock className="size-5 text-foreground" strokeWidth={1.75} />
			<p className="mt-6 font-semibold text-muted-foreground/60 text-xs uppercase tracking-widest">
				Typical platform provider
			</p>
			<h3 className="mt-2 font-medium text-foreground text-xl tracking-tight md:text-2xl">
				Agents inside their walled garden
			</h3>
			<ul className="mt-6 space-y-3">
				{PLATFORM_PAIN.map((item) => (
					<li className="flex items-start gap-3" key={item}>
						<X
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-muted-foreground/70"
							strokeWidth={1.5}
						/>
						<span className="text-foreground/80 text-sm leading-relaxed">
							{item}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function RyuCard() {
	const tone = LANDING_CARD_TONES.blue;
	return (
		<div className={landingCardSurfaceClass("blue")}>
			<Coins className={cn("size-5", tone.title)} strokeWidth={1.75} />
			<p
				className={cn(
					"mt-6 font-semibold text-xs uppercase tracking-widest",
					tone.eyebrow
				)}
			>
				Ryu
			</p>
			<h3
				className={cn(
					"mt-2 font-medium text-xl tracking-tight md:text-2xl",
					tone.title
				)}
			>
				The control layer around your agents
			</h3>
			<ul className="mt-6 space-y-3">
				{RYU_DIFFERENCE.map((item) => (
					<li className="flex items-start gap-3" key={item}>
						<Check
							aria-hidden="true"
							className={cn("mt-0.5 size-4 shrink-0", tone.marker)}
							strokeWidth={1.5}
						/>
						<span className={cn("text-sm leading-relaxed", tone.bullet)}>
							{item}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function CreditClarityPanel() {
	return (
		<div className="rounded-2xl border border-border/60 bg-background/60 p-6 md:p-8">
			<div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
				<div className="max-w-xl">
					<h3 className="font-medium text-foreground text-lg tracking-tight">
						Dollar credits, not mystery tokens
					</h3>
					<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
						Most platforms hide the markup inside a credit system. Ryu
						denominates usage in dollars, meters at cost after top-up, and shows
						you what each run spent before the bill surprises you.
					</p>
				</div>
				<dl className="grid min-w-[min(100%,16rem)] gap-3 sm:grid-cols-3 md:gap-4">
					{CREDIT_EXAMPLE.map((row) => (
						<div
							className="rounded-xl bg-muted/50 px-4 py-3 text-center"
							key={row.label}
						>
							<dt className="text-muted-foreground text-xs">{row.label}</dt>
							<dd className="mt-1 font-medium text-foreground text-sm">
								{row.value}
							</dd>
						</div>
					))}
				</dl>
			</div>
			<p className="mt-4 text-muted-foreground/70 text-xs leading-relaxed">
				Need the full breakdown?{" "}
				<Link
					className="text-foreground underline-offset-4 hover:underline"
					href="/pricing"
				>
					See pricing and credits
				</Link>
				.
			</p>
		</div>
	);
}

export default function PlatformContrast() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<div className="max-w-2xl">
					<SectionTitle title="Lots of platforms can add an agent. Ryu is built differently." />
					<p className={sectionSubtitleClass}>
						Other platforms lock you into their tools and marked-up credits. Ryu
						wraps what you already run — with spend you can predict in dollars.
					</p>
				</div>

				<div className="mt-14 grid gap-6 md:grid-cols-2">
					<Reveal>
						<PlatformCard />
					</Reveal>
					<Reveal delay={0.08}>
						<RyuCard />
					</Reveal>
				</div>

				<Reveal className="mt-6" delay={0.12}>
					<CreditClarityPanel />
				</Reveal>
			</div>
		</section>
	);
}
