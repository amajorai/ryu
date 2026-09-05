import { cn } from "@ryu/ui/lib/utils";
import { Check, Clock, Wallet } from "lucide-react";
import {
	LANDING_CARD_TONES,
	type LandingCardTone,
	landingCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle } from "./sections.tsx";

interface Column {
	body: string;
	eyebrow: string;
	icon: typeof Clock;
	points: string[];
	title: string;
	tone: LandingCardTone;
}

const COLUMNS: Column[] = [
	{
		icon: Clock,
		tone: "yellow",
		eyebrow: "Less checking",
		title: "Your team spends time on judgment, not cleanup.",
		body: "AI handles the first pass while your people review the parts that matter, with the source and the output in the same place.",
		points: [
			"Keep the source and answer together",
			"Review the decisions that need judgment",
			"Stop copying context between tools",
			"Measure the checking time you get back",
		],
	},
	{
		icon: Wallet,
		tone: "teal",
		eyebrow: "Know the cost",
		title: "The saving is visible in the bill.",
		body: "Use the AI subscriptions you already pay for, add a ceiling to managed work, and see what each workflow costs before it becomes routine.",
		points: [
			"Set a monthly ceiling per person and team",
			"See the cost of a workflow before you scale it",
			"Keep routine work local when that is cheaper",
			"Keep the subscriptions your team already uses",
		],
	},
];

export default function SaveTimeMoney() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<div className="max-w-2xl">
					<SectionTitle
						suffix={
							<span className="text-muted-foreground">
								{" "}
								Your team gets time back when the output can be trusted.
							</span>
						}
						title="AI should remove work, not add review work."
					/>
				</div>

				<div className="mt-14 grid gap-6 md:grid-cols-2">
					{COLUMNS.map((column, i) => {
						const Icon = column.icon;
						const tone = LANDING_CARD_TONES[column.tone];
						return (
							<Reveal delay={i * 0.08} key={column.eyebrow}>
								<div className={landingCardSurfaceClass(column.tone)}>
									<Icon
										className={cn("size-5", tone.title)}
										strokeWidth={1.75}
									/>
									<p
										className={cn(
											"mt-6 font-medium text-xs uppercase tracking-widest",
											tone.eyebrow
										)}
									>
										{column.eyebrow}
									</p>
									<h3
										className={cn(
											"mt-2 font-medium text-xl tracking-tight md:text-2xl",
											tone.title
										)}
									>
										{column.title}
									</h3>
									<p className={cn("mt-3 leading-relaxed", tone.body)}>
										{column.body}
									</p>
									<ul className="mt-6 space-y-3">
										{column.points.map((point) => (
											<li className="flex items-start gap-3" key={point}>
												<Check
													className={cn("mt-0.5 size-4 shrink-0", tone.marker)}
												/>
												<span
													className={cn("text-sm leading-relaxed", tone.bullet)}
												>
													{point}
												</span>
											</li>
										))}
									</ul>
								</div>
							</Reveal>
						);
					})}
				</div>
			</div>
		</section>
	);
}
