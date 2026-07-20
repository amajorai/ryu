import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { landingSurfaceCardXlClass } from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

const steps = [
	{
		title: "The agent bill is not just tokens.",
		body: "Startups and SMEs pay for model calls, SaaS seats, API keys, tool wiring, retries, audits, and the engineer who has to hold it together.",
	},
	{
		title: "Ryu controls the expensive parts.",
		body: "Local models handle routine work. Cloud models handle the jobs that need them. Budgets, routing, memory, tools, and audit live in one place.",
	},
	{
		title: "Your team gets agents, not an infra project.",
		body: "Install ready-made agents for real roles, connect them to the tools your team already uses, and keep humans in the loop where work needs review.",
	},
	{
		title: "Or we roll it out with you.",
		body: "For businesses, Ryu can be product plus implementation: we map the workflow, install the right agents, set the policies, and tune spend around the work.",
	},
];

export default function WhyRyu() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:gap-16">
				{/* Left, pinned statement */}
				<div className="lg:sticky lg:top-28 lg:self-start">
					<SectionTitle title="Agents should save money before they spend it." />
					<p className={sectionSubtitleClass}>
						Useful agents without hiring a platform team.
					</p>
					<div className="mt-8 flex flex-col gap-3 sm:flex-row">
						<Link
							className={cn(buttonVariants({ variant: "default" }))}
							href="https://cal.com/jiaweing/ryu-demo"
							rel="noopener noreferrer"
							target="_blank"
						>
							Book a Demo
						</Link>
						<Link
							className={cn(buttonVariants({ variant: "ghost" }))}
							href="/products/agents-as-a-service"
						>
							Agents as a Service
						</Link>
					</div>
				</div>

				{/* Right, numbered steps that scroll past the pinned left */}
				<div className="space-y-4 lg:space-y-6">
					{steps.map((step, i) => (
						<Reveal delay={(i % 2) * 0.08} key={step.title}>
							<div className={landingSurfaceCardXlClass}>
								<span className="font-medium text-muted-foreground/50 text-sm">
									{String(i + 1).padStart(2, "0")}
								</span>
								<h3 className="mt-3 font-medium text-foreground text-xl tracking-tight">
									{step.title}
								</h3>
								<p className="mt-2 text-muted-foreground leading-relaxed">
									{step.body}
								</p>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
