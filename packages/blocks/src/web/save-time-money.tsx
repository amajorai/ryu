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
		eyebrow: "Save time",
		title: "Agents that are ready on install.",
		body: "No MCP wiring, no API-key hunt, no week-long integration. The setup work that usually falls on an engineer is already done.",
		points: [
			"One-click agents, tools, and skills with no glue code to write",
			"Tools, memory, and audit wired in, not built per project",
			"Ready-made agents for real roles instead of a blank prompt",
			"Or we map the workflow and roll it out with you",
		],
	},
	{
		icon: Wallet,
		tone: "teal",
		eyebrow: "Save money",
		title: "Cheap work never touches expensive models.",
		body: "Local models handle routine work; cloud models handle only the jobs that need them. Every call runs through one budget and routing layer.",
		points: [
			"Smart routing keeps simple tasks off premium cloud models",
			"Per-agent budgets and full cost visibility, never blind spend",
			"One layer for security, tools, and memory, not SaaS seats per team",
			"Bring your own keys and subscriptions, zero lock-in",
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
								Ryu removes the setup that eats weeks and the bills that never
								stop.
							</span>
						}
						title="Ryu saves you time and money."
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
											"mt-6 font-semibold text-xs uppercase tracking-widest",
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
