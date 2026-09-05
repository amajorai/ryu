import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Languages, Receipt, ShieldQuestion } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import {
	LANDING_CARD_TONES,
	type LandingCardTone,
	landingCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";

/**
 * One runtime underneath, sold as a named job per industry. The card leads with
 * the OUTCOME the firm buys and only then says what the work is — a partner
 * shops for "take the jobs I used to refuse", not for an agent platform.
 */
interface VerticalCard {
	icon: LucideIcon;
	outcome: string;
	slug: string;
	title: string;
	tone: LandingCardTone;
	work: string;
}

const CARDS: VerticalCard[] = [
	{
		icon: Languages,
		tone: "purple",
		title: "Translation",
		slug: "translation",
		outcome: "Take the confidential jobs you used to refuse",
		work: "Legal and commercial document translation, with your glossary, your reviewers, and a record of every job that a client can be shown.",
	},
	{
		icon: ShieldQuestion,
		tone: "blue",
		title: "Insurance",
		slug: "insurance",
		outcome: "Clear the claims backlog without new headcount",
		work: "Claims file intake and processing, with each step written down and the calls that need a human waiting for one.",
	},
	{
		icon: Receipt,
		tone: "green",
		title: "Accounting",
		slug: "accounting",
		outcome: "Take on more clients through busy season",
		work: "Working paper preparation and document-heavy prep work, running on your machines so client financials never leave the firm.",
	},
];

export default function VerticalSolutions() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-6xl">
				<StaggerLines className="max-w-2xl">
					<SectionTitle title="Set up for the way your firm already works." />
					<p className={sectionSubtitleClass}>
						Your document types, your rules, your reviewers, your approval
						steps, running on real work within days.
					</p>
				</StaggerLines>

				<div className="mt-14 grid gap-6 md:grid-cols-3">
					{CARDS.map((card, i) => {
						const Icon = card.icon;
						const tone = LANDING_CARD_TONES[card.tone];
						return (
							<Reveal delay={i * 0.08} key={card.slug}>
								<div
									className={cn(
										"flex flex-col",
										landingCardSurfaceClass(card.tone)
									)}
								>
									<Icon
										aria-hidden="true"
										className={cn("size-5", tone.title)}
										strokeWidth={1.75}
									/>
									<p
										className={cn(
											"mt-6 font-medium text-xs uppercase tracking-widest",
											tone.eyebrow
										)}
									>
										{card.title}
									</p>
									<h3
										className={cn(
											"mt-2 font-medium text-xl tracking-tight md:text-2xl",
											tone.title
										)}
									>
										{card.outcome}
									</h3>
									<p className={cn("mt-3 text-sm leading-relaxed", tone.body)}>
										{card.work}
									</p>
									<div className="mt-6">
										<Link
											className={cn(
												"inline-flex items-center gap-1.5 font-medium text-sm",
												tone.title
											)}
											href={`/for/${card.slug}` as Route}
										>
											See how it runs
											<ArrowRight aria-hidden="true" className="size-4" />
										</Link>
									</div>
								</div>
							</Reveal>
						);
					})}
				</div>
			</div>
		</section>
	);
}
