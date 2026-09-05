import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Computer, LockKeyhole, Sparkles } from "lucide-react";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

/**
 * The page thesis: the three facts that turn a useful answer into work a team
 * can safely use. Keep these concrete; trust is a product promise only when a
 * buyer can see what changes in their day.
 *
 * Every line is written from the reader's side, not ours. Keep the grammatical
 * subject as the team deciding whether to use AI in real work.
 */
const POINTS: { detail: string; icon: LucideIcon; label: string }[] = [
	{
		icon: Sparkles,
		label: "Comes ready to use",
		detail: "Ryu manages the models, runtime, and updates behind the Bot.",
	},
	{
		icon: LockKeyhole,
		label: "Works in its own sandbox",
		detail: "Give Ryu a task without setting up local AI or a server.",
	},
	{
		icon: Computer,
		label: "Uses your computer by permission",
		detail: "Computer access stays behind the controls you approve.",
	},
];

export default function TrustStrip() {
	return (
		<section
			className="container mx-auto scroll-mt-24 px-4 pt-8 md:pt-12"
			id="trust"
		>
			<div className="mx-auto max-w-6xl">
				<div className="mb-8 max-w-2xl">
					<SectionTitle title="Give Ryu work, not another chat." />
					<p className={sectionSubtitleClass}>
						Ryu Bot handles the setup so you can start with the task.
					</p>
				</div>

				<div className="grid gap-3 sm:grid-cols-3">
					{POINTS.map((point, i) => {
						const Icon = point.icon;
						return (
							<Reveal delay={(i % 3) * 0.06} key={point.label}>
								<div
									className={cn(
										"flex h-full flex-col gap-2 rounded-2xl bg-muted/50 p-4 backdrop-blur-sm",
										"transition-colors duration-200 hover:bg-muted/70"
									)}
								>
									<Icon
										aria-hidden="true"
										className="size-5 text-foreground"
										strokeWidth={1.75}
									/>
									<p className="font-medium text-foreground text-sm">
										{point.label}
									</p>
									<p className="text-muted-foreground text-sm leading-relaxed">
										{point.detail}
									</p>
								</div>
							</Reveal>
						);
					})}
				</div>
			</div>
		</section>
	);
}
