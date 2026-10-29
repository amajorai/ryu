import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { landingSurfaceCardXlClass } from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";

const steps = [
	{
		title: "We start with one workflow your team already pays for.",
		body: "We look at the checking, copy-paste, and rework around it, then say plainly where Ryu can remove cost without hiding the risk.",
	},
	{
		title: "We connect the context it needs.",
		body: "Your documents, systems, rules, and review points. The setup stays around the work you already do, not a new process your team has to learn.",
	},
	{
		title: "You see the answer and the evidence.",
		body: "A plain record shows the source, the output, the changes, the decision, and the cost. Your team decides what is ready to ship.",
	},
	{
		title: "You expand only when the first workflow is trusted.",
		body: "Every rule and correction your team captures stays. The next workflow starts with the evidence from the first, not another blank experiment.",
	},
];

export default function WhyRyu() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-2 lg:gap-16">
				{/* Left, pinned statement */}
				<div className="lg:sticky lg:top-28 lg:self-start">
					{/* Wraps only the title and its supporting line: the button row below
					    is a flex layout and `.t-stagger-line` would force it to block. */}
					<StaggerLines>
						<SectionTitle title="Start with one workflow." />
						<p className={sectionSubtitleClass}>
							Use Ryu where checking and copy-paste are costing your team time.
						</p>
					</StaggerLines>
					<div className="mt-8 flex flex-col gap-3 sm:flex-row">
						<Link
							className={cn(buttonVariants({ variant: "mono" }))}
							href="https://cal.com/amajor/ryu-demo"
							rel="noopener noreferrer"
							target="_blank"
						>
							Talk through your AI workflow
						</Link>
						<Link
							className={cn(buttonVariants({ variant: "ghost" }))}
							href="/for"
						>
							See pricing
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
